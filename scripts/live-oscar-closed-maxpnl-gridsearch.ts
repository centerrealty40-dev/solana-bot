/**
 * Live Oscar — **тупой перебор** комбинаций выходных параметров на закрытых сделках + PG `price_usd`
 * в окне **[entryTs, journal exitTs]** (как в `live-oscar-hypothesis-sweep.ts`, без «хвоста» после выхода).
 *
 * Цель: **максимизировать сумму `netPnlUsd` симуляции** по всем подготовленным сделкам при фиксированной
 * ценовой траектории из БД. Это не прогноз кошелька на будущее — контрфакт «если бы N сделок назад
 * стояли такие пороги».
 *
 * Сетка по умолчанию умеренная (~8k комбо). Узже: `--quick`. Своя сетка: списки через запятую
 * (`--tp-steps`, `--tp-sells`, …).
 *
 *   npx tsx scripts/live-oscar-closed-maxpnl-gridsearch.ts --journal data/live/pt1-oscar-live.jsonl
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../src/papertrader/config.js';
import { sourceSnapshotTable } from '../src/papertrader/dip-detector.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';
import {
  cloneOpenFromJournal,
  simulateLifecycle,
  type Anchor,
} from '../src/scripts/paper2-strategy-backtest.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function stringifyEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function pm2AppPaperEnv(appName: 'live-oscar' | 'live-oscar-risky'): Record<string, string> {
  const ecosystem = require(path.join(repoRoot, 'ecosystem.config.cjs')) as {
    apps: Array<{ name?: string; env?: Record<string, unknown> }>;
  };
  const app = ecosystem.apps?.find((a) => a.name === appName);
  if (!app?.env) throw new Error(`ecosystem.config.cjs: ${appName} env not found`);
  return stringifyEnv(app.env as Record<string, unknown>);
}

function withEnvPatch<T>(patch: Record<string, string>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k] of Object.entries(patch)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  return process.argv[i + 1]!;
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchPriceAnchorsPg(args: {
  mint: string;
  source: string;
  entryTs: number;
  endTs: number;
}): Promise<Anchor[]> {
  const table = sourceSnapshotTable(args.source);
  if (!table) return [];
  const mint = sqlQuote(args.mint);
  const t0 = args.entryTs / 1000;
  const t1 = args.endTs / 1000;
  const q = `
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::double precision AS ts_ms,
           price_usd::double precision AS p
    FROM ${table}
    WHERE base_mint = ${mint}
      AND ts >= to_timestamp(${t0})
      AND ts <= to_timestamp(${t1})
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts ASC
  `;
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Array<{ ts_ms: unknown; p: unknown }>;
  const out: Anchor[] = [];
  for (const row of rows) {
    const ts = Number(row.ts_ms);
    const p = Number(row.p);
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) continue;
    out.push({ ts, p });
  }
  return out;
}

function mergeCfg(base: PaperTraderConfig, patch: Partial<PaperTraderConfig>): PaperTraderConfig {
  return { ...base, ...patch };
}

function tpAbMirror(patch: Partial<PaperTraderConfig>): Partial<PaperTraderConfig> {
  const out = { ...patch };
  if (typeof patch.tpGridStepPnl === 'number') {
    out.liveExitModeBTpGridStepPnl = patch.tpGridStepPnl;
  }
  if (typeof patch.tpGridSellFraction === 'number') {
    out.liveExitModeBTpGridSellFraction = patch.tpGridSellFraction;
  }
  if (typeof patch.tpGridFirstRungRetraceMinPnlPct === 'number') {
    out.liveExitModeBTpGridFirstRungRetraceMinPnlPct = patch.tpGridFirstRungRetraceMinPnlPct;
  }
  return out;
}

function clipAnchors(anchors: Anchor[], t0: number, t1: number): Anchor[] {
  return anchors.filter((a) => a.ts >= t0 && a.ts <= t1);
}

function parseCsvNums(flag: string, fallback: number[]): number[] {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) return fallback;
  const parts = process.argv[i + 1]!.split(',');
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p.trim());
    if (Number.isFinite(n)) out.push(n);
  }
  return out.length ? out : fallback;
}

type Combo = { id: string; patch: Partial<PaperTraderConfig> };

function buildComboGrid(quick: boolean): Combo[] {
  const tpSteps = quick
    ? [0.025, 0.04, 0.06]
    : parseCsvNums('--tp-steps', [0.02, 0.025, 0.03, 0.04, 0.05, 0.07]);
  const tpSells = quick
    ? [0.05, 0.12, 0.2]
    : parseCsvNums('--tp-sells', [0.05, 0.08, 0.12, 0.15, 0.2]);
  const tpRetrace = quick
    ? [0.025]
    : parseCsvNums('--tp-retrace', [0.02, 0.025]);
  const killSig = quick
    ? [18, 28]
    : parseCsvNums('--kill-signal-pct', [15, 22, 28, 35]);
  const dcaKill = quick
    ? [-0.08, -0.1]
    : parseCsvNums('--dca-kill', [-0.06, -0.08, -0.1, -0.12]);
  const trailDrop = quick
    ? [0.1, 0.12]
    : parseCsvNums('--trail-drop', [0.1, 0.12, 0.15]);
  const trailTrig = quick
    ? [1.04, 1.06]
    : parseCsvNums('--trail-trigger-x', [1.04, 1.06, 1.08]);

  const combos: Combo[] = [];
  for (const step of tpSteps) {
    for (const sell of tpSells) {
      for (const retr of tpRetrace) {
        for (const ks of killSig) {
          for (const dk of dcaKill) {
            for (const td of trailDrop) {
              for (const tx of trailTrig) {
                const patch = tpAbMirror({
                  tpGridStepPnl: step,
                  tpGridSellFraction: sell,
                  tpGridFirstRungRetraceMinPnlPct: retr,
                  liveStagedEntryKillDropPct: ks,
                  dcaKillstop: dk,
                  liveExitModeBDcaKillstop: dk,
                  trailDrop: td,
                  trailTriggerX: tx,
                  liveExitModeBTrailDrop: td,
                  liveExitModeBTrailTriggerX: tx,
                });
                const id = [
                  `tp${Math.round(step * 1000)}`,
                  `sf${Math.round(sell * 100)}`,
                  `r${Math.round(retr * 1000)}`,
                  `sk${Math.round(ks)}`,
                  `dk${Math.round(-dk * 100)}`,
                  `td${Math.round(td * 100)}`,
                  `tx${Math.round(tx * 100)}`,
                ].join('_');
                combos.push({ id, patch });
              }
            }
          }
        }
      }
    }
  }
  return combos;
}

type PrepRow = {
  closedTrade: Record<string, unknown>;
  anchors: Anchor[];
  actualNetUsd: number;
  journalExitTs: number;
  entryTs: number;
};

async function main(): Promise<void> {
  const t0 = Date.now();
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  const stepMs = argNum('--step-ms', 60_000);
  const topN = argNum('--top', 30);
  const quick = process.argv.includes('--quick');
  const risky = process.argv.includes('--risky');
  const appName = risky ? 'live-oscar-risky' : 'live-oscar';
  const pmEnv = pm2AppPaperEnv(appName);

  const { baseCfg, dcaLevels, tpLadder } = withEnvPatch(pmEnv, () => ({
    baseCfg: loadPaperTraderConfig(),
    dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
  }));

  const combos = buildComboGrid(quick);
  const combosWithBaseline: Combo[] = [{ id: 'BASELINE_PM2_PATCH_EMPTY', patch: {} }, ...combos];

  const prep: PrepRow[] = [];
  let skippedBad = 0;
  let skippedOpen = 0;
  let sumActual = 0;

  const abs = path.resolve(journal);
  if (!fs.existsSync(abs)) {
    console.error('journal missing', abs);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim() || line[0] !== '{') continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.kind !== 'live_position_close') continue;
    if (typeof e.strategyId === 'string' && e.strategyId !== 'live-oscar') continue;
    const ct = e.closedTrade as Record<string, unknown> | undefined;
    if (!ct || typeof ct.mint !== 'string') continue;
    const net = Number(ct.netPnlUsd ?? 0);
    const pnlPct = Number(ct.pnlPct ?? 0);
    if (!Number.isFinite(net) || Math.abs(net) > 1e6 || !Number.isFinite(pnlPct) || Math.abs(pnlPct) > 5000) {
      skippedBad++;
      continue;
    }
    const src = typeof ct.source === 'string' ? ct.source : '';
    if (!sourceSnapshotTable(src)) {
      skippedOpen++;
      continue;
    }
    let probe: OpenTrade;
    try {
      probe = cloneOpenFromJournal(ct, baseCfg);
    } catch {
      skippedOpen++;
      continue;
    }
    const entryTs = probe.entryTs;
    const exitTs = Number(ct.exitTs ?? 0);
    if (!Number.isFinite(exitTs) || exitTs <= entryTs) {
      skippedOpen++;
      continue;
    }
    const anchors = await fetchPriceAnchorsPg({ mint: probe.mint, source: src, entryTs, endTs: exitTs });
    if (anchors.length < 2) {
      skippedOpen++;
      continue;
    }
    sumActual += net;
    prep.push({ closedTrade: ct, anchors, actualNetUsd: net, journalExitTs: exitTs, entryTs });
  }

  type Score = {
    id: string;
    patch: Partial<PaperTraderConfig>;
    sumNet: number;
    nOk: number;
    nSkip: number;
  };

  const scores: Score[] = [];

  for (const c of combosWithBaseline) {
    let sumNet = 0;
    let nOk = 0;
    let nSkip = 0;
    const cfg = mergeCfg(baseCfg, c.patch);
    for (const row of prep) {
      const anchorsClipped = clipAnchors(row.anchors, row.entryTs, row.journalExitTs);
      let baseOt: OpenTrade;
      try {
        baseOt = cloneOpenFromJournal(row.closedTrade, cfg);
      } catch {
        nSkip++;
        continue;
      }
      const sim = simulateLifecycle({
        baseOt,
        anchors: anchorsClipped.length >= 2 ? anchorsClipped : row.anchors,
        cfg,
        dcaLevels,
        tpLadder,
        stepMs,
      });
      if (!sim) {
        nSkip++;
        continue;
      }
      sumNet += sim.netPnlUsd;
      nOk++;
    }
    scores.push({ id: c.id, patch: c.patch, sumNet, nOk, nSkip });
  }

  scores.sort((a, b) => b.sumNet - a.sumNet);
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  const best = scores[0]!;
  const baseline = scores.find((s) => s.id === 'BASELINE_PM2_PATCH_EMPTY')!;
  const baselineRank = scores.findIndex((s) => s.id === 'BASELINE_PM2_PATCH_EMPTY') + 1;

  const top = scores.slice(0, topN).map((s, idx) => ({
    rank: idx + 1,
    id: s.id,
    sumNetPnlUsd: +s.sumNet.toFixed(2),
    deltaVsActualJournalUsd: +(s.sumNet - sumActual).toFixed(2),
    meanNetUsd: s.nOk ? +(s.sumNet / s.nOk).toFixed(3) : null,
    tradesSimulated: s.nOk,
    skipped: s.nSkip,
    /** Ключевые числа для копирования в env (A/B зеркалированы в patch). */
    params: summarizePatch(s.patch),
    envHints: patchToEnvHints(s.patch),
  }));

  console.log(
    JSON.stringify(
      {
        journal: abs,
        pm2PaperEnvApp: appName,
        anchorWindow: 'entryTs .. journal exitTs (no post-exit horizon)',
        tradesPrepared: prep.length,
        sumActualClosedNetPnlUsd: +sumActual.toFixed(2),
        skippedCorrupt: skippedBad,
        skippedNoAnchorsOrOpen: skippedOpen,
        totalCombosEvaluated: combosWithBaseline.length,
        combosExcludingBaseline: combos.length,
        quickPreset: quick,
        elapsedSec: +elapsedSec,
        objective: 'maximize sum(sim.netPnlUsd) over closed trades on PG anchors',
        caveatRu:
          'Это математический перебор на дискретной сетке и на ценах из Postgres, не гарантия будущего PnL и не тождество реальному исполнению Jupiter.',
        best: {
          id: best.id,
          sumNetPnlUsd: +best.sumNet.toFixed(2),
          deltaVsActualJournalUsd: +(best.sumNet - sumActual).toFixed(2),
          params: summarizePatch(best.patch),
          envHints: patchToEnvHints(best.patch),
        },
        baselinePm2: baseline
          ? {
              rankAmongAll: baselineRank,
              sumNetPnlUsd: +baseline.sumNet.toFixed(2),
              deltaVsActualJournalUsd: +(baseline.sumNet - sumActual).toFixed(2),
            }
          : null,
        topN: top,
      },
      null,
      2,
    ),
  );
}

function summarizePatch(patch: Partial<PaperTraderConfig>): Record<string, number> {
  const out: Record<string, number> = {};
  const pick = (k: keyof PaperTraderConfig) => {
    const v = patch[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[String(k)] = v;
  };
  pick('tpGridStepPnl');
  pick('tpGridSellFraction');
  pick('tpGridFirstRungRetraceMinPnlPct');
  pick('liveStagedEntryKillDropPct');
  pick('dcaKillstop');
  pick('trailDrop');
  pick('trailTriggerX');
  return out;
}

/** Подсказка для ручного переноса в `ecosystem.config.cjs` (A и B для TP/трейла/kill). */
function patchToEnvHints(patch: Partial<PaperTraderConfig>): Record<string, string> {
  const e: Record<string, string> = {};
  const set = (k: string, v: number) => {
    e[k] = String(v);
  };
  if (typeof patch.tpGridStepPnl === 'number') {
    set('PAPER_TP_GRID_STEP_PNL', patch.tpGridStepPnl);
    set('PAPER_LIVE_EXIT_MODE_B_TP_GRID_STEP_PNL', patch.tpGridStepPnl);
  }
  if (typeof patch.tpGridSellFraction === 'number') {
    set('PAPER_TP_GRID_SELL_FRACTION', patch.tpGridSellFraction);
    set('PAPER_LIVE_EXIT_MODE_B_TP_GRID_SELL_FRACTION', patch.tpGridSellFraction);
  }
  if (typeof patch.tpGridFirstRungRetraceMinPnlPct === 'number') {
    set('PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL', patch.tpGridFirstRungRetraceMinPnlPct);
    set('PAPER_LIVE_EXIT_MODE_B_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL', patch.tpGridFirstRungRetraceMinPnlPct);
  }
  if (typeof patch.liveStagedEntryKillDropPct === 'number') {
    set('PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT', patch.liveStagedEntryKillDropPct);
  }
  if (typeof patch.dcaKillstop === 'number') {
    set('PAPER_DCA_KILLSTOP', patch.dcaKillstop);
  }
  if (typeof patch.liveExitModeBDcaKillstop === 'number') {
    set('PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP', patch.liveExitModeBDcaKillstop);
  }
  if (typeof patch.trailDrop === 'number') {
    set('PAPER_TRAIL_DROP', patch.trailDrop);
    set('PAPER_LIVE_EXIT_MODE_B_TRAIL_DROP', patch.trailDrop);
  }
  if (typeof patch.trailTriggerX === 'number') {
    set('PAPER_TRAIL_TRIGGER_X', patch.trailTriggerX);
    set('PAPER_LIVE_EXIT_MODE_B_TRAIL_TRIGGER_X', patch.trailTriggerX);
  }
  return e;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
