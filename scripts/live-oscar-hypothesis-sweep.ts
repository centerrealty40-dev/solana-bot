/**
 * Live Oscar — **пробэктест двух явных гипотез** на закрытых сделках + PG `price_usd`:
 *
 * **H_kill_tight** — signal kill staged-entry ближе к цене сигнала (напр. 5% / 10% vs прод).
 * **H_no_grid_tpX** — отключить TP-grid, выход **полным остатком** по `tpX` (напр. +8% к avg).
 * **H_chop** — после **KILLSTOP** ждать кулдаун и снова входить **первой ногой того же USD**,
 *   пока не кончится окно `[entryTs, journalExitTs]` (без «вечного хвоста» после выхода).
 *
 * Якоря PG по умолчанию **только до фактического `exitTs` журнала** (`--extend-past-exit-ms` опционально),
 * чтобы не раздувать PnL фиктивным TIMEOUT после реального закрытия.
 *
 *   npx tsx scripts/live-oscar-hypothesis-sweep.ts --journal data/live/pt1-oscar-live.jsonl
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
import type { ClosedTrade, DexId, Lane, OpenTrade, PositionLeg } from '../src/papertrader/types.js';
import type { ExitReason } from '../src/papertrader/types.js';
import {
  cloneOpenFromJournal,
  priceAt,
  simulateLifecycle,
  type Anchor,
} from '../src/scripts/paper2-strategy-backtest.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const EMPTY_METRICS: OpenTrade['entryMetrics'] = {
  uniqueBuyers: 0,
  uniqueSellers: 0,
  sumBuySol: 0,
  sumSellSol: 0,
  topBuyerShare: 0,
  bcProgress: 0,
};

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

/** Якоря в окне [t0, t1]; если мало точек — возвращаем как есть (simulateLifecycle сам интерполирует). */
function clipAnchors(anchors: Anchor[], t0: number, t1: number): Anchor[] {
  return anchors.filter((a) => a.ts >= t0 && a.ts <= t1);
}

function firstLegUsdFromClosed(ct: Record<string, unknown>): number {
  const legs = ct.legs as PositionLeg[] | undefined;
  const leg0 = legs?.[0];
  if (leg0 && Number.isFinite(leg0.sizeUsd) && leg0.sizeUsd > 0) return leg0.sizeUsd;
  return 0;
}

/** Упрощённый повторный вход: одна нога `legUsd`, staged signal = цена входа, те же пороги доборов/kill из cfg. */
function buildReentryOpen(template: OpenTrade, cfg: PaperTraderConfig, entryTs: number, px: number, legUsd: number): OpenTrade {
  const ot: OpenTrade = {
    mint: template.mint,
    symbol: template.symbol,
    lane: template.lane,
    source: template.source,
    metricType: template.metricType,
    dex: template.dex,
    entryTs,
    entryMcUsd: px,
    entryMetrics: EMPTY_METRICS,
    peakMcUsd: px,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ ts: entryTs, price: px, marketPrice: px, sizeUsd: legUsd, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: legUsd,
    avgEntry: px,
    avgEntryMarket: px,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: template.pairAddress,
    entryLiqUsd: template.entryLiqUsd,
    tokenDecimals: template.tokenDecimals,
    liveKillstopBelowStreak: 0,
  };
  if (cfg.liveStagedEntryEnabled) {
    ot.liveStagedEntry = {
      signalTs: entryTs,
      signalPriceUsd: px,
      firstDropPct: cfg.liveStagedEntryFirstDropPct,
      firstLegUsd: cfg.liveStagedEntryFirstLegUsd,
      secondDropPct: cfg.liveStagedEntrySecondDropPct,
      secondLegUsd: cfg.liveStagedEntrySecondLegUsd,
      thirdDropPct: cfg.liveStagedEntryThirdDropPct,
      thirdLegUsd: cfg.liveStagedEntryThirdLegUsd,
      killDropPct: cfg.liveStagedEntryKillDropPct,
      secondLegDone: false,
      thirdLegDone: false,
    };
  }
  return ot;
}

/**
 * «Чоп»: пока есть время до journalExitTs — после KILLSTOP кулдаун и новый вход первой ногой.
 * Если первый выход не KILLSTOP — одна стандартная симуляция (как обычный counterfactual).
 */
function simulateChopOnAnchors(args: {
  closedTrade: Record<string, unknown>;
  anchors: Anchor[];
  cfg: PaperTraderConfig;
  dcaLevels: ReturnType<typeof parseDcaLevels>;
  tpLadder: ReturnType<typeof parseTpLadder>;
  stepMs: number;
  journalExitTs: number;
  cooldownMs: number;
  maxRounds: number;
}): { totalNetUsd: number; rounds: number; lastExit: ExitReason; skipped: boolean } {
  const { closedTrade, anchors, cfg, dcaLevels, tpLadder, stepMs, journalExitTs, cooldownMs, maxRounds } = args;
  if (anchors.length < 2) return { totalNetUsd: 0, rounds: 0, lastExit: 'TIMEOUT', skipped: true };

  let cum = 0;
  let rounds = 0;
  let lastExit: ExitReason = 'TIMEOUT';
  let tStart = Number((closedTrade as { entryTs?: unknown }).entryTs ?? 0);
  if (!Number.isFinite(tStart) || tStart <= 0) return { totalNetUsd: 0, rounds: 0, lastExit: 'TIMEOUT', skipped: true };

  const legUsd = firstLegUsdFromClosed(closedTrade);
  if (!(legUsd > 0)) return { totalNetUsd: 0, rounds: 0, lastExit: 'TIMEOUT', skipped: true };

  while (rounds < maxRounds && tStart < journalExitTs) {
    let baseOt: OpenTrade;
    try {
      baseOt =
        rounds === 0
          ? cloneOpenFromJournal(closedTrade, cfg)
          : buildReentryOpen(
              cloneOpenFromJournal(closedTrade, cfg),
              cfg,
              tStart,
              priceAt(anchors, tStart),
              legUsd,
            );
    } catch {
      return { totalNetUsd: cum, rounds, lastExit, skipped: true };
    }

    const slice = clipAnchors(anchors, tStart, journalExitTs);
    if (slice.length < 2) break;

    const ct: ClosedTrade | null = simulateLifecycle({
      baseOt,
      anchors: slice,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    if (!ct) break;
    cum += ct.netPnlUsd;
    rounds++;
    lastExit = ct.exitReason;
    const exitTsRound = Number(ct.exitTs);
    if (!Number.isFinite(exitTsRound)) break;

    if (ct.exitReason !== 'KILLSTOP') {
      break;
    }
    tStart = exitTsRound + cooldownMs;
    if (tStart >= journalExitTs) break;
  }

  return { totalNetUsd: cum, rounds, lastExit, skipped: false };
}

type Scenario = { id: string; cfgPatch: Partial<PaperTraderConfig> };

function buildHypothesisScenarios(tpFullPct: number): Scenario[] {
  const tpX = 1 + tpFullPct / 100;
  return [
    { id: 'H0_prod_baseline', cfgPatch: {} },
    { id: 'H1_staged_kill_signal_5pct', cfgPatch: { liveStagedEntryKillDropPct: 5 } },
    { id: 'H2_staged_kill_signal_10pct', cfgPatch: { liveStagedEntryKillDropPct: 10 } },
    {
      id: `H3_no_tp_grid_full_exit_${tpFullPct}pct_avg`,
      cfgPatch: tpAbMirror({
        tpGridStepPnl: 0,
        tpGridSellFraction: 0,
        tpGridFirstRungRetraceMinPnlPct: 0,
        liveExitModeBTpGridStepPnl: 0,
        liveExitModeBTpGridSellFraction: 0,
        liveExitModeBTpGridFirstRungRetraceMinPnlPct: 0,
        tpX: tpX,
        /** Пиковый трейл с недостижимым arm — по сути только TP/kill/timeout. */
        trailMode: 'peak',
        trailTriggerX: 1e6,
        trailDrop: 0.5,
        liveExitModeBTrailTriggerX: 1e6,
        liveExitModeBTrailDrop: 0.5,
      }),
    },
    {
      id: `H4_no_grid_${tpFullPct}pct_plus_kill5`,
      cfgPatch: tpAbMirror({
        tpGridStepPnl: 0,
        tpGridSellFraction: 0,
        tpGridFirstRungRetraceMinPnlPct: 0,
        liveExitModeBTpGridStepPnl: 0,
        liveExitModeBTpGridSellFraction: 0,
        liveExitModeBTpGridFirstRungRetraceMinPnlPct: 0,
        tpX: tpX,
        trailMode: 'peak',
        trailTriggerX: 1e6,
        trailDrop: 0.5,
        liveExitModeBTrailTriggerX: 1e6,
        liveExitModeBTrailDrop: 0.5,
        liveStagedEntryKillDropPct: 5,
      }),
    },
  ];
}

type RowAgg = {
  nSim: number;
  sumNet: number;
  exit: Partial<Record<ExitReason, number>>;
  skipped: number;
};

async function main(): Promise<void> {
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  const stepMs = argNum('--step-ms', 60_000);
  const extendPastExitMs = argNum('--extend-past-exit-ms', 0);
  const tpFullPct = argNum('--tp-full-pct', 8);
  const chopCooldownMin = argNum('--chop-cooldown-min', 5);
  const chopMaxRounds = argNum('--chop-max-rounds', 12);
  const risky = process.argv.includes('--risky');
  const appName = risky ? 'live-oscar-risky' : 'live-oscar';
  const pmEnv = pm2AppPaperEnv(appName);

  const { baseCfg, dcaLevels, tpLadder } = withEnvPatch(pmEnv, () => ({
    baseCfg: loadPaperTraderConfig(),
    dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
  }));

  const scenarios = buildHypothesisScenarios(tpFullPct);
  const cooldownMs = chopCooldownMin * 60_000;

  const prep: Array<{
    closedTrade: Record<string, unknown>;
    anchors: Anchor[];
    actualNetUsd: number;
    journalExitTs: number;
    entryTs: number;
  }> = [];
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
    const anchorEndTs = exitTs + extendPastExitMs;
    const anchors = await fetchPriceAnchorsPg({ mint: probe.mint, source: src, entryTs, endTs: anchorEndTs });
    if (anchors.length < 2) {
      skippedOpen++;
      continue;
    }
    sumActual += net;
    prep.push({ closedTrade: ct, anchors, actualNetUsd: net, journalExitTs: exitTs, entryTs });
  }

  const agg = new Map<string, RowAgg>();
  for (const s of scenarios) {
    agg.set(s.id, { nSim: 0, sumNet: 0, exit: {}, skipped: 0 });
  }

  const chopAgg: RowAgg = { nSim: 0, sumNet: 0, exit: {}, skipped: 0 };
  let chopRoundSum = 0;
  let chopRoundsN = 0;

  for (const row of prep) {
    const anchorsClipped = clipAnchors(row.anchors, row.entryTs, row.journalExitTs);

    for (const s of scenarios) {
      const cfg = mergeCfg(baseCfg, s.cfgPatch);
      let baseOt: OpenTrade;
      try {
        baseOt = cloneOpenFromJournal(row.closedTrade, cfg);
      } catch {
        agg.get(s.id)!.skipped++;
        continue;
      }
      const ct = simulateLifecycle({
        baseOt,
        anchors: anchorsClipped.length >= 2 ? anchorsClipped : row.anchors,
        cfg,
        dcaLevels,
        tpLadder,
        stepMs,
      });
      const a = agg.get(s.id)!;
      if (!ct) {
        a.skipped++;
        continue;
      }
      a.nSim++;
      a.sumNet += ct.netPnlUsd;
      a.exit[ct.exitReason] = (a.exit[ct.exitReason] ?? 0)! + 1;
    }

    const cfgChop = mergeCfg(baseCfg, { liveStagedEntryKillDropPct: 5 });
    const rChop = simulateChopOnAnchors({
      closedTrade: row.closedTrade,
      anchors: row.anchors,
      cfg: cfgChop,
      dcaLevels,
      tpLadder,
      stepMs,
      journalExitTs: row.journalExitTs,
      cooldownMs,
      maxRounds: chopMaxRounds,
    });
    if (!rChop.skipped) {
      chopAgg.nSim++;
      chopAgg.sumNet += rChop.totalNetUsd;
      chopRoundSum += rChop.rounds;
      chopRoundsN++;
      chopAgg.exit[rChop.lastExit] = (chopAgg.exit[rChop.lastExit] ?? 0)! + 1;
    } else chopAgg.skipped++;
  }

  const meanChopRounds = chopRoundsN ? chopRoundSum / chopRoundsN : null;

  const table = scenarios.map((s) => {
    const a = agg.get(s.id)!;
    return {
      scenario: s.id,
      tradesSimulated: a.nSim,
      sumNetPnlUsd: +a.sumNet.toFixed(2),
      deltaVsActualJournalUsd: +(a.sumNet - sumActual).toFixed(2),
      meanNetPnlUsd: a.nSim ? +(a.sumNet / a.nSim).toFixed(3) : null,
      exitMix: a.exit,
      skipped: a.skipped,
    };
  });
  table.sort((a, b) => b.sumNetPnlUsd - a.sumNetPnlUsd);

  const interpretation = [
    'Окно PG: от entry до journal exitTs (+ extend-past-exit-ms). Без продления нет искусственного богатства «после закрытия».',
    `H3/H4: полный выход при xAvg>=${(1 + tpFullPct / 100).toFixed(4)} (≈+${tpFullPct}% к avg), сетка TP отключена (step 0).`,
    `H_chop: staged signal kill 5%, кулдаун ${chopCooldownMin}m после KILLSTOP, до ${chopMaxRounds} кругов; повторный вход — одна нога того же USD, что первая нога в журнале.`,
  ];

  console.log(
    JSON.stringify(
      {
        journal: abs,
        trades: prep.length,
        sumActualClosedNetPnlUsd: +sumActual.toFixed(2),
        skippedCorrupt: skippedBad,
        skippedNoPath: skippedOpen,
        anchorPolicy: {
          extendPastExitMs,
          note: 'Якоря ограничены реальным временем закрытия в журнале (плюс опциональный хвост).',
        },
        chopHypothesis: {
          label: `staged_signal_kill_5pct + re-enter each ${chopCooldownMin}m after KILLSTOP (max ${chopMaxRounds} rounds, first leg only on re-entry)`,
          tradesSimulated: chopAgg.nSim,
          sumNetPnlUsd: +chopAgg.sumNet.toFixed(2),
          deltaVsActualJournalUsd: +(chopAgg.sumNet - sumActual).toFixed(2),
          meanNetPerTradeUsd: chopAgg.nSim ? +(chopAgg.sumNet / chopAgg.nSim).toFixed(3) : null,
          meanRoundsPerTrade: meanChopRounds != null ? +meanChopRounds.toFixed(2) : null,
          lastExitMixAcrossTrades: chopAgg.exit,
          skipped: chopAgg.skipped,
        },
        rankedSinglePassHypotheses: table,
        interpretation,
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
