import type { PaperTraderConfig, DcaLevel, TpLadderLevel } from '../config.js';
import { cfgEffectiveForOpen } from '../cfg-effective-for-open.js';
import { recordLossExitIfApplicable } from '../discovery/dip-clones.js';
import type {
  ClosedTrade,
  DexSource,
  ExitContext,
  ExitReason,
  OpenTrade,
  PartialSell,
  PositionLeg,
  PriceVerifyVerdict,
} from '../types.js';
import { fetchLatestSnapshotPrice, getLiveMcUsd, getSolUsd } from '../pricing.js';
import { verifyExitPrice } from '../pricing/price-verify.js';
import { getPriorityFeeUsd } from '../pricing/priority-fee.js';
import {
  buildOptionalLiqWatchCloseStamp,
  evaluateLiqDrainState,
  loadCurrentPoolLiqUsd,
} from '../pricing/liq-watch.js';
import { applyEntryCosts, applyExitCosts, buildCloseCosts } from '../costs.js';
import type {
  LiveBuyPipelineResult,
  LiveOscarPhase4Tracker,
  LiveTokenToSolSellResult,
} from '../../live/phase4-types.js';
import { fetchContextSwaps } from './context-swaps.js';
import {
  collectFiredLadderPnls,
  ladderRetraceTriggered,
  ladderPnlThresholdMark,
  ladderPnlThresholdTaken,
  ladderStepOrThresholdTaken,
  LADDER_PNL_EPS,
  markLadderStepFired,
} from './tp-ladder-state.js';
import { dcaCrossedDownward, dcaEffPrev, dcaStepOrTriggerTaken, markDcaStepFired } from './dca-state.js';
import { dcaKillstopEffective, tpGridEffective } from './tp-grid-effective.js';
import { child } from '../../core/logger.js';
import { appendLiveBuyAnchorsAfterDca } from '../../live/live-buy-anchor.js';
import { scheduleLivePostCloseTailSweep } from '../../live/post-close-tail-sweep.js';
import type { LiveOscarConfig } from '../../live/config.js';
import { serializeClosedTrade, serializeOpenTrade } from '../../live/strategy-snapshot.js';
import { tryLiveEntryScaleInTrackerStep } from '../../live/entry-scale-in.js';
import { liveFetchBuyQuote } from '../../live/jupiter.js';
import { tokenUsdFromBuyQuoteFitDecimals } from '../../live/phase5-gates.js';
import {
  notifyLiveTrackerJupiterFallback,
  notifyLiveTrackerSnapshotJupiterDivergence,
} from '../../core/telegram/jupiter-alerts.js';

const log = child('tracker');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scheduleTailAfterLiveClose(
  liveOscarCfg: LiveOscarConfig | undefined,
  mint: string,
  symbol: string,
  decimals: number,
  priceUsdPerToken: number,
  dexSource?: string,
): void {
  const px = priceUsdPerToken > 0 ? priceUsdPerToken : 1e-12;
  scheduleLivePostCloseTailSweep({
    liveCfg: liveOscarCfg,
    mint,
    symbol,
    decimals,
    priceUsdPerToken: px,
    dexSource,
  });
}

export { ladderRetraceTriggered } from './tp-ladder-state.js';

/** W7.4.2 — returns verdict for JSONL stamping; `defer` means skip this exit attempt until next tracker tick. */
async function exitPriceVerifyGate(args: {
  cfg: PaperTraderConfig;
  mint: string;
  symbol: string;
  tokenDecimals: number;
  usdNotional: number;
  snapshotPriceUsd: number;
  context: 'partial_sell' | 'close';
  journalAppend: TrackerArgs['journalAppend'];
  stats: TrackerStats;
  /** When true, blocked quotes do not defer (TIMEOUT escalation path). */
  ignoreBlockOnFail?: boolean;
}): Promise<{ defer: boolean; verdict: PriceVerifyVerdict | null }> {
  const {
    cfg,
    mint,
    symbol,
    tokenDecimals,
    usdNotional,
    snapshotPriceUsd,
    context,
    journalAppend,
    stats,
    ignoreBlockOnFail,
  } = args;
  if (!cfg.priceVerifyExitEnabled) return { defer: false, verdict: null };
  if (!(usdNotional > 1e-6) || !(snapshotPriceUsd > 0)) return { defer: false, verdict: null };

  const solUsd = getSolUsd() ?? 0;
  let verdict: PriceVerifyVerdict;
  try {
    verdict = await verifyExitPrice({
      cfg,
      mint,
      tokenDecimals,
      usdNotional,
      solUsd,
      snapshotPriceUsd,
    });
  } catch (e) {
    log.warn({ err: (e as Error)?.message, mint: mint.slice(0, 8) }, 'verifyExitPrice threw');
    verdict = { kind: 'skipped', reason: 'fetch-fail', ts: Date.now() };
  }

  if (verdict.kind === 'blocked' && cfg.priceVerifyExitBlockOnFail && !ignoreBlockOnFail) {
    stats.skippedPriceVerifyExit += 1;
    journalAppend({
      kind: 'eval-skip-exit',
      mint,
      symbol,
      context,
      reason: `price_verify_exit:${verdict.reason}`,
      priceVerifyExit: verdict,
    });
    return { defer: true, verdict };
  }

  return { defer: false, verdict };
}

export interface TrackerStats {
  closed: Record<ExitReason, number>;
  /** W7.4.2 — exits deferred because pre-exit Jupiter quote failed gates with block_on_fail. */
  skippedPriceVerifyExit: number;
}

export interface TrackerArgs {
  cfg: PaperTraderConfig;
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  dcaLevels: DcaLevel[];
  tpLadder: TpLadderLevel[];
  stats: TrackerStats;
  btcCtx: () => { ret1h_pct: number | null; ret4h_pct: number | null; updated_ts: number | null };
  /** Paper JSONL or live noop — never mix stores (W8.0-p4 P4-I1). */
  journalAppend: (event: Record<string, unknown>) => void;
  /** W8.0 Phase 7 — live JSONL `live_position_*` mirror for replay. */
  journalLiveStrategy?: (event: Record<string, unknown>) => void;
  /** Live-oscar simulate sells / DCA buys after tracker decisions. */
  livePhase4?: LiveOscarPhase4Tracker;
  /** Live-oscar env (post-close tail sweep, etc.). */
  liveOscarCfg?: LiveOscarConfig;
  /**
   * Live: each tracker tick — SPL RPC vs journal `open`. Return mints that are still **open** in memory
   * but have **zero** raw token balance on the wallet (sold externally, failed journal write, etc.).
   * Tracker paper-closes them as RECONCILE_ORPHAN after optional age grace + second RPC verify.
   */
  reconcilePaperCloseZeroMints?: (
    open: Map<string, OpenTrade>,
  ) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /**
   * Live: re-check SPL balance before orphan paper-close. Return false on RPC failure or if tokens remain —
   * avoids false orphan when boot reconcile saw a transient empty wallet read.
   */
  verifyReconcileOrphanWalletZero?: (mint: string) => Promise<boolean>;
  /**
   * Live: wall-clock age (`entryTs`) required before orphan close; younger positions skipped (RPC TA lag).
   */
  reconcileOrphanMinPositionAgeMs?: number;
}

interface PeakState {
  lastPersistedPeak: number;
}
const peakStateByMint = new Map<string, PeakState>();

/** Consecutive full-exit verify defers per mint (TIMEOUT escalation). */
const exitCloseVerifyDefersByMint = new Map<string, number>();
/** Telemetry for partial sells (live JSONL only). */
const exitPartialVerifyDefersByMint = new Map<string, number>();

function clearExitCloseDeferForMint(mint: string): void {
  exitCloseVerifyDefersByMint.delete(mint);
}

function clearExitPartialDeferForMint(mint: string): void {
  exitPartialVerifyDefersByMint.delete(mint);
}

function priceVerifyVerdictSummary(verdict: PriceVerifyVerdict | null): string {
  if (!verdict) return 'none';
  if (verdict.kind === 'ok') return 'ok';
  if (verdict.kind === 'blocked') return `blocked:${verdict.reason}`;
  return `skipped:${verdict.reason}`;
}

function totalProceedsNet(ot: OpenTrade): number {
  return ot.partialSells.reduce((s, p) => s + (p.proceedsUsd || 0), 0);
}
function totalProceedsGross(ot: OpenTrade): number {
  return ot.partialSells.reduce((s, p) => s + (p.grossProceedsUsd || 0), 0);
}

/**
 * Builds a self-contained, audit-ready summary of WHY this trade is closing.
 * Lets the dashboard render "TP +7.2% (peak +32%, retrace −19pp)" style strings
 * instead of just "TP".
 *
 * Pure helper — no I/O. All inputs are taken from the OpenTrade snapshot and
 * the per-strategy config that fired the close.
 */
function buildExitContext(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  closePnlPct: number;
  ageH: number;
  exitReason: ExitReason;
  curMetric: number;
  xAvg: number;
  tpLadder: TpLadderLevel[];
  liqDrop?: { dropPct: number; entryLiqUsd: number; currentLiqUsd: number; ageMs: number } | null;
}): ExitContext {
  const { cfg, ot, closePnlPct, ageH, exitReason, curMetric, xAvg, tpLadder, liqDrop } = args;
  const killEff = dcaKillstopEffective(ot, cfg);
  const peak = ot.peakPnlPct;
  const retraceFromPeakPct =
    peak > 0 && Number.isFinite(peak)
      ? +(((peak - closePnlPct) / peak) * 100).toFixed(2)
      : null;
  const tpLadderHits =
    cfg.tpGridStepPnl > 0 ? collectFiredLadderPnls(ot, []).length : collectFiredLadderPnls(ot, tpLadder).length;
  const tpLadderTotal = cfg.tpGridStepPnl > 0 ? 0 : tpLadder.length;
  const dcaLegsAdded = Math.max(0, ot.legs.length - 1);

  let triggerLabel = exitReason as string;
  switch (exitReason) {
    case 'TP': {
      if (ot.remainingFraction <= 1e-6 && tpLadderHits > 0) {
        triggerLabel =
          cfg.tpGridStepPnl > 0
            ? `TP grid fully unwound (${tpLadderHits} partials)`
            : `TP ladder fully unwound (${tpLadderHits}/${tpLadderTotal} hits)`;
      } else if (xAvg >= cfg.tpX) {
        triggerLabel = `TP xAvg≥${cfg.tpX.toFixed(2)} (cur ${xAvg.toFixed(2)}x)`;
      } else {
        triggerLabel = `TP (no remaining)`;
      }
      break;
    }
    case 'SL':
      triggerLabel = `SL xAvg≤${cfg.slX.toFixed(2)} (cur ${xAvg.toFixed(2)}x)`;
      break;
    case 'TRAIL':
      if (cfg.trailMode === 'ladder_retrace') {
        triggerLabel =
          cfg.tpGridStepPnl > 0
            ? `TRAIL grid retrace (${tpLadderHits} partials, cur ${xAvg.toFixed(2)}x, peak ${(1 + peak / 100).toFixed(2)}x)`
            : `TRAIL ladder retrace (${tpLadderHits}/${tpLadderTotal} hits, cur ${xAvg.toFixed(2)}x, peak ${(1 + peak / 100).toFixed(2)}x)`;
      } else {
        const peakX = ot.peakMcUsd > 0 ? curMetric / ot.peakMcUsd : 0;
        triggerLabel = `TRAIL peak retrace ${((peakX - 1) * 100).toFixed(1)}% from peak (drop≥${(cfg.trailDrop * 100).toFixed(0)}%)`;
      }
      break;
    case 'TIMEOUT':
      triggerLabel = `TIMEOUT ${cfg.timeoutHours}h${ot.trailingArmed ? ' (trail was armed)' : ' (trail NEVER armed; need ' + cfg.trailTriggerX.toFixed(2) + 'x)'}`;
      break;
    case 'KILLSTOP':
      triggerLabel = `DCA killstop ${(killEff * 100).toFixed(0)}% (cur ${closePnlPct.toFixed(1)}% vs avg, ${dcaLegsAdded} DCA legs)`;
      break;
    case 'NO_DATA':
      triggerLabel = `no-data ${cfg.timeoutHours}h (price stream gone — hard close)`;
      break;
    case 'LIQ_DRAIN':
      if (liqDrop) {
        const ageS = Math.round(liqDrop.ageMs / 1000);
        triggerLabel = `liq drop ${liqDrop.dropPct.toFixed(1)}% ($${Math.round(liqDrop.entryLiqUsd).toLocaleString()} → $${Math.round(liqDrop.currentLiqUsd).toLocaleString()}, snapshot ${ageS}s old)`;
      } else {
        triggerLabel = `liq drain (no detail)`;
      }
      break;
    case 'RECONCILE_ORPHAN':
      triggerLabel = `reconcile orphan (в журнале позиция ещё open, на кошельке 0 токенов по mint)`;
      break;
    case 'PERIODIC_HEAL':
      triggerLabel = `periodic self-heal (stuck open / wallet sync)`;
      break;
    case 'CAPITAL_ROTATE':
      triggerLabel = `Ротация капитала (Phase 5): полный on-chain sell для освобождения SOL под новый вход — не сбой кода`;
      break;
  }

  return {
    closePnlPct: +closePnlPct.toFixed(2),
    peakPnlPct: +peak.toFixed(2),
    retraceFromPeakPct,
    trailingArmed: ot.trailingArmed,
    ageHours: +ageH.toFixed(3),
    tpLadderHits,
    tpLadderTotal,
    dcaLegsAdded,
    remainingFractionAtClose: +ot.remainingFraction.toFixed(4),
    triggerLabel,
    cfgSnapshot: {
      tpX: cfg.tpX,
      slX: cfg.slX,
      trailMode: cfg.trailMode,
      trailDrop: cfg.trailDrop,
      trailTriggerX: cfg.trailTriggerX,
      timeoutHours: cfg.timeoutHours,
      dcaKillstop: killEff,
    },
  };
}

function buildClosedTrade(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  marketSell: number;
  effectiveSell: number;
  exitReason: ExitReason;
  ageH: number;
  /** W7.3 — per simulated tx (buy/sell legs + partials + final exit). */
  networkFeeUsdPerTx: number;
}): ClosedTrade {
  const { cfg, ot, marketSell, effectiveSell, exitReason, ageH, networkFeeUsdPerTx } = args;
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

  const networkFeeUsdTotal = (ot.legs.length + ot.partialSells.length + 1) * networkFeeUsdPerTx;

  const slipDynamicBpsEntry = 0;
  const slipDynamicBpsExit = 0;

  const costs = buildCloseCosts({
    cfg,
    trade: ot,
    exit: { effectivePrice: effectiveSell, marketPrice: marketSell },
    networkFeeUsdTotal,
    slipDynamicBpsEntry,
    slipDynamicBpsExit,
    netPnlUsd,
    grossPnlUsd,
  });

  const firstLeg: PositionLeg | undefined = ot.legs[0];
  return {
    ...ot,
    exitTs: Date.now(),
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

type TpPartialSellResult = 'ok' | 'defer_next' | 'abort_mint';

/** Shared partial TP path for discrete ladder rungs and TP grid steps. */
async function tryExecuteTpPartialSell(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  sellFraction: number;
  ladderStepIndex: number;
  ladderRungsTotal: number;
  ladderPnlPct: number;
  tpGrid: boolean;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  stats: TrackerStats;
  markLadder: () => void;
  logLabelPct: string;
}): Promise<TpPartialSellResult> {
  const {
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction: rawSellFrac,
    ladderStepIndex,
    ladderRungsTotal,
    ladderPnlPct,
    tpGrid,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    stats,
    markLadder,
    logLabelPct,
  } = args;
  const sellFraction = Math.min(1, rawSellFrac);
  const marketSell = curMetric;
  const investedSoldUsd = ot.totalInvestedUsd * ot.remainingFraction * sellFraction;
  const { effectivePrice: modeledEffectiveSell } = applyExitCosts(
    cfg,
    marketSell,
    ot.dex,
    investedSoldUsd,
    null,
  );
  const remainingValueNet = ot.totalInvestedUsd * ot.remainingFraction * (modeledEffectiveSell / ot.avgEntry);
  let proceedsUsd = remainingValueNet * sellFraction;
  const remainingValueGross =
    ot.totalInvestedUsd * ot.remainingFraction * (marketSell / ot.avgEntryMarket);
  let grossProceedsUsd = remainingValueGross * sellFraction;
  let pnlUsd = proceedsUsd - investedSoldUsd;
  let grossPnlUsd = grossProceedsUsd - investedSoldUsd;
  let effectiveSell = modeledEffectiveSell;

  const prevPartialDefers = exitPartialVerifyDefersByMint.get(mint) ?? 0;
  const maxEsc = cfg.priceVerifyExitMaxDefersEscalation;
  const escalatePartialVerify = maxEsc > 0 && prevPartialDefers >= maxEsc;

  const exitPvPartial = await exitPriceVerifyGate({
    cfg,
    mint,
    symbol: ot.symbol,
    tokenDecimals: ot.tokenDecimals ?? 6,
    usdNotional: investedSoldUsd,
    snapshotPriceUsd: marketSell,
    context: 'partial_sell',
    journalAppend,
    stats,
    ignoreBlockOnFail: escalatePartialVerify,
  });
  if (exitPvPartial.defer) {
    const n = (exitPartialVerifyDefersByMint.get(mint) ?? 0) + 1;
    exitPartialVerifyDefersByMint.set(mint, n);
    journalLiveStrategy?.({
      kind: 'live_exit_verify_defer',
      mint,
      context: 'partial_sell',
      phase: 'defer',
      consecutiveDefers: n,
      verdictSummary: priceVerifyVerdictSummary(exitPvPartial.verdict),
    });
    return 'defer_next';
  }
  if (escalatePartialVerify && exitPvPartial.verdict?.kind === 'blocked') {
    journalLiveStrategy?.({
      kind: 'live_exit_verify_defer',
      mint,
      context: 'partial_sell',
      phase: 'escalate_proceed',
      consecutiveDefers: prevPartialDefers,
      verdictSummary: priceVerifyVerdictSummary(exitPvPartial.verdict),
    });
  }
  clearExitPartialDeferForMint(mint);

  let sellOut: LiveTokenToSolSellResult = { ok: true };
  if (livePhase4 && marketSell > 0 && investedSoldUsd > 1e-6) {
    sellOut = await livePhase4.tryTokenToSolSell({
      mint,
      symbol: ot.symbol,
      usdNotional: investedSoldUsd,
      priceUsdPerToken: marketSell,
      decimals: ot.tokenDecimals ?? 6,
      intentKind: 'sell_partial',
    });
    if (!sellOut.ok) return 'abort_mint';
    if (sellOut.solProceedsLamports == null || sellOut.solProceedsLamports <= 0n) {
      log.warn(
        { mint: mint.slice(0, 8), symbol: ot.symbol },
        'live partial sell ok but missing solProceedsLamports — using modeled proceedsUsd',
      );
    }
  }

  let proceedsUsdSource: NonNullable<PartialSell['proceedsUsdSource']> = 'model';
  let solProceedsLamports: string | undefined;
  const spotSol = getSolUsd();
  if (
    sellOut.solProceedsLamports != null &&
    sellOut.solProceedsLamports > 0n &&
    spotSol > 0 &&
    Number.isFinite(spotSol) &&
    ot.avgEntry > 0
  ) {
    const actualUsd = (Number(sellOut.solProceedsLamports) / 1e9) * spotSol;
    const tokensSold = investedSoldUsd / ot.avgEntry;
    const modeledProceedsFloor = proceedsUsd;
    if (tokensSold > 1e-18 && Number.isFinite(actualUsd)) {
      const chainImplausible =
        modeledProceedsFloor > 2 &&
        actualUsd < Math.min(modeledProceedsFloor * 0.2, Math.max(0.5, modeledProceedsFloor * 0.35)) &&
        marketSell >= ot.avgEntry * 0.97;
      if (chainImplausible) {
        log.warn(
          {
            mint: mint.slice(0, 8),
            symbol: ot.symbol,
            actualUsd,
            modeledProceedsUsd: modeledProceedsFloor,
            investedSoldUsd,
          },
          'live partial sell chain SOL→USD implausible vs modeled proceeds; keeping modeled USD',
        );
      } else {
        proceedsUsd = actualUsd;
        grossProceedsUsd = actualUsd;
        pnlUsd = proceedsUsd - investedSoldUsd;
        grossPnlUsd = pnlUsd;
        effectiveSell = proceedsUsd / tokensSold;
        proceedsUsdSource =
          sellOut.solProceedsSource === 'confirmed_meta'
            ? 'chain_sol'
            : sellOut.solProceedsSource === 'jupiter_quote'
              ? 'jupiter_quote'
              : 'chain_sol';
        solProceedsLamports = sellOut.solProceedsLamports.toString();
      }
    }
  }

  const ps: PartialSell = {
    ts: Date.now(),
    price: effectiveSell,
    marketPrice: marketSell,
    sellFraction,
    reason: 'TP_LADDER',
    proceedsUsd,
    grossProceedsUsd,
    pnlUsd,
    grossPnlUsd,
    ...(solProceedsLamports ? { solProceedsLamports } : {}),
    proceedsUsdSource,
  };
  ot.partialSells.push(ps);
  ot.remainingFraction *= 1 - sellFraction;
  markLadder();
  const mcUsdLive_ps = await getLiveMcUsd(
    mint,
    ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
  );
  const pfPs = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
  journalAppend({
    kind: 'partial_sell',
    mint,
    ts: ps.ts,
    price: effectiveSell,
    marketPrice: marketSell,
    sellFraction,
    ladderStepIndex,
    ladderRungsTotal,
    ladderPnlPct,
    reason: 'TP_LADDER',
    proceedsUsd,
    grossProceedsUsd,
    pnlUsd,
    grossPnlUsd,
    remainingFraction: ot.remainingFraction,
    mcUsdLive: mcUsdLive_ps,
    priorityFee: pfPs,
    ...(tpGrid ? { tpGrid: true } : {}),
    ...(exitPvPartial.verdict ? { priceVerifyExit: exitPvPartial.verdict } : {}),
    ...(solProceedsLamports ? { solProceedsLamports } : {}),
    proceedsUsdSource,
  });
  journalLiveStrategy?.({
    kind: 'live_position_partial_sell',
    mint,
    openTrade: serializeOpenTrade(ot),
  });
  console.log(
    `[${logLabelPct}] ${mint.slice(0, 8)} $${ot.symbol} sold=${(sellFraction * 100).toFixed(0)}% pnl=$${pnlUsd.toFixed(2)} remain=${(ot.remainingFraction * 100).toFixed(0)}%`,
  );
  return 'ok';
}

async function closeOpenTradeReconcileOrphan(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  stats: TrackerStats;
  tpLadder: TpLadderLevel[];
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  btcCtx: TrackerArgs['btcCtx'];
  verifyReconcileOrphanWalletZero?: TrackerArgs['verifyReconcileOrphanWalletZero'];
  liveOscarCfg?: LiveOscarConfig;
}): Promise<void> {
  const {
    mint,
    ot,
    cfg,
    open,
    closed,
    stats,
    tpLadder,
    journalAppend,
    journalLiveStrategy,
    btcCtx,
    verifyReconcileOrphanWalletZero,
    liveOscarCfg,
  } = args;

  if (verifyReconcileOrphanWalletZero) {
    let allow: boolean;
    try {
      allow = await verifyReconcileOrphanWalletZero(mint);
    } catch {
      allow = false;
    }
    if (!allow) return;
  }

  const ageH = (Date.now() - ot.entryTs) / 3_600_000;
  const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
  const perTxNd = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
  const ct = buildClosedTrade({
    cfg,
    ot,
    marketSell: 0,
    effectiveSell: 0,
    exitReason: 'RECONCILE_ORPHAN',
    ageH,
    networkFeeUsdPerTx: perTxNd,
  });
  /** Ledger hygiene: wallet had 0 atoms — drop stale `open`; attribute only realized partials, unwind remainder at cost (no phantom -100%). */
  const invested = ot.totalInvestedUsd;
  const partialNet = totalProceedsNet(ot);
  const partialGross = totalProceedsGross(ot);
  const remUsdAtCost = invested * Math.max(0, ot.remainingFraction);
  const remUsdAtCostGross = remUsdAtCost * (ot.avgEntryMarket > 0 ? ot.avgEntryMarket / ot.avgEntry : 1);
  ct.totalProceedsUsd = partialNet + remUsdAtCost;
  ct.grossTotalProceedsUsd = partialGross + remUsdAtCostGross;
  ct.netPnlUsd = ct.totalProceedsUsd - invested;
  ct.grossPnlUsd = ct.grossTotalProceedsUsd - invested;
  ct.pnlPct = invested > 0 ? (ct.netPnlUsd / invested) * 100 : 0;
  ct.grossPnlPct = invested > 0 ? (ct.grossPnlUsd / invested) * 100 : 0;
  ct.effective_exit_price = ot.avgEntry;
  ct.theoretical_exit_price = ot.avgEntryMarket;
  ct.exitMcUsd = 0;
  ct.costs = buildCloseCosts({
    cfg,
    trade: ot,
    exit: { effectivePrice: ot.avgEntry, marketPrice: ot.avgEntryMarket },
    networkFeeUsdTotal: 0,
    slipDynamicBpsEntry: 0,
    slipDynamicBpsExit: 0,
    netPnlUsd: ct.netPnlUsd,
    grossPnlUsd: ct.grossPnlUsd,
  });
  const exitCtx = buildExitContext({
    cfg,
    ot,
    closePnlPct: ct.pnlPct,
    ageH,
    exitReason: 'RECONCILE_ORPHAN',
    curMetric: 0,
    xAvg: 0,
    tpLadder,
  });
  ct.exitContext = exitCtx;
  clearExitCloseDeferForMint(mint);
  clearExitPartialDeferForMint(mint);
  open.delete(mint);
  closed.push(ct);
  stats.closed.RECONCILE_ORPHAN++;
  const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
  const mcUsdLive_close = await getLiveMcUsd(
    mint,
    ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
  );
  const liqWatchStamp = await buildOptionalLiqWatchCloseStamp(cfg, ot);
  journalAppend({
    kind: 'close',
    ...ct,
    peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
    btc_exit: btcCtx(),
    exit_swaps: exitSwaps,
    mcUsdLive: mcUsdLive_close,
    priorityFee: pfClose,
    exitContext: exitCtx,
    reconcileOrphan: true,
    ...(liqWatchStamp ? { liqWatch: liqWatchStamp } : {}),
  });
  journalLiveStrategy?.({
    kind: 'live_position_close',
    mint,
    closedTrade: serializeClosedTrade(ct),
  });
  recordLossExitIfApplicable(cfg, mint, ct.exitTs, ct.netPnlUsd);
  const pxOrphan =
    ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.avgEntry > 0 ? ot.avgEntry : 1e-12;
  scheduleTailAfterLiveClose(liveOscarCfg, mint, ot.symbol, ot.tokenDecimals ?? 6, pxOrphan, ot.source);
  peakStateByMint.delete(mint);
  console.log(`[RECONCILE_ORPHAN] ${mint.slice(0, 8)} $${ot.symbol}`);
}

/**
 * Phase 5 capital rotation: `sell_full` уже исполнен on-chain — синхронизировать память стратегии и live JSONL,
 * чтобы дашборд не показывал ложный «RECONCILE_ORPHAN» на следующем тике.
 */
export async function finalizeLiveCapitalRotatePaperClose(args: {
  cfg: PaperTraderConfig;
  mint: string;
  /** USD/token, как при ранжировании ротации (lastObserved / avgEntry). */
  marketSellPx: number;
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  stats: TrackerStats;
  tpLadder: TpLadderLevel[];
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  btcCtx: TrackerArgs['btcCtx'];
  liveOscarCfg?: LiveOscarConfig;
}): Promise<boolean> {
  const {
    cfg,
    mint,
    marketSellPx,
    open,
    closed,
    stats,
    tpLadder,
    journalAppend,
    journalLiveStrategy,
    btcCtx,
    liveOscarCfg,
  } = args;
  const ot = open.get(mint);
  if (!ot) return false;
  const marketSell =
    marketSellPx > 0
      ? marketSellPx
      : ot.lastObservedPriceUsd ?? ot.avgEntryMarket ?? ot.avgEntry;
  if (!(marketSell > 0)) return false;

  const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
  if (investedRemaining <= 1e-6) {
    open.delete(mint);
    peakStateByMint.delete(mint);
    clearExitCloseDeferForMint(mint);
    clearExitPartialDeferForMint(mint);
    return true;
  }

  const ageH = (Date.now() - ot.entryTs) / 3_600_000;
  const { effectivePrice: effectiveSell } = applyExitCosts(
    cfg,
    marketSell,
    ot.dex,
    Math.max(1, investedRemaining),
    null,
  );
  const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
  const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
  const perTxClose = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
  const ct = buildClosedTrade({
    cfg,
    ot,
    marketSell,
    effectiveSell,
    exitReason: 'CAPITAL_ROTATE',
    ageH,
    networkFeeUsdPerTx: perTxClose,
  });
  const xAvg = ot.avgEntry > 0 ? marketSell / ot.avgEntry : 0;
  const exitContextMain = buildExitContext({
    cfg,
    ot,
    closePnlPct: ct.pnlPct,
    ageH,
    exitReason: 'CAPITAL_ROTATE',
    curMetric: marketSell,
    xAvg,
    tpLadder,
  });
  ct.exitContext = exitContextMain;

  clearExitCloseDeferForMint(mint);
  clearExitPartialDeferForMint(mint);
  open.delete(mint);
  closed.push(ct);
  if (stats.closed.CAPITAL_ROTATE != null) stats.closed.CAPITAL_ROTATE++;

  const mcUsdLive_close = await getLiveMcUsd(
    mint,
    ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
  );
  const liqWatchExit = await buildOptionalLiqWatchCloseStamp(cfg, ot);
  journalAppend({
    kind: 'close',
    ...ct,
    peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
    btc_exit: btcCtx(),
    exit_market_price: marketSell,
    exit_effective_price: effectiveSell,
    exit_swaps: exitSwaps,
    mcUsdLive: mcUsdLive_close,
    priorityFee: pfClose,
    exitContext: exitContextMain,
    capitalRotate: true,
    ...(liqWatchExit ? { liqWatch: liqWatchExit } : {}),
  });
  journalLiveStrategy?.({
    kind: 'live_position_close',
    mint,
    closedTrade: serializeClosedTrade(ct),
  });
  recordLossExitIfApplicable(cfg, mint, ct.exitTs, ct.netPnlUsd);
  scheduleTailAfterLiveClose(
    liveOscarCfg,
    mint,
    ot.symbol,
    ot.tokenDecimals ?? 6,
    marketSell,
    ot.source,
  );
  peakStateByMint.delete(mint);
  console.log(
    `[CAPITAL_ROTATE] ${mint.slice(0, 8)} $${ot.symbol} pnl_net=${ct.pnlPct >= 0 ? '+' : ''}${ct.pnlPct.toFixed(1)}%`,
  );
  return true;
}

/**
 * Live-only escape hatch: full exit with Jupiter `sell_full` (Phase 4 uses chain balance),
 * **without** exit price-verify gate — removes stuck TIMEOUT loops blocked by verify.
 */
export async function trackerForceFullExitLive(args: {
  cfg: PaperTraderConfig;
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  tpLadder: TpLadderLevel[];
  stats: TrackerStats;
  btcCtx: TrackerArgs['btcCtx'];
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  mint: string;
  marketSell: number;
}): Promise<boolean> {
  const {
    cfg,
    open,
    closed,
    tpLadder,
    stats,
    btcCtx,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    mint,
    marketSell,
  } = args;
  const ot = open.get(mint);
  if (!ot || !(marketSell > 0)) return false;
  if (!livePhase4) return false;

  const ageH = (Date.now() - ot.entryTs) / 3_600_000;
  const paperRemUsd = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
  const usdForSell =
    paperRemUsd > 1e-6 ? paperRemUsd : Math.max(cfg.positionUsd * 1e-4, 0.01);
  const { effectivePrice: effectiveSell } = applyExitCosts(
    cfg,
    marketSell,
    ot.dex,
    Math.max(1, usdForSell),
    null,
  );
  const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
  const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
  const perTxClose = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
  const ct = buildClosedTrade({
    cfg,
    ot,
    marketSell,
    effectiveSell,
    exitReason: 'PERIODIC_HEAL',
    ageH,
    networkFeeUsdPerTx: perTxClose,
  });
  const xAvg = marketSell / ot.avgEntry;
  const exitContextMain = buildExitContext({
    cfg,
    ot,
    closePnlPct: ct.pnlPct,
    ageH,
    exitReason: 'PERIODIC_HEAL',
    curMetric: marketSell,
    xAvg,
    tpLadder,
  });
  ct.exitContext = exitContextMain;

  const okSell = await livePhase4.tryTokenToSolSell({
    mint,
    symbol: ot.symbol,
    usdNotional: usdForSell,
    priceUsdPerToken: marketSell,
    decimals: ot.tokenDecimals ?? 6,
    intentKind: 'sell_full',
  });
  if (!okSell.ok) return false;

  clearExitCloseDeferForMint(mint);
  clearExitPartialDeferForMint(mint);
  open.delete(mint);
  closed.push(ct);
  if (stats.closed.PERIODIC_HEAL != null) stats.closed.PERIODIC_HEAL++;
  const mcUsdLive_close = await getLiveMcUsd(
    mint,
    ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
  );
  const liqWatchExit = await buildOptionalLiqWatchCloseStamp(cfg, ot);
  journalAppend({
    kind: 'close',
    ...ct,
    peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
    btc_exit: btcCtx(),
    exit_market_price: marketSell,
    exit_effective_price: effectiveSell,
    exit_swaps: exitSwaps,
    mcUsdLive: mcUsdLive_close,
    priorityFee: pfClose,
    exitContext: exitContextMain,
    periodicHeal: true,
    ...(liqWatchExit ? { liqWatch: liqWatchExit } : {}),
  });
  journalLiveStrategy?.({
    kind: 'live_position_close',
    mint,
    closedTrade: serializeClosedTrade(ct),
  });
  recordLossExitIfApplicable(cfg, mint, ct.exitTs, ct.netPnlUsd);
  scheduleTailAfterLiveClose(
    liveOscarCfg,
    mint,
    ot.symbol,
    ot.tokenDecimals ?? 6,
    marketSell,
    ot.source,
  );
  peakStateByMint.delete(mint);
  console.log(
    `[PERIODIC_HEAL] ${mint.slice(0, 8)} $${ot.symbol} pnl_net=${ct.pnlPct >= 0 ? '+' : ''}${ct.pnlPct.toFixed(1)}% age=${ageH.toFixed(1)}h`,
  );
  return true;
}

export async function trackerTick(args: TrackerArgs): Promise<void> {
  const {
    cfg,
    open,
    closed,
    dcaLevels,
    tpLadder,
    stats,
    btcCtx,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    reconcilePaperCloseZeroMints,
    verifyReconcileOrphanWalletZero,
    reconcileOrphanMinPositionAgeMs,
    liveOscarCfg,
  } = args;

  let reconciledOrphans = 0;
  let orphanMints: readonly string[] | undefined;
  if (reconcilePaperCloseZeroMints) {
    const rawList = reconcilePaperCloseZeroMints(open);
    orphanMints = rawList instanceof Promise ? await rawList : rawList;
  }
  if (orphanMints?.length) {
    const oz = new Set(orphanMints);
    const graceMs = reconcileOrphanMinPositionAgeMs ?? 0;
    const nowOrphan = Date.now();
    for (const m of [...open.keys()]) {
      if (!oz.has(m)) continue;
      const ot = open.get(m);
      if (!ot) continue;
      if (graceMs > 0 && ot.entryTs > 0 && nowOrphan - ot.entryTs < graceMs) continue;
      await closeOpenTradeReconcileOrphan({
        mint: m,
        ot,
        cfg,
        open,
        closed,
        stats,
        tpLadder,
        journalAppend,
        journalLiveStrategy,
        btcCtx,
        verifyReconcileOrphanWalletZero,
        liveOscarCfg,
      });
      reconciledOrphans += 1;
    }
  }

  if (open.size === 0) return;
  const mints = [...open.keys()];

  for (const mint of mints) {
    const ot = open.get(mint);
    if (!ot) continue;
    const effCfg = cfgEffectiveForOpen(cfg, ot);

    let snapPx = 0;
    try {
      const raw = await fetchLatestSnapshotPrice(
        mint,
        ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
      );
      snapPx = Number(raw ?? 0);
    } catch (err) {
      console.warn(`tracker fetch failed for ${mint}: ${(err as Error).message}`);
    }
    let curMetric = snapPx > 0 ? snapPx : 0;

    /**
     * Live: MTM для TP / trail / SL — в первую очередь Jupiter tradable (SOL→token quote), а не PG `price_usd`
     * (коллектор может отставать или расходиться с реальным маршрутом). PG остаётся fallback, если Jupiter
     * выглядит сломанным относительно якоря входа (>2× расхождение). Пробуем Jupiter даже при пустом PG.
     * Telegram при сбое quote или сильном PG↔Jupiter — `src/core/telegram/jupiter-alerts.ts`.
     */
    if (livePhase4 && liveOscarCfg) {
      const solUsd = getSolUsd() ?? 0;
      const hintDec = ot.tokenDecimals ?? 6;
      const anchorPx =
        ot.avgEntryMarket > 0
          ? ot.avgEntryMarket
          : ot.avgEntry > 0
            ? ot.avgEntry
            : snapPx > 0
              ? snapPx
              : 0;
      const remUsd = ot.totalInvestedUsd * Math.max(0.05, ot.remainingFraction);
      const probeUsd = Math.max(5, Math.min(45, remUsd * 0.12));
      const snapshotPxForAlerts = snapPx > 0 ? snapPx : anchorPx;

      if (!(solUsd > 0)) {
        void notifyLiveTrackerJupiterFallback({
          strategyId: cfg.strategyId,
          mint,
          symbol: ot.symbol,
          snapshotPx: snapshotPxForAlerts,
          probeUsd,
          solUsd: 0,
          dexSource: ot.source,
          reason: 'exception',
          errorMessage: 'solUsd missing — Jupiter probe skipped',
        });
      } else {
        try {
          const fq = await liveFetchBuyQuote({
            cfg: liveOscarCfg,
            outputMint: mint,
            sizeUsd: probeUsd,
            solUsd,
          });
          if (!fq) {
            void notifyLiveTrackerJupiterFallback({
              strategyId: cfg.strategyId,
              mint,
              symbol: ot.symbol,
              snapshotPx: snapshotPxForAlerts,
              probeUsd,
              solUsd,
              dexSource: ot.source,
              reason: 'quote-null',
            });
          } else {
            const fit = tokenUsdFromBuyQuoteFitDecimals(fq.quoteResponse, solUsd, hintDec, anchorPx);
            const jpx = fit?.px;
            if (jpx == null || !(jpx > 0)) {
              void notifyLiveTrackerJupiterFallback({
                strategyId: cfg.strategyId,
                mint,
                symbol: ot.symbol,
                snapshotPx: snapshotPxForAlerts,
                probeUsd,
                solUsd,
                dexSource: ot.source,
                reason: 'jupiter-price-null',
              });
            } else {
              const fittedDec = fit!.decimalsUsed;
              if (fittedDec !== hintDec && ot.tokenDecimals !== fittedDec) {
                log.warn(
                  {
                    mint: mint.slice(0, 8),
                    symbol: ot.symbol,
                    hintDec,
                    fittedDec,
                  },
                  'live tracker: adjusted mint decimals from Jupiter quote vs entry anchor (MTM)',
                );
                ot.tokenDecimals = fittedDec;
              }
              const divergeVsAnchor =
                anchorPx > 0 ? Math.abs(anchorPx - jpx) / Math.max(anchorPx, 1e-18) : 0;
              const jupiterSaneVsEntry = !(anchorPx > 0) || divergeVsAnchor <= 2;
              if (jupiterSaneVsEntry) {
                curMetric = jpx;
                const divergeVsSnap =
                  snapPx > 0 ? Math.abs(snapPx - jpx) / Math.max(jpx, 1e-18) : Number.POSITIVE_INFINITY;
                if (snapPx > 0 && divergeVsSnap > 0.035) {
                  log.warn(
                    {
                      mint: mint.slice(0, 8),
                      symbol: ot.symbol,
                      snapshotPx: snapPx,
                      jupiterPx: jpx,
                      divergePct: +(divergeVsSnap * 100).toFixed(2),
                    },
                    'live tracker: PG snapshot vs Jupiter tradable price; using Jupiter for decisions',
                  );
                  void notifyLiveTrackerSnapshotJupiterDivergence({
                    strategyId: cfg.strategyId,
                    mint,
                    symbol: ot.symbol,
                    snapshotPx: snapPx,
                    jupiterPx: jpx,
                    divergePct: divergeVsSnap * 100,
                    probeUsd,
                    avgEntryMarket: ot.avgEntryMarket,
                  });
                } else if (!(snapPx > 0)) {
                  log.warn(
                    { mint: mint.slice(0, 8), symbol: ot.symbol, jupiterPx: jpx },
                    'live tracker: PG price missing; using Jupiter MTM',
                  );
                }
              } else {
                log.warn(
                  {
                    mint: mint.slice(0, 8),
                    symbol: ot.symbol,
                    snapshotPx: snapPx,
                    jupiterPx: jpx,
                    anchorPx,
                    divergeVsAnchorPct: +(divergeVsAnchor * 100).toFixed(1),
                  },
                  'live tracker: Jupiter MTM conflicts with entry anchor; keeping PG / entry fallback',
                );
                if (snapPx > 0) curMetric = snapPx;
                else if (anchorPx > 0) curMetric = anchorPx;
                else curMetric = jpx;
              }
            }
          }
        } catch (e) {
          log.warn(
            { mint: mint.slice(0, 8), err: (e as Error)?.message },
            'live tracker: Jupiter probe failed; keeping snapshot price',
          );
          void notifyLiveTrackerJupiterFallback({
            strategyId: cfg.strategyId,
            mint,
            symbol: ot.symbol,
            snapshotPx: snapshotPxForAlerts,
            probeUsd,
            solUsd,
            dexSource: ot.source,
            reason: 'exception',
            errorMessage: (e as Error)?.message,
          });
        }
      }
    }

    await sleep(120);

    if (curMetric > 0) {
      ot.lastObservedPriceUsd = curMetric;
    }

    const ageH = (Date.now() - ot.entryTs) / 3_600_000;

    // ----- W7.5 — liquidity drain watch (before TP/SL/TRAIL and NO_DATA stall close) -----
    if (cfg.liqWatchEnabled && ot.pairAddress && (ot.entryLiqUsd ?? 0) > 0) {
      const positionAgeMs = Math.max(0, Date.now() - ot.entryTs);
      const load = await loadCurrentPoolLiqUsd({
        pairAddress: ot.pairAddress,
        source: ot.source as DexSource,
        cfg,
      });
      const verdict = evaluateLiqDrainState({
        cfg,
        entryLiqUsd: ot.entryLiqUsd!,
        load,
        consecutiveFailures: ot.liqWatchConsecutiveFailures ?? 0,
        positionAgeMs,
      });

      if (verdict.kind === 'pending') {
        ot.liqWatchConsecutiveFailures = verdict.consecutiveFailures;
        ot.liqWatchLastLiqUsd = verdict.currentLiqUsd;
      } else if (verdict.kind === 'ok') {
        ot.liqWatchConsecutiveFailures = 0;
        ot.liqWatchLastLiqUsd = verdict.currentLiqUsd;
        ot.liqWatchLastDropPct = verdict.dropPct;
      } else if (verdict.kind === 'force-close' && cfg.liqWatchForceClose) {
        ot.liqWatchConsecutiveFailures = cfg.liqWatchConsecutiveFailures;
        const rawPx =
          ot.lastObservedPriceUsd ??
          ot.legs[0]?.marketPrice ??
          ot.avgEntryMarket ??
          ot.avgEntry ??
          0;
        const marketSell = Number(rawPx) > 0 ? Number(rawPx) : ot.avgEntry > 0 ? ot.avgEntry : 0;
        const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
        const { effectivePrice: effectiveSell } = applyExitCosts(
          cfg,
          marketSell,
          ot.dex,
          Math.max(1, investedRemaining),
          null,
        );
        const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
        const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
        const perTxClose = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
        const ct = buildClosedTrade({
          cfg,
          ot,
          marketSell,
          effectiveSell,
          exitReason: 'LIQ_DRAIN',
          ageH,
          networkFeeUsdPerTx: perTxClose,
        });
        const exitContext = buildExitContext({
          cfg: effCfg,
          ot,
          closePnlPct: ct.pnlPct,
          ageH,
          exitReason: 'LIQ_DRAIN',
          curMetric: marketSell,
          xAvg: ot.avgEntry > 0 ? marketSell / ot.avgEntry : 1,
          tpLadder,
          liqDrop: {
            dropPct: verdict.dropPct,
            entryLiqUsd: ot.entryLiqUsd ?? 0,
            currentLiqUsd: verdict.currentLiqUsd,
            ageMs: verdict.ageMs,
          },
        });
        ct.exitContext = exitContext;
        if (livePhase4 && marketSell > 0 && investedRemaining > 1e-6) {
          const ok = await livePhase4.tryTokenToSolSell({
            mint,
            symbol: ot.symbol,
            usdNotional: investedRemaining,
            priceUsdPerToken: marketSell,
            decimals: ot.tokenDecimals ?? 6,
            intentKind: 'sell_full',
          });
          if (!ok.ok) continue;
        }
        clearExitCloseDeferForMint(mint);
        clearExitPartialDeferForMint(mint);
        open.delete(mint);
        closed.push(ct);
        stats.closed.LIQ_DRAIN++;
        const mcUsdLive_close = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        journalAppend({
          kind: 'close',
          ...ct,
          peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
          btc_exit: btcCtx(),
          exit_market_price: marketSell,
          exit_effective_price: effectiveSell,
          exit_swaps: exitSwaps,
          mcUsdLive: mcUsdLive_close,
          priorityFee: pfClose,
          exitContext,
          liqWatch: {
            source: verdict.from,
            entryLiqUsd: ot.entryLiqUsd,
            currentLiqUsd: verdict.currentLiqUsd,
            dropPct: verdict.dropPct,
            ageMs: verdict.ageMs,
            consecutiveFailures: cfg.liqWatchConsecutiveFailures,
            ts: verdict.ts,
          },
        });
        journalLiveStrategy?.({
          kind: 'live_position_close',
          mint,
          closedTrade: serializeClosedTrade(ct),
        });
        recordLossExitIfApplicable(cfg, mint, ct.exitTs, ct.netPnlUsd);
        scheduleTailAfterLiveClose(
          liveOscarCfg,
          mint,
          ot.symbol,
          ot.tokenDecimals ?? 6,
          marketSell,
          ot.source,
        );
        peakStateByMint.delete(mint);
        console.log(
          `[LIQ_DRAIN] ${mint.slice(0, 8)} $${ot.symbol} drop=${verdict.dropPct.toFixed(1)}% liq=$${verdict.currentLiqUsd.toFixed(0)}`,
        );
        continue;
      } else if (verdict.kind === 'force-close' && !cfg.liqWatchForceClose) {
        log.warn(
          { mint: mint.slice(0, 8), dropPct: verdict.dropPct, currentLiqUsd: verdict.currentLiqUsd },
          'liq-watch force-close suppressed (shadow)',
        );
        ot.liqWatchLastLiqUsd = verdict.currentLiqUsd;
        ot.liqWatchLastDropPct = verdict.dropPct;
      }

      if (cfg.liqWatchStampOnTrack) {
        journalAppend({
          kind: 'liq_watch_tick',
          mint,
          verdict,
        });
      }
    }

    if (!(curMetric > 0)) {
      if (ageH >= effCfg.timeoutHours) {
        const pfCloseNd = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
        const perTxNd = pfCloseNd.usd > 0 ? pfCloseNd.usd : cfg.networkFeeUsd;
        const ct = buildClosedTrade({
          cfg,
          ot,
          marketSell: 0,
          effectiveSell: 0,
          exitReason: 'NO_DATA',
          ageH,
          networkFeeUsdPerTx: perTxNd,
        });
        const exitContextNd = buildExitContext({
          cfg: effCfg,
          ot,
          closePnlPct: ct.pnlPct,
          ageH,
          exitReason: 'NO_DATA',
          curMetric: 0,
          xAvg: 0,
          tpLadder,
        });
        ct.exitContext = exitContextNd;
        clearExitCloseDeferForMint(mint);
        clearExitPartialDeferForMint(mint);
        open.delete(mint);
        closed.push(ct);
        stats.closed.NO_DATA++;
        const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
        const mcUsdLive_closeNd = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        const liqWatchNoData = await buildOptionalLiqWatchCloseStamp(cfg, ot);
        journalAppend({
          kind: 'close',
          ...ct,
          peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
          btc_exit: btcCtx(),
          exit_swaps: exitSwaps,
          mcUsdLive: mcUsdLive_closeNd,
          priorityFee: pfCloseNd,
          exitContext: exitContextNd,
          ...(liqWatchNoData ? { liqWatch: liqWatchNoData } : {}),
        });
        journalLiveStrategy?.({
          kind: 'live_position_close',
          mint,
          closedTrade: serializeClosedTrade(ct),
        });
        recordLossExitIfApplicable(cfg, mint, ct.exitTs, ct.netPnlUsd);
        peakStateByMint.delete(mint);
        console.log(`[NO_DATA] ${mint.slice(0, 8)} $${ot.symbol}`);
      }
      continue;
    }

    const firstPrice = ot.legs[0]?.price || ot.entryMcUsd;
    const dropFromFirstPct = curMetric / firstPrice - 1;
    const xAvg = curMetric / ot.avgEntry;
    const pnlPctVsAvg = (xAvg - 1) * 100;
    const tgEff = tpGridEffective(ot, effCfg);

    if (curMetric > ot.peakMcUsd) {
      const wasArmed = ot.trailingArmed;
      ot.peakMcUsd = curMetric;
      ot.peakPnlPct = pnlPctVsAvg;
      if (xAvg >= effCfg.trailTriggerX) ot.trailingArmed = true;
      const ps = peakStateByMint.get(mint) || { lastPersistedPeak: -Infinity };
      if ((!wasArmed && ot.trailingArmed) || pnlPctVsAvg >= ps.lastPersistedPeak + effCfg.peakLogStepPct) {
        ps.lastPersistedPeak = pnlPctVsAvg;
        peakStateByMint.set(mint, ps);
        journalAppend({
          kind: 'peak',
          mint,
          peakMcUsd: ot.peakMcUsd,
          peakPnlPct: ot.peakPnlPct,
          trailingArmed: ot.trailingArmed,
        });
      }
    }

    const killEff = dcaKillstopEffective(ot, effCfg);
    const mayDca =
      (tgEff.stepPnl <= 0 || ot.partialSells.length === 0) &&
      (dcaLevels.length > 0 || killEff < 0) &&
      ot.remainingFraction > 0;
    if (mayDca) {
      const effPrevDrop = dcaEffPrev(ot);
      for (let dcaIdx = 0; dcaIdx < dcaLevels.length; dcaIdx++) {
        const lvl = dcaLevels[dcaIdx]!;
        if (dcaStepOrTriggerTaken(ot, dcaIdx, lvl.triggerPct)) continue;
        if (!dcaCrossedDownward(effPrevDrop, dropFromFirstPct, lvl.triggerPct)) continue;
        ot.livePendingScaleIn = null;
        const addUsd = cfg.positionUsd * lvl.addFraction;
        let dcaBuyRes: LiveBuyPipelineResult | undefined;
        if (livePhase4) {
          if (!open.has(mint)) continue;
          dcaBuyRes = await livePhase4.trySolToTokenBuy({
            mint,
            symbol: ot.symbol,
            usdNotional: addUsd,
          });
          if (!dcaBuyRes.ok) continue;
        }
        const marketBuy = curMetric;
        const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);
        ot.legs.push({
          ts: Date.now(),
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
        if (cfg.liveExitModeAbEnabled) ot.liveExitProfileMode = 'B';
        if (livePhase4 && dcaBuyRes) {
          appendLiveBuyAnchorsAfterDca(ot, dcaBuyRes);
        }
        const mcUsdLive_dca = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        const pfDca = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
        journalAppend({
          kind: 'dca_add',
          mint,
          ts: Date.now(),
          price: effectiveBuy,
          marketPrice: marketBuy,
          sizeUsd: addUsd,
          dcaStepIndex: dcaIdx,
          dcaLevelsTotal: dcaLevels.length,
          triggerPct: lvl.triggerPct,
          avgEntry: ot.avgEntry,
          avgEntryMarket: ot.avgEntryMarket,
          totalInvestedUsd: ot.totalInvestedUsd,
          legCount: ot.legs.length,
          mcUsdLive: mcUsdLive_dca,
          priorityFee: pfDca,
          ...(cfg.liveExitModeAbEnabled
            ? {
                timelineLabelRu: `DCA шаг ${dcaIdx + 1}/${dcaLevels.length} (${(lvl.triggerPct * 100).toFixed(0)}%) · режим выхода B`,
                liveExitProfileMode: 'B' as const,
              }
            : {}),
        });
        journalLiveStrategy?.({
          kind: 'live_position_dca',
          mint,
          openTrade: serializeOpenTrade(ot),
        });
        console.log(
          `[DCA] ${mint.slice(0, 8)} $${ot.symbol} +$${addUsd.toFixed(0)} @trigger=${(lvl.triggerPct * 100).toFixed(0)}% step=${dcaIdx + 1}/${dcaLevels.length} avgEff=${ot.avgEntry.toFixed(8)}`,
        );
      }
    }

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
          const r = await tryExecuteTpPartialSell({
            mint,
            ot,
            cfg: effCfg,
            curMetric,
            sellFraction: sellFrac,
            ladderStepIndex: k - 1,
            ladderRungsTotal: 0,
            ladderPnlPct: threshold,
            tpGrid: true,
            journalAppend,
            journalLiveStrategy,
            livePhase4,
            stats,
            markLadder: () => ladderPnlThresholdMark(ot.ladderUsedLevels, threshold),
            logLabelPct: `TPgrid+${(threshold * 100).toFixed(0)}%`,
          });
        if (r === 'abort_mint') {
          break;
        }
        if (r === 'defer_next') {
          break;
        }
      }
    }

    if (tpLadder.length > 0 && ot.remainingFraction > 0) {
      for (let stepIdx = 0; stepIdx < tpLadder.length; stepIdx++) {
        const lvl = tpLadder[stepIdx]!;
        if (ladderStepOrThresholdTaken(ot, stepIdx, lvl.pnlPct)) continue;
        if (xAvg - 1 >= lvl.pnlPct) {
          const r = await tryExecuteTpPartialSell({
            mint,
            ot,
            cfg: effCfg,
            curMetric,
            sellFraction: lvl.sellFraction,
            ladderStepIndex: stepIdx,
            ladderRungsTotal: tpLadder.length,
            ladderPnlPct: lvl.pnlPct,
            tpGrid: false,
            journalAppend,
            journalLiveStrategy,
            livePhase4,
            stats,
            markLadder: () => markLadderStepFired(ot, stepIdx, lvl.pnlPct),
            logLabelPct: `TP+${(lvl.pnlPct * 100).toFixed(0)}%`,
          });
          if (r === 'abort_mint') {
            continue;
          }
          if (r === 'defer_next') {
            continue;
          }
        }
      }
    }

    /** Вторая нога — после оценки частичных TP: не докупать, если уже была ступень сетки (меньше «жирного» усреднения перед kill). */
    if (
      livePhase4 &&
      liveOscarCfg &&
      ot.livePendingScaleIn &&
      ot.partialSells.length === 0
    ) {
      await tryLiveEntryScaleInTrackerStep({
        cfg,
        ot,
        mint,
        curMetric,
        livePhase4,
        liveOscarCfg,
        journalAppend,
        journalLiveStrategy,
        verifyStillOpen: () => open.has(mint),
      });
    }

    let exitReason: ExitReason | null = null;
    if (killEff < 0 && pnlPctVsAvg / 100 <= killEff) exitReason = 'KILLSTOP';
    else if (xAvg >= effCfg.tpX) exitReason = 'TP';
    else if (effCfg.slX > 0 && xAvg <= effCfg.slX) exitReason = 'SL';
    else if (
      effCfg.trailMode === 'ladder_retrace' &&
      ladderRetraceTriggered(
        ot,
        tpLadder,
        xAvg,
        tgEff.stepPnl > 0 ? 'grid' : 'discrete',
        tgEff.firstRungRetraceMinPnlPct,
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
      const exitSwaps = await fetchContextSwaps(cfg, mint, Date.now());
      const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
      const perTxClose = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
      const ct = buildClosedTrade({
        cfg,
        ot,
        marketSell,
        effectiveSell,
        exitReason,
        ageH,
        networkFeeUsdPerTx: perTxClose,
      });
      const exitContextMain = buildExitContext({
        cfg: effCfg,
        ot,
        closePnlPct: ct.pnlPct,
        ageH,
        exitReason,
        curMetric,
        xAvg,
        tpLadder,
      });
      ct.exitContext = exitContextMain;
      const prevCloseDefers = exitCloseVerifyDefersByMint.get(mint) ?? 0;
      const maxEsc = cfg.priceVerifyExitMaxDefersEscalation;
      /** After N verify defers, force proceed on full exit (TRAIL/KILLSTOP etc.), same cap as partial escalation. */
      const escalateCloseVerify = maxEsc > 0 && prevCloseDefers >= maxEsc;
      const exitPvClose = await exitPriceVerifyGate({
        cfg,
        mint,
        symbol: ot.symbol,
        tokenDecimals: ot.tokenDecimals ?? 6,
        usdNotional: investedRemaining,
        snapshotPriceUsd: marketSell,
        context: 'close',
        journalAppend,
        stats,
        /** TIMEOUT bypasses verify immediately; other reasons escalate after `priceVerifyExitMaxDefersEscalation` defers. */
        ignoreBlockOnFail: escalateCloseVerify || exitReason === 'TIMEOUT',
      });
      if (exitPvClose.defer) {
        const n = (exitCloseVerifyDefersByMint.get(mint) ?? 0) + 1;
        exitCloseVerifyDefersByMint.set(mint, n);
        journalLiveStrategy?.({
          kind: 'live_exit_verify_defer',
          mint,
          context: 'close',
          phase: 'defer',
          consecutiveDefers: n,
          verdictSummary: priceVerifyVerdictSummary(exitPvClose.verdict),
          exitReason,
        });
        continue;
      }
      if (escalateCloseVerify && exitPvClose.verdict?.kind === 'blocked') {
        journalLiveStrategy?.({
          kind: 'live_exit_verify_defer',
          mint,
          context: 'close',
          phase: 'escalate_proceed',
          consecutiveDefers: prevCloseDefers,
          verdictSummary: priceVerifyVerdictSummary(exitPvClose.verdict),
          exitReason,
        });
      }
      if (exitPvClose.verdict == null || exitPvClose.verdict.kind !== 'blocked') {
        clearExitCloseDeferForMint(mint);
      }

      if (livePhase4 && marketSell > 0 && investedRemaining > 1e-6) {
        const ok = await livePhase4.tryTokenToSolSell({
          mint,
          symbol: ot.symbol,
          usdNotional: investedRemaining,
          priceUsdPerToken: marketSell,
          decimals: ot.tokenDecimals ?? 6,
          intentKind: 'sell_full',
        });
        if (!ok.ok) continue;
      }
      open.delete(mint);
      clearExitCloseDeferForMint(mint);
      clearExitPartialDeferForMint(mint);
      closed.push(ct);
      const statKey: ExitReason = exitReason === 'KILLSTOP' ? 'SL' : exitReason;
      if (stats.closed[statKey] != null) stats.closed[statKey]++;
      const mcUsdLive_close = await getLiveMcUsd(
        mint,
        ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
      );
      const liqWatchExit = await buildOptionalLiqWatchCloseStamp(cfg, ot);
      journalAppend({
        kind: 'close',
        ...ct,
        peak_pnl_pct: +ot.peakPnlPct.toFixed(2),
        btc_exit: btcCtx(),
        exit_market_price: marketSell,
        exit_effective_price: effectiveSell,
        exit_swaps: exitSwaps,
        mcUsdLive: mcUsdLive_close,
        priorityFee: pfClose,
        exitContext: exitContextMain,
        ...(liqWatchExit ? { liqWatch: liqWatchExit } : {}),
        ...(exitPvClose.verdict ? { priceVerifyExit: exitPvClose.verdict } : {}),
      });
      journalLiveStrategy?.({
        kind: 'live_position_close',
        mint,
        closedTrade: serializeClosedTrade(ct),
      });
      recordLossExitIfApplicable(cfg, mint, ct.exitTs, ct.netPnlUsd);
      scheduleTailAfterLiveClose(
        liveOscarCfg,
        mint,
        ot.symbol,
        ot.tokenDecimals ?? 6,
        marketSell,
        ot.source,
      );
      peakStateByMint.delete(mint);
      const arrow = ct.pnlPct >= 0 ? '+' : '';
      console.log(
        `[${exitReason}] ${mint.slice(0, 8)} $${ot.symbol} pnl_net=${arrow}${ct.pnlPct.toFixed(1)}%/$${ct.netPnlUsd.toFixed(2)} legs=${ot.legs.length} sells=${ot.partialSells.length} age=${ageH.toFixed(1)}h`,
      );
    }

    if (curMetric > 0 && open.has(mint) && Number.isFinite(dropFromFirstPct)) {
      const ote = open.get(mint);
      if (ote) ote.dcaLastEvalDropFromFirstPct = dropFromFirstPct;
    }
  }
}
