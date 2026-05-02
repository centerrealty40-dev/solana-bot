/**
 * Paper2 strategy backtest: replays exit/DCA/ladder rules on a price path
 * reconstructed from jsonl (open → peak / dca / partial → close), with linear
 * interpolation between observed timestamps.
 *
 * Usage (from repo root, with .env for loadPaperTraderConfig):
 *   npx tsx src/scripts/paper2-strategy-backtest.ts --jsonl data/paper2/pt1-diprunner.jsonl
 *   npx tsx src/scripts/paper2-strategy-backtest.ts --jsonl path.jsonl --grid quick --step-ms 120000
 *   npx tsx src/scripts/paper2-strategy-backtest.ts --jsonl path.jsonl --features-only
 *
 * Limitation: the path is only as dense as journal events; sharp moves between
 * two logs may be missed. Tier-B improvement: densify from pair_snapshots in PG.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';

import type { PaperTraderConfig, DcaLevel, TpLadderLevel } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { applyEntryCosts, applyExitCosts, buildCloseCosts } from '../papertrader/costs.js';
import type { ClosedTrade, DexId, ExitReason, Lane, OpenTrade, PartialSell, PositionLeg } from '../papertrader/types.js';
import {
  dcaCrossedDownward,
  dcaEffPrev,
  dcaStepOrTriggerTaken,
  markDcaStepFired,
} from '../papertrader/executor/dca-state.js';
import {
  ladderStepOrThresholdTaken,
  markLadderStepFired,
} from '../papertrader/executor/tp-ladder-state.js';

const EMPTY_METRICS: OpenTrade['entryMetrics'] = {
  uniqueBuyers: 0,
  uniqueSellers: 0,
  sumBuySol: 0,
  sumSellSol: 0,
  topBuyerShare: 0,
  bcProgress: 0,
};

interface Anchor {
  ts: number;
  p: number;
}

interface Lifecycle {
  mint: string;
  open: Record<string, unknown>;
  close: Record<string, unknown>;
  /** Chronological journal rows from open through close (inclusive). */
  events: Record<string, unknown>[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

function priceAt(anchors: Anchor[], t: number): number {
  if (anchors.length === 0) return 0;
  if (t <= anchors[0].ts) return anchors[0].p;
  const last = anchors[anchors.length - 1];
  if (t >= last.ts) return last.p;
  let i = 1;
  while (i < anchors.length && anchors[i].ts < t) i++;
  const a = anchors[i - 1];
  const b = anchors[i];
  const w = (t - a.ts) / (b.ts - a.ts);
  return a.p + w * (b.p - a.p);
}

function totalProceedsNet(ot: OpenTrade): number {
  return ot.partialSells.reduce((s, p) => s + (p.proceedsUsd || 0), 0);
}
function totalProceedsGross(ot: OpenTrade): number {
  return ot.partialSells.reduce((s, p) => s + (p.grossProceedsUsd || 0), 0);
}

function buildClosedTradeSim(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  marketSell: number;
  effectiveSell: number;
  exitReason: ExitReason;
  ageH: number;
  exitTs: number;
}): ClosedTrade {
  const { cfg, ot, marketSell, effectiveSell, exitReason, ageH, exitTs } = args;
  let finalProceeds = 0;
  let finalGrossProceeds = 0;
  if (ot.remainingFraction > 1e-6 && marketSell > 0) {
    finalProceeds = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
    finalGrossProceeds = ot.totalInvestedUsd * ot.remainingFraction * (marketSell / ot.avgEntryMarket);
  }
  const totalProceedsUsd = totalProceedsNet(ot) + finalProceeds;
  const grossTotalProceedsUsd = totalProceedsGross(ot) + finalGrossProceeds;
  const netPnlUsd = totalProceedsUsd - ot.totalInvestedUsd;
  const grossPnlUsd = grossTotalProceedsUsd - ot.totalInvestedUsd;
  const totalPnlPct = ot.totalInvestedUsd > 0 ? (netPnlUsd / ot.totalInvestedUsd) * 100 : 0;
  const grossPnlPct = ot.totalInvestedUsd > 0 ? (grossPnlUsd / ot.totalInvestedUsd) * 100 : 0;
  const networkFeeUsdTotal = (ot.legs.length + ot.partialSells.length + 1) * cfg.networkFeeUsd;
  const costs = buildCloseCosts({
    cfg,
    trade: ot,
    exit: { effectivePrice: effectiveSell, marketPrice: marketSell },
    networkFeeUsdTotal,
    slipDynamicBpsEntry: 0,
    slipDynamicBpsExit: 0,
    netPnlUsd,
    grossPnlUsd,
  });
  const firstLeg: PositionLeg | undefined = ot.legs[0];
  return {
    ...ot,
    exitTs,
    exitMcUsd: marketSell,
    exitReason,
    pnlPct: totalPnlPct,
    durationMin: ageH * 60,
    totalProceedsUsd,
    netPnlUsd,
    grossTotalProceedsUsd,
    grossPnlUsd,
    grossPnlPct,
    costs,
    effective_entry_price: ot.avgEntry,
    effective_exit_price: effectiveSell,
    theoretical_entry_price: firstLeg ? firstLeg.marketPrice : ot.avgEntryMarket,
    theoretical_exit_price: marketSell,
  };
}

function cloneOpenFromJournal(open: Record<string, unknown>): OpenTrade {
  const legs = open.legs as PositionLeg[] | undefined;
  const leg0 = legs?.[0];
  if (!leg0) throw new Error('open event missing legs[0]');
  const dex = (open.dex as DexId) || 'raydium';
  const entryTs = Number(open.entryTs);
  const mkt = Number(leg0.marketPrice ?? open.entryMarketPrice ?? open.entryMcUsd ?? leg0.price);
  const feat = open.features as { pair_address?: unknown; liq_usd?: unknown } | undefined;
  const pairRaw = open.pairAddress ?? feat?.pair_address;
  const pairAddress =
    pairRaw != null && String(pairRaw).trim() ? String(pairRaw).trim() : null;
  const entryLiqRaw = open.entryLiqUsd ?? feat?.liq_usd;
  const entryLiqUsd =
    typeof entryLiqRaw === 'number' && Number(entryLiqRaw) > 0 ? Number(entryLiqRaw) : null;
  return {
    mint: String(open.mint),
    symbol: String(open.symbol ?? ''),
    lane: (open.lane as Lane) || 'post_migration',
    source: open.source as string | undefined,
    metricType: (open as { metricType?: 'mc' | 'price' }).metricType ?? 'price',
    dex,
    entryTs,
    entryMcUsd: Number(open.entryMcUsd ?? leg0.price),
    entryMetrics: EMPTY_METRICS,
    peakMcUsd: mkt,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ ...leg0, ts: entryTs }],
    partialSells: [],
    totalInvestedUsd: leg0.sizeUsd,
    avgEntry: leg0.price,
    avgEntryMarket: leg0.marketPrice ?? leg0.price,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress,
    entryLiqUsd,
  };
}

function anchorsFromEvents(events: Record<string, unknown>[]): Anchor[] {
  const raw: Anchor[] = [];
  for (const e of events) {
    const kind = e.kind as string;
    if (kind === 'open') {
      const legs = e.legs as PositionLeg[] | undefined;
      const p = Number(legs?.[0]?.marketPrice ?? e.entryMarketPrice ?? e.entryMcUsd ?? 0);
      raw.push({ ts: Number(e.entryTs), p });
    } else if (kind === 'peak') {
      raw.push({ ts: Number(e.ts), p: Number(e.peakMcUsd) });
    } else if (kind === 'dca_add') {
      raw.push({ ts: Number(e.ts), p: Number(e.marketPrice) });
    } else if (kind === 'partial_sell') {
      raw.push({ ts: Number(e.ts), p: Number(e.marketPrice) });
    } else if (kind === 'close') {
      const p = Number(e.exit_market_price ?? e.exitMcUsd ?? e.theoretical_exit_price ?? 0);
      raw.push({ ts: Number(e.ts), p });
    }
  }
  raw.sort((a, b) => a.ts - b.ts);
  const merged: Anchor[] = [];
  for (const a of raw) {
    if (!Number.isFinite(a.p) || a.p <= 0) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.ts === a.ts) prev.p = a.p;
    else merged.push({ ...a });
  }
  return merged;
}

interface SimResult {
  closed: ClosedTrade | null;
  exitReason: ExitReason | 'OPEN' | 'NO_DATA';
}

/**
 * One synchronous tracker step — mirrors `tracker.ts` order (minus network / appendEvent).
 */
function simStep(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  curMetric: number;
  virtualNow: number;
  dcaLevels: DcaLevel[];
  tpLadder: TpLadderLevel[];
  peakLog: { lastPersistedPeak: number };
}): SimResult {
  const { cfg, ot, curMetric, virtualNow, dcaLevels, tpLadder, peakLog } = args;

  const ageH = (virtualNow - ot.entryTs) / 3_600_000;

  if (!(curMetric > 0)) {
    if (ageH > cfg.timeoutHours) {
      const ct = buildClosedTradeSim({
        cfg,
        ot,
        marketSell: 0,
        effectiveSell: 0,
        exitReason: 'NO_DATA',
        ageH,
        exitTs: virtualNow,
      });
      return { closed: ct, exitReason: 'NO_DATA' };
    }
    return { closed: null, exitReason: 'OPEN' };
  }

  const firstPrice = ot.legs[0]?.price || ot.entryMcUsd;
  const dropFromFirstPct = curMetric / firstPrice - 1;
  const xAvg = curMetric / ot.avgEntry;
  const pnlPctVsAvg = (xAvg - 1) * 100;

  if (curMetric > ot.peakMcUsd) {
    const wasArmed = ot.trailingArmed;
    ot.peakMcUsd = curMetric;
    ot.peakPnlPct = pnlPctVsAvg;
    if (xAvg >= cfg.trailTriggerX) ot.trailingArmed = true;
    if ((!wasArmed && ot.trailingArmed) || pnlPctVsAvg >= peakLog.lastPersistedPeak + cfg.peakLogStepPct) {
      peakLog.lastPersistedPeak = pnlPctVsAvg;
    }
  }

  if ((dcaLevels.length > 0 || cfg.dcaKillstop < 0) && ot.remainingFraction > 0) {
    const effPrevDrop = dcaEffPrev(ot);
    for (let dcaIdx = 0; dcaIdx < dcaLevels.length; dcaIdx++) {
      const lvl = dcaLevels[dcaIdx]!;
      if (dcaStepOrTriggerTaken(ot, dcaIdx, lvl.triggerPct)) continue;
      if (!dcaCrossedDownward(effPrevDrop, dropFromFirstPct, lvl.triggerPct)) continue;
      const addUsd = cfg.positionUsd * lvl.addFraction;
      const marketBuy = curMetric;
      const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);
      ot.legs.push({
        ts: virtualNow,
        price: effectiveBuy,
        marketPrice: marketBuy,
        sizeUsd: addUsd,
        reason: 'dca',
        triggerPct: lvl.triggerPct,
      });
      ot.totalInvestedUsd += addUsd;
      const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
      ot.avgEntry = num / ot.totalInvestedUsd;
      const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
      ot.avgEntryMarket = numM / ot.totalInvestedUsd;
      markDcaStepFired(ot, dcaIdx, lvl.triggerPct);
      ot.remainingFraction = 1;
      if (curMetric > ot.peakMcUsd) ot.peakMcUsd = curMetric;
      ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
      ot.trailingArmed = ot.trailingArmed && curMetric / ot.avgEntry >= cfg.trailTriggerX;
    }
  }

  /** Ladder threshold matches live `tracker.ts`: uses `xAvg` from tick start (before DCA), while sizing uses post-DCA `ot`. */
  if (tpLadder.length > 0 && ot.remainingFraction > 0) {
    for (let stepIdx = 0; stepIdx < tpLadder.length; stepIdx++) {
      const lvl = tpLadder[stepIdx]!;
      if (ladderStepOrThresholdTaken(ot, stepIdx, lvl.pnlPct)) continue;
      if (xAvg - 1 >= lvl.pnlPct) {
        const sellFraction = Math.min(1, lvl.sellFraction);
        const marketSell = curMetric;
        const investedSoldUsd = ot.totalInvestedUsd * ot.remainingFraction * sellFraction;
        const { effectivePrice: effectiveSell } = applyExitCosts(cfg, marketSell, ot.dex, investedSoldUsd, null);
        const remainingValueNet = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
        const proceedsUsd = remainingValueNet * sellFraction;
        const remainingValueGross =
          ot.totalInvestedUsd * ot.remainingFraction * (marketSell / ot.avgEntryMarket);
        const grossProceedsUsd = remainingValueGross * sellFraction;
        const pnlUsd = proceedsUsd - investedSoldUsd;
        const grossPnlUsd = grossProceedsUsd - investedSoldUsd;
        const ps: PartialSell = {
          ts: virtualNow,
          price: effectiveSell,
          marketPrice: marketSell,
          sellFraction,
          reason: 'TP_LADDER',
          proceedsUsd,
          grossProceedsUsd,
          pnlUsd,
          grossPnlUsd,
        };
        ot.partialSells.push(ps);
        ot.remainingFraction *= 1 - sellFraction;
        markLadderStepFired(ot, stepIdx, lvl.pnlPct);
      }
    }
  }

  const xAvgExit = curMetric / ot.avgEntry;
  const pnlPctVsAvgExit = (xAvgExit - 1) * 100;
  let exitReason: ExitReason | null = null;
  if (cfg.dcaKillstop < 0 && pnlPctVsAvgExit / 100 <= cfg.dcaKillstop) exitReason = 'KILLSTOP';
  else if (xAvgExit >= cfg.tpX) exitReason = 'TP';
  else if (cfg.slX > 0 && xAvgExit <= cfg.slX) exitReason = 'SL';
  else if (ot.trailingArmed && curMetric <= ot.peakMcUsd * (1 - cfg.trailDrop)) exitReason = 'TRAIL';
  else if (ageH >= cfg.timeoutHours) exitReason = 'TIMEOUT';
  if (!exitReason && ot.remainingFraction <= 1e-6) exitReason = 'TP';

  if (exitReason) {
    const marketSell = curMetric;
    const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
    const { effectivePrice: effectiveSell } = applyExitCosts(
      cfg,
      marketSell,
      ot.dex,
      Math.max(1, investedRemaining),
      null,
    );
    const ct = buildClosedTradeSim({
      cfg,
      ot,
      marketSell,
      effectiveSell,
      exitReason,
      ageH,
      exitTs: virtualNow,
    });
    return { closed: ct, exitReason };
  }

  if (curMetric > 0 && Number.isFinite(dropFromFirstPct)) {
    ot.dcaLastEvalDropFromFirstPct = dropFromFirstPct;
  }
  return { closed: null, exitReason: 'OPEN' };
}

function deepCloneOpen(ot: OpenTrade): OpenTrade {
  return {
    ...ot,
    legs: ot.legs.map((l) => ({ ...l })),
    partialSells: ot.partialSells.map((p) => ({ ...p })),
    dcaUsedLevels: new Set(ot.dcaUsedLevels),
    dcaUsedIndices: new Set(ot.dcaUsedIndices),
    ladderUsedLevels: new Set(ot.ladderUsedLevels),
    ladderUsedIndices: new Set(ot.ladderUsedIndices),
    dcaLastEvalDropFromFirstPct: ot.dcaLastEvalDropFromFirstPct,
    entryMetrics: { ...ot.entryMetrics },
  };
}

function simulateLifecycle(args: {
  baseOt: OpenTrade;
  anchors: Anchor[];
  cfg: PaperTraderConfig;
  dcaLevels: DcaLevel[];
  tpLadder: TpLadderLevel[];
  stepMs: number;
}): ClosedTrade | null {
  const { baseOt, anchors, cfg, dcaLevels, tpLadder, stepMs } = args;
  const ot = deepCloneOpen(baseOt);
  const peakLog = { lastPersistedPeak: -Infinity };
  const lastAnchorTs = anchors.length ? anchors[anchors.length - 1].ts : baseOt.entryTs;

  for (let t = ot.entryTs; t <= lastAnchorTs + stepMs; t += stepMs) {
    const curMetric = priceAt(anchors, t);
    const r = simStep({ cfg, ot, curMetric, virtualNow: t, dcaLevels, tpLadder, peakLog });
    if (r.closed) return r.closed;
  }

  // Force close at end of path if still open (label TIMEOUT at last price).
  const finalT = lastAnchorTs;
  const curMetric = priceAt(anchors, finalT);
  const ageH = (finalT - ot.entryTs) / 3_600_000;
  if (curMetric > 0) {
    const marketSell = curMetric;
    const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
    const { effectivePrice: effectiveSell } = applyExitCosts(
      cfg,
      marketSell,
      ot.dex,
      Math.max(1, investedRemaining),
      null,
    );
    return buildClosedTradeSim({
      cfg,
      ot,
      marketSell,
      effectiveSell,
      exitReason: 'TIMEOUT',
      ageH,
      exitTs: finalT,
    });
  }
  return buildClosedTradeSim({
    cfg,
    ot,
    marketSell: 0,
    effectiveSell: 0,
    exitReason: 'NO_DATA',
    ageH,
    exitTs: finalT,
  });
}

async function readLifecycles(jsonlPath: string): Promise<Lifecycle[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  const byMint = new Map<string, Record<string, unknown>[]>();
  const completed: Lifecycle[] = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = e.kind as string | undefined;
    const mint = e.mint as string | undefined;
    if (!kind || !mint) continue;

    if (kind === 'open') {
      byMint.set(mint, [e]);
      continue;
    }

    const buf = byMint.get(mint);
    if (!buf) continue;
    buf.push(e);

    if (kind === 'close') {
      const openEv = buf[0];
      if ((openEv.kind as string) !== 'open') {
        byMint.delete(mint);
        continue;
      }
      completed.push({ mint, open: openEv, close: e, events: [...buf] });
      byMint.delete(mint);
    }
  }

  return completed;
}

async function main(): Promise<void> {
  const jsonlPath = arg('--jsonl');
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    console.error(
      'Usage: tsx src/scripts/paper2-strategy-backtest.ts --jsonl <path.jsonl> [--grid quick|medium|dno] [--step-ms N] [--features-only] [--no-dca] [--bucket-dip]',
    );
    process.exit(1);
  }

  const gridMode = arg('--grid') ?? 'quick';
  const stepMs = Number(arg('--step-ms') ?? 120_000);
  const featuresOnly = flag('--features-only');
  const noDca = flag('--no-dca');
  const bucketDip = flag('--bucket-dip');

  let cfg: PaperTraderConfig;
  try {
    cfg = loadPaperTraderConfig();
  } catch (err) {
    console.error('loadPaperTraderConfig failed — ensure .env matches schema:', (err as Error).message);
    process.exit(1);
  }

  const lifecycles = await readLifecycles(jsonlPath);
  if (lifecycles.length === 0) {
    console.error('No complete open→close lifecycles found in file.');
    process.exit(1);
  }

  const dcaLevels = noDca ? [] : parseDcaLevels(process.env.PAPER_DCA_LEVELS);
  const tpLadder = parseTpLadder(process.env.PAPER_TP_LADDER);
  if (noDca) console.log('\n(--no-dca) DCA levels cleared; PAPER_DCA_KILLSTOP still applies if set in env.');

  /* ----- Actual PnL + feature correlation (from journal closes) ----- */
  const rows: { dip: number | null; impulse: number | null; liq: number | null; vol5m: number | null; net: number }[] =
    [];
  for (const lc of lifecycles) {
    const feat = lc.open.features as Record<string, unknown> | undefined;
    const dip = feat?.dip_pct != null ? Number(feat.dip_pct) : null;
    const impulse = feat?.impulse_pct != null ? Number(feat.impulse_pct) : null;
    const liq = feat?.liq_usd != null ? Number(feat.liq_usd) : null;
    const vol5m = feat?.vol5m_usd != null ? Number(feat.vol5m_usd) : null;
    const net = Number(lc.close.netPnlUsd ?? 0);
    rows.push({ dip, impulse, liq, vol5m, net });
  }

  const dips = rows.map((r) => r.dip).filter((x): x is number => x != null && Number.isFinite(x));
  const qs = (arr: number[]): number[] => {
    const s = [...arr].sort((a, b) => a - b);
    if (s.length === 0) return [0, 0, 0];
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    return [q(0.25), q(0.5), q(0.75)];
  };
  const dipQs = qs(dips);

  console.log('\n=== Journal summary ===');
  console.log(`Lifecycles: ${lifecycles.length}`);
  const sumActual = rows.reduce((s, r) => s + r.net, 0);
  console.log(`Sum actual netPnlUsd (from closes): ${sumActual.toFixed(2)}`);

  console.log('\n=== Entry features vs actual net PnL (by dip_pct quartile) ===');
  for (let qi = 0; qi < 4; qi++) {
    const lo = qi === 0 ? -Infinity : dipQs[qi - 1];
    const hi = qi === 3 ? Infinity : dipQs[qi];
    const bucket = rows.filter((r) => r.dip != null && r.dip > lo && r.dip <= hi);
    const mean = bucket.length ? bucket.reduce((s, r) => s + r.net, 0) / bucket.length : 0;
    const loS = qi === 0 ? '-inf' : lo.toFixed(3);
    const hiS = qi === 3 ? 'inf' : hi.toFixed(3);
    console.log(`  dip Q${qi + 1} (${loS} .. ${hiS}): n=${bucket.length} mean_net=${mean.toFixed(2)}`);
  }

  if (featuresOnly) return;

  /* ----- Baseline sim (current cfg) ----- */
  let baseSum = 0;
  let baseWins = 0;
  const simRows: { dip: number | null; net: number }[] = [];
  for (const lc of lifecycles) {
    const anchors = anchorsFromEvents(lc.events);
    if (anchors.length < 2) continue;
    const baseOt = cloneOpenFromJournal(lc.open);
    const ct = simulateLifecycle({
      baseOt,
      anchors,
      cfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    if (ct) {
      baseSum += ct.netPnlUsd;
      if (ct.netPnlUsd > 0) baseWins++;
      const feat = lc.open.features as Record<string, unknown> | undefined;
      const dip = feat?.dip_pct != null ? Number(feat.dip_pct) : null;
      simRows.push({ dip, net: ct.netPnlUsd });
    }
  }
  console.log('\n=== Baseline sim (env cfg, interpolated path) ===');
  console.log(`Sum counterfactual netPnlUsd: ${baseSum.toFixed(2)}  wins: ${baseWins}/${lifecycles.length}`);

  if (bucketDip) {
    console.log('\n=== Baseline sim vs dip_pct quartile (same cutoffs as journal table) ===');
    for (let qi = 0; qi < 4; qi++) {
      const lo = qi === 0 ? -Infinity : dipQs[qi - 1];
      const hi = qi === 3 ? Infinity : dipQs[qi];
      const bucket = simRows.filter((r) => r.dip != null && Number.isFinite(r.dip) && r.dip > lo && r.dip <= hi);
      const mean = bucket.length ? bucket.reduce((s, r) => s + r.net, 0) / bucket.length : 0;
      const loS = qi === 0 ? '-inf' : lo.toFixed(3);
      const hiS = qi === 3 ? 'inf' : hi.toFixed(3);
      console.log(`  dip Q${qi + 1} (${loS} .. ${hiS}): n=${bucket.length} mean_sim_net=${mean.toFixed(2)}`);
    }
  }

  /* ----- Grid search ----- */
  const gridQuick = {
    tpX: [2.0, 2.5, 3.0],
    slX: [0.55, 0.65, 0.75],
    trailTriggerX: [1.12, 1.18, 1.25],
    trailDrop: [0.18, 0.22, 0.28],
    timeoutHours: [18, 36],
    dcaKillstop: [-0.5, -0.62],
  };
  const gridMedium = {
    tpX: [1.8, 2.2, 2.6, 3.2],
    slX: [0.5, 0.6, 0.7, 0.8],
    trailTriggerX: [1.1, 1.15, 1.2, 1.3],
    trailDrop: [0.15, 0.2, 0.25, 0.3],
    timeoutHours: [12, 24, 48],
    dcaKillstop: [-0.45, -0.55, -0.65],
  };
  /** Tighter TP/SL/trail/timeouts around `pt1-dno` production (no DCA / optional killstop). */
  const gridDno = {
    tpX: [1.2, 1.5, 1.8, 2.2],
    slX: [0, 0.7, 0.8, 0.9],
    trailTriggerX: [1.03, 1.05, 1.1, 1.15],
    trailDrop: [0.04, 0.07, 0.1, 0.15],
    timeoutHours: [0.5, 1, 2, 4],
    dcaKillstop: [0, -0.4, -0.55],
  };
  const G = gridMode === 'medium' ? gridMedium : gridMode === 'dno' ? gridDno : gridQuick;

  type Best = { sum: number; params: Record<string, number> };
  let best: Best = { sum: -Infinity, params: {} };
  let count = 0;

  for (const tpX of G.tpX) {
    for (const slX of G.slX) {
      for (const trailTriggerX of G.trailTriggerX) {
        for (const trailDrop of G.trailDrop) {
          for (const timeoutHours of G.timeoutHours) {
            for (const dcaKillstop of G.dcaKillstop) {
              count++;
              const trialCfg: PaperTraderConfig = {
                ...cfg,
                tpX,
                slX,
                trailTriggerX,
                trailDrop,
                timeoutHours,
                dcaKillstop,
              };
              let sum = 0;
              for (const lc of lifecycles) {
                const anchors = anchorsFromEvents(lc.events);
                if (anchors.length < 2) continue;
                const baseOt = cloneOpenFromJournal(lc.open);
                const ct = simulateLifecycle({
                  baseOt,
                  anchors,
                  cfg: trialCfg,
                  dcaLevels,
                  tpLadder,
                  stepMs,
                });
                if (ct) sum += ct.netPnlUsd;
              }
              if (sum > best.sum) best = { sum, params: { tpX, slX, trailTriggerX, trailDrop, timeoutHours, dcaKillstop } };
            }
          }
        }
      }
    }
  }

  console.log(`\n=== Grid (${gridMode}) evaluated ${count} combos ===`);
  console.log('Best sum counterfactual netPnlUsd:', best.sum.toFixed(2));
  console.log('Best params:', JSON.stringify(best.params, null, 2));
  console.log('\nNote: ladder/DCA specs follow PAPER_DCA_LEVELS / PAPER_TP_LADDER from env; extend script to grid those strings if needed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
