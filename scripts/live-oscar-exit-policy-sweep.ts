/**
 * Live Oscar — широкий контрфакт по **TP-сетке / staged kill / таймауту / трейлу A**
 * на тех же закрытиях и PG-якорях, что `live-oscar-trail-scenario-sweep.ts`.
 *
 * После правок `simStep` учитываются **режим A/B** (`cfgEffectiveForOpen`), **staged-entry доборы**
 * и **signal kill** vs **DCA kill** + debounce multi-leg — ближе к live, чем ранние симуляции.
 *
 *   npx tsx scripts/live-oscar-exit-policy-sweep.ts --journal data/live/pt1-oscar-live.jsonl --horizon-hours 24 --step-ms 60000
 *
 * `--horizon-hours` держите умеренным (12–24), иначе TIMEOUT на хвосте окна раздувает USD.
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
import type { ExitReason } from '../src/papertrader/types.js';
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

type Scenario = { id: string; cfgPatch: Partial<PaperTraderConfig> };

/** Синхронно дублируем TP A/B и staged-kill пороги, чтобы сценарий применялся и после переключения в B. */
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

function buildScenarios(): Scenario[] {
  return [
    { id: 'S0_prod_baseline', cfgPatch: {} },
    /** Крупнее ступени, меньше срезов — «сидеть в плюсе дольше» */
    { id: 'S1_tp_step5pct_sell8pct', cfgPatch: tpAbMirror({ tpGridStepPnl: 0.05, tpGridSellFraction: 0.08 }) },
    { id: 'S2_tp_step7_5pct_sell12pct', cfgPatch: tpAbMirror({ tpGridStepPnl: 0.075, tpGridSellFraction: 0.12 }) },
    { id: 'S3_tp_step10pct_sell15pct', cfgPatch: tpAbMirror({ tpGridStepPnl: 0.1, tpGridSellFraction: 0.15 }) },
    /** Мельче сетка — контроль к «копеечным» частичкам */
    { id: 'S4_tp_step2pct_sell4pct', cfgPatch: tpAbMirror({ tpGridStepPnl: 0.02, tpGridSellFraction: 0.04 }) },
    /** Жёстче / мягче signal kill (от цены сигнала, staged) */
    { id: 'S5_kill_signal_18pct', cfgPatch: { liveStagedEntryKillDropPct: 18 } },
    { id: 'S6_kill_signal_28pct', cfgPatch: { liveStagedEntryKillDropPct: 28 } },
    { id: 'S7_kill_signal_35pct', cfgPatch: { liveStagedEntryKillDropPct: 35 } },
    /** Таймауты */
    { id: 'S8_timeout_A_12h', cfgPatch: { timeoutHours: 12 } },
    { id: 'S9_timeout_B_3h', cfgPatch: { liveExitModeBTimeoutHours: 3 } },
    /** Трейл режима A чуть шире */
    { id: 'S10_trail_A_drop12_trig108', cfgPatch: { trailDrop: 0.12, trailTriggerX: 1.08 } },
    { id: 'S11_trail_A_drop8_trig105', cfgPatch: { trailDrop: 0.08, trailTriggerX: 1.05 } },
    /** Трейл B */
    { id: 'S12_trail_B_drop10', cfgPatch: { liveExitModeBTrailDrop: 0.1 } },
    { id: 'S13_trail_B_drop15', cfgPatch: { liveExitModeBTrailDrop: 0.15 } },
    /** Комбо: шире TP + мягче signal kill */
    { id: 'S14_combo_wideTp_softKill', cfgPatch: tpAbMirror({ tpGridStepPnl: 0.075, tpGridSellFraction: 0.12, liveStagedEntryKillDropPct: 30 }) },
    /** Комбо: узкий kill + короче B-timeout */
    { id: 'S15_combo_tightKill_shortBto', cfgPatch: { liveStagedEntryKillDropPct: 18, liveExitModeBTimeoutHours: 3 } },
  ];
}

type RowAgg = {
  nSim: number;
  sumNet: number;
  exit: Partial<Record<ExitReason, number>>;
  skippedAnchors: number;
};

async function main(): Promise<void> {
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  const horizonH = argNum('--horizon-hours', 24);
  const stepMs = argNum('--step-ms', 60_000);
  const risky = process.argv.includes('--risky');
  const appName = risky ? 'live-oscar-risky' : 'live-oscar';
  const pmEnv = pm2AppPaperEnv(appName);

  const { baseCfg, dcaLevels, tpLadder } = withEnvPatch(pmEnv, () => ({
    baseCfg: loadPaperTraderConfig(),
    dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
  }));
  const scenarios = buildScenarios();

  const prep: Array<{
    mint: string;
    baseOt: ReturnType<typeof cloneOpenFromJournal>;
    anchors: Anchor[];
    actualNetUsd: number;
  }> = [];
  let skippedOpen = 0;
  let skippedBad = 0;
  let sumActualJournal = 0;

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
    let baseOt: ReturnType<typeof cloneOpenFromJournal>;
    try {
      baseOt = cloneOpenFromJournal(ct, baseCfg);
    } catch {
      skippedOpen++;
      continue;
    }
    const entryTs = baseOt.entryTs;
    const exitTs = Number(ct.exitTs ?? 0);
    if (!Number.isFinite(exitTs) || exitTs <= entryTs) {
      skippedOpen++;
      continue;
    }
    const endTs = exitTs + horizonH * 3_600_000;
    const anchors = await fetchPriceAnchorsPg({ mint: baseOt.mint, source: src, entryTs, endTs });
    if (anchors.length < 2) {
      skippedOpen++;
      continue;
    }
    sumActualJournal += net;
    prep.push({ mint: baseOt.mint, baseOt, anchors, actualNetUsd: net });
  }

  const agg = new Map<string, RowAgg>();
  for (const s of scenarios) {
    agg.set(s.id, { nSim: 0, sumNet: 0, exit: {}, skippedAnchors: 0 });
  }

  for (const row of prep) {
    for (const s of scenarios) {
      const cfg = mergeCfg(baseCfg, s.cfgPatch);
      const ct = simulateLifecycle({
        baseOt: row.baseOt,
        anchors: row.anchors,
        cfg,
        dcaLevels,
        tpLadder,
        stepMs,
      });
      const a = agg.get(s.id)!;
      if (!ct) {
        a.skippedAnchors++;
        continue;
      }
      a.nSim++;
      a.sumNet += ct.netPnlUsd;
      const er = ct.exitReason;
      a.exit[er] = (a.exit[er] ?? 0)! + 1;
    }
  }

  const table = scenarios.map((s) => {
    const a = agg.get(s.id)!;
    return {
      scenario: s.id,
      tradesSimulated: a.nSim,
      sumNetPnlUsd: +a.sumNet.toFixed(2),
      deltaVsActualJournalUsd: +(a.sumNet - sumActualJournal).toFixed(2),
      meanNetPnlUsd: a.nSim ? +(a.sumNet / a.nSim).toFixed(3) : null,
      exitMix: a.exit,
      skippedNullClose: a.skippedAnchors,
    };
  });

  table.sort((a, b) => b.sumNetPnlUsd - a.sumNetPnlUsd);

  console.log(
    JSON.stringify(
      {
        journal: abs,
        tradesWithPgPath: prep.length,
        sumActualClosedNetPnlUsd: +sumActualJournal.toFixed(2),
        skippedCorruptJournal: skippedBad,
        skippedNoAnchorsOrOpen: skippedOpen,
        horizonHoursPastExit: horizonH,
        stepMs,
        pm2PaperEnvApp: appName,
        simNote:
          'Симуляция ближе к live после A/B, staged доборов и signal kill в simStep; сравнивайте deltaVsActualJournalUsd и exitMix. TIMEOUT на длинном horizon раздувает хвост.',
        rankedScenarios: table,
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
