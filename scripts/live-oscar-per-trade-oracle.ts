/**
 * Live Oscar — **по каждой закрытой сделке**: перебор сетки (signal-kill %, TP-grid, DCA kill, трейл)
 * на PG `price_usd` в **[entryTs, journal exitTs]** → для сделки запоминается набор с **максимальным sim netPnlUsd**.
 * Потом:
 * - частоты: сколько раз каждое значение (kill / step / …) встречалось в «победителе» именно этой сделки;
 * - **один общий набор** на все сделки: тот же перебор, но критерий = **максимум суммы** sim net по всем сделкам.
 *
 * `liveStagedEntryKillDropPct` — это **signal kill для staged-entry** (падение от цены сигнала в %), не путать с `dcaKillstop`.
 *
 *   npm run live:per-trade-oracle -- --journal data/live/pt1-oscar-live.jsonl
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
import { cloneOpenFromJournal, simulateLifecycle, type Anchor } from '../src/scripts/paper2-strategy-backtest.js';

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

type Combo = { id: string; patch: Partial<PaperTraderConfig> };

/** Одна сетка на всё: перебор по сделкам и глобальный максимум суммы. */
function buildOracleGrid(): Combo[] {
  const killSig = [12, 14, 15, 16, 18, 20, 22, 24, 26, 28];
  const tpSteps = [0.025, 0.03, 0.035, 0.04, 0.045, 0.05];
  const tpSells = [0.05, 0.08, 0.12, 0.15];
  const tpRetrace = [0.02, 0.025];
  const dcaKill = [-0.055, -0.06, -0.07, -0.08, -0.1];
  const trailDrop = [0.1, 0.12];
  const trailTrig = [1.04, 1.06];

  const combos: Combo[] = [];
  for (const ks of killSig) {
    for (const step of tpSteps) {
      for (const sell of tpSells) {
        for (const retr of tpRetrace) {
          for (const dk of dcaKill) {
            for (const td of trailDrop) {
              for (const tx of trailTrig) {
                const patch = tpAbMirror({
                  liveStagedEntryKillDropPct: ks,
                  tpGridStepPnl: step,
                  tpGridSellFraction: sell,
                  tpGridFirstRungRetraceMinPnlPct: retr,
                  dcaKillstop: dk,
                  liveExitModeBDcaKillstop: dk,
                  trailDrop: td,
                  trailTriggerX: tx,
                  liveExitModeBTrailDrop: td,
                  liveExitModeBTrailTriggerX: tx,
                });
                const id = `sk${ks}_tp${Math.round(step * 1000)}_sf${Math.round(sell * 100)}_r${Math.round(retr * 1000)}_dk${Math.round(-dk * 100)}_td${Math.round(td * 100)}_tx${Math.round(tx * 100)}`;
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
  journalExitTs: number;
  entryTs: number;
  actualNetUsd: number;
  mint: string;
  symbol: string;
};

type DcaLevelsT = ReturnType<typeof parseDcaLevels>;
type TpLadderT = ReturnType<typeof parseTpLadder>;

function simOneTrade(
  row: PrepRow,
  baseCfg: PaperTraderConfig,
  patch: Partial<PaperTraderConfig>,
  dcaLevels: DcaLevelsT,
  tpLadder: TpLadderT,
  stepMs: number,
): number | null {
  const cfg = mergeCfg(baseCfg, patch);
  const anchorsClipped = clipAnchors(row.anchors, row.entryTs, row.journalExitTs);
  let baseOt: OpenTrade;
  try {
    baseOt = cloneOpenFromJournal(row.closedTrade, cfg);
  } catch {
    return null;
  }
  const sim = simulateLifecycle({
    baseOt,
    anchors: anchorsClipped.length >= 2 ? anchorsClipped : row.anchors,
    cfg,
    dcaLevels,
    tpLadder,
    stepMs,
  });
  return sim ? sim.netPnlUsd : null;
}

function bumpCount(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function topCounts(m: Map<string, number>, n: number): Array<{ value: string; trades: number }> {
  return [...m.entries()]
    .map(([value, trades]) => ({ value, trades }))
    .sort((a, b) => b.trades - a.trades)
    .slice(0, n);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  const stepMs = 60_000;
  const risky = process.argv.includes('--risky');
  const appName = risky ? 'live-oscar-risky' : 'live-oscar';
  const pmEnv = pm2AppPaperEnv(appName);

  const { baseCfg, dcaLevels, tpLadder } = withEnvPatch(pmEnv, () => ({
    baseCfg: loadPaperTraderConfig(),
    dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
  }));

  const combos = buildOracleGrid();
  const abs = path.resolve(journal);
  if (!fs.existsSync(abs)) {
    console.error('journal missing', abs);
    process.exit(1);
  }

  const prep: PrepRow[] = [];
  let skippedBad = 0;
  let skippedOpen = 0;
  let sumActual = 0;

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
    prep.push({
      closedTrade: ct,
      anchors,
      journalExitTs: exitTs,
      entryTs,
      actualNetUsd: net,
      mint: probe.mint,
      symbol: typeof ct.symbol === 'string' ? ct.symbol : '',
    });
  }

  const freqKill = new Map<string, number>();
  const freqStep = new Map<string, number>();
  const freqSell = new Map<string, number>();
  const freqRetr = new Map<string, number>();
  const freqDca = new Map<string, number>();
  const freqTd = new Map<string, number>();
  const freqTx = new Map<string, number>();

  let sumIfEachTradeUsedItsOwnOracle = 0;
  const perTrade: Array<{
    mint: string;
    symbol: string;
    actualNetUsd: number;
    bestSimNetUsd: number;
    bestPatch: Partial<PaperTraderConfig>;
    bestComboId: string;
  }> = [];

  for (const row of prep) {
    let bestNet = -Number.MAX_VALUE;
    let bestPatch: Partial<PaperTraderConfig> = {};
    let bestId = '';
    for (const c of combos) {
      const v = simOneTrade(row, baseCfg, c.patch, dcaLevels, tpLadder, stepMs);
      if (v == null || !Number.isFinite(v)) continue;
      if (v > bestNet) {
        bestNet = v;
        bestPatch = c.patch;
        bestId = c.id;
      }
    }
    sumIfEachTradeUsedItsOwnOracle += bestNet;
    bumpCount(freqKill, String(bestPatch.liveStagedEntryKillDropPct ?? ''));
    bumpCount(freqStep, String(bestPatch.tpGridStepPnl ?? ''));
    bumpCount(freqSell, String(bestPatch.tpGridSellFraction ?? ''));
    bumpCount(freqRetr, String(bestPatch.tpGridFirstRungRetraceMinPnlPct ?? ''));
    bumpCount(freqDca, String(bestPatch.dcaKillstop ?? ''));
    bumpCount(freqTd, String(bestPatch.trailDrop ?? ''));
    bumpCount(freqTx, String(bestPatch.trailTriggerX ?? ''));
    perTrade.push({
      mint: row.mint,
      symbol: row.symbol,
      actualNetUsd: row.actualNetUsd,
      bestSimNetUsd: +bestNet.toFixed(4),
      bestPatch,
      bestComboId: bestId,
    });
  }

  let globalBestSum = -Number.MAX_VALUE;
  let globalBestPatch: Partial<PaperTraderConfig> = {};
  let globalBestId = '';
  for (const c of combos) {
    let s = 0;
    for (const row of prep) {
      const v = simOneTrade(row, baseCfg, c.patch, dcaLevels, tpLadder, stepMs);
      if (v == null || !Number.isFinite(v)) {
        s = -Number.MAX_VALUE;
        break;
      }
      s += v;
    }
    if (s > globalBestSum) {
      globalBestSum = s;
      globalBestPatch = c.patch;
      globalBestId = c.id;
    }
  }

  const baselineSum = prep.reduce((acc, row) => {
    const v = simOneTrade(row, baseCfg, {}, dcaLevels, tpLadder, stepMs);
    return acc + (v ?? 0);
  }, 0);

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  const modeKill = topCounts(freqKill, 1)[0];
  const modeStep = topCounts(freqStep, 1)[0];
  const modeSell = topCounts(freqSell, 1)[0];

  console.log(
    JSON.stringify(
      {
        journal: abs,
        trades: prep.length,
        gridCombos: combos.length,
        sumActualJournalNetUsd: +sumActual.toFixed(2),
        skippedCorrupt: skippedBad,
        skippedNoAnchors: skippedOpen,
        elapsedSec: +elapsedSec,
        noteRu:
          'Цены: PG price_usd от entry до journal exitTs. liveStagedEntryKillDropPct = signal-kill staged-entry (% от цены сигнала). dcaKillstop = стоп по усреднению (доля, отриц.).',
        /** Верхняя граница «если бы на каждой сделке отдельно крутить ручки» — один набор на все сделки так нельзя. */
        sumSimIfEachTradeHadItsOwnBestParams: +sumIfEachTradeUsedItsOwnOracle.toFixed(2),
        /** Один набор параметров на все сделки — максимум суммы sim по сетке. */
        oneSetMaxSumSimNetUsd: +globalBestSum.toFixed(2),
        oneSetMaxComboId: globalBestId,
        oneSetBestParams: {
          liveStagedEntryKillDropPct_signalFromSignalUsd: globalBestPatch.liveStagedEntryKillDropPct,
          tpGridStepPnl: globalBestPatch.tpGridStepPnl,
          tpGridSellFraction: globalBestPatch.tpGridSellFraction,
          tpGridFirstRungRetraceMinPnlPct: globalBestPatch.tpGridFirstRungRetraceMinPnlPct,
          dcaKillstop: globalBestPatch.dcaKillstop,
          trailDrop: globalBestPatch.trailDrop,
          trailTriggerX: globalBestPatch.trailTriggerX,
        },
        baselinePm2ParamsSumSimNetUsd: +baselineSum.toFixed(2),
        perTradeWinnersMostCommon: {
          liveStagedEntryKillDropPct_top5: topCounts(freqKill, 5),
          tpGridStepPnl_top5: topCounts(freqStep, 5),
          tpGridSellFraction_top5: topCounts(freqSell, 5),
          dcaKillstop_top5: topCounts(freqDca, 5),
        },
        /** Частый «модальный» набор по одной оси за раз (не гарантирует совместимость всех осей в одном конфиге). */
        naiveModePerAxis: {
          liveStagedEntryKillDropPct: modeKill,
          tpGridStepPnl: modeStep,
          tpGridSellFraction: modeSell,
        },
        itogOdnoPredlozhenieRu: [
          `Один набор на все ${prep.length} сделки с максимумом суммы sim: signal-kill=${globalBestPatch.liveStagedEntryKillDropPct}%, TP step=${globalBestPatch.tpGridStepPnl}, sell fraction=${globalBestPatch.tpGridSellFraction}, DCA kill=${globalBestPatch.dcaKillstop}, trail drop=${globalBestPatch.trailDrop}, trail trigger=${globalBestPatch.trailTriggerX}. Сумма sim=${globalBestSum.toFixed(2)} USD (журнал fact=${sumActual.toFixed(2)}).`,
          `Если на каждой сделке отдельно выбрать лучший из сетки — сумма sim=${sumIfEachTradeUsedItsOwnOracle.toFixed(2)} USD (верхняя граница; один конфиг так не повторит).`,
          `Чаще всего в «лучшем для этой сделки» попадал signal-kill=${modeKill?.value}% (${modeKill?.trades} сделок), TP step=${modeStep?.value} (${modeStep?.trades}), sell=${modeSell?.value} (${modeSell?.trades}).`,
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
