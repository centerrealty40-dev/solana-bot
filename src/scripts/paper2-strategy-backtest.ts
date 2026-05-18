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
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

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
  liveStagedEntrySignalTimeWindowOpen,
  liveStagedEntrySignalTtlExpired,
} from '../papertrader/executor/live-staged-entry-gates.js';
import {
  dcaKillstopEffective,
  tpGridEffective,
} from '../papertrader/executor/tp-grid-effective.js';
import { cfgEffectiveForOpen } from '../papertrader/cfg-effective-for-open.js';
import {
  LADDER_PNL_EPS,
  ladderPnlThresholdMark,
  ladderPnlThresholdTaken,
  ladderRetraceTriggeredWithSpec,
  ladderStepOrThresholdTaken,
  markLadderStepFired,
  type LadderRetraceSpec,
} from '../papertrader/executor/tp-ladder-state.js';

const EMPTY_METRICS: OpenTrade['entryMetrics'] = {
  uniqueBuyers: 0,
  uniqueSellers: 0,
  sumBuySol: 0,
  sumSellSol: 0,
  topBuyerShare: 0,
  bcProgress: 0,
};

export interface Anchor {
  ts: number;
  p: number;
}

export interface JournalLifecycle {
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

export function priceAt(anchors: Anchor[], t: number): number {
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

/** Instant full exit at `marketSell` (no partials) — for oracle / hold-thesis probes vs PG path. */
export function oracleFullExitNetPnlUsd(cfg: PaperTraderConfig, ot: OpenTrade, marketSell: number): number {
  const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
  if (investedRemaining <= 1e-9 || marketSell <= 0) return 0;
  const { effectivePrice: effectiveSell } = applyExitCosts(
    cfg,
    marketSell,
    ot.dex,
    Math.max(1, investedRemaining),
    ot.entryLiqUsd,
  );
  const finalProceeds = investedRemaining * (effectiveSell / ot.avgEntry);
  return finalProceeds - ot.totalInvestedUsd;
}

export function cloneOpenFromJournal(open: Record<string, unknown>, cfg?: PaperTraderConfig): OpenTrade {
  const legsRaw = (open.legs as PositionLeg[] | undefined) ?? [];
  const leg0 = legsRaw[0];
  if (!leg0) throw new Error('open event missing legs[0]');
  const dex = (open.dex as DexId) || 'raydium';
  const entryTs = Number(open.entryTs);
  const legsAtEntry = legsRaw.filter((l) => Number(l.ts) <= entryTs);
  const legsInit = legsAtEntry.length > 0 ? legsAtEntry : [leg0];
  const totalInvestedUsd = legsInit.reduce((s, l) => s + l.sizeUsd, 0);
  const numPx = legsInit.reduce((s, l) => s + l.sizeUsd * l.price, 0);
  const numMkt = legsInit.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
  const avgEntry = totalInvestedUsd > 0 ? numPx / totalInvestedUsd : leg0.price;
  const avgEntryMarket = totalInvestedUsd > 0 ? numMkt / totalInvestedUsd : (leg0.marketPrice ?? leg0.price);
  const mkt = Number(legsInit[0]!.marketPrice ?? open.entryMarketPrice ?? open.entryMcUsd ?? legsInit[0]!.price);
  const feat = open.features as { pair_address?: unknown; liq_usd?: unknown } | undefined;
  const pairRaw = open.pairAddress ?? feat?.pair_address;
  const pairAddress =
    pairRaw != null && String(pairRaw).trim() ? String(pairRaw).trim() : null;
  const entryLiqRaw = open.entryLiqUsd ?? feat?.liq_usd;
  const entryLiqUsd =
    typeof entryLiqRaw === 'number' && Number(entryLiqRaw) > 0 ? Number(entryLiqRaw) : null;
  const ot: OpenTrade = {
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
    legs: legsInit.map((l) => ({ ...l })),
    partialSells: [],
    totalInvestedUsd,
    avgEntry,
    avgEntryMarket,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress,
    entryLiqUsd,
    liveKillstopBelowStreak: 0,
  };
  if (typeof open.tokenDecimals === 'number' && Number.isFinite(open.tokenDecimals)) {
    ot.tokenDecimals = open.tokenDecimals;
  }
  const tpR = open.tpRegime as OpenTrade['tpRegime'] | undefined;
  if (tpR) ot.tpRegime = tpR;
  const tpGo = open.tpGridOverrides as OpenTrade['tpGridOverrides'] | undefined;
  if (tpGo && typeof tpGo === 'object') ot.tpGridOverrides = { ...tpGo };
  const tpRf = open.tpRegimeFeatures as OpenTrade['tpRegimeFeatures'] | undefined;
  if (tpRf && typeof tpRf === 'object') ot.tpRegimeFeatures = { ...tpRf };

  if (cfg?.liveStagedEntryEnabled && cfg.strategyId === 'live-oscar') {
    const l0 = legsInit[0]!;
    ot.liveStagedEntry = {
      signalTs: entryTs,
      signalPriceUsd: Number(l0.marketPrice ?? l0.price),
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

  if (!(cfg?.strategyId === 'live-oscar' && cfg.liveExitModeAbEnabled)) {
    const mode = open.liveExitProfileMode as OpenTrade['liveExitProfileMode'] | undefined;
    if (mode === 'A' || mode === 'B') ot.liveExitProfileMode = mode;
  }

  return ot;
}

export function anchorsFromJournalEvents(events: Record<string, unknown>[]): Anchor[] {
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

function liveStagedEntrySignalDropPctSim(ot: OpenTrade, curMetric: number): number | null {
  const st = ot.liveStagedEntry;
  if (!st || !(st.signalPriceUsd > 0) || !(curMetric > 0)) return null;
  return (curMetric / st.signalPriceUsd - 1) * 100;
}

function liveStagedEntryKillHitSim(ot: OpenTrade, curMetric: number): boolean {
  const st = ot.liveStagedEntry;
  if (!st || !(st.killDropPct > 0)) return false;
  const d = liveStagedEntrySignalDropPctSim(ot, curMetric);
  return d != null && d <= -st.killDropPct;
}

/** Синхронный staged-entry (2–3 ноги) как в `tracker.ts`, без Jupiter. */
function simTryLiveStagedEntryAdds(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  curMetric: number;
  virtualNow: number;
}): void {
  const { cfg, ot, curMetric, virtualNow } = args;
  if (!cfg.liveStagedEntryEnabled || !ot.liveStagedEntry || ot.remainingFraction <= 0) return;
  if (liveStagedEntryKillHitSim(ot, curMetric)) return;
  const st = ot.liveStagedEntry;
  const signalDropPct = liveStagedEntrySignalDropPctSim(ot, curMetric);
  const tpLadderPartials = ot.partialSells.filter((p) => p.reason === 'TP_LADDER').length;
  const hasThird = (st.thirdLegUsd ?? 0) > 0;
  const thirdDone = hasThird ? st.thirdLegDone === true : true;
  const pendingStagedLegs = !st.secondLegDone || !thirdDone;
  const timeWindowOpen = liveStagedEntrySignalTimeWindowOpen(cfg, st.signalTs, virtualNow);
  const stagedAddWindowOpen =
    timeWindowOpen || (tpLadderPartials >= 1 && tpLadderPartials < 2 && pendingStagedLegs);
  const stagedAddAllowed = stagedAddWindowOpen && tpLadderPartials < 2;

  function pushStagedLeg(stepIndex: number, addUsd: number, dropPct: number): void {
    const marketBuy = curMetric;
    const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);
    ot.legs.push({
      ts: virtualNow,
      price: effectiveBuy,
      marketPrice: marketBuy,
      sizeUsd: addUsd,
      reason: 'dca',
      triggerPct: -dropPct / 100,
    });
    ot.livePendingScaleIn = null;
    ot.liveKillstopBelowStreak = 0;
    ot.totalInvestedUsd += addUsd;
    const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
    ot.avgEntry = num / ot.totalInvestedUsd;
    const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
    ot.avgEntryMarket = numM / ot.totalInvestedUsd;
    markDcaStepFired(ot, stepIndex, -dropPct / 100);
    ot.remainingFraction = 1;
    if (curMetric > ot.peakMcUsd) ot.peakMcUsd = curMetric;
    ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
    const effX = cfgEffectiveForOpen(cfg, ot);
    ot.trailingArmed = ot.trailingArmed && curMetric / ot.avgEntry >= effX.trailTriggerX;
    if (cfg.liveExitModeAbEnabled) ot.liveExitProfileMode = 'B';
  }

  if (
    signalDropPct != null &&
    stagedAddAllowed &&
    !st.secondLegDone &&
    signalDropPct <= -st.secondDropPct
  ) {
    pushStagedLeg(0, st.secondLegUsd, st.secondDropPct);
    st.secondLegDone = true;
  }
  if (
    signalDropPct != null &&
    stagedAddAllowed &&
    st.secondLegDone &&
    !st.thirdLegDone &&
    st.thirdLegUsd != null &&
    st.thirdLegUsd > 0 &&
    st.thirdDropPct != null &&
    signalDropPct <= -st.thirdDropPct
  ) {
    pushStagedLeg(1, st.thirdLegUsd, st.thirdDropPct);
    st.thirdLegDone = true;
  }

  const stagedLegsComplete = st.secondLegDone === true && thirdDone;
  const ttlExpired = liveStagedEntrySignalTtlExpired(cfg, st.signalTs, virtualNow);
  const ttlPreservesStagedPlan =
    tpLadderPartials >= 1 && tpLadderPartials < 2 && pendingStagedLegs;
  if (stagedLegsComplete || tpLadderPartials >= 2 || (ttlExpired && !ttlPreservesStagedPlan)) {
    ot.liveStagedEntry = undefined;
  }
}

/**
 * One synchronous tracker step — mirrors `tracker.ts` order (minus network / appendEvent).
 */
export function simStep(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  curMetric: number;
  virtualNow: number;
  dcaLevels: DcaLevel[];
  tpLadder: TpLadderLevel[];
  peakLog: { lastPersistedPeak: number };
  ladderRetraceSpec?: LadderRetraceSpec;
  /**
   * `undefined` — прежнее поведение: на новом ATH при `xAvg >= trailTriggerX` сразу `trailingArmed`.
   * Число — как у live-oscar с TP-grid: arm только если уже есть ≥N частичных TP (`TP_LADDER`), либо нет TP-срезов.
   */
  minTpGridPartialsForPeakTrailArm?: number;
}): SimResult {
  const { cfg, ot, curMetric, virtualNow, dcaLevels, tpLadder, peakLog, ladderRetraceSpec, minTpGridPartialsForPeakTrailArm } =
    args;
  const retraceSpec: LadderRetraceSpec = ladderRetraceSpec ?? { kind: 'baseline' };
  let effCfg = cfgEffectiveForOpen(cfg, ot);
  const ageH = (virtualNow - ot.entryTs) / 3_600_000;

  if (!(curMetric > 0)) {
    if (ageH > effCfg.timeoutHours) {
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
  let xAvg = curMetric / ot.avgEntry;
  let pnlPctVsAvg = (xAvg - 1) * 100;
  effCfg = cfgEffectiveForOpen(cfg, ot);
  let tgEff = tpGridEffective(ot, effCfg);

  if (curMetric > ot.peakMcUsd) {
    const wasArmed = ot.trailingArmed;
    ot.peakMcUsd = curMetric;
    ot.peakPnlPct = pnlPctVsAvg;
    const tgArm = tpGridEffective(ot, effCfg);
    const usesTpSlicesArm = tgArm.stepPnl > 0 || tpLadder.length > 0;
    const tpSlicesDoneArm = ot.partialSells.filter((p) => p.reason === 'TP_LADDER').length;
    if (xAvg >= effCfg.trailTriggerX) {
      if (minTpGridPartialsForPeakTrailArm === undefined) {
        ot.trailingArmed = true;
      } else if (!usesTpSlicesArm || tpSlicesDoneArm >= minTpGridPartialsForPeakTrailArm) {
        ot.trailingArmed = true;
      }
    }
    if ((!wasArmed && ot.trailingArmed) || pnlPctVsAvg >= peakLog.lastPersistedPeak + effCfg.peakLogStepPct) {
      peakLog.lastPersistedPeak = pnlPctVsAvg;
    }
  }

  let killEffBt = dcaKillstopEffective(ot, effCfg);
  const mayDca =
    !ot.liveStagedEntry &&
    (tgEff.stepPnl <= 0 || ot.partialSells.length === 0) &&
    (dcaLevels.length > 0 || killEffBt < 0) &&
    ot.remainingFraction > 0;
  if (mayDca) {
    const effPrevDrop = dcaEffPrev(ot);
    for (let dcaIdx = 0; dcaIdx < dcaLevels.length; dcaIdx++) {
      const lvl = dcaLevels[dcaIdx]!;
      if (dcaStepOrTriggerTaken(ot, dcaIdx, lvl.triggerPct)) continue;
      if (!dcaCrossedDownward(effPrevDrop, dropFromFirstPct, lvl.triggerPct)) continue;
      const addUsd = effCfg.positionUsd * lvl.addFraction;
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
      ot.trailingArmed = ot.trailingArmed && curMetric / ot.avgEntry >= effCfg.trailTriggerX;
    }
  }

  simTryLiveStagedEntryAdds({ cfg, ot, curMetric, virtualNow });

  xAvg = curMetric / ot.avgEntry;
  pnlPctVsAvg = (xAvg - 1) * 100;
  effCfg = cfgEffectiveForOpen(cfg, ot);
  tgEff = tpGridEffective(ot, effCfg);
  killEffBt = dcaKillstopEffective(ot, effCfg);

  /** TP grid (+5% steps, etc.) — same order as `tracker.ts`. Partial sizing uses post-DCA `ot`; thresholds use tick-start `xAvg`. */
  if (tgEff.stepPnl > 0 && ot.remainingFraction > 0) {
    const pnlFrac = xAvg - 1;
    const step = tgEff.stepPnl;
    const sellFrac = Math.min(1, tgEff.sellFraction);
    let maxK = Math.floor((pnlFrac + LADDER_PNL_EPS) / step);
    if (tgEff.maxRungs != null && tgEff.maxRungs >= 1) {
      maxK = Math.min(maxK, tgEff.maxRungs);
    }
    for (let k = 1; k <= maxK; k++) {
      const threshold = k * step;
      if (ladderPnlThresholdTaken(ot.ladderUsedLevels, threshold)) continue;
      if (pnlFrac + LADDER_PNL_EPS < threshold) break;
      if (cfg.strategyId === 'live-oscar' && cfg.liveExitModeAbEnabled && ot.liveExitProfileMode == null && k === 1) {
        ot.liveExitProfileMode = 'A';
        effCfg = cfgEffectiveForOpen(cfg, ot);
        tgEff = tpGridEffective(ot, effCfg);
      }
      const sellFraction = sellFrac;
      const marketSellPx = curMetric;
      const investedSoldUsd = ot.totalInvestedUsd * ot.remainingFraction * sellFraction;
      const { effectivePrice: effectiveSell } = applyExitCosts(cfg, marketSellPx, ot.dex, investedSoldUsd, null);
      const remainingValueNet = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
      const proceedsUsd = remainingValueNet * sellFraction;
      const remainingValueGross =
        ot.totalInvestedUsd * ot.remainingFraction * (marketSellPx / ot.avgEntryMarket);
      const grossProceedsUsd = remainingValueGross * sellFraction;
      const pnlUsd = proceedsUsd - investedSoldUsd;
      const grossPnlUsd = grossProceedsUsd - investedSoldUsd;
      ot.partialSells.push({
        ts: virtualNow,
        price: effectiveSell,
        marketPrice: marketSellPx,
        sellFraction,
        reason: 'TP_LADDER',
        proceedsUsd,
        grossProceedsUsd,
        pnlUsd,
        grossPnlUsd,
      });
      ot.remainingFraction *= 1 - sellFraction;
      ladderPnlThresholdMark(ot.ladderUsedLevels, threshold);
    }
  }

  /** Discrete `PAPER_TP_LADDER` rows (if any). */
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

  let exitReason: ExitReason | null = null;
  const inSignalKill = liveStagedEntryKillHitSim(ot, curMetric);
  const inKillTerritory =
    inSignalKill || (!ot.liveStagedEntry && killEffBt < 0 && pnlPctVsAvg / 100 <= killEffBt);
  if (inKillTerritory) {
    const debounceKillAfterReplenish =
      cfg.strategyId === 'live-oscar' && ot.legs.length > 1 && !inSignalKill;
    if (debounceKillAfterReplenish) {
      const nextStreak = (ot.liveKillstopBelowStreak ?? 0) + 1;
      ot.liveKillstopBelowStreak = nextStreak;
      if (nextStreak >= 2) exitReason = 'KILLSTOP';
    } else {
      ot.liveKillstopBelowStreak = 0;
      exitReason = 'KILLSTOP';
    }
  } else {
    ot.liveKillstopBelowStreak = 0;
  }

  if (!exitReason) {
    if (xAvg >= effCfg.tpX) exitReason = 'TP';
    else if (effCfg.slX > 0 && xAvg <= effCfg.slX) exitReason = 'SL';
    else if (
      effCfg.trailMode === 'ladder_retrace' &&
      ladderRetraceTriggeredWithSpec(
        ot,
        tpLadder,
        xAvg,
        tgEff.stepPnl > 0 ? 'grid' : 'discrete',
        tgEff.firstRungRetraceMinPnlPct,
        retraceSpec,
      )
    )
      exitReason = 'TRAIL';
    else if (
      effCfg.trailMode === 'peak' &&
      ot.trailingArmed &&
      curMetric <= ot.peakMcUsd * (1 - effCfg.trailDrop)
    )
      exitReason = 'TRAIL';
    else if (ageH >= effCfg.timeoutHours) exitReason = 'TIMEOUT';
  }
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

export type CfgAfterDcaPolicy = 'after_first_dca' | 'after_first_non_open_leg';

function openTradeHasPostEntryLegForPolicy(ot: OpenTrade, policy: CfgAfterDcaPolicy): boolean {
  if (policy === 'after_first_non_open_leg') return ot.legs.some((l) => l.reason !== 'open');
  return ot.legs.some((l) => l.reason === 'dca');
}

export function simulateLifecycle(args: {
  baseOt: OpenTrade;
  anchors: Anchor[];
  cfg: PaperTraderConfig;
  /** After any simulated `dca` leg exists, switch exit/grid/trail/timeout to this config (next tick onward). */
  cfgAfterDca?: PaperTraderConfig;
  /**
   * When `cfgAfterDca` is set: switch after first **`dca`** leg (default), or after any leg that is not **`open`**
   * (covers **scale_in** — closer to live Oscar **B** after the second entry leg).
   */
  cfgAfterDcaPolicy?: CfgAfterDcaPolicy;
  dcaLevels: DcaLevel[];
  tpLadder: TpLadderLevel[];
  stepMs: number;
  ladderRetraceSpec?: LadderRetraceSpec;
  minTpGridPartialsForPeakTrailArm?: number;
}): ClosedTrade | null {
  const {
    baseOt,
    anchors,
    cfg,
    cfgAfterDca,
    cfgAfterDcaPolicy,
    dcaLevels,
    tpLadder,
    stepMs,
    ladderRetraceSpec,
    minTpGridPartialsForPeakTrailArm,
  } = args;
  const ot = deepCloneOpen(baseOt);
  const peakLog = { lastPersistedPeak: -Infinity };
  let activeCfg = cfg;
  const lastAnchorTs = anchors.length ? anchors[anchors.length - 1].ts : baseOt.entryTs;
  const postEntryPolicy: CfgAfterDcaPolicy = cfgAfterDcaPolicy ?? 'after_first_dca';

  for (let t = ot.entryTs; t <= lastAnchorTs + stepMs; t += stepMs) {
    const curMetric = priceAt(anchors, t);
    const r = simStep({
      cfg: activeCfg,
      ot,
      curMetric,
      virtualNow: t,
      dcaLevels,
      tpLadder,
      peakLog,
      ladderRetraceSpec,
      minTpGridPartialsForPeakTrailArm,
    });
    if (r.closed) return r.closed;
    if (cfgAfterDca && openTradeHasPostEntryLegForPolicy(ot, postEntryPolicy)) {
      activeCfg = cfgAfterDca;
    }
  }

  // Force close at end of path if still open (label TIMEOUT at last price).
  const finalT = lastAnchorTs;
  const curMetric = priceAt(anchors, finalT);
  const ageH = (finalT - ot.entryTs) / 3_600_000;
  if (curMetric > 0) {
    const marketSell = curMetric;
    const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
    const { effectivePrice: effectiveSell } = applyExitCosts(
      activeCfg,
      marketSell,
      ot.dex,
      Math.max(1, investedRemaining),
      null,
    );
    return buildClosedTradeSim({
      cfg: activeCfg,
      ot,
      marketSell,
      effectiveSell,
      exitReason: 'TIMEOUT',
      ageH,
      exitTs: finalT,
    });
  }
  return buildClosedTradeSim({
    cfg: activeCfg,
    ot,
    marketSell: 0,
    effectiveSell: 0,
    exitReason: 'NO_DATA',
    ageH,
    exitTs: finalT,
  });
}

export async function readJournalLifecycles(jsonlPath: string): Promise<JournalLifecycle[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  const byMint = new Map<string, Record<string, unknown>[]>();
  const completed: JournalLifecycle[] = [];

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
      'Usage: tsx src/scripts/paper2-strategy-backtest.ts --jsonl <path.jsonl> [--grid quick|medium|dno] [--step-ms N] [--features-only] [--no-dca] [--bucket-dip] [--since-close-hours N]',
    );
    process.exit(1);
  }

  const gridMode = arg('--grid') ?? 'quick';
  const stepMs = Number(arg('--step-ms') ?? 120_000);
  const featuresOnly = flag('--features-only');
  const noDca = flag('--no-dca');
  const bucketDip = flag('--bucket-dip');
  const sinceCloseH = Number(arg('--since-close-hours') ?? NaN);

  let cfg: PaperTraderConfig;
  try {
    cfg = loadPaperTraderConfig();
  } catch (err) {
    console.error('loadPaperTraderConfig failed — ensure .env matches schema:', (err as Error).message);
    process.exit(1);
  }

  let lifecycles = await readJournalLifecycles(jsonlPath);
  if (Number.isFinite(sinceCloseH) && sinceCloseH > 0) {
    const sinceTs = Date.now() - sinceCloseH * 3_600_000;
    lifecycles = lifecycles.filter((lc) => {
      const c = lc.close;
      const exitTs = typeof c.exitTs === 'number' ? c.exitTs : 0;
      const wallTs = typeof c.ts === 'number' ? c.ts : 0;
      const t = exitTs > 0 ? exitTs : wallTs;
      return t >= sinceTs;
    });
    console.log(`\n(--since-close-hours ${sinceCloseH}) Lifecycles with exit time in window: ${lifecycles.length}`);
  }
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
    const anchors = anchorsFromJournalEvents(lc.events);
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
                const anchors = anchorsFromJournalEvents(lc.events);
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

/** Only run CLI when this file is the process entry (imports must not fire main()). */
function ranAsCliScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = path.resolve(fileURLToPath(import.meta.url));
  return path.resolve(entry) === here;
}

if (ranAsCliScript()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
