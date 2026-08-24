import path from 'node:path';
import { executeCopyBuy, executeCopySell } from '../copytrader/executor.js';
import { checkCopyFundingGate } from '../copytrader/funding-gate.js';
import { fetchMintBalanceRaw } from '../copytrader/live-exec.js';
import type { MildDipConfig } from './config.js';
import {
  collectCandidateMints,
  enrichAndFilterCandidates,
  ownTapeWakeMints,
  priorityMintsFromCooldown,
  priorityMintsFromKnifeWatch,
  priorityMintsFromLastExit,
  priorityMintsFromRecentTrades,
  resolveKnifeDipPct,
  type MildDipCandidate,
} from './discover.js';
import { closeEmptyAtas } from './close-empty-ata.js';
import {
  appendLeaderGateShadowOutcome,
  attemptMirrorFirstClipLeg,
  attemptMildDipEntry,
  mirrorFirstClipWindowBaseMs,
  mirrorEntryAttemptOutcome,
  takeLeaderGateShadowDeferSlot,
} from './entry-attempt.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import {
  leaderBalanceGuardReason,
  leaderFlatReconcileDecision,
  readLeaderBalance,
  readLeaderBalanceForGuard,
} from './leader-balance.js';
import { maybeAlertMildDipDexLoad } from './dex-load.js';
import {
  evaluateFastPathCandidate,
  fastPathChasePct,
  getStructuralCache,
  structuralFromDexDetails,
  streamDrawdownPct,
  shouldJournalGreenLeaderSeenBypass,
  shouldJournalLeaderSeenSkip,
  streamObservabilitySnapshot,
  greenTapeMinuteOptions,
  loadStructural,
  leaderCoBuyAlignOk,
} from './fast-path.js';
import {
  greenMinuteJupiterStats,
  releaseGreenMinuteJupiterRefresh,
  requestGreenMinuteJupiterRefresh,
  tickGreenMinuteJupiterRefresh,
} from './green-minute-jupiter-refresh.js';
import {
  evaluateLeaderMirrorObservation,
  leaderMirrorKnifeWaitPending,
  leaderMirrorDecisionSuppressed,
  leaderMirrorHitKey,
  leaderMirrorNeedsStructuralBackfill,
  leaderMirrorObservationWindowMs,
  leaderMirrorObservationFresh,
  selectLeaderMirrorQuoteKeys,
  type LeaderMirrorMetricSource,
} from './leader-mirror.js';
import {
  isKnifeDipPct,
  upsertKnifeWatch,
  type KnifeStabilizeGates,
} from './knife-stabilize.js';
import {
  dumpFromSignalPct,
  evaluateWaitDipReady,
  isRebuyBelowExitWindow,
  priorityMintsFromWaitDipWatch,
  shouldParkWaitDip,
  upsertWaitDipWatch,
  waitDipDumpTooDeep,
  waitDipTooDeepJournalAllowed,
  type WaitDipGates,
} from './wait-dip.js';
import {
  applyMarkDecisionToPosition,
  decideMarkExit,
  orderMintsForDexRefresh,
  mapPool,
  orderMintsForMark,
  type MarkExitDecision,
} from './exit-engine.js';
import { MONEY_MOTIVATED_EXIT_REASONS, shouldDeferSoftExit } from './exit-defer.js';
import {
  LeaderSellFeed,
  reconcileLeaderBuyEvents,
  reconcileLeaderSellEvents,
  type LeaderSellEvent,
} from './leader-sell-feed.js';
import {
  decideLeaderSellExit,
  isLeaderSellEventValidForPosition,
  mirrorLeaderSellRetryDue,
  selectLatestValidLeaderSellEventForPosition,
  selectNewerLeaderSellEvent,
} from './leader-sell-exit.js';
import { recoverDeferIsCapped } from './recover-defer.js';
import {
  bounceFromTroughPct,
  isRecoveringFromTrough,
  profitExitMinHoldApplies,
  profitExitMinHoldBypassed,
  shouldJournalProfitExitMinHoldSkip,
  tpRungsCoveredByGainPct,
} from './gates.js';
import {
  leaderStyleMinRingSpanMs,
  resolveLeaderStylePairAge,
} from './leader-style.js';
import { evaluateConfirmedTrough } from './confirmed-trough.js';
import { cooldownMsAfterExit } from './cooldown.js';
import {
  leaderSeedHitByMint,
  readLeaderSeedHits,
  type LeaderSeedHit,
} from './discover-extra.js';
import { leaderEverSeenInState } from './leader-seen-gate.js';
import {
  averageEntryAfterScaleIn,
  evaluateLeaderAlignDefer,
  type LeaderAlignHit,
} from './leader-align.js';
import { isRunnerPartialExit } from './sell-partial.js';
import { profitFillMinPriceUsd } from './profit-fill-guard.js';
import { retrySlippageBpsForAttempt } from './exit-retry.js';
import { prioritizeFreshStructuralEntries } from './structural-priority.js';
import { decideExitRefire } from './exit-refire.js';
import { resolveExitMarkFromRing } from './exit-mark.js';
import { peekCopyQuoteBalances } from '../copytrader/funding-gate.js';
import {
  evaluateLeaderStyleEntry,
  shouldJournalLeaderStyleSkip,
} from './leader-style.js';
import { validateStreamDexPrice } from './price-sanity.js';
import {
  mirrorAverageHoldAllowed,
  mirrorAveragePriceAllowed,
  mirrorAverageReference,
  mirrorRecentLocalLow,
} from './mirror-averaging.js';
import {
  computeMarkLiquidityTelemetry,
  readOpenMarkMetrics,
} from './open-mark-metrics.js';
import { requestOpenMarkRefresh } from './open-mark-refresh.js';
import {
  openMarkNeedsJupiterTopUp,
  requestOpenMarkJupiterRefresh,
} from './open-mark-jupiter-refresh.js';
import {
  DEXSCREENER_BATCH_MAX,
  fetchDexScreenerPairCreatedAtMany,
  fetchDexScreenerPairDetails,
  prefetchDexScreenerPairDetailsMany,
  prefetchDexScreenerPairDetailsManyWithMetadata,
} from '../papertrader/pricing/dexscreener-quote-cache.js';
import { parseTokenRaw, settleAfterSuccessfulSell } from './sell-settle.js';
import { resolveSellRemainder } from './sell-remainder.js';
import { sweepUnmanagedOrphans } from './orphan-sweep.js';
import { burnDustOrphans } from './dust-burn.js';
import {
  loadMildDipHotMints,
  mildDipHotMints,
  saveMildDipHotMints,
} from './hot-mints.js';
import {
  loadMildDipPriceRing,
  mildDipPriceRing,
  saveMildDipPriceRing,
} from './price-ring.js';
import {
  appendMildDipJournal,
  loadMildDipState,
  MAX_LEADER_MIRROR_DECISIONS,
  saveMildDipState,
  mildDipStateSaveBlocked,
  type MildDipOpenPosition,
  type MildDipState,
} from './state.js';
import { checkMildDipDiskSpace, runMildDipDataRetention } from './disk-hygiene.js';
import {
  hydrateTradeLotsFromOpen,
  writeUsBuyFill,
  writeUsSellFill,
} from './trade-journal.js';
import {
  accountMirrorCashLeg,
  mirrorOpenMarkValueUsd,
  confirmLossCapObservation,
} from './mirror-loss-cap.js';
import { executionWalletPubkey } from '../copytrader/position-reconcile.js';
import { maybeTopUpFeeSol } from './fee-sol-topup.js';
import {
  evaluateStagedEntryAdd,
  evaluateStagedProfitExit,
  stagedEntryAverageCostPx,
} from './staged-entry.js';
import {
  createDumpSellTape,
  createGivebackDumpGate,
  type DumpClassifyOpts,
} from './dump-classify.js';
import { createOneshotDumpGraceTracker } from './oneshot-dump.js';
import { startMildDipHotMintStream } from './stream.js';
import { createStreamPriceSampler } from './stream-price-sampler.js';
import { MildDipPriceRing } from './price-ring.js';
import { mildDipPairAgeRegistry } from './pair-age-registry.js';
import {
  mirrorOwnStructuralCanApply,
  resolveMirrorStructuralMetrics,
} from './mirror-structural.js';
import {
  DEFAULT_MILD_DIP_TAPE_GATES,
  MildDipTapeShadow,
  type MildDipTapeStructuralSnapshot,
  createMildDipTapeShadowStateSaver,
  loadMildDipTapeShadowState,
  tapeShadowDiscoverySampleDecision,
  tapePairAgeBackfillDue,
  resolveTapeStructuralSnapshotFromCache,
  selectTapeStructuralBatch,
} from './tape-shadow.js';
import {
  HOLDING_DUST_RAW,
  verdictDropEmptyOnNoBalance,
} from './sell-empty-guard.js';

function mirrorLossCapTriggered(cfg: MildDipConfig, state: MildDipState): boolean {
  return cfg.leaderMirror.lossCapUsd > 0 && state.mirrorLossCapTriggeredAtMs != null;
}

function maybeTriggerMirrorLossCap(
  cfg: MildDipConfig,
  state: MildDipState,
  drawdownUsd: number,
  nowMs: number,
): void {
  if (cfg.leaderMirror.lossCapUsd <= 0 || state.mirrorLossCapTriggeredAtMs != null) return;
  if (drawdownUsd <= -cfg.leaderMirror.lossCapUsd) {
    const observation = confirmLossCapObservation({
      drawdownUsd,
      capUsd: cfg.leaderMirror.lossCapUsd,
      pendingDrawdownUsd: state.mirrorLossCapPendingDrawdownUsd,
      pendingAtMs: state.mirrorLossCapPendingAtMs,
      nowMs,
    });
    if (observation.confirmed) {
      state.mirrorLossCapTriggeredAtMs = nowMs;
      state.mirrorLossCapTriggeredPnlUsd = drawdownUsd;
      saveMildDipState(cfg.statePath, state);
      console.warn(
        `[mild-dip] MIRROR LOSS CAP TRIGGERED drawdown=$${drawdownUsd.toFixed(2)} ` +
          `cap=$${cfg.leaderMirror.lossCapUsd.toFixed(2)}`,
      );
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mirror_loss_cap_triggered',
        drawdownUsd,
        lossCapUsd: cfg.leaderMirror.lossCapUsd,
        triggeredAtMs: nowMs,
      });
      return;
    }
    state.mirrorLossCapPendingDrawdownUsd = observation.pendingDrawdownUsd;
    state.mirrorLossCapPendingAtMs = observation.pendingAtMs;
    saveMildDipState(cfg.statePath, state);
    return;
  }
  if (
    state.mirrorLossCapPendingDrawdownUsd != null ||
    state.mirrorLossCapPendingAtMs != null
  ) {
    state.mirrorLossCapPendingDrawdownUsd = undefined;
    state.mirrorLossCapPendingAtMs = undefined;
    saveMildDipState(cfg.statePath, state);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let lastMirrorLossCapStatusMs = 0;
let lastMirrorLossCapEvaluationMs = 0;

function mirrorLossCapValues(state: MildDipState): {
  cashUsd: number;
  bagsUsd: number;
  drawdownUsd: number;
} {
  const cashUsd = state.mirrorTradingCashUsd ?? 0;
  const bagsUsd = Object.values(state.open)
    .filter((position) => position.lane === 'leader_mirror')
    .reduce((sum, position) => sum + mirrorOpenMarkValueUsd(position), 0);
  return { cashUsd, bagsUsd, drawdownUsd: cashUsd + bagsUsd };
}

function ensureMirrorLossCapBaseline(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
): void {
  if (cfg.leaderMirror.lossCapUsd <= 0 || state.mirrorLossCapBaselineAtMs != null) return;
  const bagsUsd = mirrorLossCapValues(state).bagsUsd;
  state.mirrorTradingCashUsd = -bagsUsd;
  state.mirrorLossCapBaselineAtMs = nowMs;
  saveMildDipState(cfg.statePath, state);
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mirror_loss_cap_baseline',
    tradingCashUsd: state.mirrorTradingCashUsd,
    openBagsUsd: bagsUsd,
    openMirror: Object.values(state.open).filter(
      (position) => position.lane === 'leader_mirror',
    ).length,
    baselineAtMs: nowMs,
  });
}

/** Floor for a last partial clip when draining the wallet. */
const MIN_CLIP_USD = 1;

export type MildDipLoopStats = {
  open: number;
  lastScanAtMs: number | null;
  lastMarkAtMs: number | null;
  lastMarkPassMs: number | null;
  lastMarkedOk: number | null;
  lastMarkedNull: number | null;
  mode: string;
  hotMints: number;
  stream: boolean;
};

/**
 * In-flight sells — mint stays in `state.open` until sell settles so a restart
 * or concurrent mark pass cannot orphan / double-buy the bag.
 */
const sellInFlight = new Set<string>();

/** Post-sell balance re-reads while the RPC node still shows the pre-sell bag. */
const SELL_SETTLE_REREADS = 3;

/** In-flight buys — seat reserved in `state.open` before Jupiter send. */
const buyInFlight = new Set<string>();

/** Live loop stats pointer for mark-pass telemetry (set in runMildDipLoop). */
let loopStatsRef: MildDipLoopStats | null = null;
let tryEntriesInFlight = false;
let tryEntriesStartedAtMs = 0;
let tryEntriesStallReportedAtMs = 0;
const TRY_ENTRIES_STALL_THRESHOLD_MS = 60_000;

function openCount(state: MildDipState): number {
  return Object.keys(state.open).length;
}

function onCooldown(state: MildDipState, mint: string, nowMs: number): boolean {
  const until = state.cooldownUntilMs[mint] ?? 0;
  return until > nowMs;
}

/** Sample stream prices for cooldown / open / post-exit / hot / leader-known mints. */
export function shouldSampleStreamPrice(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  nowMs: number,
  lookbackMs: number,
  hotMints = mildDipHotMints,
): boolean {
  const until = state.cooldownUntilMs[mint] ?? 0;
  if (until > nowMs) return true; // actively cooling — record the trough
  if (until > 0 && nowMs - until <= lookbackMs) return true; // just ready — still useful
  if (state.open[mint]) return true; // open book — denser trail marks via stream
  if (state.waitDipWatch?.[mint]) return true; // parked wait-dip needs live marks
  if (state.knifeWatch?.[mint]) return true; // deep-knife watch needs trough marks
  const lastEx = state.lastExitByMint?.[mint]?.atMs ?? 0;
  if (lastEx > 0 && nowMs - lastEx <= lookbackMs) return true; // 1.11.783 post-exit wake
  // Fast-path needs live stream marks on hot names, not only cooldown.
  if (hotMints.isRecent(mint, nowMs, 180_000)) return true;
  /**
   * 1.11.930 — leader-known names must keep own-tape sampling between sessions.
   * 6zjL @ 09:44: hot-mints TTL expired hours after 04:02; one random pump log at
   * 09:09 hit should_sample_false → no drawdown tape before 8zkg's buy.
   */
  if (leaderEverSeenInState(cfg, state, mint, nowMs)) return true;
  return false;
}

function knifeGatesFromCfg(cfg: MildDipConfig): KnifeStabilizeGates {
  return {
    enabled: cfg.knifeStabilizeEnabled,
    minDipPct: cfg.knifeStabilizeMinDipPct,
    maxDipPct: cfg.knifeStabilizeMaxDipPct,
    waitMs: cfg.knifeStabilizeWaitMs,
    maxWatchMs: cfg.knifeStabilizeMaxWatchMs,
    quietMs: cfg.knifeStabilizeQuietMs,
    stabilizeBandPct: cfg.knifeStabilizeBandPct,
    minBouncePct: cfg.knifeStabilizeMinBouncePct,
    maxBouncePct: cfg.knifeStabilizeMaxBouncePct,
  };
}

/**
 * 1.11.783 — when stream fast-path defers a deep knife, arm knifeWatch from the
 * structural cache so own-tape names stay watched (slow enrich may be flat-only).
 */
function maybeArmKnifeWatchFromFastPath(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  nowMs: number,
): void {
  if (!cfg.knifeStabilizeEnabled) return;
  if (state.open[mint] || state.knifeWatch?.[mint]) return;
  const struct = getStructuralCache(mint, nowMs, cfg.fastPathStructuralCacheMs);
  if (!struct) return;
  const streamDd = streamDrawdownPct(mint, cfg.cooldownBounceLookbackMs, nowMs);
  const knifeDip = resolveKnifeDipPct(struct.metrics.priceChange5mPct, streamDd);
  const gates = knifeGatesFromCfg(cfg);
  if (!isKnifeDipPct(knifeDip, gates) || knifeDip == null) return;
  const peak = mildDipPriceRing.maxPrice(mint, cfg.cooldownBounceLookbackMs, nowMs);
  if (!state.knifeWatch) state.knifeWatch = {};
  state.knifeWatch[mint] = upsertKnifeWatch(undefined, {
    nowMs,
    priceUsd: struct.priceUsd,
    dipPct: knifeDip,
    peakPriceUsd: peak?.priceUsd ?? null,
  });
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_knife_watch_start',
    mint,
    knifeDipPct: knifeDip,
    priceUsd: struct.priceUsd,
    troughPriceUsd: state.knifeWatch[mint]!.troughPriceUsd,
    peakPriceUsd: state.knifeWatch[mint]!.peakPriceUsd,
    waitMs: cfg.knifeStabilizeWaitMs,
    source: 'own_tape_fast_path',
  });
  mildDipHotMints.note(mint, nowMs);
  console.log(
    `[mild-dip] KNIFE watch ${mint.slice(0, 8)}… dip=${knifeDip} wait=${cfg.knifeStabilizeWaitMs}ms (own-tape)`,
  );
  saveMildDipState(cfg.statePath, state);
}

function waitDipGatesFromCfg(cfg: MildDipConfig): WaitDipGates {
  return {
    enabled: cfg.waitDipEnabled === true,
    waitDipPct: cfg.waitDipPct,
    maxWatchMs: cfg.waitDipMaxWatchMs,
    maxDumpFromSignalPct: cfg.waitDipMaxDumpFromSignalPct,
    minTroughAgeMs: cfg.waitDipMinTroughAgeMs,
    troughReadyFraction: cfg.waitDipTroughReadyFraction,
    troughMinAgeMs: cfg.waitDipTroughMinAgeMs,
    troughMinBouncePct: cfg.waitDipTroughMinBouncePct,
    troughMaxBouncePct: cfg.waitDipTroughMaxBouncePct,
  };
}

/** Ring age for refresh priority — missing print = +∞ (refresh first). */
function openMarkRingAgeMs(mint: string, nowMs: number): number {
  const last = mildDipPriceRing.lastPrice(mint, nowMs);
  return last ? Math.max(0, nowMs - last.tsMs) : Number.POSITIVE_INFINITY;
}

/**
 * Kick background Dex→ring for one mint. Never await.
 * 1.11.794 — `maxInFlight` uses `markConcurrency` (live 48), not a hard-coded 3.
 */
function maybeRequestOpenMarkRefresh(
  mint: string,
  nowMs: number,
  cfg: Pick<MildDipConfig, 'markDexRefreshMs' | 'markCacheTtlMs' | 'markConcurrency' | 'entry'>,
): void {
  const refreshGap = cfg.markDexRefreshMs;
  if (!(refreshGap > 0)) return;
  const ringAge = openMarkRingAgeMs(mint, nowMs);
  if (ringAge < refreshGap) return;
  const maxInFlight = Math.max(1, Math.min(64, cfg.markConcurrency || 48));
  requestOpenMarkRefresh({
    mint,
    nowMs,
    minGapMs: refreshGap,
    maxInFlight,
    allowedDexIds: cfg.entry.allowedDexIds,
    cacheTtlMs: cfg.markCacheTtlMs > 0 ? cfg.markCacheTtlMs : 15_000,
  });
}

function maybeRequestOpenMarkJupiterRefresh(
  mint: string,
  nowMs: number,
  cfg: Pick<
    MildDipConfig,
    | 'markJupiterRefreshMs'
    | 'markJupiterProbeUsd'
    | 'markJupiterMaxInFlight'
    | 'markJupiterStreamQuietMs'
    | 'markQuarantineJupiterGapMs'
    | 'slippageBps'
  >,
  quarantined = false,
): void {
  const gap = quarantined ? cfg.markQuarantineJupiterGapMs : cfg.markJupiterRefreshMs;
  if (!(gap > 0)) return;
  if (!quarantined && !openMarkNeedsJupiterTopUp(mint, nowMs, cfg.markJupiterStreamQuietMs)) return;
  const snap = mildDipPriceRing.lastPrice(mint, nowMs)?.priceUsd;
  if (!(snap != null && snap > 0)) return;
  requestOpenMarkJupiterRefresh({
    mint,
    nowMs,
    minGapMs: gap,
    maxInFlight: cfg.markJupiterMaxInFlight,
    probeUsd: cfg.markJupiterProbeUsd,
    slippageBps: cfg.slippageBps,
    snapshotPriceUsd: snap,
  });
}

/**
 * Open-book exit mark: read price-ring only (never await HTTP).
 * Stream should feed the ring; `requestOpenMarkRefresh` tops it up in the
 * background when swaps go quiet (EtxCL9 froze at entry through a mcap spike).
 */
function markPriceUsd(
  mint: string,
  nowMs: number,
  cfg: Pick<MildDipConfig, 'markStreamMaxAgeMs' | 'markStreamPreferMaxAgeMs' | 'markDexRefreshMs'>,
  /**
   * 1.11.822 — a sample taken before we bought is not a mark on this position.
   * `6tfuqq`: we filled at 0.00012981 while the ring still held the pre-dip
   * 0.0001596 from 3s earlier, so the first mark printed a phantom +22.95%,
   * armed the trail and ran the whole bank ladder out at the entry price.
   */
  openedAtMs?: number,
): { px: number | null; volume5mUsd: number | null; source: 'stream' | 'dex' | null } {
  const preferStreamMs = cfg.markStreamPreferMaxAgeMs > 0 ? cfg.markStreamPreferMaxAgeMs : 0;
  const streamSample =
    preferStreamMs > 0
      ? mildDipPriceRing.lastPriceBySource(mint, 'stream', nowMs, preferStreamMs)
      : null;
  const dexMaxAge = cfg.markDexRefreshMs > 0 ? cfg.markDexRefreshMs * 3 : 0;
  const dexSample =
    dexMaxAge > 0 ? mildDipPriceRing.lastPriceBySource(mint, 'dex', nowMs, dexMaxAge) : null;
  const last =
    streamSample ??
    dexSample ??
    mildDipPriceRing.lastPrice(mint, nowMs);
  const staleVsEntry =
    last != null && openedAtMs != null && openedAtMs > 0 && last.tsMs < openedAtMs;
  const resolved = resolveExitMarkFromRing({
    last:
      last && !staleVsEntry
        ? {
            priceUsd: last.priceUsd,
            tsMs: last.tsMs,
            source: last.source === 'stream' ? 'stream' : 'dex',
          }
        : null,
    nowMs,
    maxAgeMs: cfg.markStreamMaxAgeMs > 0 ? cfg.markStreamMaxAgeMs : 0,
  });
  return {
    px: resolved.px,
    volume5mUsd: resolved.volume5mUsd,
    source: resolved.source,
  };
}

/** mint → last `mild_dip_mark` journal ts (throttle, process-local). */
const lastMarkJournalMs = new Map<string, number>();

/**
 * mint → last `mild_dip_wait_dip_ready` journal ts (throttle, process-local).
 * A parked seat re-reads ready on every tick; one seat logged 363 identical
 * lines before expiring, which drowns the journal used for entry research.
 */
const lastWaitDipReadyJournalMs = new Map<string, number>();
const WAIT_DIP_READY_JOURNAL_GAP_MS = 15_000;
const lastWaitDipTargetTroughJournalMs = new Map<string, number>();
const WAIT_DIP_TARGET_TROUGH_JOURNAL_GAP_MS = 15_000;
const lastStagedAddSkipJournalMs = new Map<string, number>();
const STAGED_ADD_SKIP_JOURNAL_GAP_MS = 15_000;
const lastMirrorExitSuppressedJournalMs = new Map<string, number>();
const MIRROR_EXIT_SUPPRESSED_JOURNAL_GAP_MS = 15_000;

/**
 * Sample the mark path of an open position into the journal so trail widths can
 * be re-fitted offline on our own trades. Throttled per mint; peak moves and
 * exits are always recorded so the upper envelope is never lost.
 */
function maybeJournalMark(
  cfg: MildDipConfig,
  pos: MildDipOpenPosition,
  decision: MarkExitDecision,
  volume5mUsd: number | null,
  liquidityUsd: number | null,
  nowMs: number,
  source: 'stream' | 'dex' | null,
): void {
  if (cfg.markJournalMs <= 0) return;
  const newPeak = decision.peakPriceUsd > (pos.peakPriceUsd ?? 0);
  const last = lastMarkJournalMs.get(pos.mint) ?? 0;
  if (
    !newPeak &&
    !decision.shouldExit &&
    decision.markQuarantineForceReleased !== true &&
    nowMs - last < cfg.markJournalMs
  ) return;
  lastMarkJournalMs.set(pos.mint, nowMs);
  const liquidityTelemetry = computeMarkLiquidityTelemetry({
    liquidityUsd,
    entryLiquidityUsd: pos.entryLiquidityUsd,
    priceUsd: decision.markPriceUsd,
    entryPriceUsd: pos.entryPriceUsd,
  });
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_mark',
    mint: pos.mint,
    symbol: pos.symbol,
    entryPx: pos.entryPriceUsd,
    /** Mark beside the fill: the basis `pnlPct` / `mfePct` are measured from. */
    entryMarkPx: decision.entryMarketPriceUsd,
    px: decision.markPriceUsd,
    peakPx: decision.peakPriceUsd,
    armed: decision.armed,
    mfePct: +decision.mfePct.toFixed(2),
    givebackPct: +decision.givebackPct.toFixed(2),
    pnlPct: +decision.pnlPct.toFixed(2),
    gainPct: +decision.gainPct.toFixed(2),
    postEntryTroughPriceUsd: decision.postEntryTroughPriceUsd,
    postEntryTroughAtMs: decision.postEntryTroughAtMs,
    bounceOffTroughPct: +decision.bounceOffTroughPct.toFixed(2),
    troughAgeMs: decision.troughAgeMs,
    /** Real money against the fill; differs from `pnlPct` by the entry overpay. */
    pnlPctVsFill: +decision.pnlPctVsFill.toFixed(2),
    heldSec: Math.round(Math.max(0, nowMs - pos.openedAtMs) / 1000),
    vol5m: volume5mUsd,
    entryVol5m: pos.entryVolume5mUsd ?? null,
    liq: liquidityUsd != null ? +liquidityUsd.toFixed(2) : null,
    entryLiq:
      pos.entryLiquidityUsd != null && Number.isFinite(pos.entryLiquidityUsd)
        ? +pos.entryLiquidityUsd.toFixed(2)
        : null,
    liqRatio:
      liquidityTelemetry.liqRatio != null
        ? +liquidityTelemetry.liqRatio.toFixed(4)
        : null,
    depthDrainRatio:
      liquidityTelemetry.depthDrainRatio != null
        ? +liquidityTelemetry.depthDrainRatio.toFixed(4)
        : null,
    liqDrainConfirmTicks: decision.liquidityDrainConfirmTicks ?? 0,
    newPeak,
    source,
    // 1.11.852 — held back pending confirmation. pnl/mfe are not computed for
    // these, so offline analysis must drop them rather than read zeros.
    quarantined: decision.markQuarantined === true,
    quarantineForceReleased: decision.markQuarantineForceReleased === true,
    quarantineBlindMs: decision.markQuarantineBlindMs ?? null,
    quarantineAcceptedSource:
      decision.markQuarantineForceReleased === true ? source : null,
  });
}

/** Reclaim rent on empty mint ATA after full exit (live only). */
async function reclaimEmptyAta(
  cfg: MildDipConfig,
  args: { mint?: string; symbol?: string; reason: string },
): Promise<void> {
  if (cfg.executionMode !== 'live') return;
  const secret = cfg.walletSecret?.trim();
  if (!secret) return;
  try {
    const result = await closeEmptyAtas({
      rpcUrl: cfg.rpcUrl,
      walletSecret: secret,
      mint: args.mint,
    });
    if (result.closed <= 0 && result.errors.length === 0) return;
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_ata_closed',
      reason: args.reason,
      mint: args.mint ?? null,
      symbol: args.symbol ?? null,
      closed: result.closed,
      reclaimedLamports: result.reclaimedLamports,
      reclaimedSol: +(result.reclaimedLamports / 1e9).toFixed(6),
      signatures: result.signatures,
      errors: result.errors.slice(0, 5),
    });
    if (result.closed > 0) {
      console.log(
        `[mild-dip] ATA close ${args.symbol ?? 'sweep'} n=${result.closed} ` +
          `reclaimed=${(result.reclaimedLamports / 1e9).toFixed(4)} SOL`,
      );
    } else if (result.errors.length > 0) {
      console.warn(`[mild-dip] ATA close failed: ${result.errors[0]}`);
    }
  } catch (err) {
    console.warn(
      `[mild-dip] ATA close error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve clip size from wallet USDC. No slot cap when maxOpenPositions=0 —
 * keep spending until the wallet cannot fund the configured minimum clip.
 */
async function resolveEntrySizeUsd(
  cfg: MildDipConfig,
  copyCfg: ReturnType<typeof mildDipToCopyTraderConfig>,
  nowMs: number,
  wantUsd: number,
): Promise<{ sizeUsd: number; stop: boolean; reason?: string; usdc?: number }> {
  const want = wantUsd > 0 ? wantUsd : cfg.positionUsd;
  const full = await checkCopyFundingGate(copyCfg, want, nowMs);
  if (full.ok) return { sizeUsd: want, stop: false, usdc: full.quoteUsd };

  if (full.reason === 'insufficient_usdc') {
    const leftover = Math.floor(full.quoteUsd * 100) / 100;
    const minClipUsd = Math.max(MIN_CLIP_USD, cfg.sizeMinUsd);
    if (leftover + 1e-9 < minClipUsd) {
      return { sizeUsd: 0, stop: true, reason: 'usdc_exhausted', usdc: full.quoteUsd };
    }
    const partial = await checkCopyFundingGate(copyCfg, leftover, nowMs);
    if (partial.ok) return { sizeUsd: leftover, stop: false, usdc: partial.quoteUsd };
    return { sizeUsd: 0, stop: true, reason: partial.reason, usdc: partial.quoteUsd };
  }

  // Fee SOL / RPC — do not keep hammering this scan.
  return { sizeUsd: 0, stop: true, reason: full.reason, usdc: full.quoteUsd };
}

function adoptOnChainHolding(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  mint: string;
  symbol: string;
  tokenRaw: string;
  priceUsd: number;
  pc5m: number | null;
  nowMs: number;
}): void {
  const { cfg, state, mint, symbol, tokenRaw, priceUsd, pc5m, nowMs } = args;
  const sizeUsd =
    priceUsd > 0 ? Number(tokenRaw) / 1e6 * priceUsd : cfg.positionUsd;
  const pos: MildDipOpenPosition = {
    mint,
    symbol,
    entryPriceUsd: priceUsd > 0 ? priceUsd : 0,
    sizeUsd: Number.isFinite(sizeUsd) && sizeUsd > 0 ? sizeUsd : cfg.positionUsd,
    tokenRaw,
    openedAtMs: nowMs,
    entryPc5mPct: pc5m,
    buySignature: null,
    peakPriceUsd: priceUsd > 0 ? priceUsd : 0,
    trailArmed: false,
  };
  state.open[mint] = pos;
  if (priceUsd > 0) {
    mildDipPriceRing.note(mint, priceUsd, { tsMs: nowMs, source: 'dex' });
  }
  saveMildDipState(cfg.statePath, state);
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_adopt_holding',
    mint,
    symbol,
    tokenRaw,
    priceUsd: pos.entryPriceUsd,
    sizeUsd: pos.sizeUsd,
    pc5m,
  });
  console.log(`[mild-dip] ADOPT existing bag ${symbol} mint=${mint.slice(0, 8)}… raw=${tokenRaw}`);
}


function rebuyWindowForMint(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  nowMs: number,
): boolean {
  return isRebuyBelowExitWindow({
    lastExitAtMs: state.lastExitByMint?.[mint]?.atMs,
    nowMs,
    rebuyBelowExitPct: cfg.rebuyBelowExitPct,
    rebuyBelowExitMaxAgeMs: cfg.rebuyBelowExitMaxAgeMs,
  });
}

function clearWaitDipForRebuyWindow(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  nowMs: number,
): boolean {
  const watch = state.waitDipWatch?.[mint];
  if (!watch) return false;
  if (!rebuyWindowForMint(cfg, state, mint, nowMs)) return false;
  delete state.waitDipWatch![mint];
  const last = mildDipPriceRing.lastPrice(mint, nowMs);
  const px = last && last.priceUsd > 0 ? last.priceUsd : watch.lastPriceUsd;
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_wait_dip_expire',
    mint,
    symbol: watch.symbol,
    signalPriceUsd: watch.signalPriceUsd,
    waitDipPct: watch.waitDipPct,
    lastPriceUsd: px,
    reasons: ['wait_dip_cleared_rebuy_window'],
    ageMs: nowMs - watch.detectedAtMs,
  });
  saveMildDipState(cfg.statePath, state);
  console.log(
    `[mild-dip] WAIT_DIP clear-rebuy ${watch.symbol} mint=${mint.slice(0, 8)}… ` +
      `(rebuyBelowExit=${cfg.rebuyBelowExitPct}% — no wait−${Math.abs(cfg.waitDipPct)}% stack)`,
  );
  return true;
}

async function tryFireWaitDip(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  nowMs: number,
): Promise<boolean> {
  if (!cfg.waitDipEnabled) return false;
  const watch = state.waitDipWatch?.[mint];
  if (!watch) return false;
  if (buyInFlight.has(mint) || sellInFlight.has(mint)) return false;
  if (state.open[mint]) {
    delete state.waitDipWatch![mint];
    return false;
  }
  // Post-exit rebuy window: do not hold for extra −7% — fall through to direct buy.
  if (clearWaitDipForRebuyWindow(cfg, state, mint, nowMs)) return false;
  if (onCooldown(state, mint, nowMs)) return false;

  const unlimited = cfg.maxOpenPositions <= 0;
  if (!unlimited && openCount(state) >= cfg.maxOpenPositions) return false;

  const last = mildDipPriceRing.lastPrice(mint, nowMs);
  const px = last && last.priceUsd > 0 ? last.priceUsd : watch.lastPriceUsd;
  const gates = waitDipGatesFromCfg(cfg);
  const confirmedTrough = evaluateConfirmedTrough({
    ring: mildDipPriceRing,
    mint,
    nowMs,
    windowMs: cfg.entryTroughLookbackMs,
    freshPriceUsd: px,
  });
  const verdict = evaluateWaitDipReady(watch, gates, nowMs, px, confirmedTrough);
  if (state.waitDipWatch) {
    state.waitDipWatch[mint] = upsertWaitDipWatch(watch, {
      nowMs,
      priceUsd: px,
      signalPriceUsd: watch.signalPriceUsd,
      waitDipPct: watch.waitDipPct,
      symbol: watch.symbol,
      originalDipSource: watch.originalDipSource,
      metrics: watch.metrics,
    });
  }
  if (verdict.expire) {
    delete state.waitDipWatch![mint];
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_wait_dip_expire',
      mint,
      symbol: watch.symbol,
      signalPriceUsd: watch.signalPriceUsd,
      waitDipPct: watch.waitDipPct,
      lastPriceUsd: px,
      // 1.11.809 — deepest point reached tells "never got deep enough" apart
      // from "got there and we failed to fill", which need opposite fixes.
      troughPriceUsd: watch.troughPriceUsd,
      troughDumpFromSignalPct: dumpFromSignalPct(
        watch.troughPriceUsd,
        watch.signalPriceUsd,
      ),
      reasons: verdict.reasons,
      ageMs: nowMs - watch.detectedAtMs,
    });
    saveMildDipState(cfg.statePath, state);
    return false;
  }
  if (!verdict.ready) {
    if (verdict.reasons.some((reason) => reason.startsWith('wait_dip_target_trough_age='))) {
      const previous = lastWaitDipTargetTroughJournalMs.get(mint) ?? 0;
      if (nowMs - previous >= WAIT_DIP_TARGET_TROUGH_JOURNAL_GAP_MS) {
        lastWaitDipTargetTroughJournalMs.set(mint, nowMs);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_wait_dip_target_trough_defer',
          mint,
          symbol: watch.symbol,
          signalPriceUsd: watch.signalPriceUsd,
          targetPriceUsd: verdict.targetPriceUsd,
          markPriceUsd: px,
          troughAgeMs: confirmedTrough.troughAgeMs,
          troughAtMs: confirmedTrough.troughAtMs,
          minTroughAgeMs: cfg.waitDipMinTroughAgeMs,
          bounceFromTroughPct: confirmedTrough.bounceFromTroughPct,
          dropFromWindowHighPct: confirmedTrough.dropFromWindowHighPct,
          reasons: verdict.reasons,
        });
      }
    }
    return false;
  }
  if (waitDipDumpTooDeep(verdict.dumpFromSignalPct, cfg.waitDipMaxDumpFromSignalPct)) {
    delete state.waitDipWatch![mint];
    if (waitDipTooDeepJournalAllowed(mint, nowMs)) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_wait_dip_too_deep',
        mint,
        symbol: watch.symbol,
        signalPriceUsd: watch.signalPriceUsd,
        priceUsd: px,
        dumpFromSignalPct: verdict.dumpFromSignalPct,
        maxDumpFromSignalPct: cfg.waitDipMaxDumpFromSignalPct,
      });
    }
    saveMildDipState(cfg.statePath, state);
    return false;
  }

  /**
   * 1.11.928 — refloor gate removed: decayed Dex on fill must not kill a ready
   * wait-dip seat (leader co-buy / churn were the live blockers on Ezft93).
   */
  const freshStruct = await loadStructural(mint, cfg, nowMs);
  const leaderSeenAtMs = state.leaderSeenMints?.[mint] ?? null;
  const waitSeedHit =
    cfg.leaderSeedPath != null
      ? leaderSeedHitByMint(
          readLeaderSeedHits(cfg.leaderSeedPath, nowMs, {
            maxAgeMs: cfg.leaderCoBuyAlignMaxMs,
            max: cfg.leaderSeedMax,
          }),
          mint,
        )
      : null;
  const metricsForCoBuy = freshStruct?.metrics ?? watch.metrics;
  const coBuy = leaderCoBuyAlignOk(cfg, metricsForCoBuy, {
    nowMs,
    trigger: 'scan',
    seedHit: waitSeedHit,
    leaderSeenAtMs,
  });
  if (!coBuy.ok) {
    delete state.waitDipWatch![mint];
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_leader_co_buy_skip',
      mint,
      symbol: watch.symbol,
      turn: coBuy.turn,
      minTurn: cfg.leaderCoBuyAlignMinTurn,
      maxAgeMs: cfg.leaderCoBuyAlignMaxMs,
      leaderFresh: coBuy.leaderFresh,
      waitMs: nowMs - watch.detectedAtMs,
      pc5m: metricsForCoBuy.priceChange5mPct ?? null,
    });
    console.log(
      `[mild-dip] SKIP leader co-buy ${watch.symbol} mint=${mint.slice(0, 8)}… ` +
        `turn=${coBuy.turn?.toFixed(4)}<${cfg.leaderCoBuyAlignMinTurn}`,
    );
    return false;
  }

  const candidate: MildDipCandidate = {
    mint,
    symbol: watch.symbol,
    priceUsd: px,
    // Fire on the fresh snapshot, not the one that qualified the seat.
    metrics: freshStruct?.metrics ?? watch.metrics,
    dipSource: 'wait_dip',
    waitDipSignalPriceUsd: watch.signalPriceUsd,
    waitDipOriginalSource: watch.originalDipSource,
    waitDipDumpFromSignalPct: verdict.dumpFromSignalPct,
  };
  const prevReadyJournal = lastWaitDipReadyJournalMs.get(mint) ?? 0;
  if (nowMs - prevReadyJournal >= WAIT_DIP_READY_JOURNAL_GAP_MS) {
    lastWaitDipReadyJournalMs.set(mint, nowMs);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_wait_dip_ready',
      mint,
      symbol: watch.symbol,
      signalPriceUsd: watch.signalPriceUsd,
      targetPriceUsd: verdict.targetPriceUsd,
      markPriceUsd: px,
      dumpFromSignalPct: verdict.dumpFromSignalPct,
      readyPath: verdict.readyPath,
      originalDipSource: watch.originalDipSource,
      waitMs: nowMs - watch.detectedAtMs,
    });
    console.log(
      `[mild-dip] WAIT_DIP ready ${watch.symbol} mint=${mint.slice(0, 8)}… ` +
        `dump=${verdict.dumpFromSignalPct?.toFixed(1)}% from signal ` +
        `(need ${cfg.waitDipPct}%) wait=${Math.round((nowMs - watch.detectedAtMs) / 1000)}s`,
    );
  }

  // Signal-ceiling path: tight chase + fresh Dex; Jupiter premium vs ceiling.
  const chase = cfg.waitDipMaxChasePct;
  const cfgWait = { ...cfg, maxChasePct: cfg.waitDipQuotePremiumPct };
  const copyCfg = mildDipToCopyTraderConfig(cfgWait);
  const result = await attemptMildDipEntry({
    cfg: cfgWait,
    state,
    candidate,
    copyCfg,
    nowMs,
    buyInFlight,
    resolveEntrySizeUsd,
    adoptOnChainHolding,
    opts: {
      chasePct: chase,
      trigger: 'scan',
      skipBounce: true,
      skipOnchainAdopt: true,
      freshDexPrebuy: true,
      softSkipCooldownMs: Math.min(cfg.fastPathSoftSkipCooldownMs, 1_500),
      lane: 'fast',
    },
  });
  return result === 'filled';
}

function parkWaitDipFromCandidate(
  cfg: MildDipConfig,
  state: MildDipState,
  candidate: MildDipCandidate,
  nowMs: number,
): void {
  if (!cfg.waitDipEnabled || !(cfg.waitDipPct < 0)) return;
  if (
    !shouldParkWaitDip({
      dipSource: candidate.dipSource,
      lastExitAtMs: state.lastExitByMint?.[candidate.mint]?.atMs,
      nowMs,
      rebuyBelowExitPct: cfg.rebuyBelowExitPct,
      rebuyBelowExitMaxAgeMs: cfg.rebuyBelowExitMaxAgeMs,
    })
  ) {
    return;
  }
  if (!(candidate.priceUsd > 0)) return;

  if (!state.waitDipWatch) state.waitDipWatch = {};
  const prev = state.waitDipWatch[candidate.mint];
  const next = upsertWaitDipWatch(prev, {
    nowMs,
    priceUsd: candidate.priceUsd,
    signalPriceUsd: prev?.signalPriceUsd ?? candidate.priceUsd,
    waitDipPct: cfg.waitDipPct,
    symbol: candidate.symbol,
    originalDipSource: prev?.originalDipSource ?? candidate.dipSource,
    metrics: prev?.metrics ?? candidate.metrics,
  });
  const isNew = !prev;
  state.waitDipWatch[candidate.mint] = next;
  if (isNew) {
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_wait_dip_start',
      mint: candidate.mint,
      symbol: candidate.symbol,
      signalPriceUsd: next.signalPriceUsd,
      waitDipPct: next.waitDipPct,
      targetPriceUsd: next.signalPriceUsd * (1 + next.waitDipPct / 100),
      originalDipSource: next.originalDipSource,
      maxWatchMs: cfg.waitDipMaxWatchMs,
    });
    console.log(
      `[mild-dip] WAIT_DIP park ${candidate.symbol} mint=${candidate.mint.slice(0, 8)}… ` +
        `signal=$${next.signalPriceUsd.toPrecision(4)} need ${cfg.waitDipPct}% ` +
        `(src=${next.originalDipSource})`,
    );
  }
  saveMildDipState(cfg.statePath, state);
}

async function tryFastPathForMint(
  cfg: MildDipConfig,
  state: MildDipState,
  mint: string,
  trigger: 'stream' | 'leader' | 'scan',
  nowMs: number,
  seedHit?: LeaderSeedHit | null,
): Promise<boolean> {
  if (!cfg.fastPathEnabled) return false;
  if (buyInFlight.has(mint) || sellInFlight.has(mint)) return false;

  if (state.open[mint]) return false;
  // Leader/exit attention → stay on the stream watch list (own tape next).
  if (trigger === 'leader' || trigger === 'stream') {
    mildDipHotMints.note(mint, nowMs);
  }
  if (onCooldown(state, mint, nowMs)) return false;

  const unlimited = cfg.maxOpenPositions <= 0;
  if (!unlimited && openCount(state) >= cfg.maxOpenPositions) return false;

  // Fire parked wait-dip first — must not require re-qualifying the main band.
  if (await tryFireWaitDip(cfg, state, mint, nowMs)) return true;

  let shadowOnly = false;
  let greenOnly = false;
  const greenLeaderGateBypassEnabled = cfg.green.enabled && !cfg.greenRequireLeaderSeen;
  const journalGreenLeaderBypass = (
    site: 'fastpath_first_touch' | 'fastpath',
  ): void => {
    if (!shouldJournalGreenLeaderSeenBypass(mint, site, nowMs)) return;
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_green_leader_seen_bypass',
      mint,
      trigger,
      stage: site,
      greenOnly: true,
      maxAgeMs: cfg.requireLeaderSeenMaxAgeMs,
      ...streamObservabilitySnapshot(
        mint,
        cfg.cooldownBounceLookbackMs,
        nowMs,
        undefined,
        greenTapeMinuteOptions(cfg),
      ),
    });
  };

  /**
   * 1.11.899 — a leader has to have touched a name before we open it for the
   * first time. Repeats on names we already know are not gated.
   *
   * Both halves of this are measured on our own closed positions, and they are
   * independent rather than one standing in for the other:
   *
   *                          first trade      repeat
   *   leader has traded it     -0.1470       -0.0284   USD/pos
   *   only we trade it        -0.3068       -0.0436
   *
   * The penalty for a first touch survives inside each column (five- and
   * seven-fold) and the penalty for a name no leader wants survives inside each
   * row, so both are real. Their intersection is the worst population in the
   * book: 205 positions, 10% of the volume, carrying -62.89 USD of a -162 total
   * at a 41% win rate.
   *
   * 1.11.816 gated the whole funnel this way and starved entry, because our
   * discovery only overlaps the seed by about a tenth. Scoped to the first touch
   * it removes 21% of positions and moves the book from -0.0784 to -0.0546 per
   * position, and a name we already know stays tradeable whatever the seed says.
   */
  const isFirstTouchForLeaderGate = !state.lastExitByMint?.[mint];
  if (
    cfg.requireLeaderSeenFirstTouch &&
    isFirstTouchForLeaderGate &&
    !cfg.requireLeaderSeen &&
    !leaderEverSeenInState(cfg, state, mint, nowMs)
  ) {
    const hit =
      seedHit ??
      leaderSeedHitByMint(
        readLeaderSeedHits(cfg.leaderSeedPath, nowMs, {
          maxAgeMs: cfg.requireLeaderSeenMaxAgeMs,
          max: cfg.leaderSeedMax,
        }),
        mint,
      );
    if (!hit) {
      if (greenLeaderGateBypassEnabled) {
        greenOnly = true;
        journalGreenLeaderBypass('fastpath_first_touch');
      } else {
        if (shouldJournalLeaderSeenSkip(mint, 'fastpath_first_touch', nowMs)) {
          appendMildDipJournal(cfg.journalPath, {
            kind: 'mild_dip_not_leader_seen_skip',
            mint,
            trigger,
            firstTouch: true,
            maxAgeMs: cfg.requireLeaderSeenMaxAgeMs,
            ...streamObservabilitySnapshot(
              mint,
              cfg.cooldownBounceLookbackMs,
              nowMs,
              undefined,
              greenTapeMinuteOptions(cfg),
            ),
          });
        }
        shadowOnly =
          cfg.leaderGateShadowDefer &&
          takeLeaderGateShadowDeferSlot(cfg, mint, nowMs);
        if (!shadowOnly) return false;
      }
    }
  }

  // 1.11.816 — names no leader has touched are the losing half of the book.
  // Checked before the Dex round-trip so it also saves the rate budget.
  if (cfg.requireLeaderSeen && !greenOnly) {
    const hit =
      seedHit ??
      leaderSeedHitByMint(
        readLeaderSeedHits(cfg.leaderSeedPath, nowMs, {
          maxAgeMs: cfg.requireLeaderSeenMaxAgeMs,
          max: cfg.leaderSeedMax,
        }),
        mint,
      );
    if (!hit) {
      if (greenLeaderGateBypassEnabled) {
        greenOnly = true;
        journalGreenLeaderBypass('fastpath');
      } else {
        if (shouldJournalLeaderSeenSkip(mint, 'fastpath', nowMs)) {
          appendMildDipJournal(cfg.journalPath, {
            kind: 'mild_dip_not_leader_seen_skip',
            mint,
            trigger,
            maxAgeMs: cfg.requireLeaderSeenMaxAgeMs,
            ...streamObservabilitySnapshot(
              mint,
              cfg.cooldownBounceLookbackMs,
              nowMs,
              undefined,
              greenTapeMinuteOptions(cfg),
            ),
          });
        }
        shadowOnly =
          cfg.leaderGateShadowDefer &&
          takeLeaderGateShadowDeferSlot(cfg, mint, nowMs);
        if (!shadowOnly) return false;
      }
    }
  }

  /**
   * 1.11.929 — stream/scan must see the same fresh leader seed as the leader
   * wake. Ezft93 @ 07:17:36: 7BNax buy 23s earlier was in the seed file but
   * `leaderSeenMints` still pointed at an hour-old stamp → structural_fail on
   * turn 0.058 < 0.06 despite observer main=true.
   */
  const coBuySeed =
    seedHit ??
    leaderSeedHitByMint(
      readLeaderSeedHits(cfg.leaderSeedPath, nowMs, {
        maxAgeMs: cfg.leaderCoBuyAlignMaxMs,
        max: cfg.leaderSeedMax,
      }),
      mint,
    );

  const candidate = await evaluateFastPathCandidate(
    cfg,
    mint,
    nowMs,
    trigger,
    coBuySeed,
    state.leaderSeenMints?.[mint] ?? null,
    greenOnly,
    shadowOnly
      ? {
          onSkip: (reason, details) =>
            appendLeaderGateShadowOutcome({
              cfg,
              mint,
              nowMs,
              trigger,
              lane: 'fast',
              stage: 'fast_path',
              reason,
              wouldBuy: false,
              details,
            }),
        }
      : undefined,
  );
  if (!candidate) {
    // Deep knife skips entry but must stay on own-tape knife watch.
    if (!shadowOnly && (trigger === 'stream' || trigger === 'scan')) {
      maybeArmKnifeWatchFromFastPath(cfg, state, mint, nowMs);
    }
    return false;
  }
  const shadowCandidate = shadowOnly ? { ...candidate, shadowOnly: true } : candidate;

  // 1.11.753 — park signals; buy only after extra dump from signal.
  // 1.11.758 — skip park for h1_red_shallow + any branch inside rebuy-below-exit window.
  if (
    !shadowOnly &&
    cfg.waitDipEnabled &&
    cfg.waitDipPct < 0 &&
    shouldParkWaitDip({
      dipSource: shadowCandidate.dipSource,
      lastExitAtMs: state.lastExitByMint?.[mint]?.atMs,
      nowMs,
      rebuyBelowExitPct: cfg.rebuyBelowExitPct,
      rebuyBelowExitMaxAgeMs: cfg.rebuyBelowExitMaxAgeMs,
    })
  ) {
    parkWaitDipFromCandidate(cfg, state, shadowCandidate, nowMs);
    // Immediate re-check: already −7% on the same tick (gap fill).
    if (await tryFireWaitDip(cfg, state, mint, nowMs)) return true;
    return false;
  }

  // Build copyCfg with chase aligned to fast-path (Jupiter premium uses maxChasePct).
  const chase = fastPathChasePct(cfg);
  const cfgFast = { ...cfg, maxChasePct: chase };
  const copyCfg = mildDipToCopyTraderConfig(cfgFast);
  const isMild = shadowCandidate.dipSource === 'mild_stabilize';
  const result = await attemptMildDipEntry({
    cfg: cfgFast,
    state,
    candidate: shadowCandidate,
    copyCfg,
    nowMs,
    buyInFlight,
    resolveEntrySizeUsd,
    adoptOnChainHolding,
    opts: {
      chasePct: chase,
      trigger,
      // Bounce path already confirmed reclaim; don't use dump-skip bounce.
      skipBounce: isMild ? true : cfg.fastPathSkipBounce,
      skipOnchainAdopt: true,
      // One structural Dex already done in evaluateFastPath — avoid second round-trip.
      freshDexPrebuy: false,
      softSkipCooldownMs: cfg.fastPathSoftSkipCooldownMs,
      lane: 'fast',
    },
  });
  return result === 'filled';
}

/** Wake parked wait-dip watches even while bags are open (stream may miss quiet names). */
async function wakeWaitDipWatches(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
): Promise<number> {
  if (!cfg.waitDipEnabled || !cfg.fastPathEnabled) return 0;
  const mints = priorityMintsFromWaitDipWatch(state.waitDipWatch);
  if (mints.length === 0) return 0;
  const unlimited = cfg.maxOpenPositions <= 0;
  let n = 0;
  for (const mint of mints) {
    if (!unlimited && openCount(state) >= cfg.maxOpenPositions) break;
    if (state.open[mint]) {
      if (state.waitDipWatch?.[mint]) delete state.waitDipWatch[mint];
      continue;
    }
    await tryFireWaitDip(cfg, state, mint, nowMs);
    n += 1;
  }
  return n;
}

/**
 * Leader buys only highlight mints — we still decide via our gates
 * (main / h1_red / knife_stabilize). Must run even while bags are open;
 * 1.11.739 skipped all tryEntries when open>0 and starved this wake path.
 * 1.11.779 — secondary to stream hot wake.
 */
/**
 * 1.11.906 — remember that a leader traded a mint, for as long as configured.
 *
 * The seed file is a two-hour view by design, so reading it alone makes the
 * first-touch gate stricter than the evidence it was built on: that measurement
 * asked whether a leader had *ever* traded the name. Every seed read unions into
 * this memory, which is what the gate then consults.
 */
function rememberLeaderSeen(
  cfg: MildDipConfig,
  state: MildDipState,
  hits: readonly LeaderSeedHit[],
  nowMs: number,
): void {
  if (cfg.leaderSeenMemoryMs <= 0 || hits.length === 0) return;
  if (!state.leaderSeenMints) state.leaderSeenMints = {};
  const mem = state.leaderSeenMints;
  for (const h of hits) {
    if (!h.mint) continue;
    mem[h.mint] = Math.max(mem[h.mint] ?? 0, h.lastSeenAtMs || nowMs);
    mildDipHotMints.note(h.mint, mem[h.mint]);
  }
  for (const [mint, ts] of Object.entries(mem)) {
    if (nowMs - ts > cfg.leaderSeenMemoryMs) delete mem[mint];
  }
}

function isMirrorFirstClipPending(
  position: MildDipOpenPosition | undefined,
  configuredLegs: number | undefined,
): boolean {
  const legs = Math.max(1, Math.min(2, Math.floor(configuredLegs ?? 1)));
  return (
    position?.lane === 'leader_mirror' &&
    (position.mirrorFirstClipLegsFilled ?? 1) < legs
  );
}

async function wakeLeaderMirrors(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
  leaderSellFeed: LeaderSellFeed | null,
): Promise<number> {
  const gates = cfg.leaderMirror;
  if (!gates.enabled) return 0;
  const mirrorObserveMs = leaderMirrorObservationWindowMs(gates);
  hydrateLeaderMirrorWatches(cfg, state, nowMs);
  const hits = readLeaderSeedHits(cfg.leaderSeedPath, nowMs, {
    maxAgeMs: Math.min(gates.hitMaxAgeMs, 600_000),
    max: cfg.leaderSeedMax,
  });
  for (const hit of hits) {
    const hitKey = leaderMirrorHitKey(hit);
    const watchKey = leaderMirrorWatchKey(hit);
    const existing = leaderMirrorWatches.get(watchKey);
    if (
      !leaderMirrorObservationFresh({
        leaderBuyTsMs: hit.blockTime != null && hit.blockTime > 0 ? hit.blockTime * 1000 : null,
        nowMs,
        maxAgeMs: gates.observationMaxAgeMs,
      })
    ) {
      if (!existing || existing.hitKey !== hitKey) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'leader_mirror_refusal',
          mint: hit.mint,
          leader: hit.leader,
          reason: 'leader_mirror_observation_stale',
          leaderBuyTsMs: hit.blockTime != null && hit.blockTime > 0 ? hit.blockTime * 1000 : null,
          lastSeenAtMs: hit.lastSeenAtMs,
          maxAgeMs: gates.observationMaxAgeMs,
          synthetic: hit.blockTime == null || hit.blockTime <= 0,
        });
      }
      continue;
    }
    if (state.open[hit.mint]) continue;
    if (existing && existing.hitKey !== hitKey) {
      leaderMirrorWatches.set(watchKey, {
        hit,
        hitKey,
        startedAtMs: nowMs,
        expiresAtMs: nowMs + mirrorObserveMs,
        metricSource: leaderMirrorNeedsStructuralBackfill(hit, gates.requireDipCandle) ? 'backfill' : 'seed',
      });
      leaderMirrorDecisions.delete(watchKey);
      leaderMirrorQuoteLastSelectedAtMs.delete(watchKey);
      leaderMirrorQuoteLastSampleTsMs.delete(watchKey);
      leaderMirrorQuoteSampleCount.delete(watchKey);
    } else if (!existing) {
      const prior = leaderMirrorDecisions.get(watchKey);
      if (
        prior &&
        leaderMirrorDecisionSuppressed({
          hit,
          hitKey: prior.hitKey,
          decidedAtMs: prior.decidedAtMs,
          nowMs,
          cooldownMs: gates.cooldownMs,
        })
      ) {
        continue;
      }
      leaderMirrorWatches.set(watchKey, {
        hit,
        hitKey,
        startedAtMs: nowMs,
        expiresAtMs: nowMs + mirrorObserveMs,
        metricSource: leaderMirrorNeedsStructuralBackfill(hit, gates.requireDipCandle) ? 'backfill' : 'seed',
      });
      leaderMirrorQuoteLastSelectedAtMs.delete(watchKey);
      leaderMirrorQuoteLastSampleTsMs.delete(watchKey);
      leaderMirrorQuoteSampleCount.delete(watchKey);
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_observe_start',
        mint: hit.mint,
        leader: hit.leader,
        leaderFillPriceUsd: hit.fillPriceUsd ?? null,
        pc5m: hit.pc5m ?? null,
        pc5mKnown: hit.pc5m != null && Number.isFinite(hit.pc5m),
        metricSource: leaderMirrorNeedsStructuralBackfill(hit, gates.requireDipCandle) ? 'backfill' : 'seed',
        observeMs: gates.observeMs,
      });
    }
  }
  const structuralCandidates = [...leaderMirrorWatches.entries()]
    .filter(
      ([watchKey, watch]) =>
        leaderMirrorNeedsStructuralBackfill(watch.hit, gates.requireDipCandle) &&
        nowMs - (leaderMirrorStructuralAttemptMs.get(watchKey) ?? 0) >= gates.structuralGapMs,
    );
  const backfillEntries = prioritizeFreshStructuralEntries(
    structuralCandidates,
    nowMs,
    gates.entryGraceMs ?? 60_000,
    gates.structuralMaxMints,
    ([, watch]) => watch.startedAtMs,
  );
  const priorityEntries = backfillEntries
    .filter(([, watch]) => nowMs - watch.startedAtMs <= (gates.entryGraceMs ?? 60_000))
    .slice(0, 1);
  const priorityKeys = new Set(priorityEntries.map(([watchKey]) => watchKey));
  const massBackfillEntries = backfillEntries.filter(([watchKey]) => !priorityKeys.has(watchKey));
  const launchStructuralBackfill = (
    entries: typeof backfillEntries,
    priority: boolean,
  ): void => {
    if (entries.length === 0) return;
    const backfillMints = [...new Set(entries.map(([, watch]) => watch.hit.mint))];
    for (const [watchKey] of entries) leaderMirrorStructuralAttemptMs.set(watchKey, nowMs);
    if (priority) leaderMirrorStructuralPriorityInFlight = true;
    else leaderMirrorStructuralInFlight = true;
    const ownStructuralPromise = cfg.mirrorOwnStructuralEnabled
      ? Promise.all(
          backfillMints.map(async (mint) => {
            const quote = mildDipPriceRing.lastPriceBySource(
              mint,
              'leader_mirror_jupiter',
              nowMs,
              gates.quoteMaxAgeMs,
            );
            return [
              mint,
              await resolveMirrorStructuralMetrics({
                mint,
                nowMs,
                rpcUrl: cfg.rpcUrl,
                quotePriceUsd: quote?.priceUsd ?? null,
                registryAgeHours: mildDipPairAgeRegistry.pairAgeHours(mint, nowMs),
                dex: {
                  priceUsd: null,
                  volume5mUsd: null,
                  priceChange5mPct: null,
                  priceChange1hPct: null,
                  liquidityUsd: null,
                  marketCapUsd: null,
                  pairAgeHours: null,
                  dexId: null,
                },
                fallbackConfig: cfg,
              }),
            ] as const;
          }),
        ).then((items) => new Map(items))
      : Promise.resolve(new Map());
    if (cfg.mirrorOwnStructuralEnabled) {
      void ownStructuralPromise
        .then((ownStructural) => {
          for (const [watchKey, startedWatch] of entries) {
            const watch = leaderMirrorWatches.get(watchKey);
            const resolved = ownStructural.get(watch?.hit.mint ?? '');
            if (!watch || watch.hitKey !== startedWatch.hitKey || !resolved) continue;
            const { metrics } = resolved;
            if (!mirrorOwnStructuralCanApply(metrics, watch.hit.pc5m)) continue;
            const pc5m = metrics.priceChange5mPct ?? watch.hit.pc5m;
            leaderMirrorWatches.set(watchKey, {
              ...watch,
              hit: {
                ...watch.hit,
                priceUsd: metrics.priceUsd ?? watch.hit.priceUsd,
                pc5m,
                pc1h: metrics.priceChange1hPct ?? watch.hit.pc1h,
                vol5m: metrics.volume5mUsd ?? watch.hit.vol5m,
                liq: metrics.liquidityUsd ?? watch.hit.liq,
                mcap: metrics.marketCapUsd ?? watch.hit.mcap,
                ageHours: metrics.pairAgeHours ?? watch.hit.ageHours,
              },
              metricSource: 'backfill',
            });
          }
        })
        .catch(() => {
          /* final combined promise journals the failure */
        });
    }
    void Promise.all([
      prefetchDexScreenerPairDetailsManyWithMetadata(backfillMints, {
        nowMs,
        cacheTtlMs: Math.max(gates.structuralGapMs, gates.quoteMaxAgeMs),
        allowedDexIds: cfg.entry.allowedDexIds,
      }),
      ownStructuralPromise,
    ]).then(async ([result, ownStructural]) => {
      if (
        result.uncoveredMints.length > 0 ||
        result.retriedMints.length > 0 ||
        result.errorMints.length > 0 ||
        result.rateLimited429 > 0 ||
        result.cooldownSkipped > 0
      ) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'leader_mirror_structural_backfill_stats',
          mints: backfillMints.length,
          requests: result.requests,
          resolvedMints: result.resolvedMints.length,
          uncoveredMints: result.uncoveredMints.length,
          retriedMints: result.retriedMints.length,
          errorMints: result.errorMints.length,
          rateLimited429: result.rateLimited429,
          cooldownSkipped: result.cooldownSkipped,
          uncoveredMintList: result.uncoveredMints,
          retriedMintList: result.retriedMints,
        });
      }
      for (const [watchKey, startedWatch] of entries) {
        const watch = leaderMirrorWatches.get(watchKey);
        if (!watch || watch.hitKey !== startedWatch.hitKey) continue;
        const mint = watch.hit.mint;
        const details = result.detailsByMint.get(mint);
        const cached = getStructuralCache(mint, nowMs, cfg.fastPathStructuralStaleMs);
        const dexMetrics = details
          ? {
              priceUsd: details.priceUsd,
              pc5m: details.priceChangeM5Pct,
              pc1h: details.priceChangeH1Pct,
              vol5m: details.volume5mUsd,
              liq: details.liquidityUsd,
              mcap: details.marketCapUsd,
              ageHours:
                details.pairCreatedAtMs != null && details.pairCreatedAtMs > 0
                  ? Math.max(0, (nowMs - details.pairCreatedAtMs) / 3_600_000)
                  : null,
              dexId: details.dexId,
            }
          : cached
            ? {
                priceUsd: cached.priceUsd,
                pc5m: cached.metrics.priceChange5mPct,
                pc1h: cached.metrics.priceChange1hPct,
                vol5m: cached.metrics.volume5mUsd,
                liq: cached.metrics.liquidityUsd,
                mcap: cached.metrics.marketCapUsd,
                ageHours: cached.metrics.pairAgeHours,
                dexId: cached.metrics.dexId,
              }
            : null;
        const resolved = ownStructural.get(mint);
        const ownMetrics = resolved?.metrics;
        const ownSources = resolved?.sources;
        const ownCanApply =
          ownMetrics != null &&
          mirrorOwnStructuralCanApply(ownMetrics, watch.hit.pc5m);
        const resolvedMetrics = ownCanApply
          ? {
              priceUsd: ownMetrics.priceUsd ?? dexMetrics?.priceUsd ?? null,
              volume5mUsd: ownMetrics.volume5mUsd ?? dexMetrics?.vol5m ?? null,
              priceChange5mPct: ownMetrics.priceChange5mPct ?? dexMetrics?.pc5m ?? null,
              priceChange1hPct: ownMetrics.priceChange1hPct ?? dexMetrics?.pc1h ?? null,
              liquidityUsd: ownMetrics.liquidityUsd ?? dexMetrics?.liq ?? null,
              marketCapUsd: ownMetrics.marketCapUsd ?? dexMetrics?.mcap ?? null,
              pairAgeHours: ownMetrics.pairAgeHours ?? dexMetrics?.ageHours ?? null,
              dexId: ownMetrics.dexId ?? dexMetrics?.dexId ?? null,
            }
          : null;
        const resolvedSources = ownSources
          ? {
              liquidity:
                ownMetrics?.liquidityUsd != null ? ownSources.liquidity : dexMetrics?.liq != null ? 'dex' : 'missing',
              marketCap:
                ownMetrics?.marketCapUsd != null ? ownSources.marketCap : dexMetrics?.mcap != null ? 'dex' : 'missing',
              pairAge:
                ownMetrics?.pairAgeHours != null ? ownSources.pairAge : dexMetrics?.ageHours != null ? 'dex' : 'missing',
            }
          : null;
        if (resolvedSources) {
          const sourceKey = JSON.stringify(resolvedSources);
          if (
            sourceKey !== leaderMirrorStructuralSourceJournal.get(mint) &&
            Object.values(resolvedSources).some((source) => source !== 'dex')
          ) {
            leaderMirrorStructuralSourceJournal.set(mint, sourceKey);
            appendMildDipJournal(cfg.journalPath, {
              kind: 'leader_mirror_structural_sources',
              mint,
              mcapSource: resolvedSources.marketCap,
              liquiditySource: resolvedSources.liquidity,
              ageSource: resolvedSources.pairAge,
            });
          }
        }
        const metrics = dexMetrics
          ? {
              ...dexMetrics,
              priceUsd: resolvedMetrics?.priceUsd ?? dexMetrics.priceUsd,
              pc5m: resolvedMetrics?.priceChange5mPct ?? dexMetrics.pc5m,
              pc1h: resolvedMetrics?.priceChange1hPct ?? dexMetrics.pc1h,
              vol5m: resolvedMetrics?.volume5mUsd ?? dexMetrics.vol5m,
              liq: resolvedMetrics?.liquidityUsd ?? dexMetrics.liq,
              mcap: resolvedMetrics?.marketCapUsd ?? dexMetrics.mcap,
              ageHours: resolvedMetrics?.pairAgeHours ?? dexMetrics.ageHours,
              dexId: resolvedMetrics?.dexId ?? dexMetrics.dexId,
            }
          : resolvedMetrics
            ? {
                priceUsd: resolvedMetrics.priceUsd ?? cached?.priceUsd ?? null,
                pc5m: resolvedMetrics.priceChange5mPct ?? cached?.metrics.priceChange5mPct ?? null,
                pc1h: resolvedMetrics.priceChange1hPct ?? cached?.metrics.priceChange1hPct ?? null,
                vol5m: resolvedMetrics.volume5mUsd ?? cached?.metrics.volume5mUsd ?? null,
                liq: resolvedMetrics.liquidityUsd,
                mcap: resolvedMetrics.marketCapUsd,
                ageHours: resolvedMetrics.pairAgeHours,
                dexId: resolvedMetrics.dexId,
              }
            : null;
        if (!metrics) continue;
        const hit: LeaderSeedHit = {
          ...watch.hit,
          priceUsd: metrics.priceUsd ?? watch.hit.priceUsd,
          pc5m: metrics.pc5m ?? watch.hit.pc5m,
          pc1h: metrics.pc1h ?? watch.hit.pc1h,
          vol5m: metrics.vol5m ?? watch.hit.vol5m,
          liq: metrics.liq ?? watch.hit.liq,
          mcap: metrics.mcap ?? watch.hit.mcap,
          ageHours: metrics.ageHours ?? watch.hit.ageHours,
          dexId: metrics.dexId ?? watch.hit.dexId,
        };
        if (leaderMirrorWatches.has(watchKey)) {
          leaderMirrorWatches.set(watchKey, { ...watch, hit, metricSource: 'backfill' });
        }
      }
    }).catch((err) => {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_structural_backfill_error',
        error: err instanceof Error ? err.message : String(err),
        mints: backfillMints.length,
      });
    }).finally(() => {
      if (priority) leaderMirrorStructuralPriorityInFlight = false;
      else leaderMirrorStructuralInFlight = false;
    });
  };
  if (priorityEntries.length > 0 && !leaderMirrorStructuralPriorityInFlight) {
    launchStructuralBackfill(priorityEntries, true);
  }
  if (massBackfillEntries.length > 0 && !leaderMirrorStructuralInFlight) {
    launchStructuralBackfill(massBackfillEntries, false);
  }
  const quoteSamples = new Map(
    [...leaderMirrorWatches.entries()].map(([watchKey, watch]) => [
      watchKey,
      mildDipPriceRing.lastPriceBySource(
        watch.hit.mint,
        'leader_mirror_jupiter',
        nowMs,
        gates.quoteMaxAgeMs,
      ),
    ]),
  );
  const quoteCandidates = [...leaderMirrorWatches.entries()].map(
    ([watchKey, watch]) => ({
      watchKey,
      startedAtMs: watch.startedAtMs,
      knifeWaitPending: leaderMirrorKnifeWaitPending({
        hit: watch.hit,
        nowMs,
        leaderBuyTsMs:
          watch.hit.blockTime != null && watch.hit.blockTime > 0
            ? watch.hit.blockTime * 1000
            : null,
        quotePriceUsd: quoteSamples.get(watchKey)?.priceUsd,
        gates,
      }),
      knifeWaitDue:
        nowMs -
          (leaderMirrorQuoteLastSelectedAtMs.get(watchKey) ??
            Number.NEGATIVE_INFINITY) >=
        gates.staleQuoteIntervalMs,
      }),
  );
  const knifeWaitQuoteIntervalMs = Math.max(
    gates.quoteIntervalMs,
    gates.staleQuoteIntervalMs,
  );
  if (
    knifeWaitQuoteWindowStartedAtMs === 0 ||
    nowMs - knifeWaitQuoteWindowStartedAtMs >= knifeWaitQuoteIntervalMs
  ) {
    knifeWaitQuoteWindowStartedAtMs = nowMs;
    knifeWaitQuoteRequestsInWindow = 0;
  }
  const quoteKeys = new Set(
    selectLeaderMirrorQuoteKeys({
      entries: quoteCandidates,
      nowMs,
      entryGraceMs: gates.entryGraceMs ?? 60_000,
      maxQuoteMints: gates.maxQuoteMints,
      knifeWaitQuoteSlots: Math.max(
        0,
        Math.floor(gates.knifeWaitQuoteSlots) -
          knifeWaitQuoteRequestsInWindow,
      ),
      lastQuotedAtMs: leaderMirrorQuoteLastSelectedAtMs,
    }),
  );
  const knifeWaitPendingByWatchKey = new Map(
    quoteCandidates.map((candidate) => [
      candidate.watchKey,
      candidate.knifeWaitPending,
    ]),
  );
  releaseGreenMinuteJupiterRefresh({
    source: 'leader_mirror_jupiter',
    keepMints: new Set(
      [...quoteKeys]
        .map((watchKey) => leaderMirrorWatches.get(watchKey)?.hit.mint)
        .filter((mint): mint is string => mint != null),
    ),
  });
  for (const candidate of quoteCandidates) {
    if (!candidate.knifeWaitPending) continue;
    knifeWaitQuoteWaitingKeys.add(candidate.watchKey);
    if (!quoteKeys.has(candidate.watchKey)) {
      knifeWaitQuoteUncoveredKeys.add(candidate.watchKey);
      continue;
    }
  }
  let filled = 0;
  for (const [watchKey, watch] of leaderMirrorWatches) {
    const mint = watch.hit.mint;
    if (state.open[mint]) {
      leaderMirrorEntryRetryAfterMs.delete(watchKey);
      leaderMirrorWatches.delete(watchKey);
      continue;
    }
    const hit = watch.hit;
    if (nowMs >= watch.expiresAtMs) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_refusal',
        mint,
        leader: hit.leader,
        reason: 'leader_mirror_observe_expired',
        leaderFillPriceUsd: hit.fillPriceUsd ?? null,
        sizeUsd: hit.sizeUsd ?? null,
        metricSource: watch.metricSource,
      });
      leaderMirrorDecisions.set(watchKey, {
        hitKey: watch.hitKey,
        decidedAtMs: nowMs,
        reason: 'leader_mirror_observe_expired',
      });
      leaderMirrorWatches.delete(watchKey);
      continue;
    }
    if ((leaderMirrorEntryRetryAfterMs.get(watchKey) ?? 0) > nowMs) continue;
    const feedSell = leaderSellFeed?.get(mint, nowMs);
    const leaderSell = feedSell && feedSell.leader === hit.leader ? feedSell : null;
    const leaderBuyTsMs =
      hit.blockTime != null && hit.blockTime > 0
        ? hit.blockTime * 1000
        : hit.lastSeenAtMs;
    const leaderBuyTsMsForGrace =
      hit.blockTime != null && hit.blockTime > 0
        ? hit.blockTime * 1000
        : null;
    const entryGraceActive =
      leaderBuyTsMsForGrace != null &&
      nowMs - leaderBuyTsMsForGrace >= 0 &&
      nowMs - leaderBuyTsMsForGrace <= (gates.entryGraceMs ?? 60_000);
    const leaderSellDecision = decideLeaderSellExit({
      enabled: cfg.leaderMirror.leaderSellExitEnabled,
      lane: 'leader_mirror',
      leaders: cfg.leaderMirror.leaders,
      event: leaderSell,
      openedAtMs: leaderBuyTsMs,
      nowMs,
      maxAgeMs: cfg.leaderMirror.leaderSellExitMaxAgeMs,
    });
    if (leaderSellDecision.shouldExit && leaderSell) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_refusal',
        mint,
        leader: leaderSell.leader,
        reason: 'leader_mirror_leader_sell',
        leaderSignature: leaderSell.signature,
        leaderSellBlockTimeMs: leaderSell.blockTimeMs,
        leaderBuyTsMs,
        leaderFillPriceUsd: hit.fillPriceUsd ?? null,
        leaderSellFillPriceUsd: leaderSell.fillPriceUsd,
        leaderSellMarkPnlPct: leaderSell.markPnlPct,
        quotePriceUsd: null,
        pc5m: hit.pc5m ?? null,
        quoteGainPct: null,
        metricSource: watch.metricSource,
      });
      leaderMirrorDecisions.set(watchKey, {
        hitKey: watch.hitKey,
        decidedAtMs: nowMs,
        reason: 'leader_mirror_leader_sell',
      });
      leaderMirrorWatches.delete(watchKey);
      leaderSellFeed?.remove(mint);
      continue;
    }
    if (quoteKeys.has(watchKey)) {
      const quoteRequested = requestGreenMinuteJupiterRefresh({
        mint,
        nowMs,
        snapshotPriceUsd: hit.fillPriceUsd ?? 0,
        enabled: true,
        minGapMs: knifeWaitPendingByWatchKey.get(watchKey)
          ? Math.max(gates.quoteIntervalMs, gates.staleQuoteIntervalMs)
          : entryGraceActive
          ? gates.quoteIntervalMs
          : Math.max(gates.quoteIntervalMs, gates.staleQuoteIntervalMs),
        ttlMs: Math.max(3 * gates.quoteMaxAgeMs, 30_000),
        maxMints: gates.maxQuoteMints,
        maxInFlight: 16,
        priority: knifeWaitPendingByWatchKey.get(watchKey)
          ? 0
          : entryGraceActive
            ? 1
            : 0,
        probeUsd: gates.positionUsd,
        slippageBps: cfg.slippageBps,
        source: 'leader_mirror_jupiter',
      });
      if (quoteRequested) {
        leaderMirrorQuoteLastSelectedAtMs.set(watchKey, nowMs);
        if (knifeWaitPendingByWatchKey.get(watchKey)) {
          knifeWaitQuoteRequestsInWindow += 1;
        }
      }
    }
    const quote = quoteSamples.get(watchKey) ?? null;
    if (
      quote &&
      quote.tsMs > (leaderMirrorQuoteLastSampleTsMs.get(watchKey) ?? 0)
    ) {
      leaderMirrorQuoteLastSampleTsMs.set(watchKey, quote.tsMs);
      leaderMirrorQuoteSampleCount.set(
        watchKey,
        (leaderMirrorQuoteSampleCount.get(watchKey) ?? 0) + 1,
      );
    }
    const decision = evaluateLeaderMirrorObservation({
      hit,
      quotePriceUsd: quote?.priceUsd,
      quoteTsMs: quote?.tsMs,
      leaderBuyTsMs: leaderBuyTsMsForGrace,
      nowMs,
      watchStartedAtMs: watch.startedAtMs,
      gates,
    });
    if (decision.action === 'wait') {
      const waitReason = decision.waitReason ?? 'unknown';
      if (
        watch.lastWaitReason !== waitReason ||
        nowMs - (watch.lastWaitAtMs ?? 0) >= 60_000
      ) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'leader_mirror_wait',
          mint,
          leader: hit.leader,
          waitReason,
          metricSource: watch.metricSource,
          quotePriceUsd: quote?.priceUsd ?? null,
          leaderFillPriceUsd: hit.fillPriceUsd ?? null,
          sizeUsd: hit.sizeUsd ?? null,
          quoteGainPct:
            quote?.priceUsd != null && hit.fillPriceUsd != null && hit.fillPriceUsd > 0
              ? (quote.priceUsd / hit.fillPriceUsd - 1) * 100
              : null,
          entryGraceActive,
          waitedMs: Math.max(0, nowMs - watch.startedAtMs),
        });
        watch.lastWaitReason = waitReason;
        watch.lastWaitAtMs = nowMs;
      }
      continue;
    }
    if (decision.action === 'skip') {
      const quoteGainPct =
        quote?.priceUsd != null && hit.fillPriceUsd != null && hit.fillPriceUsd > 0
          ? (quote.priceUsd / hit.fillPriceUsd - 1) * 100
          : null;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_refusal',
        mint,
        leader: hit.leader,
        reason: decision.reason,
        quotePriceUsd: quote?.priceUsd ?? null,
        leaderFillPriceUsd: hit.fillPriceUsd ?? null,
        sizeUsd: hit.sizeUsd ?? null,
        pc5m: hit.pc5m ?? null,
        pc5mKnown: hit.pc5m != null && Number.isFinite(hit.pc5m),
        quoteGainPct,
        entryGraceActive,
        metricSource: watch.metricSource,
      });
      leaderMirrorDecisions.set(watchKey, {
        hitKey: watch.hitKey,
        decidedAtMs: nowMs,
        reason: decision.reason,
      });
      leaderMirrorWatches.delete(watchKey);
      continue;
    }
    const openMirror = Object.values(state.open).filter(
      (position) => position.lane === 'leader_mirror',
    ).length;
    if (gates.maxOpen > 0 && openMirror >= gates.maxOpen) {
      const quoteGainPct =
        quote?.priceUsd != null && hit.fillPriceUsd != null && hit.fillPriceUsd > 0
          ? (quote.priceUsd / hit.fillPriceUsd - 1) * 100
          : null;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_refusal',
        mint,
        reason: 'leader_mirror_exposure_cap',
        openMirror,
        maxOpen: gates.maxOpen,
        pc5m: hit.pc5m ?? null,
        quoteGainPct,
        metricSource: watch.metricSource,
      });
      leaderMirrorDecisions.set(watchKey, {
        hitKey: watch.hitKey,
        decidedAtMs: nowMs,
        reason: 'leader_mirror_exposure_cap',
      });
      leaderMirrorWatches.delete(watchKey);
      continue;
    }
    if (mirrorLossCapTriggered(cfg, state)) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_refusal',
        mint,
        reason: 'mirror_loss_cap',
        tradingCashUsd: state.mirrorTradingCashUsd ?? 0,
        lossCapUsd: cfg.leaderMirror.lossCapUsd,
      });
      leaderMirrorDecisions.set(watchKey, {
        hitKey: watch.hitKey,
        decidedAtMs: nowMs,
        reason: 'mirror_loss_cap',
      });
      leaderMirrorWatches.delete(watchKey);
      continue;
    }
    const candidate: MildDipCandidate = {
      mint,
      symbol: 'unknown',
      priceUsd: decision.quotePriceUsd,
      dipSource: 'leader_mirror',
      metrics: {
        priceChange5mPct: hit.pc5m ?? null,
        volume5mUsd: hit.vol5m ?? null,
        liquidityUsd: hit.liq ?? null,
        marketCapUsd: hit.mcap ?? null,
        pairAgeHours: hit.ageHours ?? null,
        dexId: hit.dexId ?? null,
        buys5m: null,
        sells5m: null,
        volume1hUsd: null,
        priceChange1hPct: hit.pc1h ?? null,
      },
    };
    const copyCfg = mildDipToCopyTraderConfig(cfg);
    const openMirrorPosition = state.open[mint];
    const firstClipPending =
      openMirrorPosition != null &&
      isMirrorFirstClipPending(openMirrorPosition, cfg.leaderMirror.firstClipLegs);
    let result =
      firstClipPending
        ? await attemptMirrorFirstClipLeg({
            cfg,
            state,
            candidate,
            copyCfg,
            nowMs,
            buyInFlight,
            resolveEntrySizeUsd,
            leader: hit.leader,
          })
        : await attemptMildDipEntry({
            cfg,
            state,
            candidate,
            copyCfg,
            nowMs,
            buyInFlight,
            resolveEntrySizeUsd,
            adoptOnChainHolding,
            opts: {
              chasePct: 0,
              trigger: 'leader',
              skipBounce: true,
              skipOnchainAdopt: true,
              freshDexPrebuy: false,
              softSkipCooldownMs: 1_500,
              lane: 'fast',
              mirror: true,
              mirrorBranch: decision.mirrorBranch,
              leaderBuyTsMs,
              leaderBuySignature: hit.signature,
              leaderMirrorLeader: hit.leader,
              mirrorExecutionRetryBackoffMs: gates.executionRetryBackoffMs,
              mirrorExecutionSlippageMultiplier: gates.executionSlippageMultiplier,
              mirrorExecutionSlippageMaxBps: gates.executionSlippageMaxBps,
              mirrorPc5mKnown: hit.pc5m != null && Number.isFinite(hit.pc5m),
              mirrorEntryGraceActive: entryGraceActive,
              mirrorQuoteGainPct:
                hit.fillPriceUsd != null && hit.fillPriceUsd > 0
                  ? (decision.quotePriceUsd / hit.fillPriceUsd - 1) * 100
                  : null,
              mirrorExit: {
                armPct: gates.exitArmPct,
                trailPct: gates.exitTrailPct,
                stopPct: gates.exitStopPct,
                noMoveCutMs: gates.noMoveCutMs,
                noMoveMinMfePct: gates.noMoveMinMfePct,
                maxHoldMs: gates.maxHoldMs,
              },
            },
          });
    if (
      result === 'filled' &&
      isMirrorFirstClipPending(
        state.open[mint],
        cfg.leaderMirror.firstClipLegs,
      )
    ) {
      result = await attemptMirrorFirstClipLeg({
        cfg,
        state,
        candidate,
        copyCfg,
        nowMs,
        buyInFlight,
        resolveEntrySizeUsd,
        leader: hit.leader,
      });
    }
    const outcome = mirrorEntryAttemptOutcome(result);
    if (outcome === 'filled') {
      if (decision.knifeWait) {
        const entryPriceUsd =
          (state.open as Record<string, { entryPriceUsd?: number }>)[mint]
            ?.entryPriceUsd ?? decision.quotePriceUsd;
        const discountPct =
          hit.fillPriceUsd != null && hit.fillPriceUsd > 0
            ? (1 - entryPriceUsd / hit.fillPriceUsd) * 100
            : null;
        appendMildDipJournal(cfg.journalPath, {
          kind: 'leader_mirror_knife_wait',
          mint,
          leader: hit.leader,
          pc5m: decision.knifeWait.leaderPc5m,
          leaderFillPriceUsd: decision.knifeWait.leaderFillPriceUsd,
          entryPriceUsd,
          discountPct,
          waitedMs: decision.knifeWait.waitedMs,
          quoteCount: leaderMirrorQuoteSampleCount.get(watchKey) ?? 0,
          enteredByDiscount: decision.knifeWait.enteredByDiscount,
          enteredByWindowExpiry: decision.knifeWait.enteredByWindowExpiry,
        });
      }
      leaderMirrorEntryRetryAfterMs.delete(watchKey);
      leaderMirrorWatches.delete(watchKey);
      state.cooldownUntilMs[mint] = nowMs + gates.cooldownMs;
      filled += 1;
    } else if (outcome === 'retry') {
      leaderMirrorEntryRetryAfterMs.set(
        watchKey,
        nowMs + gates.executionRetryBackoffMs,
      );
    } else {
      leaderMirrorEntryRetryAfterMs.delete(watchKey);
      leaderMirrorWatches.delete(watchKey);
      leaderMirrorDecisions.set(watchKey, {
        hitKey: watch.hitKey,
        decidedAtMs: nowMs,
        reason: 'leader_mirror_execution_skip',
      });
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_refusal',
        mint,
        leader: hit.leader,
        reason: 'leader_mirror_execution_skip',
        leaderFillPriceUsd: hit.fillPriceUsd ?? null,
        sizeUsd: hit.sizeUsd ?? null,
        quotePriceUsd: decision.quotePriceUsd ?? null,
        pc5m: hit.pc5m ?? null,
        quoteGainPct:
          hit.fillPriceUsd != null && hit.fillPriceUsd > 0
            ? (decision.quotePriceUsd / hit.fillPriceUsd - 1) * 100
            : null,
        metricSource: watch.metricSource,
      });
    }
  }
  for (const watchKey of leaderMirrorQuoteSampleCount.keys()) {
    if (!leaderMirrorWatches.has(watchKey)) {
      leaderMirrorQuoteLastSelectedAtMs.delete(watchKey);
      leaderMirrorQuoteLastSampleTsMs.delete(watchKey);
      leaderMirrorQuoteSampleCount.delete(watchKey);
    }
  }
  persistLeaderMirrorWatches(cfg, state);
  return filled;
}

async function wakeLeaderSeeds(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
): Promise<number> {
  /**
   * 1.11.875 — the seed is attention, not a buy signal.
   *
   * This lane was switched off in 1.11.782 as "copytrading", but it does not
   * buy anything: it hands the mint to `tryFastPathForMint`, which runs our own
   * structural and dip gates and rejects most of them. With it off, a mint only
   * reaches us through stream / boosts / profiles, so a name two leaders were
   * trading (49nkLrXi) had a seed entry and not one journal row — never looked
   * at, never skipped, simply absent.
   *
   * Bounded because the seed holds up to `leaderSeedMax` mints and this runs
   * every scan: a per-cycle slice, and a per-mint re-look interval so the same
   * seed does not spend the Dex budget every three seconds. One batched Dex
   * request warms the slice before the gates read it.
   */
  if (!cfg.leaderSeedEntryEnabled) return 0;
  if (!cfg.fastPathEnabled) return 0;
  const unlimited = cfg.maxOpenPositions <= 0;
  if (!unlimited && openCount(state) >= cfg.maxOpenPositions) return 0;
  const leaders = readLeaderSeedHits(cfg.leaderSeedPath, nowMs, {
    maxAgeMs: Math.min(cfg.leaderSeedMaxAgeMs, 600_000),
    max: cfg.leaderSeedMax,
  });
  rememberLeaderSeen(cfg, state, leaders, nowMs);
  const perCycle = cfg.leaderSeedWakeMax > 0 ? cfg.leaderSeedWakeMax : 12;
  const relookMs = cfg.leaderSeedRelookMs;
  const due = leaders.filter((hit) => {
    if (state.open[hit.mint]) return false;
    if (onCooldown(state, hit.mint, nowMs)) return false;
    const last = leaderSeedLookedAtMs.get(hit.mint) ?? 0;
    return relookMs <= 0 || nowMs - last >= relookMs;
  });
  // Freshest leader activity first: the dip they just took is the live one, and
  // its observer snapshot is the one still inside `LEADER_SEED_DEX_MAX_AGE_MS`,
  // so the structural gate reads it instead of spending a Dex slot.
  due.sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
  const slice = due.slice(0, perCycle);
  if (slice.length === 0) return 0;
  let n = 0;
  for (const hit of slice) {
    if (!unlimited && openCount(state) >= cfg.maxOpenPositions) break;
    if (state.open[hit.mint]) continue;
    leaderSeedLookedAtMs.set(hit.mint, nowMs);
    await tryFastPathForMint(cfg, state, hit.mint, 'leader', nowMs, hit);
    n += 1;
  }
  if (leaderSeedLookedAtMs.size > 4_000) {
    for (const [mint, ts] of leaderSeedLookedAtMs) {
      if (nowMs - ts > cfg.leaderSeedMaxAgeMs) leaderSeedLookedAtMs.delete(mint);
    }
  }
  return n;
}

/**
 * Own-tape watch set — never leader-seed driven (1.11.782/783).
 * post-exit ∪ cooldown-touch ∪ hot stream.
 */
function streamWakeMintList(cfg: MildDipConfig, state: MildDipState, nowMs: number): string[] {
  return ownTapeWakeMints({
    hotMints: mildDipHotMints.list(nowMs),
    lastExitByMint: state.lastExitByMint,
    cooldownUntilMs: state.cooldownUntilMs,
    nowMs,
    postExitWakeMs: cfg.postExitWakeMs,
    postExitWakeMax: cfg.postExitWakeMax,
    maxTotal: 80,
  });
}

/** Single-flight: overlapping wakes each reserved Dex gate slots → multi-minute backlog. */
let wakeStreamHotMintsInFlight = false;
const leaderStyleBuyMs: number[] = [];
const leaderStyleSkipAtMs = new Map<string, number>();
const leaderStyleSkipHourMs: number[] = [];

function journalLeaderStyleSkip(
  cfg: MildDipConfig,
  mint: string,
  payload: Record<string, unknown>,
  nowMs: number,
): void {
  const last = leaderStyleSkipAtMs.get(mint) ?? 0;
  while (leaderStyleSkipHourMs.length > 0 && leaderStyleSkipHourMs[0]! < nowMs - 3_600_000) {
    leaderStyleSkipHourMs.shift();
  }
  if (!shouldJournalLeaderStyleSkip({
    lastAtMs: last,
    nowMs,
    intervalMs: cfg.leaderStyle.skipJournalIntervalMs,
    hourCount: leaderStyleSkipHourMs.length,
    maxPerHour: cfg.leaderStyle.skipJournalMaxPerHour,
  })) return;
  leaderStyleSkipAtMs.set(mint, nowMs);
  leaderStyleSkipHourMs.push(nowMs);
  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_lstyle_skip',
    mint,
    ...payload,
  });
}

/** 1.11.779/781 — re-check watch set even while bags are open (not only onMint). */
async function wakeStreamHotMints(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
): Promise<number> {
  if (!cfg.fastPathEnabled) return 0;
  if (wakeStreamHotMintsInFlight) return 0;
  wakeStreamHotMintsInFlight = true;
  try {
    const unlimited = cfg.maxOpenPositions <= 0;
    if (!unlimited && openCount(state) >= cfg.maxOpenPositions) return 0;
    let n = 0;
    for (const mint of streamWakeMintList(cfg, state, nowMs)) {
      if (!unlimited && openCount(state) >= cfg.maxOpenPositions) break;
      if (state.open[mint]) continue;
      await tryFastPathForMint(cfg, state, mint, 'stream', nowMs);
      n += 1;
    }
    return n;
  } finally {
    wakeStreamHotMintsInFlight = false;
  }
}

/**
 * 1.11.783 — advance knife watches + post-exit Dex enrich even while bags open
 * (tryEntries is flat-only). Throttled / tiny enrich set — marks stay primary.
 */
async function wakeOwnTapeKnifeEnrich(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
): Promise<number> {
  if (!cfg.knifeStabilizeEnabled) return 0;
  const unlimited = cfg.maxOpenPositions <= 0;
  if (!unlimited && openCount(state) >= cfg.maxOpenPositions) return 0;

  const knifePriority = priorityMintsFromKnifeWatch(state.knifeWatch);
  const postExit = priorityMintsFromLastExit(state.lastExitByMint, nowMs, {
    watchMs: cfg.postExitWakeMs,
    max: Math.min(12, cfg.postExitWakeMax),
  });
  const forceEnrich = [...new Set([...knifePriority, ...postExit])].slice(0, 12);
  if (forceEnrich.length === 0) return 0;

  const enrichPass = await enrichAndFilterCandidates(cfg, forceEnrich, {
    nowMs,
    // Was hard-capped at 12 regardless of config; the cap is the config now.
    maxEnrich: cfg.enrichMax,
    enrichConcurrency: Math.min(cfg.enrichConcurrency, 4),
    bypassCache: false,
    cacheTtlMs: 3_000,
    forceEnrich,
    knifeWatch: state.knifeWatch ?? {},
  });
  state.knifeWatch = enrichPass.knifeWatch;
  for (const ev of enrichPass.knifeEvents) {
    appendMildDipJournal(cfg.journalPath, ev);
    const k = String(ev.kind ?? '');
    if (k === 'mild_dip_knife_watch_start') {
      console.log(
        `[mild-dip] KNIFE watch ${String(ev.mint).slice(0, 8)}… dip=${ev.knifeDipPct} wait=${cfg.knifeStabilizeWaitMs}ms`,
      );
    } else if (k === 'mild_dip_knife_ready') {
      console.log(
        `[mild-dip] KNIFE ready ${String(ev.mint).slice(0, 8)}… mode=${ev.mode} bounce=${ev.bouncePct}`,
      );
    }
  }
  saveMildDipState(cfg.statePath, state);

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  let filled = 0;
  for (const c of enrichPass.candidates) {
    if (!unlimited && openCount(state) >= cfg.maxOpenPositions) break;
    if (c.dipSource !== 'knife_stabilize') continue;
    if (state.open[c.mint]) continue;
    const result = await attemptMildDipEntry({
      cfg,
      state,
      candidate: c,
      copyCfg,
      nowMs,
      buyInFlight,
      resolveEntrySizeUsd,
      adoptOnChainHolding,
      opts: {
        chasePct: cfg.maxChasePct,
        trigger: 'scan',
        skipBounce: false,
        skipOnchainAdopt: false,
        freshDexPrebuy: true,
        softSkipCooldownMs: Math.min(cfg.mintCooldownMs, 60_000),
        lane: 'slow',
      },
    });
    if (result === 'filled') filled += 1;
  }
  return filled;
}

async function tryEntries(cfg: MildDipConfig, state: MildDipState, nowMs: number): Promise<void> {
  if (tryEntriesInFlight) return;
  tryEntriesInFlight = true;
  tryEntriesStartedAtMs = nowMs;
  try {
    await tryEntriesBody(cfg, state, nowMs);
  } finally {
    tryEntriesInFlight = false;
    tryEntriesStartedAtMs = 0;
    tryEntriesStallReportedAtMs = 0;
  }
}

async function tryEntriesBody(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
): Promise<void> {
  if (cfg.leaderMirror.mirrorOnly) return;
  const unlimited = cfg.maxOpenPositions <= 0;
  if (cfg.leaderStyle.enabled) {
    const lstyleMints = await collectCandidateMints(cfg, { nowMs });
    const lstylePass = await enrichAndFilterCandidates(cfg, lstyleMints, {
      nowMs,
      maxEnrich: cfg.leaderStyle.maxEnrich,
      enrichConcurrency: cfg.leaderStyle.enrichConcurrency,
      bypassCache: false,
      cacheTtlMs: 3_000,
      leaderStyle: true,
    });
    const copyCfg = mildDipToCopyTraderConfig(cfg);
    const cutoff = nowMs - 3_600_000;
    while (leaderStyleBuyMs.length > 0 && leaderStyleBuyMs[0]! < cutoff) leaderStyleBuyMs.shift();
    for (const c of lstylePass.candidates) {
      if (!unlimited && openCount(state) >= cfg.maxOpenPositions) break;
      if (state.open[c.mint] || buyInFlight.has(c.mint)) continue;
      const openLstyle = Object.values(state.open).filter((p) => p.lane === 'leader_style').length;
      if (cfg.leaderStyle.maxOpen > 0 && openLstyle >= cfg.leaderStyle.maxOpen) {
        journalLeaderStyleSkip(cfg, c.mint, { reason: 'max_open' }, nowMs);
        continue;
      }
      if (cfg.leaderStyle.maxBuysPerHour > 0 && leaderStyleBuyMs.length >= cfg.leaderStyle.maxBuysPerHour) {
        journalLeaderStyleSkip(cfg, c.mint, { reason: 'buys_per_hour' }, nowMs);
        continue;
      }
      const stats = mildDipPriceRing.windowStats(c.mint, cfg.leaderStyle.pullbackWindowMs, nowMs);
      const observedTapeSpanMs = mildDipPriceRing.observedSpanMs(c.mint, nowMs);
      const pairAge = resolveLeaderStylePairAge({
        nowMs,
        pairCreatedAtMs: c.pairCreatedAtMs,
        registryAgeHours: mildDipPairAgeRegistry.pairAgeHours(c.mint, nowMs),
        observedTapeSpanMs,
      });
      const pairAgeMs = pairAge.pairAgeMs;
      const minRingSpanMs = leaderStyleMinRingSpanMs(
        cfg.leaderStyle.minRingSpanMs,
        cfg.leaderStyle.pullbackWindowMs,
      );
      const verdict = evaluateLeaderStyleEntry({
        enabled: true,
        dataAgeMs: stats.spanMs,
        minDataAgeMs: minRingSpanMs,
        volume5mUsd: c.metrics.volume5mUsd,
        liquidityUsd: c.metrics.liquidityUsd,
        minVol5mToLiq: cfg.leaderStyle.minVol5mToLiq,
        minLiquidityUsd: cfg.leaderStyle.minLiquidityUsd,
        maxLiquidityUsd: cfg.leaderStyle.maxLiquidityUsd,
        currentPriceUsd: c.priceUsd,
        localHighUsd: stats.maxPriceUsd,
        localLowUsd: stats.minPriceUsd,
        pullbackPct: cfg.leaderStyle.pullbackPct,
      });
      if (stats.spanMs < minRingSpanMs) {
        journalLeaderStyleSkip(cfg, c.mint, {
          reason: 'insufficient_ring_span',
          pairAgeMs,
          pairAgeSource: pairAge.pairAgeSource,
          ringSpanMs: stats.spanMs,
        }, nowMs);
        continue;
      }
      if (pairAgeMs == null || pairAgeMs < cfg.leaderStyle.minPairAgeMs) {
        journalLeaderStyleSkip(cfg, c.mint, {
          reason: 'insufficient_pair_age',
          pairAgeMs,
          pairAgeSource: pairAge.pairAgeSource,
          ringSpanMs: stats.spanMs,
        }, nowMs);
        continue;
      }
      if (!verdict.pass) {
        journalLeaderStyleSkip(cfg, c.mint, {
          reason: verdict.reason,
          pairAgeMs,
          pairAgeSource: pairAge.pairAgeSource,
          ringSpanMs: stats.spanMs,
          turnover: verdict.turnover,
          liquidityUsd: c.metrics.liquidityUsd,
          pc5m: c.metrics.priceChange5mPct,
          pullbackPct: verdict.pullbackPct,
        }, nowMs);
        continue;
      }
      const result = await attemptMildDipEntry({
        cfg, state, candidate: c, copyCfg, nowMs, buyInFlight,
        resolveEntrySizeUsd, adoptOnChainHolding,
        opts: {
          chasePct: 0, trigger: 'scan', skipBounce: true,
          skipOnchainAdopt: false, freshDexPrebuy: false,
          softSkipCooldownMs: 1_500, lane: 'slow', leaderStyle: true,
        },
      });
      if (result === 'filled') {
        leaderStyleBuyMs.push(nowMs);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_lstyle_buy', mint: c.mint, symbol: c.symbol,
          pairAgeMs, pairAgeSource: pairAge.pairAgeSource, ringSpanMs: stats.spanMs, turnover: verdict.turnover,
          liquidityUsd: c.metrics.liquidityUsd, pc5m: c.metrics.priceChange5mPct,
          pullbackPct: verdict.pullbackPct, localHighUsd: stats.maxPriceUsd,
          localLowUsd: stats.minPriceUsd, priceUsd: c.priceUsd,
          sizeUsd: cfg.leaderStyle.positionUsd, trigger: 'lstyle_scan',
        });
      } else {
        journalLeaderStyleSkip(cfg, c.mint, { reason: 'execution_skip' }, nowMs);
      }
    }
  }
  const slots = unlimited ? Number.POSITIVE_INFINITY : cfg.maxOpenPositions - openCount(state);
  if (!unlimited && slots <= 0) return;

  // 1.11.782 — own-tape only. Leader-seed entry is opt-in (default off).
  if (cfg.fastPathEnabled) {
    for (const mint of streamWakeMintList(cfg, state, nowMs)) {
      if (!unlimited && openCount(state) >= cfg.maxOpenPositions) break;
      if (state.open[mint]) continue;
      await tryFastPathForMint(cfg, state, mint, 'stream', nowMs);
    }
    if (cfg.leaderSeedEntryEnabled) {
      await wakeLeaderSeeds(cfg, state, nowMs);
    }
  }

  // Slow lane: tiny cached enrich for knife / post-exit leftovers.
  const priority = priorityMintsFromCooldown(state.cooldownUntilMs, nowMs, {
    postCooldownMs: 120_000,
  });
  const knifePriority = priorityMintsFromKnifeWatch(state.knifeWatch);
  const postExitPriority = priorityMintsFromLastExit(state.lastExitByMint, nowMs, {
    watchMs: cfg.postExitWakeMs,
    max: cfg.postExitWakeMax,
  });
  const recentTradePriority = priorityMintsFromRecentTrades(state.cooldownUntilMs, nowMs, {
    watchMs: cfg.postExitWakeMs,
    max: cfg.postExitWakeMax,
  });
  const forceEnrich = [
    ...new Set([
      ...priority,
      ...knifePriority,
      ...postExitPriority,
      ...recentTradePriority,
    ]),
  ];
  const mints = await collectCandidateMints(cfg, { priorityMints: forceEnrich, nowMs });
  const enrichPass = await enrichAndFilterCandidates(cfg, mints, {
    nowMs,
    maxEnrich: cfg.enrichMax,
    enrichConcurrency: Math.min(cfg.enrichConcurrency, 6),
    bypassCache: false,
    cacheTtlMs: 3_000,
    forceEnrich,
    knifeWatch: state.knifeWatch ?? {},
  });
  state.knifeWatch = enrichPass.knifeWatch;
  for (const ev of enrichPass.knifeEvents) {
    appendMildDipJournal(cfg.journalPath, ev);
    const k = String(ev.kind ?? '');
    if (k === 'mild_dip_knife_watch_start') {
      console.log(
        `[mild-dip] KNIFE watch ${String(ev.mint).slice(0, 8)}… dip=${ev.knifeDipPct} wait=${cfg.knifeStabilizeWaitMs}ms`,
      );
    } else if (k === 'mild_dip_knife_ready') {
      console.log(
        `[mild-dip] KNIFE ready ${String(ev.mint).slice(0, 8)}… mode=${ev.mode} bounce=${ev.bouncePct}`,
      );
    }
  }
  saveMildDipState(cfg.statePath, state);

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  let filled = 0;
  for (const c of enrichPass.candidates) {
    if (filled >= slots) break;
    // Prefer fast-path for non-knife; knife still uses slow confirm.
    if (c.dipSource !== 'knife_stabilize' && cfg.fastPathEnabled) {
      const ok = await tryFastPathForMint(cfg, state, c.mint, 'scan', nowMs);
      if (ok) {
        filled += 1;
        continue;
      }
      // Wait-dip parks inside fast-path — do not fall through to immediate slow buy.
      if (
        cfg.waitDipEnabled &&
        cfg.waitDipPct < 0 &&
        shouldParkWaitDip({
          dipSource: c.dipSource,
          lastExitAtMs: state.lastExitByMint?.[c.mint]?.atMs,
          nowMs,
          rebuyBelowExitPct: cfg.rebuyBelowExitPct,
          rebuyBelowExitMaxAgeMs: cfg.rebuyBelowExitMaxAgeMs,
        })
      ) {
        continue;
      }
    }
    // Slow lane: also park wait-eligible sources when fast-path off / failed without park.
    if (
      cfg.waitDipEnabled &&
      cfg.waitDipPct < 0 &&
      shouldParkWaitDip({
        dipSource: c.dipSource,
        lastExitAtMs: state.lastExitByMint?.[c.mint]?.atMs,
        nowMs,
        rebuyBelowExitPct: cfg.rebuyBelowExitPct,
        rebuyBelowExitMaxAgeMs: cfg.rebuyBelowExitMaxAgeMs,
      })
    ) {
      parkWaitDipFromCandidate(cfg, state, c, nowMs);
      if (await tryFireWaitDip(cfg, state, c.mint, nowMs)) filled += 1;
      continue;
    }
    const result = await attemptMildDipEntry({
      cfg,
      state,
      candidate: c,
      copyCfg,
      nowMs,
      buyInFlight,
      resolveEntrySizeUsd,
      adoptOnChainHolding,
      opts: {
        chasePct: cfg.maxChasePct,
        trigger: 'scan',
        skipBounce: false,
        skipOnchainAdopt: false,
        freshDexPrebuy: true,
        softSkipCooldownMs: Math.min(cfg.mintCooldownMs, 60_000),
        lane: 'slow',
      },
    });
    if (result === 'filled') filled += 1;
    if (result === 'stop') break;
  }
}

async function executeQueuedSell(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  decision: MarkExitDecision;
  nowMs: number;
}): Promise<void> {
  const { cfg, state, decision, nowMs } = args;
  const mint = decision.mint;
  const pos = state.open[mint];
  if (!pos || !decision.reason) return;

  const fraction =
    decision.fraction > 0 && decision.fraction < 1 ? decision.fraction : 1;
  // Any 0<frac<1 must keep a runner. Reason whitelist omitted mfe_bank_sleeve /
  // never_arm_bounce half-cuts → state deleted while ~50% remained on-chain
  // (GZudMdxm orphan −80%).
  const isPartial = isRunnerPartialExit(fraction);
  const retryableFullExitReasons = new Set([
    'hard_stop',
    'cliff_dump',
    'peak_giveback',
    'mfe_bank_sleeve',
    'never_arm_giveback',
    'never_arm_bounce',
    'never_arm_freefall',
    'never_arm_time_red',
    'never_arm_stale',
    'never_arm_dead',
    'never_arm_vol_fade',
    'never_arm_timeout',
    'max_hold_underwater',
    'hard_time_stop',
    'breakeven_stop',
    'dead_set_bounce',
    'liq_drain',
    'mirror_dust_close',
  ]);
  const retryEligible = !isPartial && retryableFullExitReasons.has(decision.reason);
  const retryReason = retryEligible ? decision.reason : undefined;
  const priorRetryCount =
    retryReason != null && pos.exitRetryReason === retryReason
      ? Math.max(0, pos.exitRetryCount ?? 0)
      : 0;
  const retrySlippageBps = retrySlippageBpsForAttempt({
    eligible: retryEligible,
    baseSlippageBps: cfg.slippageBps,
    priorRetryCount,
    stepBps: cfg.exitRetrySlippageStepBps,
    maxBps: cfg.exitRetrySlippageMaxBps,
  });

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  /**
   * The executor sells `min(tokenRawBase, on-chain ATA)`. A buy's quoted
   * `outAmount` runs above the confirmed fill, so a fresh bag must size off the
   * chain read alone. But once a leg has settled, `tokenRaw` is `before − sold`
   * arithmetic and is the *safer* of the two: right after a partial the chain
   * read still answers the pre-sell balance, and asking for that much is what
   * produced the `Custom:6024` bursts (three failed bank_2 legs over 11s on
   * `J7o48eA9q` before the node caught up).
   */
  /**
   * 1.11.883 — a sell taken because there is money on the table must not fill
   * under our cost. The mark that decided it is a mid; the quote in the executor
   * is the price we can get, and over 2009 sells those differed by a median
   * 0.99% (p25 −3.59%). 8PecVcC took the bounce half at −3.26% with MFE 0.12%,
   * twice. Cost is the gain basis: the fill, or the mark beside it when that sat
   * higher. Stops and time cuts pass no floor — they are leaving regardless.
   */
  const costPriceUsd = Math.max(
    pos.entryPriceUsd,
    pos.entryMarkPriceUsd != null && pos.entryMarkPriceUsd > 0 ? pos.entryMarkPriceUsd : 0,
  );
  /**
   * 1.11.884 — only when the decision itself was at or above cost.
   *
   * The floor is there to stop slippage dragging a genuine gain under water. It
   * is not a veto on leaving: `breakeven_stop` also fires on a bag that is
   * deeply red, and 9PXM1p spent eleven hours at −27% issuing 2898 refused
   * sells at `sell_quote_below_floor:-26.86%`, one Jupiter quote each, because
   * a floor at cost can never be met from there. If we are already below cost
   * when we decide, the exit is a cut and it goes.
   */
  const minExitPriceUsd =
    MONEY_MOTIVATED_EXIT_REASONS.has(decision.reason) &&
    costPriceUsd > 0 &&
    decision.gainPct >= 0
      ? costPriceUsd
      : undefined;
  const profitFillMaxSlipPct =
    cfg.exit.profitFillMaxSlipPct != null && cfg.exit.profitFillMaxSlipPct > 0
      ? cfg.exit.profitFillMaxSlipPct
      : 0;
  const lossFillMaxSlipPct =
    cfg.exit.lossFillMaxSlipPct != null && cfg.exit.lossFillMaxSlipPct > 0
      ? cfg.exit.lossFillMaxSlipPct
      : 0;
  const profitFillMinPrice = profitFillMinPriceUsd({
    reason: decision.reason,
    gainPct: decision.gainPct,
    decisionPriceUsd: decision.markPriceUsd,
    maxSlipPct: profitFillMaxSlipPct,
  });
  const lossFillMinPrice = profitFillMinPriceUsd({
    reason: decision.reason,
    gainPct: decision.gainPct,
    decisionPriceUsd: decision.markPriceUsd,
    maxSlipPct: lossFillMaxSlipPct,
    mode: 'loss',
  });
  const profitFillMinPriceUsdValue =
    profitFillMinPrice != null ? profitFillMinPrice : undefined;
  const lossFillMinPriceUsdValue =
    lossFillMinPrice != null ? lossFillMinPrice : undefined;
  const guardedMinExitPriceUsd =
    [minExitPriceUsd, profitFillMinPriceUsdValue, lossFillMinPriceUsdValue]
      .filter((value): value is number => value != null)
      .reduce((max, value) => Math.max(max, value), 0) || undefined;
  const minExitPriceGuard: 'cost_floor' | 'profit_fill_slippage' | 'loss_fill_slippage' | undefined =
    lossFillMinPriceUsdValue != null
      ? 'loss_fill_slippage'
      : profitFillMinPriceUsdValue != null
      ? 'profit_fill_slippage'
      : minExitPriceUsd != null
        ? 'cost_floor'
        : undefined;
  const sellArgs = (overrides: {
    tokenRawBase?: string;
    slippageBpsOverride?: number;
    attempt: number;
  }) => ({
    cfg: copyCfg,
    mint,
    symbol: pos.symbol,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd: decision.markPriceUsd,
    sizeUsd: pos.sizeUsd,
    fraction,
    leaderSignature: `milddip_exit_${decision.reason}_${nowMs}_${overrides.attempt}`,
    sellDelayMs: 0,
    ...(guardedMinExitPriceUsd != null ? { minExitPriceUsd: guardedMinExitPriceUsd } : {}),
    ...(minExitPriceGuard != null ? { minExitPriceGuard } : {}),
    ...(profitFillMinPriceUsdValue != null || lossFillMinPriceUsdValue != null
      ? {
          fillGuardDecisionPriceUsd: decision.markPriceUsd,
          fillGuardMaxSlipPct:
            lossFillMinPriceUsdValue != null ? lossFillMaxSlipPct : profitFillMaxSlipPct,
        }
      : {}),
    ...(overrides.tokenRawBase != null
      ? { tokenRawBase: overrides.tokenRawBase }
      : pos.tokenRawSettled && pos.tokenRaw
        ? { tokenRawBase: pos.tokenRaw }
        : {}),
    ...(overrides.slippageBpsOverride != null
      ? { slippageBpsOverride: overrides.slippageBpsOverride }
      : retrySlippageBps != null
        ? { slippageBpsOverride: retrySlippageBps }
        : {}),
    ...(pos.lane === 'leader_mirror'
      ? {
          slippageRetryMultiplier: cfg.leaderMirror.executionSlippageMultiplier,
          slippageRetryMaxBps: cfg.leaderMirror.executionSlippageMaxBps,
        }
      : {}),
  });

  const settleRefireClosed = async (onchainRaw: bigint) => {
    const afterBalances = await peekCopyQuoteBalances(copyCfg);
    const usdcBefore = sell.usdcBefore ?? null;
    const usdcAfter = afterBalances?.quoteUsd ?? null;
    const feeSolBefore = sell.feeSolBefore ?? null;
    const feeSolAfter = afterBalances?.feeSol ?? null;
    const quoteReceivedUsd =
      usdcBefore != null && usdcAfter != null && usdcAfter > usdcBefore
        ? usdcAfter - usdcBefore
        : null;
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_exit_refire',
      mint,
      symbol: pos.symbol,
      lane: pos.lane ?? 'dip',
      exitReason: decision.reason,
      sellReason: 'confirm_timeout',
      action: 'settle_closed',
      attempt: 0,
      maxAttempts: cfg.leaderMirror.exitRefireMax,
      onchainRaw: onchainRaw.toString(),
      dustRaw: HOLDING_DUST_RAW.toString(),
      appliedSlippageBps: null,
      usdcBefore,
      usdcAfter,
      feeSolBefore,
      feeSolAfter,
      quoteReceivedUsd,
    });
    return {
      usdcBefore,
      usdcAfter,
      feeSolBefore,
      feeSolAfter,
      quoteReceivedUsd,
    };
  };

  let sell = await executeCopySell(sellArgs({ attempt: 0 }));
  let refireAttempt = 0;
  let refireSettlement: Awaited<ReturnType<typeof settleRefireClosed>> | null = null;
  while (
    !sell.ok &&
    sell.reason === 'confirm_timeout' &&
    pos.lane === 'leader_mirror' &&
    fraction === 1 &&
    cfg.leaderMirror.exitRefireMax > 0
  ) {
    await sleep(800);
    const freshRaw = await fetchMintBalanceRaw(copyCfg, mint);
    const onchainRaw = freshRaw != null ? parseTokenRaw(freshRaw) : null;
    if (onchainRaw == null) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_exit_refire',
        mint,
        symbol: pos.symbol,
        lane: pos.lane,
        exitReason: decision.reason,
        sellReason: sell.reason,
        action: 'give_up',
        attempt: refireAttempt,
        maxAttempts: cfg.leaderMirror.exitRefireMax,
        onchainRaw: null,
        dustRaw: HOLDING_DUST_RAW.toString(),
        appliedSlippageBps: null,
      });
      break;
    }
    const action = decideExitRefire({
      lane: pos.lane,
      sellReason: sell.reason,
      fraction,
      attemptsUsed: refireAttempt,
      maxAttempts: cfg.leaderMirror.exitRefireMax,
      onchainRaw,
      dustRaw: HOLDING_DUST_RAW,
    });
    const nextSlippageBps =
      action === 'refire'
        ? retrySlippageBpsForAttempt({
            eligible: true,
            baseSlippageBps: cfg.slippageBps,
            priorRetryCount: priorRetryCount + refireAttempt + 1,
            stepBps: cfg.exitRetrySlippageStepBps,
            maxBps: cfg.exitRetrySlippageMaxBps,
          })
        : undefined;
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_exit_refire',
      mint,
      symbol: pos.symbol,
      lane: pos.lane,
      exitReason: decision.reason,
      sellReason: sell.reason,
      action,
      attempt: refireAttempt,
      maxAttempts: cfg.leaderMirror.exitRefireMax,
      onchainRaw: onchainRaw.toString(),
      dustRaw: HOLDING_DUST_RAW.toString(),
      appliedSlippageBps: nextSlippageBps ?? null,
    });
    if (action === 'settle_closed') {
      refireSettlement = await settleRefireClosed(onchainRaw);
      break;
    }
    if (action === 'give_up') break;
    refireAttempt += 1;
    sell = await executeCopySell(
      sellArgs({
        attempt: refireAttempt,
        tokenRawBase: onchainRaw.toString(),
        ...(nextSlippageBps != null ? { slippageBpsOverride: nextSlippageBps } : {}),
      }),
    );
  }

  if (pos.lane === 'leader_mirror' && (sell.ok || refireSettlement != null)) {
    const cashDelta = refireSettlement
      ? refireSettlement.quoteReceivedUsd ?? 0
      : accountMirrorCashLeg(
          state,
          sell as unknown as Record<string, unknown>,
          'sell',
        );
    if (refireSettlement) {
      state.mirrorTradingCashUsd = (state.mirrorTradingCashUsd ?? 0) + cashDelta;
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mirror_trading_cash_leg',
      mint,
      exitReason: decision.reason,
      cashDeltaUsd: cashDelta,
      tradingCashUsd: state.mirrorTradingCashUsd,
    });
  }

  appendMildDipJournal(cfg.journalPath, {
    kind: 'mild_dip_sell',
    reason: decision.reason,
    lane: pos.lane ?? 'dip',
    mint,
    symbol: pos.symbol,
    entryPx: pos.entryPriceUsd,
    peakPx: decision.peakPriceUsd,
    exitPx: sell.priceUsd || decision.markPriceUsd,
    mfePct: +decision.mfePct.toFixed(2),
    givebackPct: +decision.givebackPct.toFixed(2),
    /** Mark/quote price-ratio % — NOT wallet cash. Use trades.jsonl cashPnlUsd. */
    realizedPct: +(sell.pnlPct ?? decision.pnlPct).toFixed(2),
    quoteReceivedUsd: refireSettlement ? refireSettlement.quoteReceivedUsd : sell.quoteReceivedUsd ?? null,
    usdcBefore: refireSettlement ? refireSettlement.usdcBefore : sell.usdcBefore ?? null,
    usdcAfter: refireSettlement ? refireSettlement.usdcAfter : sell.usdcAfter ?? null,
    feeSolBefore: refireSettlement ? refireSettlement.feeSolBefore : sell.feeSolBefore ?? null,
    feeSolAfter: refireSettlement ? refireSettlement.feeSolAfter : sell.feeSolAfter ?? null,
    fraction,
    tpRung: decision.reason === 'tp_grid' ? decision.tpRungIndex : null,
    liq: decision.liquidityUsd != null ? +decision.liquidityUsd.toFixed(2) : null,
    entryLiq:
      pos.entryLiquidityUsd != null && Number.isFinite(pos.entryLiquidityUsd)
        ? +pos.entryLiquidityUsd.toFixed(2)
        : null,
    liqRatio: decision.liqRatio != null ? +decision.liqRatio.toFixed(4) : null,
    depthDrainRatio:
      decision.depthDrainRatio != null ? +decision.depthDrainRatio.toFixed(4) : null,
    liqDrainConfirmTicks: decision.liquidityDrainConfirmTicks ?? 0,
    lossExitBounceCap: decision.lossExitBounceCap ?? null,
    lossReclaimWaitMs: decision.lossReclaimWaitMs ?? null,
    lossReclaimTargetPct: cfg.exit.lossReclaimTargetPct,
    scaleOut: isPartial,
    armed: decision.armed,
    holdSec: Math.floor((nowMs - pos.openedAtMs) / 1000),
    ok: sell.ok || refireSettlement != null,
    sellReason: sell.reason ?? null,
    settleSource: refireSettlement ? 'refire_onchain_flat' : null,
    fillConfirmed: refireSettlement ? false : null,
    minExitPriceGuard: sell.minExitPriceGuard ?? null,
    signature: sell.signature ?? null,
    mode: cfg.executionMode,
  });
  try {
    const wallet =
      cfg.walletPubkeyExpected?.trim() ||
      executionWalletPubkey(copyCfg) ||
      'unknown';
    writeUsSellFill({
      tradesPath: cfg.tradesPath,
      wallet,
      mint,
      symbol: pos.symbol,
      ok: sell.ok || refireSettlement != null,
      signature: sell.signature ?? null,
      sizeUsdIntent: pos.sizeUsd,
      fraction,
      usdcBefore: refireSettlement ? refireSettlement.usdcBefore : sell.usdcBefore ?? null,
      usdcAfter: refireSettlement ? refireSettlement.usdcAfter : sell.usdcAfter ?? null,
      feeSolBefore: refireSettlement ? refireSettlement.feeSolBefore : sell.feeSolBefore ?? null,
      feeSolAfter: refireSettlement ? refireSettlement.feeSolAfter : sell.feeSolAfter ?? null,
      quoteReceivedUsd: refireSettlement
        ? refireSettlement.quoteReceivedUsd
        : sell.quoteReceivedUsd ?? null,
      txMeta: sell.txMeta,
      fillPriceUsd: refireSettlement ? null : sell.priceUsd || decision.markPriceUsd,
      markPnlPct: refireSettlement ? null : sell.pnlPct ?? decision.pnlPct,
      reason: decision.reason,
      lossExitBounceCap: decision.lossExitBounceCap ?? null,
      lossReclaimWaitMs: decision.lossReclaimWaitMs ?? null,
      lossReclaimTargetPct: cfg.exit.lossReclaimTargetPct,
      nowMs,
    });
  } catch {
    /* never block exit on journal IO */
  }

  const realizedPnl = sell.pnlPct ?? decision.pnlPct;
  const cd = cooldownMsAfterExit({
    pnlPct: realizedPnl,
    mintCooldownMs: cfg.mintCooldownMs,
    lossCooldownMs: cfg.lossCooldownMs,
  });

  const noteLastExit = (exitPx: number): void => {
    if (!(exitPx > 0)) return;
    if (!state.lastExitByMint) state.lastExitByMint = {};
    // Prefer live Dex open-mark liq; fall back to entry snapshot.
    const markLiq = readOpenMarkMetrics(mint, nowMs, 300_000)?.liquidityUsd;
    const entryLiq = state.open[mint]?.entryLiquidityUsd;
    const liq =
      markLiq != null && markLiq > 0
        ? markLiq
        : entryLiq != null && entryLiq > 0
          ? entryLiq
          : null;
    state.lastExitByMint[mint] = {
      priceUsd: exitPx,
      atMs: nowMs,
      pnlPct: +realizedPnl.toFixed(2),
      ...(liq != null ? { liquidityUsd: liq } : {}),
    };
    // 1.11.783 — pin to hot buffer so stream wake / sampler keep the name.
    mildDipHotMints.note(mint, nowMs);
  };

  if (refireSettlement) {
    const realizedPnl = decision.pnlPct;
    const exitPx = decision.markPriceUsd || pos.entryPriceUsd;
    if (state.open[mint]) {
      delete state.open[mint];
      state.cooldownUntilMs[mint] = nowMs + cd.cooldownMs;
      noteLastExit(exitPx);
      saveMildDipState(cfg.statePath, state);
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_cooldown_set',
      mint,
      symbol: pos.symbol,
      pnlPct: +realizedPnl.toFixed(2),
      cooldownMs: cd.cooldownMs,
      cooldownKind: cd.kind,
      exitReason: decision.reason,
      lastExitPriceUsd: exitPx,
      settleReason: 'confirm_timeout_refire_chain_flat',
      remainderSource: 'refire_onchain_read',
    });
    await reclaimEmptyAta(cfg, {
      mint,
      symbol: pos.symbol,
      reason: `post_sell_${decision.reason}`,
    });
    return;
  }

  if (sell.ok) {
    const exitPx = sell.priceUsd || decision.markPriceUsd;
    /**
     * Settle against a fresh on-chain read, but never above what the executor
     * proves is left. A read taken right after the send routinely still answers
     * the pre-sell balance, and settling on it kept fully-closed bags tracked as
     * runners — the exit engine then ground on a phantom bag for dozens of
     * `Custom:6024` / `no_token_balance` legs while holding an open-book slot.
     */
    const beforeRaw = parseTokenRaw(sell.tokenRawBefore);
    const soldRaw = parseTokenRaw(sell.tokenRawSold);
    let verdict = resolveSellRemainder({
      beforeRaw,
      soldRaw,
      observedRaw: parseTokenRaw(await fetchMintBalanceRaw(copyCfg, mint)),
    });
    for (let i = 0; verdict.stale && i < SELL_SETTLE_REREADS; i += 1) {
      await sleep(450);
      verdict = resolveSellRemainder({
        beforeRaw,
        soldRaw,
        observedRaw: parseTokenRaw(await fetchMintBalanceRaw(copyCfg, mint)),
      });
    }
    let rem = verdict.remainingRaw;
    // Hint from executor only if we still have nothing to settle against.
    if (rem == null) rem = parseTokenRaw(sell.tokenRawRemaining);

    const settle = settleAfterSuccessfulSell({
      fraction,
      remainingRaw: rem,
      beforeRaw,
    });
    if (settle.action === 'keep_runner' && state.open[mint]) {
      const live = state.open[mint]!;
      if (isPartial || settle.reason === 'remainder_above_dust') {
        live.scaleOutDone = true;
      }
      if (decision.reason === 'mfe_bank_1') live.mfeBankStage = 1;
      else if (decision.reason === 'mfe_bank_2') live.mfeBankStage = 2;
      else if (decision.reason === 'tp_grid' && decision.tpRungIndex != null) {
        const fillPx = sell.priceUsd || decision.markPriceUsd;
        const achievedGainPct =
          decision.gainBasisPriceUsd > 0 && fillPx > 0
            ? (fillPx / decision.gainBasisPriceUsd - 1) * 100
            : decision.gainPct;
        live.tpRungsDone = Math.max(
          decision.tpRungIndex,
          tpRungsCoveredByGainPct(cfg.exit, achievedGainPct),
        );
        live.lastTpGridFillAtMs = nowMs;
      }
      if (decision.reason === 'mirror_tp_ladder' && decision.tpRungIndex != null) {
        live.mirrorLadderRungsDone = Math.max(
          live.mirrorLadderRungsDone ?? 0,
          decision.tpRungIndex,
        );
      }
      live.exitRetryCount = undefined;
      live.exitRetryReason = undefined;
      if (isPartial) {
        live.sizeUsd = Math.max(0, live.sizeUsd * (1 - fraction));
      }
      live.peakPriceUsd = decision.peakPriceUsd;
      live.trailArmed = decision.armed;
      if (settle.remainingRaw != null) {
        // Either arithmetic (`before − sold`) or a read at/below it — both are
        // safe caps for the next leg, unlike a buy quote's `outAmount`.
        live.tokenRaw = settle.remainingRaw.toString();
        live.tokenRawSettled = true;
      }
      saveMildDipState(cfg.statePath, state);
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_sell_settle',
        mint,
        symbol: pos.symbol,
        exitReason: decision.reason,
        action: 'keep_runner',
        settleReason: settle.reason,
        fraction,
        remainingRaw: settle.remainingRaw?.toString() ?? null,
        intendedPartial: isPartial,
        remainderSource: verdict.reason,
        tokenRawBefore: sell.tokenRawBefore ?? null,
        tokenRawSold: sell.tokenRawSold ?? null,
      });
      console.log(
        `[mild-dip] SCALE-OUT ${pos.symbol} frac=${fraction} pnl=${realizedPnl.toFixed(1)}% ` +
          `mfe=${decision.mfePct.toFixed(1)}% giveback=${decision.givebackPct.toFixed(1)}% ` +
          `runner≈$${live.sizeUsd.toFixed(2)} settle=${settle.reason} mode=${cfg.executionMode}`,
      );
      return;
    }

    // Confirmed flat (or keep_runner without open — nothing to do).
    if (state.open[mint]) {
      delete state.open[mint];
      state.cooldownUntilMs[mint] = nowMs + cd.cooldownMs;
      noteLastExit(exitPx);
      saveMildDipState(cfg.statePath, state);
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_cooldown_set',
      mint,
      symbol: pos.symbol,
      pnlPct: +realizedPnl.toFixed(2),
      cooldownMs: cd.cooldownMs,
      cooldownKind: cd.kind,
      exitReason: decision.reason,
      lastExitPriceUsd: exitPx,
      settleReason: settle.reason,
      remainderSource: verdict.reason,
    });
    console.log(
      `[mild-dip] SELL ${pos.symbol} reason=${decision.reason} pnl=${realizedPnl.toFixed(1)}% ` +
        `mfe=${decision.mfePct.toFixed(1)}% giveback=${decision.givebackPct.toFixed(1)}% ` +
        `cooldown=${Math.round(cd.cooldownMs / 1000)}s(${cd.kind}) mode=${cfg.executionMode}`,
    );
    await reclaimEmptyAta(cfg, {
      mint,
      symbol: pos.symbol,
      reason: `post_sell_${decision.reason}`,
    });
    return;
  }

  const reason = sell.reason ?? 'unknown';
  if (state.open[mint]) {
    const live = state.open[mint]!;
    if (retryEligible) {
      live.exitRetryReason = retryReason;
      live.exitRetryCount = priorRetryCount + 1;
    } else {
      live.exitRetryReason = undefined;
      live.exitRetryCount = undefined;
    }
    saveMildDipState(cfg.statePath, state);
  }
  if (reason === 'no_token_balance') {
    // Re-read chain before dropping — sell path races RPC right after buy
    // (CkTFDN: false empty → drop_empty → unmanaged −80% bag).
    await sleep(400);
    const raw = await fetchMintBalanceRaw(copyCfg, mint);
    const onchainRaw = raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
    const verdict = verdictDropEmptyOnNoBalance({
      onchainRaw,
      openedAtMs: pos.openedAtMs,
      nowMs,
    });
    if (!verdict.drop) {
      if (state.open[mint] && onchainRaw > HOLDING_DUST_RAW && raw) {
        state.open[mint]!.tokenRaw = raw;
        // A bare chain read may itself be stale-high — do not let it cap a sell.
        state.open[mint]!.tokenRawSettled = false;
        saveMildDipState(cfg.statePath, state);
      }
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_sell_balance_race',
        mint,
        symbol: pos.symbol,
        exitReason: decision.reason,
        guardReason: verdict.reason,
        onchainRaw: onchainRaw.toString(),
        pnlPct: +realizedPnl.toFixed(2),
        holdSec: Math.floor((nowMs - pos.openedAtMs) / 1000),
      });
      console.warn(
        `[mild-dip] sell no_token_balance but ${verdict.reason} ` +
          `${pos.symbol} mint=${mint.slice(0, 8)}… (still tracking)`,
      );
      return;
    }
    if (state.open[mint]) {
      delete state.open[mint];
      state.cooldownUntilMs[mint] = nowMs + cd.cooldownMs;
      // 1.11.783 — drop_empty was wiping the bag without lastExit → post-exit wake blind.
      noteLastExit(decision.markPriceUsd || pos.entryPriceUsd);
      saveMildDipState(cfg.statePath, state);
    }
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_drop_empty',
      mint,
      symbol: pos.symbol,
      exitReason: decision.reason,
      pnlPct: +realizedPnl.toFixed(2),
      cooldownMs: cd.cooldownMs,
      cooldownKind: cd.kind,
      confirmedEmpty: true,
      lastExitPriceUsd: decision.markPriceUsd || pos.entryPriceUsd,
    });
    console.warn(
      `[mild-dip] DROP empty bag ${pos.symbol} mint=${mint.slice(0, 8)}… ` +
        `cooldown=${Math.round(cd.cooldownMs / 1000)}s(${cd.kind})`,
    );
    await reclaimEmptyAta(cfg, {
      mint,
      symbol: pos.symbol,
      reason: 'post_drop_empty',
    });
    return;
  }

  // Keep `state.open[mint]` — retry next mark pass. Never orphan on soft fail.
  console.warn(`[mild-dip] sell failed ${mint.slice(0, 8)}…: ${reason} (still tracking)`);
}

/**
 * Phase 1: parallel marks (stream-first, Dex refresh for vol) — armed first.
 * Phase 2: persist peak/arm updates (positions stay open).
 * Phase 3: sell queue with limited concurrency — mint leaves state only after
 * confirmed sell / empty bag. In-flight mints skipped on subsequent marks.
 */
const SOFT_GIVEBACK_REASONS = new Set([
  'peak_giveback',
  'peak_giveback_partial',
  'mfe_bank_sleeve',
  'never_arm_giveback',
]);

/** Soft exits deferred while reclaiming off local trough (not cliff/timeout). */
const RECOVER_DEFER_REASONS = new Set([
  'peak_giveback',
  'peak_giveback_partial',
  'mfe_bank_sleeve',
  'never_arm_giveback',
  'never_arm_stale',
  'never_arm_dead',
  'never_arm_vol_fade',
]);

/** mint → last dump_classify_pending journal ts (throttle). */
const lastDumpClassifyJournalMs = new Map<string, number>();
/** mint → last recover_defer journal ts (throttle). */
const lastRecoverDeferJournalMs = new Map<string, number>();
/** mint → last time the leader-seed lane looked at it (Dex budget guard). */
const leaderSeedLookedAtMs = new Map<string, number>();
const leaderMirrorWatches = new Map<
  string,
  {
    hit: LeaderSeedHit;
    hitKey: string;
    startedAtMs: number;
    expiresAtMs: number;
    metricSource: LeaderMirrorMetricSource;
    lastWaitReason?: string;
    lastWaitAtMs?: number;
  }
>();
const leaderMirrorDecisions = new Map<
  string,
  { hitKey: string; decidedAtMs: number; reason: string }
>();
function leaderMirrorWatchKey(hit: LeaderSeedHit): string {
  return `${hit.mint}:${hit.leader ?? ''}`;
}
const leaderMirrorStructuralAttemptMs = new Map<string, number>();
const leaderMirrorStructuralSourceJournal = new Map<string, string>();
const leaderMirrorEntryRetryAfterMs = new Map<string, number>();
const leaderMirrorQuoteLastSelectedAtMs = new Map<string, number>();
const leaderMirrorQuoteLastSampleTsMs = new Map<string, number>();
const leaderMirrorQuoteSampleCount = new Map<string, number>();
const knifeWaitQuoteWaitingKeys = new Set<string>();
const knifeWaitQuoteUncoveredKeys = new Set<string>();
let knifeWaitQuoteWindowStartedAtMs = 0;
let knifeWaitQuoteRequestsInWindow = 0;
let leaderMirrorStructuralInFlight = false;
let leaderMirrorStructuralPriorityInFlight = false;
let leaderMirrorStateHydrated = false;

function hydrateLeaderMirrorWatches(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
): void {
  if (leaderMirrorStateHydrated) return;
  leaderMirrorStateHydrated = true;
  leaderMirrorWatches.clear();
  leaderMirrorDecisions.clear();
  leaderMirrorQuoteLastSelectedAtMs.clear();
  leaderMirrorQuoteLastSampleTsMs.clear();
  leaderMirrorQuoteSampleCount.clear();
  const mirrorObserveMs = leaderMirrorObservationWindowMs(cfg.leaderMirror);
  for (const [watchKey, watch] of Object.entries(state.leaderMirrorWatches ?? {})) {
    if (watch.expiresAtMs <= nowMs || state.open[watch.hit.mint]) continue;
    if (
      !leaderMirrorObservationFresh({
        leaderBuyTsMs:
          watch.hit.blockTime != null && watch.hit.blockTime > 0
            ? watch.hit.blockTime * 1000
            : null,
        nowMs,
        maxAgeMs: cfg.leaderMirror.observationMaxAgeMs,
      })
    ) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_refusal',
        mint: watch.hit.mint,
        leader: watch.hit.leader,
        reason: 'leader_mirror_observation_stale',
        synthetic: true,
        source: 'watch_hydration',
      });
      continue;
    }
    leaderMirrorWatches.set(
      watchKey,
      watch.expiresAtMs < watch.startedAtMs + mirrorObserveMs
        ? { ...watch, expiresAtMs: watch.startedAtMs + mirrorObserveMs }
        : watch,
    );
  }
  for (const [key, decision] of Object.entries(state.leaderMirrorDecisions ?? {})) {
    leaderMirrorDecisions.set(key, decision);
  }
  if (
    Object.keys(state.leaderMirrorWatches ?? {}).length !== leaderMirrorWatches.size
  ) {
    persistLeaderMirrorWatches(cfg, state);
  }
}

function persistLeaderMirrorWatches(cfg: MildDipConfig, state: MildDipState): void {
  const nowMs = Date.now();
  const retentionMs = Math.max(cfg.leaderMirror.observeMs * 2, 5 * 60_000);
  for (const [key, watch] of leaderMirrorWatches) {
    if (watch.expiresAtMs <= nowMs) leaderMirrorWatches.delete(key);
  }
  for (const [key, decision] of leaderMirrorDecisions) {
    if (decision.decidedAtMs < nowMs - retentionMs) leaderMirrorDecisions.delete(key);
  }
  if (leaderMirrorDecisions.size > MAX_LEADER_MIRROR_DECISIONS) {
    const stale = [...leaderMirrorDecisions.entries()]
      .sort(([, a], [, b]) => a.decidedAtMs - b.decidedAtMs)
      .slice(0, leaderMirrorDecisions.size - MAX_LEADER_MIRROR_DECISIONS);
    for (const [key] of stale) leaderMirrorDecisions.delete(key);
  }
  const watches = Object.fromEntries(leaderMirrorWatches);
  const decisions = Object.fromEntries(leaderMirrorDecisions);
  const watchesChanged =
    JSON.stringify(state.leaderMirrorWatches ?? {}) !== JSON.stringify(watches);
  const decisionsChanged =
    JSON.stringify(state.leaderMirrorDecisions ?? {}) !== JSON.stringify(decisions);
  if (!watchesChanged && !decisionsChanged) return;
  state.leaderMirrorWatches = watches;
  state.leaderMirrorDecisions = decisions;
  saveMildDipState(cfg.statePath, state);
}
/** mint → last exit_defer_would_buy journal ts (throttle). */
const lastExitDeferJournalMs = new Map<string, number>();
/** mint → last leader_align_defer journal ts (throttle). */
const lastLeaderAlignJournalMs = new Map<string, number>();

function toLeaderAlignHit(hit: LeaderSeedHit | null): LeaderAlignHit | null {
  if (!hit) return null;
  return {
    mint: hit.mint,
    lastSeenAtMs: hit.lastSeenAtMs,
    leader: hit.leader,
    signature: hit.signature,
    fillPriceUsd: hit.fillPriceUsd,
    sizeUsd: hit.sizeUsd,
    blockTime: hit.blockTime,
    isAdd: hit.isAdd,
    class: hit.class,
  };
}

/**
 * One-shot average-in while a soft exit is deferred on a fresh leader buy.
 * Does not open a new seat — merges into the existing bag.
 */
async function attemptLeaderAlignScaleIn(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  mint: string;
  nowMs: number;
  markPriceUsd: number;
  hit: LeaderAlignHit;
  wouldReason: string;
}): Promise<void> {
  const { cfg, state, mint, nowMs, hit, wouldReason } = args;
  if (mildDipStateSaveBlocked()) return;
  const pos = state.open[mint];
  if (!pos) return;
  if (pos.leaderAlignScaleInDone) return;
  if (buyInFlight.has(mint) || sellInFlight.has(mint)) return;
  if (!(cfg.leaderAlignScaleInUsd > 0)) return;

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  const sized = await resolveEntrySizeUsd(cfg, copyCfg, nowMs, cfg.leaderAlignScaleInUsd);
  if (sized.stop || !(sized.sizeUsd > 0)) {
    appendMildDipJournal(cfg.journalPath, {
      kind: 'leader_align_scale_in_skip',
      mint,
      symbol: pos.symbol,
      reason: sized.reason ?? 'no_size',
      wantUsd: cfg.leaderAlignScaleInUsd,
      wouldReason,
    });
    return;
  }

  const fillPx =
    hit.fillPriceUsd != null && hit.fillPriceUsd > 0
      ? hit.fillPriceUsd
      : args.markPriceUsd > 0
        ? args.markPriceUsd
        : pos.entryPriceUsd;
  if (!(fillPx > 0)) return;

  buyInFlight.add(mint);
  const leaderSig = `milddip_leader_align_${mint.slice(0, 8)}_${nowMs}`;
  appendMildDipJournal(cfg.journalPath, {
    kind: 'leader_align_scale_in_attempt',
    mint,
    symbol: pos.symbol,
    sizeUsd: sized.sizeUsd,
    priceUsd: fillPx,
    wouldReason,
    leader: hit.leader ?? null,
    leaderSignature: hit.signature ?? null,
    leaderAgeMs: Math.max(0, nowMs - hit.lastSeenAtMs),
    prevEntryPx: pos.entryPriceUsd,
    prevSizeUsd: pos.sizeUsd,
  });

  try {
    const buy = await executeCopyBuy({
      cfg: copyCfg,
      mint,
      symbol: pos.symbol,
      priceUsd: fillPx,
      sizeUsd: sized.sizeUsd,
      kind: 'entry',
      evalResult: {
        pass: true,
        reasons: [`leader_align_scale_in:${wouldReason}`],
        score: Math.abs(args.markPriceUsd > 0 ? ((args.markPriceUsd / pos.entryPriceUsd - 1) * 100) : 0),
      },
      leaderSignature: leaderSig,
      leaderPriceUsd: fillPx,
      leaderBuyTs: hit.blockTime != null ? hit.blockTime * 1000 : nowMs,
      ...(pos.lane === 'leader_mirror'
        ? {
            beforeSend: async () => {
              const guardRead = await readLeaderBalanceForGuard(
                cfg,
                pos.leaderMirrorLeader,
                mint,
              );
              const raw = guardRead.balanceRaw;
              const holds = raw != null && raw > 0n;
              appendMildDipJournal(cfg.journalPath, {
                kind: 'leader_mirror_balance_guard',
                mint,
                leader: pos.leaderMirrorLeader ?? null,
                holds,
                reason: leaderBalanceGuardReason(guardRead),
              });
              return holds;
            },
          }
        : {}),
      slippageRetryMultiplier: cfg.leaderMirror.executionSlippageMultiplier,
      slippageRetryMaxBps: cfg.leaderMirror.executionSlippageMaxBps,
    });
    if (!buy.ok) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_align_scale_in_result',
        mint,
        symbol: pos.symbol,
        ok: false,
        reason: buy.reason ?? 'buy_failed',
        sizeUsd: sized.sizeUsd,
      });
      return;
    }
    const live = state.open[mint];
    if (!live) return;
    if (live.lane === 'leader_mirror') {
      accountMirrorCashLeg(state, buy as unknown as Record<string, unknown>, 'buy');
    }
    const addPx = buy.priceUsd != null && buy.priceUsd > 0 ? buy.priceUsd : fillPx;
    const newEntry = averageEntryAfterScaleIn({
      prevEntryUsd: live.entryPriceUsd,
      prevSizeUsd: live.sizeUsd,
      addFillUsd: addPx,
      addSizeUsd: sized.sizeUsd,
    });
    if (newEntry != null && newEntry > 0) live.entryPriceUsd = newEntry;
    live.sizeUsd = live.sizeUsd + sized.sizeUsd;
    live.leaderAlignScaleInDone = true;
    const rem = await fetchMintBalanceRaw(copyCfg, mint);
    if (rem && /^\d+$/.test(rem) && BigInt(rem) > HOLDING_DUST_RAW) {
      live.tokenRaw = rem;
      // Bag just grew — a pre-scale-in settled figure would cap the next sell
      // below what we hold. Size off the chain read until a leg settles again.
      live.tokenRawSettled = false;
    }
    saveMildDipState(cfg.statePath, state);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'leader_align_scale_in_result',
      mint,
      symbol: live.symbol,
      ok: true,
      sizeUsd: sized.sizeUsd,
      fillPx: addPx,
      newEntryPx: live.entryPriceUsd,
      newSizeUsd: live.sizeUsd,
      signature: buy.signature ?? null,
      leader: hit.leader ?? null,
      wouldReason,
    });
    console.log(
      `[mild-dip] LEADER_ALIGN SCALE-IN ${live.symbol} mint=${mint.slice(0, 8)}… ` +
        `+$${sized.sizeUsd} @$${addPx.toPrecision(4)} avgEntry=$${live.entryPriceUsd.toPrecision(4)} ` +
        `(held ${wouldReason})`,
    );
  } catch (err) {
    appendMildDipJournal(cfg.journalPath, {
      kind: 'leader_align_scale_in_result',
      mint,
      symbol: pos.symbol,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      sizeUsd: sized.sizeUsd,
    });
  } finally {
    buyInFlight.delete(mint);
  }
}

async function attemptStagedEntryAdd(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  pos: MildDipOpenPosition;
  markPriceUsd: number;
  liquidityUsd: number | null;
  nowMs: number;
  troughPriceUsd: number | null;
  troughAtMs: number | null;
}): Promise<void> {
  const { cfg, state, pos, markPriceUsd, liquidityUsd, nowMs, troughPriceUsd, troughAtMs } = args;
  const verdict = evaluateStagedEntryAdd({
    enabled: cfg.stagedEntryEnabled,
    addDone: pos.stagedEntryAddDone === true,
    attempts: pos.stagedEntryAddAttempts ?? 0,
    nowMs,
    lastAttemptAtMs: pos.stagedEntryLastAttemptAtMs,
    markPx: markPriceUsd,
    firstFillPx: pos.stagedEntryFirstFillPriceUsd ?? null,
    anchorMode: cfg.stagedAddAnchor,
    troughPx: troughPriceUsd,
    troughAtMs,
    triggerPct: cfg.stagedAddTriggerPct,
    maxChasePct: cfg.stagedAddMaxChasePct,
    troughTriggerPct: cfg.stagedAddTroughTriggerPct,
    troughBandPct: cfg.stagedAddTroughBandPct,
    minTroughAgeMs: cfg.stagedAddMinTroughAgeMs,
    intendedUsd: pos.stagedEntryIntendedUsd ?? 0,
    alreadyFilledUsd: pos.stagedEntryFilledUsd ?? pos.sizeUsd,
    addMult: cfg.stagedAddMult,
    addMaxUsd: cfg.stagedAddMaxUsd,
    liquidityUsd,
    minLiquidityUsd: cfg.entryMinLiquidityUsd,
    liquidityDrainActive: (pos.liquidityDrainConfirmTicks ?? 0) > 0,
    rugRiskActive: pos.stagedEntryRugRiskTier === 'knife' || pos.stagedEntryRugRiskTier === 'blocked',
  });
  if (!verdict.shouldAdd) {
    if (verdict.reason === 'above_chase_band' || verdict.reason === 'above_trough_band') {
      const previous = lastStagedAddSkipJournalMs.get(pos.mint) ?? 0;
      if (nowMs - previous >= STAGED_ADD_SKIP_JOURNAL_GAP_MS) {
        lastStagedAddSkipJournalMs.set(pos.mint, nowMs);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_staged_add',
          mint: pos.mint,
          symbol: pos.symbol,
          lane: pos.lane ?? 'dip',
          firstFillPx: pos.stagedEntryFirstFillPriceUsd ?? null,
          triggerPx: verdict.triggerPx,
          mark: markPriceUsd,
          intendedUsd: pos.stagedEntryIntendedUsd ?? null,
          addUsd: 0,
          anchorMode: cfg.stagedAddAnchor,
          postEntryTroughPriceUsd: verdict.anchorPx,
          postEntryTroughAtMs: verdict.anchorAtMs,
          bounceOffTroughPct: verdict.bounceOffAnchorPct,
          pnlPctVsFill: verdict.markVsFirstFillPct,
          ok: false,
          reason: verdict.reason,
        });
      }
    }
    return;
  }

  pos.stagedEntryAddAttempts = (pos.stagedEntryAddAttempts ?? 0) + 1;
  pos.stagedEntryLastAttemptAtMs = nowMs;
  const copyCfg = mildDipToCopyTraderConfig(cfg);
  const event = {
    kind: 'mild_dip_staged_add' as const,
    mint: pos.mint,
    symbol: pos.symbol,
    lane: pos.lane ?? 'dip',
    firstFillPx: pos.stagedEntryFirstFillPriceUsd ?? null,
    triggerPx: verdict.triggerPx,
    mark: markPriceUsd,
    intendedUsd: pos.stagedEntryIntendedUsd ?? null,
    addUsd: verdict.addUsd,
    anchorMode: cfg.stagedAddAnchor,
    postEntryTroughPriceUsd: verdict.anchorPx,
    postEntryTroughAtMs: verdict.anchorAtMs,
    bounceOffTroughPct: verdict.bounceOffAnchorPct,
    pnlPctVsFill: verdict.markVsFirstFillPct,
  };
  const journal = (extra: Record<string, unknown>): void => {
    appendMildDipJournal(cfg.journalPath, { ...event, ...extra });
  };

  const sized = await resolveEntrySizeUsd(cfg, copyCfg, nowMs, verdict.addUsd);
  if (sized.stop || !(sized.sizeUsd > 0)) {
    journal({ ok: false, reason: sized.reason ?? 'no_add_size' });
    saveMildDipState(cfg.statePath, state);
    return;
  }
  try {
    const buy = await executeCopyBuy({
      cfg: copyCfg,
      mint: pos.mint,
      symbol: pos.symbol,
      priceUsd: markPriceUsd,
      sizeUsd: sized.sizeUsd,
      kind: 'add',
      evalResult: {
        pass: true,
        reasons: ['mild_dip_staged_entry_trigger'],
        score: markPriceUsd,
      },
      leaderSignature: `milddip_staged_add_${pos.mint.slice(0, 8)}_${nowMs}`,
      trigger: 'stream',
      leaderPriceUsd: verdict.triggerPx ?? markPriceUsd,
      leaderBuyTs: nowMs,
      ...(pos.lane === 'leader_mirror'
        ? {
            beforeSend: async () => {
              const guardRead = await readLeaderBalanceForGuard(
                cfg,
                pos.leaderMirrorLeader,
                pos.mint,
              );
              const raw = guardRead.balanceRaw;
              const holds = raw != null && raw > 0n;
              appendMildDipJournal(cfg.journalPath, {
                kind: 'leader_mirror_balance_guard',
                mint: pos.mint,
                leader: pos.leaderMirrorLeader ?? null,
                holds,
                reason: leaderBalanceGuardReason(guardRead),
              });
              return holds;
            },
            slippageRetryMultiplier: cfg.leaderMirror.executionSlippageMultiplier,
            slippageRetryMaxBps: cfg.leaderMirror.executionSlippageMaxBps,
          }
        : {}),
    });
    if (!buy.ok) {
      journal({ ok: false, addUsd: sized.sizeUsd, reason: buy.reason ?? 'buy_failed' });
      saveMildDipState(cfg.statePath, state);
      return;
    }
    const live = state.open[pos.mint];
    if (!live) return;
    if (live.lane === 'leader_mirror') {
      accountMirrorCashLeg(state, buy as unknown as Record<string, unknown>, 'buy');
    }
    const raw = await fetchMintBalanceRaw(copyCfg, pos.mint);
    const fillPx = buy.priceUsd || markPriceUsd;
    const addCostUsd = buy.quoteSpentUsd ?? sized.sizeUsd;
    try {
      writeUsBuyFill({
        tradesPath: cfg.tradesPath,
        wallet:
          cfg.walletPubkeyExpected?.trim() ||
          executionWalletPubkey(copyCfg) ||
          'unknown',
        mint: pos.mint,
        symbol: pos.symbol,
        ok: true,
        signature: buy.signature ?? null,
        sizeUsdIntent: sized.sizeUsd,
        usdcBefore: buy.usdcBefore ?? sized.usdc ?? null,
        usdcAfter: buy.usdcAfter ?? null,
        feeSolBefore: buy.feeSolBefore ?? null,
        feeSolAfter: buy.feeSolAfter ?? null,
        quoteSpentUsd: buy.quoteSpentUsd ?? addCostUsd,
        txMeta: buy.txMeta,
        fillPriceUsd: fillPx,
        dipSource: 'mild_dip_staged_add',
        nowMs,
      });
    } catch {
      /* never block staged add state updates on journal IO */
    }
    live.sizeUsd += sized.sizeUsd;
    live.stagedEntryFilledUsd = (live.stagedEntryFilledUsd ?? pos.sizeUsd) + sized.sizeUsd;
    const priorCost = live.stagedEntryTotalCostUsd ?? pos.sizeUsd;
    const priorTokens =
      live.stagedEntryTotalTokenAmount ??
      ((live.stagedEntryFirstFillPriceUsd ?? live.entryPriceUsd) > 0
        ? priorCost / (live.stagedEntryFirstFillPriceUsd ?? live.entryPriceUsd)
        : 0);
    live.stagedEntryTotalCostUsd = priorCost + addCostUsd;
    live.stagedEntryTotalTokenAmount =
      priorTokens + (fillPx > 0 ? addCostUsd / fillPx : 0);
    live.stagedEntryAvgCostPriceUsd =
      live.stagedEntryTotalTokenAmount > 0
        ? live.stagedEntryTotalCostUsd / live.stagedEntryTotalTokenAmount
        : live.entryPriceUsd;
    live.stagedEntryAddDone = true;
    if (raw && /^\d+$/.test(raw) && BigInt(raw) > 0n) {
      live.tokenRaw = raw;
      live.tokenRawSettled = false;
    }
    saveMildDipState(cfg.statePath, state);
    journal({
      ok: true,
      addUsd: sized.sizeUsd,
      reason: null,
      fillPx: buy.priceUsd || markPriceUsd,
      signature: buy.signature ?? null,
    });
  } catch (err) {
    journal({
      ok: false,
      addUsd: sized.sizeUsd,
      reason: err instanceof Error ? err.message : String(err),
    });
    saveMildDipState(cfg.statePath, state);
  }
}

async function attemptMirrorAverage(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  pos: MildDipOpenPosition;
  markPriceUsd: number;
  nowMs: number;
  leaderHeld: boolean;
}): Promise<void> {
  const { cfg, state, pos, markPriceUsd, nowMs } = args;
  if (mildDipStateSaveBlocked()) return;
  const g = cfg.leaderMirror;
  if (g.lossCapUsd > 0 && state.mirrorLossCapTriggeredAtMs != null) return;
  if (
    (pos.mirrorFirstClipLegsFilled ?? 1) <
    Math.max(1, Math.min(2, Math.floor(g.firstClipLegs ?? 1)))
  ) return;
  const averageAttempts = pos.mirrorAverageAttempts ?? 0;
  const averageReference = mirrorAverageReference({
    entryPriceUsd: pos.mirrorOriginalEntryPriceUsd ?? pos.entryPriceUsd,
    lastAverageFillPriceUsd: pos.mirrorAverageFillPriceUsd,
    attempts: averageAttempts,
    initialDiscountPct: g.averageMinDiscountPct,
    nextDiscountPct: g.averageNextDiscountPct,
  });
  if (!averageReference) return;
  const averageHoldSinceMs =
    averageAttempts > 0
      ? pos.mirrorAverageLastFillAtMs ?? pos.openedAtMs
      : pos.openedAtMs;
  if (
    !args.leaderHeld ||
    averageAttempts >= g.averageMaxTimes ||
    (pos.mirrorAverageLastAttemptAtMs != null &&
      nowMs - pos.mirrorAverageLastAttemptAtMs < 60_000) ||
    !(g.averageEnabled && g.averageUsd > 0)
  ) return;
  if (buyInFlight.has(pos.mint) || sellInFlight.has(pos.mint)) return;
  const target = await mirrorRecentLocalLow({
    mint: pos.mint,
    nowMs,
    windowsMs: g.averageWindowsMs,
    excludeTailMs: g.averageExcludeTailMs,
    entryPriceUsd: averageReference.entryPriceUsd,
    minDiscountPct: averageReference.minDiscountPct,
  });
  if (
    target == null ||
    !mirrorAverageHoldAllowed({
      openedAtMs: averageHoldSinceMs,
      nowMs,
      minHoldMs: g.averageMinHoldMs,
    }) ||
    !mirrorAveragePriceAllowed({
      markPriceUsd,
      entryPriceUsd: averageReference.entryPriceUsd,
      targetPriceUsd: target,
      tolerancePct: g.averageTolerancePct,
      minDiscountPct: averageReference.minDiscountPct,
    })
  ) return;
  pos.mirrorAverageLastAttemptAtMs = nowMs;
  saveMildDipState(cfg.statePath, state);
  const copyCfg = mildDipToCopyTraderConfig(cfg);
  const sized = await resolveEntrySizeUsd(cfg, copyCfg, nowMs, g.averageUsd);
  if (sized.stop || !(sized.sizeUsd > 0)) {
    saveMildDipState(cfg.statePath, state);
    return;
  }
  buyInFlight.add(pos.mint);
  try {
    const buy = await executeCopyBuy({
      cfg: copyCfg,
      mint: pos.mint,
      symbol: pos.symbol,
      priceUsd: markPriceUsd,
      sizeUsd: Math.min(g.averageUsd, sized.sizeUsd),
      kind: 'add',
      evalResult: { pass: true, reasons: ['mirror_local_low_average'], score: target },
      leaderSignature: `milddip_mirror_average_${pos.mint.slice(0, 8)}_${nowMs}`,
      trigger: 'stream',
      leaderPriceUsd: markPriceUsd,
      leaderBuyTs: nowMs,
      beforeSend: async () => {
        const guardRead = await readLeaderBalanceForGuard(
          cfg,
          pos.leaderMirrorLeader,
          pos.mint,
        );
        const raw = guardRead.balanceRaw;
        const holds = raw != null && raw > 0n;
        appendMildDipJournal(cfg.journalPath, {
          kind: 'leader_mirror_balance_guard',
          mint: pos.mint,
          leader: pos.leaderMirrorLeader ?? null,
          holds,
          reason: leaderBalanceGuardReason(guardRead),
        });
        return holds;
      },
      slippageRetryMultiplier: g.executionSlippageMultiplier,
      slippageRetryMaxBps: g.executionSlippageMaxBps,
    });
    if (!buy.ok) return;
    const live = state.open[pos.mint];
    if (!live) return;
    const addUsd = buy.quoteSpentUsd ?? Math.min(g.averageUsd, sized.sizeUsd);
    const fillPx = buy.priceUsd > 0 ? buy.priceUsd : markPriceUsd;
    try {
      writeUsBuyFill({
        tradesPath: cfg.tradesPath,
        wallet:
          cfg.walletPubkeyExpected?.trim() ||
          executionWalletPubkey(copyCfg) ||
          'unknown',
        mint: pos.mint,
        symbol: pos.symbol,
        ok: true,
        signature: buy.signature ?? null,
        sizeUsdIntent: Math.min(g.averageUsd, sized.sizeUsd),
        usdcBefore: buy.usdcBefore ?? sized.usdc ?? null,
        usdcAfter: buy.usdcAfter ?? null,
        feeSolBefore: buy.feeSolBefore ?? null,
        feeSolAfter: buy.feeSolAfter ?? null,
        quoteSpentUsd: buy.quoteSpentUsd ?? addUsd,
        txMeta: buy.txMeta,
        fillPriceUsd: fillPx,
        dipSource: 'mirror_average',
        nowMs,
      });
    } catch {
      /* never block mirror average state updates on journal IO */
    }
    const event = buy as unknown as Record<string, unknown>;
    accountMirrorCashLeg(state, event, 'buy');
    const priorTokens = live.sizeUsd / Math.max(live.entryPriceUsd, 1e-18);
    const addTokens = addUsd / Math.max(fillPx, 1e-18);
    live.entryPriceUsd = (live.sizeUsd + addUsd) / (priorTokens + addTokens);
    live.sizeUsd += addUsd;
    live.mirrorAverageDone = true;
    live.mirrorAverageAttempts = (live.mirrorAverageAttempts ?? 0) + 1;
    live.mirrorAverageFillPriceUsd = fillPx;
    live.mirrorAverageLastFillAtMs = nowMs;
    live.mirrorLadderBasisPriceUsd = fillPx;
    live.mirrorLadderRungsDone = 0;
    const raw = await fetchMintBalanceRaw(copyCfg, pos.mint);
    if (raw && /^\d+$/.test(raw)) {
      live.tokenRaw = raw;
      live.tokenRawSettled = false;
    }
    saveMildDipState(cfg.statePath, state);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mirror_average',
      mint: pos.mint,
      symbol: pos.symbol,
      targetPriceUsd: target,
      markPriceUsd,
      fillPriceUsd: fillPx,
      amountUsd: addUsd,
      attempt: live.mirrorAverageAttempts,
      newEntryPriceUsd: live.entryPriceUsd,
    });
  } catch (err) {
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mirror_average',
      mint: pos.mint,
      symbol: pos.symbol,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    buyInFlight.delete(pos.mint);
  }
}

async function tryExits(
  cfg: MildDipConfig,
  state: MildDipState,
  nowMs: number,
  oneshotDumpGrace: ReturnType<typeof createOneshotDumpGraceTracker>,
  dumpTape: ReturnType<typeof createDumpSellTape>,
  givebackDumpGate: ReturnType<typeof createGivebackDumpGate>,
  leaderSellFeed: LeaderSellFeed | null,
): Promise<void> {
  const lossCapValues = mirrorLossCapValues(state);
  if (nowMs - lastMirrorLossCapEvaluationMs >= 5_000) {
    lastMirrorLossCapEvaluationMs = nowMs;
    maybeTriggerMirrorLossCap(cfg, state, lossCapValues.drawdownUsd, nowMs);
  }
  if (
    cfg.leaderMirror.enabled &&
    nowMs - lastMirrorLossCapStatusMs >= 60_000
  ) {
    lastMirrorLossCapStatusMs = nowMs;
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mirror_realized_loss_cap_status',
      tradingCashUsd: lossCapValues.cashUsd,
      openBagsUsd: lossCapValues.bagsUsd,
      drawdownUsd: lossCapValues.drawdownUsd,
      baselineAtMs: state.mirrorLossCapBaselineAtMs ?? null,
      lossCapUsd: cfg.leaderMirror.lossCapUsd,
      remainingToCapUsd:
        cfg.leaderMirror.lossCapUsd > 0
          ? Math.max(0, lossCapValues.drawdownUsd + cfg.leaderMirror.lossCapUsd)
          : null,
      capTriggered: mirrorLossCapTriggered(cfg, state),
      openMirror: Object.values(state.open).filter(
        (position) => position.lane === 'leader_mirror',
      ).length,
    });
  }
  const ordered = orderMintsForMark(state.open).filter(
    (m) => !sellInFlight.has(m) && !buyInFlight.has(m),
  );
  if (ordered.length === 0) return;

  const leaderHits =
    cfg.leaderAlignEnabled && cfg.leaderSeedPath
      ? readLeaderSeedHits(cfg.leaderSeedPath, nowMs, {
          maxAgeMs: Math.max(cfg.leaderAlignMaxAgeMs, 60_000),
          max: cfg.leaderSeedMax,
        })
      : [];
  const markStarted = Date.now();
  // 1.11.794 — refresh blind/oldest first so armed bags cannot starve new opens
  // of the Dex→ring slots (was hard-coded maxInFlight=3 in armed-first order).
  const refreshOrder = orderMintsForDexRefresh({
    mints: ordered,
    nowMs,
    ringAgeMs: openMarkRingAgeMs,
  });
  // 1.11.820 — warm the whole open book in one batched request before the
  // per-mint refreshes; each of those then reads cache instead of hitting the
  // API. With 30+ open bags this was the second-largest DexScreener consumer.
  if (cfg.markDexRefreshMs > 0) {
    const stale = refreshOrder.filter(
      (m) => openMarkRingAgeMs(m, nowMs) >= cfg.markDexRefreshMs,
    );
    if (stale.length > 1) {
      void prefetchDexScreenerPairDetailsMany(stale, {
        nowMs,
        allowedDexIds: cfg.entry.allowedDexIds,
        cacheTtlMs: cfg.markCacheTtlMs > 0 ? cfg.markCacheTtlMs : 15_000,
        bypassGate: true,
      }).catch(() => undefined);
    }
  }
  /**
   * 1.11.917 — an armed bag may not be judged on a print that has not moved.
   */
  const armedBound = cfg.markArmedMaxAgeMs > 0 ? cfg.markArmedMaxAgeMs : 0;
  const armedStale =
    armedBound > 0
      ? refreshOrder.filter((m) => {
          const p = state.open[m];
          if (p?.trailArmed !== true) return false;
          if (openMarkRingAgeMs(m, nowMs) >= armedBound) return true;
          const px = mildDipPriceRing.lastPrice(m, nowMs)?.priceUsd;
          const unchangedSinceMs = p.markUnchangedSinceMs;
          if (px != null && px === p.lastMarkPriceUsd && unchangedSinceMs != null) {
            return nowMs - unchangedSinceMs >= armedBound;
          }
          return false;
        })
      : [];
  if (armedStale.length > 0) {
    await prefetchDexScreenerPairDetailsMany(armedStale, {
      nowMs,
      allowedDexIds: cfg.entry.allowedDexIds,
      cacheTtlMs: Math.min(cfg.markCacheTtlMs > 0 ? cfg.markCacheTtlMs : 3_000, 3_000),
      bypassGate: true,
    }).catch(() => undefined);
  }
  for (const mint of refreshOrder) {
    maybeRequestOpenMarkRefresh(mint, nowMs, cfg);
    maybeRequestOpenMarkJupiterRefresh(mint, nowMs, cfg);
  }
  // Exit decisions: armed-first; sync ring reads only.
  const markRows = ordered.map((mint) => {
    const { px, volume5mUsd, source } = markPriceUsd(
      mint,
      nowMs,
      cfg,
      state.open[mint]?.openedAtMs,
    );
    const metrics = readOpenMarkMetrics(mint, nowMs);
    return {
      mint,
      px,
      volume5mUsd: metrics?.volume5mUsd ?? volume5mUsd,
      pc5mPct: metrics?.pc5mPct ?? null,
      liquidityUsd: metrics?.liquidityUsd ?? null,
      liquidityMetricsTsMs: metrics?.tsMs ?? null,
      source,
    };
  });
  const markPassMs = Date.now() - markStarted;
  let markedOk = 0;
  let markedNull = 0;
  for (const row of markRows) {
    if (row.px == null) markedNull += 1;
    else markedOk += 1;
  }

  const toSell: MarkExitDecision[] = [];
  const streamRows = markRows.filter((r) => r.source === 'stream' && r.px != null);
  if (streamRows.length > 0) {
    await prefetchDexScreenerPairDetailsMany(
      streamRows.map((r) => r.mint),
      {
        nowMs,
        allowedDexIds: cfg.entry.allowedDexIds,
        cacheTtlMs: Math.min(cfg.markCacheTtlMs > 0 ? cfg.markCacheTtlMs : 3_000, 3_000),
        bypassGate: true,
      },
    ).catch(() => undefined);
  }
  for (const {
    mint,
    px,
    volume5mUsd,
    pc5mPct,
    liquidityUsd,
    liquidityMetricsTsMs,
    source,
  } of markRows) {
    const pos = state.open[mint];
    if (!pos || sellInFlight.has(mint)) continue;
    const feedLeaderSell = leaderSellFeed?.get(mint, nowMs);
    if (
      pos.mirrorLeaderSellIntent &&
      !isLeaderSellEventValidForPosition({
        event: {
          mint,
          leader: pos.mirrorLeaderSellIntent.leader,
          signature: pos.mirrorLeaderSellIntent.signature,
          blockTimeMs: pos.mirrorLeaderSellIntent.leaderBlockTimeMs,
          fillPriceUsd: null,
          markPnlPct: null,
        },
        leader: pos.leaderMirrorLeader,
        leaderBuyTsMs: pos.leaderBuyTsMs,
        openedAtMs: pos.openedAtMs,
      })
    ) {
      const droppedIntent = pos.mirrorLeaderSellIntent;
      delete pos.mirrorLeaderSellIntent;
      saveMildDipState(cfg.statePath, state);
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mirror_leader_sell_intent_dropped',
        mint,
        symbol: pos.symbol,
        leader: droppedIntent.leader,
        signature: droppedIntent.signature,
        leaderBlockTimeMs: droppedIntent.leaderBlockTimeMs,
        leaderBuyTsMs: pos.leaderBuyTsMs ?? null,
        reason: 'before_current_leader_session',
      });
    }
    const durableLeaderSell: LeaderSellEvent | null = pos.mirrorLeaderSellIntent
      ? {
          mint,
          leader: pos.mirrorLeaderSellIntent.leader,
          signature: pos.mirrorLeaderSellIntent.signature,
          blockTimeMs: pos.mirrorLeaderSellIntent.leaderBlockTimeMs,
          fillPriceUsd: null,
          markPnlPct: null,
        }
      : null;
    const validFeedLeaderSell =
      feedLeaderSell &&
      isLeaderSellEventValidForPosition({
        event: feedLeaderSell,
        leader: pos.leaderMirrorLeader,
        leaderBuyTsMs: pos.leaderBuyTsMs,
        openedAtMs: pos.openedAtMs,
      })
        ? feedLeaderSell
        : null;
    const leaderSellEvent = selectNewerLeaderSellEvent(
      durableLeaderSell,
      validFeedLeaderSell,
    );
    const leaderSellEventIsDurable =
      leaderSellEvent != null && leaderSellEvent === durableLeaderSell;
    const leaderSellDecision = decideLeaderSellExit({
      enabled: cfg.leaderMirror.leaderSellExitEnabled,
      lane: pos.lane,
      leaders: cfg.leaderMirror.leaders,
      event: leaderSellEvent,
      openedAtMs: pos.leaderBuyTsMs,
      nowMs,
      // Once persisted on the position, the intent is authoritative and is
      // deliberately outside the live feed's freshness window.
      maxAgeMs: leaderSellEventIsDurable ? 0 : cfg.leaderMirror.leaderSellExitMaxAgeMs,
    });
    if (
      leaderSellEventIsDurable &&
      !mirrorLeaderSellRetryDue(pos.mirrorLeaderSellIntent?.lastAttemptAtMs, nowMs)
    ) {
      continue;
    }
    if (leaderSellDecision.shouldExit && leaderSellEvent) {
      if (
        !pos.mirrorLeaderSellIntent ||
        leaderSellEvent.blockTimeMs > pos.mirrorLeaderSellIntent.leaderBlockTimeMs
      ) {
        pos.mirrorLeaderSellIntent = {
          leader: leaderSellEvent.leader,
          signature: leaderSellEvent.signature,
          leaderBlockTimeMs: leaderSellEvent.blockTimeMs,
          detectedAtMs: nowMs,
        };
        saveMildDipState(cfg.statePath, state);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mirror_leader_sell_intent',
          mint,
          symbol: pos.symbol,
          leader: leaderSellEvent.leader,
          signature: leaderSellEvent.signature,
          leaderBlockTimeMs: leaderSellEvent.blockTimeMs,
          detectedAtMs: nowMs,
          source: 'live_feed',
        });
      }
      const ourMarkPriceUsd = px;
      const markPriceUsd =
        ourMarkPriceUsd != null && ourMarkPriceUsd > 0
          ? ourMarkPriceUsd
          : pos.entryPriceUsd;
      const ourPnlPct =
        ourMarkPriceUsd != null && pos.entryPriceUsd > 0
          ? ((ourMarkPriceUsd / pos.entryPriceUsd) - 1) * 100
          : null;
      const pnlPct = ourPnlPct ?? 0;
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mirror_leader_sell_exit',
        mint,
        symbol: pos.symbol,
        leader: leaderSellEvent.leader,
        leaderSignature: leaderSellEvent.signature,
        leaderBlockTimeMs: leaderSellEvent.blockTimeMs,
        leaderFillPriceUsd: leaderSellEvent.fillPriceUsd,
        leaderMarkPnlPct: leaderSellEvent.markPnlPct,
        ourMarkPriceUsd,
        ourPnlPct: ourPnlPct == null ? null : +ourPnlPct.toFixed(2),
        lagMs: Math.max(0, nowMs - leaderSellEvent.blockTimeMs),
        reason: leaderSellDecision.reason,
      });
      leaderSellFeed?.remove(mint);
      toSell.push({
        mint,
        markPriceUsd,
        entryMarketPriceUsd: pos.entryMarkPriceUsd ?? null,
        tpRungIndex: null,
        peakPriceUsd: Math.max(pos.peakPriceUsd ?? 0, markPriceUsd),
        armed: pos.trailArmed === true,
        justArmed: false,
        shouldExit: true,
        fraction: 1,
        reason: 'mirror_leader_sell',
        mfePct: 0,
        givebackPct: 0,
        pnlPct,
        gainPct: pnlPct,
        gainBasisPriceUsd: pos.entryPriceUsd,
        pnlPctVsFill: pnlPct,
        bounceOffTroughPct: 0,
        troughAgeMs: 0,
        volFadeSamples: pos.volFadeSamples ?? [],
        postEntryTroughPriceUsd: pos.postEntryTroughUsd ?? pos.entryPriceUsd,
        postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
      });
      continue;
    }
    /**
     * 1.11.879 — let a sell settle before deciding again on this bag.
     *
     * `sellInFlight` only covers the transaction. Once it cleared, the next mark
     * tick two seconds later decided on a price that could predate the sell, and
     * on a size the chain read had not caught up with: two `never_arm_bounce`
     * legs went out 4.1s apart (33Grh5V then 2HJmyTW), the second filling 5.6%
     * lower than the first while the reading it fired on said the bounce had
     * grown. One decision per bag until the data postdates the last one.
     */
    if (
      cfg.exitMinSpacingMs > 0 &&
      pos.lastSellAtMs != null &&
      nowMs - pos.lastSellAtMs < cfg.exitMinSpacingMs
    ) {
      continue;
    }
    if (
      px != null &&
      pos.lastSellMarkPriceUsd != null &&
      px === pos.lastSellMarkPriceUsd
    ) {
      continue;
    }

    const heldMs = Math.max(0, nowMs - (pos.openedAtMs > 0 ? pos.openedAtMs : nowMs));
    const maxHold = cfg.exit.neverArmMaxHoldMs > 0 ? cfg.exit.neverArmMaxHoldMs : 0;
    const hardTimeStop =
      cfg.exit.hardTimeStopMs > 0 ? cfg.exit.hardTimeStopMs : 0;
    const deadMin = cfg.exit.neverArmDeadMinMs > 0 ? cfg.exit.neverArmDeadMinMs : 0;

    /**
     * Null / blind mark must NOT skip hold ceilings — a delisted or
     * ring-frozen mint can otherwise sit forever (5EAUpz: pnl stuck at 0).
     * 1.11.781/782 — past max-hold force-exit even when armed (cannot prove green).
     */
    if (px == null) {
      let forceReason:
        | 'never_arm_timeout'
        | 'max_hold_underwater'
        | 'hard_time_stop'
        | 'never_arm_dead'
        | null =
        null;
      if (hardTimeStop > 0 && heldMs >= hardTimeStop) {
        forceReason = 'hard_time_stop';
      } else if (maxHold > 0 && heldMs >= maxHold) {
        forceReason =
          pos.trailArmed === true ? 'max_hold_underwater' : 'never_arm_timeout';
      } else if (pos.trailArmed !== true && deadMin > 0 && heldMs >= deadMin) {
        forceReason = 'never_arm_dead';
      }
      if (forceReason) {
        const syn =
          pos.peakPriceUsd != null && pos.peakPriceUsd > 0
            ? pos.peakPriceUsd
            : pos.entryPriceUsd;
        console.warn(
          `[mild-dip] force-exit ${pos.symbol} mint=${mint.slice(0, 8)}… reason=${forceReason} (null mark, held=${Math.round(heldMs / 1000)}s)`,
        );
        toSell.push({
          mint,
          markPriceUsd: syn,
          entryMarketPriceUsd: pos.entryMarkPriceUsd ?? null,
          tpRungIndex: null,
          peakPriceUsd: syn,
          armed: pos.trailArmed === true,
          justArmed: false,
          shouldExit: true,
          fraction: 1,
          reason: forceReason,
          mfePct: 0,
          givebackPct: 0,
          pnlPct: 0,
          gainPct: 0,
          gainBasisPriceUsd: pos.entryPriceUsd,
          pnlPctVsFill: 0,
          bounceOffTroughPct: 0,
          troughAgeMs: 0,
          volFadeSamples: pos.volFadeSamples ?? [],
          postEntryTroughPriceUsd: pos.postEntryTroughUsd ?? pos.entryPriceUsd,
          postEntryTroughAtMs: pos.postEntryTroughAtMs ?? pos.openedAtMs,
        });
      }
      continue;
    }

    const dexCrossCheckPx =
      source === 'stream' && px != null
        ? (
            await fetchDexScreenerPairDetails(mint, {
              nowMs,
              allowedDexIds: cfg.entry.allowedDexIds,
              cacheTtlMs: Math.min(cfg.markCacheTtlMs > 0 ? cfg.markCacheTtlMs : 3_000, 3_000),
              bypassGate: true,
            })
          )?.priceUsd ?? null
        : null;
    const priceSanity = validateStreamDexPrice({
      streamPriceUsd: source === 'stream' ? px : null,
      dexPriceUsd: dexCrossCheckPx,
      maxDivergenceFactor: cfg.streamDexMaxDivergenceFactor,
    });
    if (!priceSanity.valid) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_stream_dex_price_sanity_skip',
        mint,
        streamPriceUsd: px,
        dexPriceUsd: dexCrossCheckPx,
        divergenceFactor: priceSanity.divergence,
        source,
        at: 'exit',
      });
      continue;
    }
    const mirrorFirstClipPending =
      pos.lane === 'leader_mirror' &&
      (() => {
        const firstClipLegs = Math.max(
          1,
          Math.min(2, Math.floor(cfg.leaderMirror.firstClipLegs ?? 1)),
        );
        const firstFillAtMs = mirrorFirstClipWindowBaseMs(
          pos.openedAtMs,
          pos.mirrorFirstClipFirstFillAtMs,
        );
        return (
          (pos.mirrorFirstClipLegsFilled ?? 1) < firstClipLegs &&
          nowMs - firstFillAtMs <= cfg.leaderMirror.entryGraceMs
        );
      })();
    const mirrorLastBuyFillAtMs = Math.max(
      mirrorFirstClipWindowBaseMs(
        pos.openedAtMs,
        pos.mirrorFirstClipFirstFillAtMs,
      ),
      pos.mirrorAverageLastFillAtMs ?? 0,
    );
    const mirrorEntrySettlementAgeMs = Math.max(0, nowMs - mirrorLastBuyFillAtMs);
    const mirrorEntrySettling =
      pos.lane === 'leader_mirror' &&
      cfg.leaderMirror.ladderMinSettleSec > 0 &&
      mirrorEntrySettlementAgeMs < cfg.leaderMirror.ladderMinSettleSec * 1_000;
    const decision = decideMarkExit({
      mint,
      pos,
      markPriceUsd: px,
      gates: cfg.exit,
      markJumpConfirmMaxMs: cfg.markJumpConfirmMaxMs,
      markQuarantineGreenMaxMs: cfg.exit.markQuarantineGreenMaxMs,
      dexCrossCheckPx,
      nowMs,
      pc5mPct,
      volume5mUsd,
      turnover5mLiq: (() => {
        const om = readOpenMarkMetrics(mint, nowMs);
        return om && om.volume5mUsd != null && om.liquidityUsd != null && om.liquidityUsd > 0
          ? om.volume5mUsd / om.liquidityUsd
          : null;
      })(),
      liquidityUsd,
      liquidityMetricsFresh: liquidityUsd != null,
      liquidityMetricsTsMs,
      oneshotDumpGraceActive:
        cfg.oneshotDumpGraceEnabled && oneshotDumpGrace.isActive(mint, nowMs),
      markSource: source,
      greenGates: {
        takeProfitPct:
          pos.greenExitTakeProfitPct ??
          (cfg.green.exitTrailEnabled ? 0 : cfg.green.takeProfitPct),
        stopPct:
          pos.greenExitStopPct ??
          (cfg.green.exitTrailEnabled ? cfg.green.exitStopPct : cfg.green.stopPct),
        maxHoldMs:
          pos.greenExitMaxHoldMs ??
          (cfg.green.exitTrailEnabled ? cfg.green.exitMaxHoldMs : cfg.green.maxHoldMs),
        noMoveCutMs: pos.greenExitNoMoveCutMs ?? cfg.green.noMoveCutMs,
        noMoveMinMfePct: pos.greenExitNoMoveMinMfePct ?? cfg.green.noMoveMinMfePct,
        trailEnabled: pos.greenExitTrailEnabled ?? cfg.green.exitTrailEnabled,
        armPct: pos.greenExitArmPct ?? cfg.green.exitArmPct,
        trailPct: pos.greenExitTrailPct ?? cfg.green.exitTrailPct,
      },
      mirrorGates: {
        trailEnabled: cfg.leaderMirror.ownExitEnabled,
        takeProfitPct: 0,
        stopPct: pos.mirrorExitStopPct ?? cfg.leaderMirror.exitStopPct,
        maxHoldMs: pos.mirrorExitMaxHoldMs ?? cfg.leaderMirror.maxHoldMs,
        noMoveCutMs: pos.mirrorExitNoMoveCutMs ?? cfg.leaderMirror.noMoveCutMs,
        noMoveMinMfePct: pos.mirrorExitNoMoveMinMfePct ?? cfg.leaderMirror.noMoveMinMfePct,
        armPct: pos.mirrorExitArmPct ?? cfg.leaderMirror.exitArmPct,
        trailPct: pos.mirrorExitTrailPct ?? cfg.leaderMirror.exitTrailPct,
        ownExitEnabled: cfg.leaderMirror.ownExitEnabled,
        lossCapActive:
          cfg.leaderMirror.lossCapFlatten &&
          mirrorLossCapTriggered(cfg, state),
        ownExitTimeStopMs: cfg.leaderMirror.ownExitTimeStopMs,
        leaderSellOnly: cfg.leaderMirror.leaderSellOnlyExit,
        safetyMaxHoldMs: cfg.leaderMirror.safetyMaxHoldMs,
        ladderStepPct: cfg.leaderMirror.ladderStepPct,
        ladderStepAfterAveragePct: cfg.leaderMirror.ladderStepAfterAveragePct,
        ladderSellFraction: cfg.leaderMirror.ladderSellFraction,
        ladderDustUsd: cfg.leaderMirror.ladderDustUsd,
        mirrorDustCloseUsd: cfg.leaderMirror.dustCloseUsd,
        mirrorFirstClipPending,
        mirrorEntrySettling,
        mirrorEntrySettlementAgeMs,
      },
      leaderStyleGates: pos.lane === 'leader_style'
        ? {
            profitReboundPct: cfg.leaderStyle.profitReboundPct,
            pnlTpPct: cfg.leaderStyle.pnlTpPct,
            volFadeRatio: cfg.leaderStyle.volFadeRatio,
            depthDrainMax: cfg.leaderStyle.depthDrainMax,
            maxHoldMs: cfg.leaderStyle.maxHoldMs,
          }
        : undefined,
    });
    if (!decision) continue;
    if (decision.markQuarantined === true) {
      maybeRequestOpenMarkJupiterRefresh(mint, nowMs, cfg, true);
    }
    // First usable volume reading becomes the fade baseline for adopted bags.
    if (pos.entryVolume5mUsd == null && volume5mUsd != null && volume5mUsd > 0) {
      pos.entryVolume5mUsd = volume5mUsd;
    }

    maybeJournalMark(cfg, pos, decision, volume5mUsd, liquidityUsd, nowMs, source);
    if (decision.mirrorExitSuppressedReason != null) {
      const key = `${mint}:${decision.mirrorExitSuppressedReason}`;
      const lastSuppressedAtMs = lastMirrorExitSuppressedJournalMs.get(key) ?? 0;
      if (nowMs - lastSuppressedAtMs >= MIRROR_EXIT_SUPPRESSED_JOURNAL_GAP_MS) {
        lastMirrorExitSuppressedJournalMs.set(key, nowMs);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_mirror_exit_suppressed',
          mint,
          symbol: pos.symbol,
          reason: decision.mirrorExitSuppressedReason,
          tokenRawSettled: pos.tokenRawSettled === true,
          entrySettlementAgeMs: decision.mirrorExitSuppressedReason === 'entry_settling'
            ? mirrorEntrySettlementAgeMs
            : null,
          firstClipLegsFilled: pos.mirrorFirstClipLegsFilled ?? 1,
          at: nowMs,
        });
      }
    }

    const priorLossReclaimWaitStartedAtMs = pos.lossReclaimWaitStartedAtMs;
    applyMarkDecisionToPosition(pos, decision);
    if (
      decision.lossReclaimWaitStartedAtMs != null &&
      priorLossReclaimWaitStartedAtMs !== decision.lossReclaimWaitStartedAtMs
    ) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_loss_reclaim_wait',
        mint,
        symbol: pos.symbol,
        action: 'start',
        startedAtMs: decision.lossReclaimWaitStartedAtMs,
        maxLossPct: cfg.exit.lossReclaimMaxLossPct,
        targetPct: cfg.exit.lossReclaimTargetPct,
        maxWaitMs: cfg.exit.lossReclaimMaxWaitMs,
      });
    }
    if (decision.lossReclaimWaitClearedReason != null) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_loss_reclaim_wait',
        mint,
        symbol: pos.symbol,
        action: 'clear',
        reason: decision.lossReclaimWaitClearedReason,
        waitMs:
          priorLossReclaimWaitStartedAtMs != null
            ? Math.max(0, nowMs - priorLossReclaimWaitStartedAtMs)
            : 0,
        targetPct: cfg.exit.lossReclaimTargetPct,
      });
    }

    if (
      !decision.markQuarantined &&
      !decision.shouldExit &&
      decision.markPriceUsd > 0 &&
      !sellInFlight.has(mint)
    ) {
      if (pos.lane === 'leader_mirror') {
        const firstClipLegs = Math.max(
          1,
          Math.min(2, Math.floor(cfg.leaderMirror.firstClipLegs ?? 1)),
        );
        const firstFillAtMs = mirrorFirstClipWindowBaseMs(
          pos.openedAtMs,
          pos.mirrorFirstClipFirstFillAtMs,
        );
        const firstFillPrice =
          pos.mirrorOriginalEntryPriceUsd ?? pos.entryPriceUsd;
        const firstClipWindowLive =
          (pos.mirrorFirstClipLegsFilled ?? 1) < firstClipLegs &&
          nowMs - firstFillAtMs <= cfg.leaderMirror.entryGraceMs;
        const premiumAllowed =
          firstFillPrice > 0 &&
          decision.markPriceUsd <=
            firstFillPrice * (1 + cfg.leaderMirror.maxPremiumPct / 100);
        if (
          firstClipWindowLive &&
          leaderSellEvent == null &&
          premiumAllowed
        ) {
          await attemptMirrorFirstClipLeg({
            cfg,
            state,
            leader: pos.leaderMirrorLeader,
            candidate: {
              mint,
              symbol: pos.symbol,
              priceUsd: decision.markPriceUsd,
              dipSource: 'leader_mirror',
              metrics: {
                priceChange5mPct: null,
                volume5mUsd: null,
                liquidityUsd,
                marketCapUsd: null,
                pairAgeHours: null,
                dexId: null,
                buys5m: null,
                sells5m: null,
                volume1hUsd: null,
                priceChange1hPct: null,
              },
            },
            copyCfg: mildDipToCopyTraderConfig(cfg),
            nowMs,
            buyInFlight,
            resolveEntrySizeUsd,
          });
        } else if (
          (pos.mirrorFirstClipLegsFilled ?? 1) < firstClipLegs &&
          !firstClipWindowLive
        ) {
          pos.mirrorFirstClipLegsFilled = firstClipLegs;
          saveMildDipState(cfg.statePath, state);
        }
        await attemptMirrorAverage({
          cfg,
          state,
          pos,
          markPriceUsd: decision.markPriceUsd,
          nowMs,
          leaderHeld: leaderSellEvent == null,
        });
      }
      if (cfg.leaderMirror.mirrorOnly) continue;
      await attemptStagedEntryAdd({
        cfg,
        state,
        pos,
        markPriceUsd: decision.markPriceUsd,
        liquidityUsd,
        nowMs,
        troughPriceUsd: decision.postEntryTroughPriceUsd,
        troughAtMs: decision.postEntryTroughAtMs,
      });
    }

    let profitExitVetoed = false;
    if (decision.shouldExit && decision.reason) {
      const profitMinHoldMs = cfg.exit.profitExitMinHoldMs;
      const positionAgeMs = Math.max(0, nowMs - pos.openedAtMs);
      if (
        profitMinHoldMs > 0 &&
        positionAgeMs < profitMinHoldMs &&
        !profitExitMinHoldBypassed({
          pnlPct: decision.pnlPct,
          bypassPnlPct: cfg.exit.profitExitMinHoldBypassPnlPct,
        }) &&
        profitExitMinHoldApplies({
          reason: decision.reason,
          gainPct: decision.gainPct,
          pnlPct: decision.pnlPct,
        })
      ) {
        profitExitVetoed = true;
        if (
          shouldJournalProfitExitMinHoldSkip({
            lastJournalAtMs: pos.profitExitMinHoldLastJournalAtMs,
            lastReason: pos.profitExitMinHoldLastReason,
            reason: decision.reason,
            nowMs,
          })
        ) {
          appendMildDipJournal(cfg.journalPath, {
            kind: 'mild_dip_profit_exit_min_hold_skip',
            mint,
            symbol: pos.symbol,
            branch: decision.reason,
            positionAgeMs,
            minHoldMs: profitMinHoldMs,
            bypassPnlPct: cfg.exit.profitExitMinHoldBypassPnlPct,
            markPx: decision.markPriceUsd,
            entryPx: pos.entryPriceUsd,
            pnlPct: +decision.pnlPct.toFixed(2),
            gainPct: +decision.gainPct.toFixed(2),
            mfePct: +decision.mfePct.toFixed(2),
          });
          pos.profitExitMinHoldLastJournalAtMs = nowMs;
          pos.profitExitMinHoldLastReason = decision.reason;
          saveMildDipState(cfg.statePath, state);
        }
      }
      const avgCostPx = stagedEntryAverageCostPx(pos);
      const vetoSinceMs = pos.stagedProfitVetoSinceMs;
      const profitGate = evaluateStagedProfitExit({
        reason: decision.reason,
        exitPx: decision.markPriceUsd,
        entryPriceUsd: pos.entryPriceUsd,
        stagedAddDone: pos.stagedEntryAddDone === true,
        avgCostPx,
        minOverAvgPct: cfg.stagedProfitMinOverAvgPct,
        vetoSinceMs,
        nowMs,
        vetoMaxMs: cfg.stagedProfitVetoMaxMs,
      });
      if (!profitGate.allow) {
        profitExitVetoed = true;
        let vetoStateChanged = false;
        if (pos.stagedProfitVetoSinceMs == null) {
          pos.stagedProfitVetoSinceMs = nowMs;
          vetoStateChanged = true;
        }
        const repeatDue =
          pos.stagedProfitVetoLastJournalAtMs == null ||
          nowMs - pos.stagedProfitVetoLastJournalAtMs >= 60_000;
        const sameVeto =
          pos.stagedProfitVetoLastReason === decision.reason &&
          pos.stagedProfitVetoLastThresholdPx === profitGate.thresholdPx;
        if (!sameVeto || repeatDue) {
          appendMildDipJournal(cfg.journalPath, {
            kind: 'mild_dip_staged_profit_exit_skip',
            mint,
            symbol: pos.symbol,
            reason: decision.reason,
            vetoReason: profitGate.reason,
            exitPx: decision.markPriceUsd,
            avgCostPx,
            thresholdPx: profitGate.thresholdPx,
            rung: decision.tpRungIndex,
          });
          pos.stagedProfitVetoLastJournalAtMs = nowMs;
          pos.stagedProfitVetoLastReason = decision.reason;
          pos.stagedProfitVetoLastThresholdPx = profitGate.thresholdPx;
          vetoStateChanged = true;
        }
        if (vetoStateChanged) {
          saveMildDipState(cfg.statePath, state);
        }
      } else if (profitGate.reason === 'veto_expired') {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_staged_profit_veto_expired',
          mint,
          symbol: pos.symbol,
          reason: decision.reason,
          vetoReason: profitGate.reason,
          exitPx: decision.markPriceUsd,
          avgCostPx,
          thresholdPx: profitGate.thresholdPx,
          rung: decision.tpRungIndex,
          allowed: true,
        });
        pos.stagedProfitVetoSinceMs = undefined;
        pos.stagedProfitVetoLastJournalAtMs = undefined;
        pos.stagedProfitVetoLastReason = undefined;
        pos.stagedProfitVetoLastThresholdPx = undefined;
        saveMildDipState(cfg.statePath, state);
      }
    }

    if (decision.justArmed) {
      appendMildDipJournal(cfg.journalPath, {
        kind: 'trail_armed',
        mint,
        symbol: pos.symbol,
        entryPx: pos.entryPriceUsd,
        peakPx: decision.peakPriceUsd,
        armPct: cfg.exit.armPct,
        mfePct: +decision.mfePct.toFixed(2),
      });
      console.log(
        `[mild-dip] ARM ${pos.symbol} mint=${mint.slice(0, 8)}… mfe=${decision.mfePct.toFixed(1)}% peak=$${decision.peakPriceUsd.toPrecision(4)}`,
      );
    }

    if (decision.shouldExit && decision.reason && !profitExitVetoed) {
      /**
       * 1.11.874 — would the entry side buy this right now? Then do not sell it
       * to buy it back. GCa9TZ went out on `breakeven_stop` at −10.48% and the
       * entry gate took it again ninety-eight seconds later, 7.7% lower, where
       * the ladder banked two rungs. One brain, not two hands.
       */
      if (cfg.exitDeferWouldBuyEnabled) {
        const om = readOpenMarkMetrics(mint, nowMs);
        const held = Math.max(0, nowMs - pos.openedAtMs);
        const deferVerdict = shouldDeferSoftExit({
          reason: decision.reason,
          gates: {
            enabled: true,
            maxTotalMs: cfg.exitDeferWouldBuyMaxMs,
          },
          entryGates: cfg.entry,
          metrics: om
            ? {
                pc5mPct: om.pc5mPct,
                volume5mUsd: om.volume5mUsd,
                liquidityUsd: om.liquidityUsd,
                ageMs: Math.max(0, nowMs - om.tsMs),
              }
            : null,
          carried: {
            marketCapUsd: pos.entryMarketCapUsd ?? null,
            pairAgeHours: pos.entryPairAgeHours ?? null,
          },
          priceRatioSinceEntry:
            pos.entryPriceUsd > 0 ? decision.markPriceUsd / pos.entryPriceUsd : null,
          heldMs: held,
          deferredMsSoFar: pos.exitDeferredMs ?? 0,
        });
        if (deferVerdict.defer) {
          const sinceLast =
            pos.exitDeferredAtMs != null ? Math.max(0, nowMs - pos.exitDeferredAtMs) : 0;
          // Only count time actually spent deferring, not the gaps between marks.
          pos.exitDeferredMs =
            (pos.exitDeferredMs ?? 0) + Math.min(sinceLast, cfg.markDexRefreshMs * 4);
          pos.exitDeferredAtMs = nowMs;
          const lastJ = lastExitDeferJournalMs.get(mint) ?? 0;
          if (nowMs - lastJ >= 5_000) {
            lastExitDeferJournalMs.set(mint, nowMs);
            appendMildDipJournal(cfg.journalPath, {
              kind: 'exit_defer_would_buy',
              mint,
              symbol: pos.symbol,
              wouldReason: decision.reason,
              pnlPct: +decision.pnlPct.toFixed(2),
              pnlPctVsFill: +decision.pnlPctVsFill.toFixed(2),
              mfePct: +decision.mfePct.toFixed(2),
              markPx: decision.markPriceUsd,
              entryPx: pos.entryPriceUsd,
              pc5m: om?.pc5mPct ?? null,
              vol5m: om?.volume5mUsd ?? null,
              liq: om?.liquidityUsd ?? null,
              deferredMs: pos.exitDeferredMs,
              budgetMs: cfg.exitDeferWouldBuyMaxMs,
            });
            console.log(
              `[mild-dip] EXIT_DEFER_WOULD_BUY ${pos.symbol} mint=${mint.slice(0, 8)}… ` +
                `held ${decision.reason} pnl=${decision.pnlPct.toFixed(1)}% ` +
                `pc5m=${om?.pc5mPct?.toFixed(1) ?? '?'}% spent=${Math.round((pos.exitDeferredMs ?? 0) / 1000)}s`,
            );
          }
          continue;
        }
        pos.exitDeferredAtMs = nowMs;
        /**
         * Why we are selling anyway. Without this the check was a blind spot:
         * four deferrable exits fired with no deferral and no record of what
         * declined them, which is how a mismatched staleness window hid.
         */
        appendMildDipJournal(cfg.journalPath, {
          kind: 'exit_defer_declined',
          mint,
          symbol: pos.symbol,
          wouldReason: decision.reason,
          declinedBy: deferVerdict.reasons.slice(0, 4).join(',') || null,
          pnlPct: +decision.pnlPct.toFixed(2),
          pc5m: readOpenMarkMetrics(mint, nowMs)?.pc5mPct ?? null,
          metricsAgeMs: (() => {
            const om = readOpenMarkMetrics(mint, nowMs, 0);
            return om ? Math.max(0, nowMs - om.tsMs) : null;
          })(),
        });
      }

      // 1.11.761 — leader just bought this mint while a soft exit is firing:
      // hold the sell and optionally average-in once (narrow; not a −5% scale-in).
      if (cfg.leaderAlignEnabled) {
        const seedHit = leaderSeedHitByMint(leaderHits, mint);
        const align = evaluateLeaderAlignDefer({
          enabled: true,
          shouldExit: true,
          reason: decision.reason,
          pnlPct: decision.pnlPct,
          entryPriceUsd: pos.entryPriceUsd,
          markPriceUsd: decision.markPriceUsd,
          nowMs,
          hit: toLeaderAlignHit(seedHit),
          maxAgeMs: cfg.leaderAlignMaxAgeMs,
          requireRedPct: cfg.leaderAlignRequireRedPct,
          minBelowEntryPct: cfg.leaderAlignMinBelowEntryPct,
          scaleInEnabled: cfg.leaderAlignScaleInEnabled,
          scaleInDone: pos.leaderAlignScaleInDone === true,
          requireLeaderAdd: cfg.leaderAlignRequireAdd,
        });
        if (align.defer) {
          const lastJ = lastLeaderAlignJournalMs.get(mint) ?? 0;
          if (nowMs - lastJ >= 5_000) {
            lastLeaderAlignJournalMs.set(mint, nowMs);
            appendMildDipJournal(cfg.journalPath, {
              kind: 'leader_align_defer',
              mint,
              symbol: pos.symbol,
              wouldReason: decision.reason,
              pnlPct: +decision.pnlPct.toFixed(2),
              mfePct: +decision.mfePct.toFixed(2),
              markPx: decision.markPriceUsd,
              entryPx: pos.entryPriceUsd,
              leader: align.hit?.leader ?? null,
              leaderSignature: align.hit?.signature ?? null,
              leaderFillPx: align.hit?.fillPriceUsd ?? null,
              leaderAgeMs: align.leaderAgeMs,
              scaleIn: align.scaleIn,
              scaleInDone: pos.leaderAlignScaleInDone === true,
            });
            console.log(
              `[mild-dip] LEADER_ALIGN_DEFER ${pos.symbol} mint=${mint.slice(0, 8)}… ` +
                `held ${decision.reason} pnl=${decision.pnlPct.toFixed(1)}% ` +
                `leader=${(align.hit?.leader ?? '').slice(0, 8)}… ` +
                `age=${Math.round((align.leaderAgeMs ?? 0) / 1000)}s` +
                (align.scaleIn ? ' → scale-in' : ''),
            );
          }
          if (align.scaleIn && align.hit) {
            void attemptLeaderAlignScaleIn({
              cfg,
              state,
              mint,
              nowMs,
              markPriceUsd: decision.markPriceUsd,
              hit: align.hit,
              wouldReason: decision.reason,
            }).catch((err) => {
              console.warn(
                '[mild-dip] leader-align scale-in error',
                err instanceof Error ? err.message : err,
              );
            });
          }
          continue;
        }
      }

      // Don't dump into a green reclaim off the local trough (5vkZWa stale).
      if (
        cfg.recoverDeferEnabled &&
        cfg.recoverDeferMinBouncePct > 0 &&
        RECOVER_DEFER_REASONS.has(decision.reason) &&
        decision.markPriceUsd > 0
      ) {
        const trough = mildDipPriceRing.minPrice(
          mint,
          cfg.recoverDeferLookbackMs,
          nowMs,
        );
        if (
          trough &&
          isRecoveringFromTrough({
            markPriceUsd: decision.markPriceUsd,
            troughPriceUsd: trough.priceUsd,
            minBouncePct: cfg.recoverDeferMinBouncePct,
          })
        ) {
          const bounce = bounceFromTroughPct(decision.markPriceUsd, trough.priceUsd) ?? 0;
          const lastJ = lastRecoverDeferJournalMs.get(mint) ?? 0;
          if (nowMs - lastJ >= 5_000) {
            lastRecoverDeferJournalMs.set(mint, nowMs);
            const event = {
              mint,
              symbol: pos.symbol,
              wouldReason: decision.reason,
              bouncePct: +bounce.toFixed(2),
              minBouncePct: cfg.recoverDeferMinBouncePct,
              troughPx: trough.priceUsd,
              markPx: decision.markPriceUsd,
              lookbackMs: cfg.recoverDeferLookbackMs,
              mfePct: +decision.mfePct.toFixed(2),
              pnlPct: +decision.pnlPct.toFixed(2),
            };
            if (recoverDeferIsCapped(decision.pnlPct, cfg.recoverDeferMaxPnlPct)) {
              appendMildDipJournal(cfg.journalPath, {
                kind: 'recover_defer_skip',
                ...event,
                capPnlPct: cfg.recoverDeferMaxPnlPct,
              });
              console.log(
                `[mild-dip] RECOVER_DEFER_SKIP ${pos.symbol} mint=${mint.slice(0, 8)}… ` +
                  `pnl=${decision.pnlPct.toFixed(1)}%≥${cfg.recoverDeferMaxPnlPct}% ` +
                  `bounce=${bounce.toFixed(1)}%`,
              );
            } else {
              appendMildDipJournal(cfg.journalPath, {
                kind: 'recover_defer',
                ...event,
              });
              console.log(
                `[mild-dip] RECOVER_DEFER ${pos.symbol} mint=${mint.slice(0, 8)}… ` +
                  `bounce=${bounce.toFixed(1)}%≥${cfg.recoverDeferMinBouncePct}% ` +
                  `(held ${decision.reason})`,
              );
            }
          }
          if (!recoverDeferIsCapped(decision.pnlPct, cfg.recoverDeferMaxPnlPct)) {
            continue;
          }
        }
      }

      // Soft giveback only after whale-vs-mass classify (or wait timeout).
      if (
        cfg.dumpClassifyEnabled &&
        decision.reason != null &&
        SOFT_GIVEBACK_REASONS.has(decision.reason)
      ) {
        const classifyOpts: DumpClassifyOpts = {
          windowMs: cfg.dumpClassifyWindowMs,
          minSellUsd: cfg.oneshotDumpMinSellUsd,
          maxPostResidualFrac: cfg.oneshotDumpMaxPostResidualFrac,
          massMinSellers: cfg.dumpClassifyMassMinSellers,
          whaleShare: cfg.dumpClassifyWhaleShare,
        };
        const classified = dumpTape.classify(mint, nowMs, classifyOpts);
        const gate = givebackDumpGate.allowGiveback({
          mint,
          nowMs,
          classify: classified,
          waitMs: cfg.dumpClassifyWaitMs,
          onWhale: () => {
            if (!cfg.oneshotDumpGraceEnabled || cfg.oneshotDumpGraceMs <= 0) return;
            const until = oneshotDumpGrace.note(mint, nowMs, cfg.oneshotDumpGraceMs);
            appendMildDipJournal(cfg.journalPath, {
              kind: 'dump_classify_whale_grace',
              mint,
              symbol: pos.symbol,
              sellers: classified.sellers,
              prints: classified.prints,
              totalSoldUsd: +classified.totalSoldUsd.toFixed(2),
              topSeller: classified.topSeller,
              topSoldUsd: +classified.topSoldUsd.toFixed(2),
              topEmptied: classified.topEmptied,
              topShare: +classified.topShare.toFixed(3),
              graceMs: cfg.oneshotDumpGraceMs,
              untilMs: until,
              wouldReason: decision.reason,
              givebackPct: +decision.givebackPct.toFixed(2),
            });
            console.log(
              `[mild-dip] DUMP_WHALE_GRACE ${pos.symbol} mint=${mint.slice(0, 8)}… ` +
                `sellers=${classified.sellers} top~$${classified.topSoldUsd.toFixed(0)} ` +
                `share=${(classified.topShare * 100).toFixed(0)}% ` +
                `grace=${Math.round(cfg.oneshotDumpGraceMs / 1000)}s ` +
                `(held ${decision.reason})`,
            );
          },
        });
        if (!gate.allow) {
          const lastJ = lastDumpClassifyJournalMs.get(mint) ?? 0;
          if (
            !gate.pending ||
            gate.class === 'whale_oneshot' ||
            nowMs - lastJ >= 2_000
          ) {
            lastDumpClassifyJournalMs.set(mint, nowMs);
            appendMildDipJournal(cfg.journalPath, {
              kind: gate.pending ? 'dump_classify_pending' : 'dump_classify_hold',
              mint,
              symbol: pos.symbol,
              class: gate.class,
              sellers: classified.sellers,
              prints: classified.prints,
              totalSoldUsd: +classified.totalSoldUsd.toFixed(2),
              topSeller: classified.topSeller,
              topSoldUsd: +classified.topSoldUsd.toFixed(2),
              topEmptied: classified.topEmptied,
              topShare: +classified.topShare.toFixed(3),
              waitedMs: gate.waitedMs,
              wouldReason: decision.reason,
              givebackPct: +decision.givebackPct.toFixed(2),
              mfePct: +decision.mfePct.toFixed(2),
            });
          }
          continue;
        }
        lastDumpClassifyJournalMs.delete(mint);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'dump_classify_allow',
          mint,
          symbol: pos.symbol,
          class: gate.class,
          sellers: classified.sellers,
          prints: classified.prints,
          totalSoldUsd: +classified.totalSoldUsd.toFixed(2),
          topSeller: classified.topSeller,
          topSoldUsd: +classified.topSoldUsd.toFixed(2),
          topEmptied: classified.topEmptied,
          topShare: +classified.topShare.toFixed(3),
          waitedMs: gate.waitedMs,
          reason: decision.reason,
          givebackPct: +decision.givebackPct.toFixed(2),
        });
      }
      toSell.push(decision);
      givebackDumpGate.clear(mint);
    }
  }

  // Persist peak/arm for ALL opens before any sell — crash mid-sell must not
  // lose trail state or drop mints from `open`.
  saveMildDipState(cfg.statePath, state);

  const loadStats = {
    openCount: openCount(state),
    markPassMs,
    markedOk,
    markedNull,
    markIntervalMs: cfg.markIntervalMs,
    markCacheTtlMs: cfg.markCacheTtlMs,
  };
  if (loopStatsRef) {
    loopStatsRef.lastMarkPassMs = markPassMs;
    loopStatsRef.lastMarkedOk = markedOk;
    loopStatsRef.lastMarkedNull = markedNull;
  }

  const loadResult = await maybeAlertMildDipDexLoad({
    stats: loadStats,
    gates: {
      markPassWarnMs: cfg.loadAlertMarkPassMs,
      openWarnCount: cfg.loadAlertOpenCount,
      nullRatioWarn: cfg.loadAlertNullRatio,
    },
    cooldownMs: cfg.loadAlertCooldownMs,
    enabled: cfg.loadAlertEnabled,
    nowMs,
  });
  if (loadResult.overloaded) {
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_dex_load_warn',
      ...loadStats,
      reasons: loadResult.reasons,
      alerted: loadResult.alerted,
    });
  }

  if (toSell.length === 0) return;

  /**
   * Never await Jupiter sells on the mark path — a stuck quote (U5cWTi) was
   * stretching every open mint's mark gap to 15–40s. sellInFlight still
   * dedupes; marks continue while sells drain in the background.
   */
  void mapPool(toSell, cfg.sellConcurrency, async (decision) => {
    if (sellInFlight.has(decision.mint)) return;
    if (!state.open[decision.mint]) return;
    sellInFlight.add(decision.mint);
    const intent =
      decision.reason === 'mirror_leader_sell'
        ? state.open[decision.mint]?.mirrorLeaderSellIntent
        : undefined;
    const sentAtMs = Date.now();
    const attempt = (intent?.attemptCount ?? 0) + 1;
    if (intent) {
      intent.attemptCount = attempt;
      intent.lastAttemptAtMs = sentAtMs;
      saveMildDipState(cfg.statePath, state);
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mirror_leader_sell_attempt',
        mint: decision.mint,
        leader: intent.leader,
        detectedAtMs: intent.detectedAtMs,
        leaderBlockTimeMs: intent.leaderBlockTimeMs,
        attempt,
        sentAtMs,
      });
    }
    try {
      await executeQueuedSell({ cfg, state, decision, nowMs: Date.now() });
    } finally {
      if (intent) {
        const closed = !state.open[decision.mint];
        const finishedAtMs = Date.now();
        const lagMs = Math.max(0, finishedAtMs - intent.leaderBlockTimeMs);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mirror_leader_sell_attempt_result',
          mint: decision.mint,
          leader: intent.leader,
          detectedAtMs: intent.detectedAtMs,
          leaderBlockTimeMs: intent.leaderBlockTimeMs,
          attempt,
          sentAtMs,
          finishedAtMs,
          ok: closed,
          lagMs,
        });
        if (closed) {
          appendMildDipJournal(cfg.journalPath, {
            kind: 'mirror_leader_sell_success',
            mint: decision.mint,
            leader: intent.leader,
            detectedAtMs: intent.detectedAtMs,
            leaderBlockTimeMs: intent.leaderBlockTimeMs,
            attempt,
            sentAtMs,
            lagMs,
          });
        }
        if (lagMs > 30_000) {
          console.warn(
            `[mild-dip] mirror leader sell lag exceeded 30s mint=${decision.mint} lagMs=${lagMs}`,
          );
        }
      }
      sellInFlight.delete(decision.mint);
      // Stamped after the attempt, so the settle window starts from the moment
      // the size on chain could have changed (1.11.879).
      const after = state.open[decision.mint];
      if (after) {
        after.lastSellAtMs = Date.now();
        after.lastSellMarkPriceUsd = decision.markPriceUsd;
      }
    }
  }).catch((err) => {
    console.warn(
      '[mild-dip] background sell queue failed',
      err instanceof Error ? err.message : err,
    );
  });
}

export async function runMildDipLoop(
  cfg: MildDipConfig,
  opts?: { once?: boolean; signal?: AbortSignal },
): Promise<void> {
  const state = loadMildDipState(cfg.statePath, {
    mirrorObserveMs: cfg.leaderMirror.observeMs,
  });
  ensureMirrorLossCapBaseline(cfg, state, Date.now());
  maybeTriggerMirrorLossCap(
    cfg,
    state,
    mirrorLossCapValues(state).drawdownUsd,
    Date.now(),
  );
  leaderMirrorStateHydrated = false;
  const stats: MildDipLoopStats = {
    open: openCount(state),
    lastScanAtMs: null,
    lastMarkAtMs: null,
    lastMarkPassMs: null,
    lastMarkedOk: null,
    lastMarkedNull: null,
    mode: cfg.executionMode,
    hotMints: 0,
    stream: false,
  };
  loopStatsRef = stats;

  const lotsHydrated = hydrateTradeLotsFromOpen(state.open ?? {}, Date.now());
  if (lotsHydrated > 0) {
    console.log(`[mild-dip] hydrated trade lots from open state: ${lotsHydrated}`);
  }

  const hotLoaded = loadMildDipHotMints(cfg.hotMintsPath);
  const ringLoaded = loadMildDipPriceRing(cfg.priceRingPath);
  if (hotLoaded > 0 || ringLoaded > 0) {
    console.log(
      `[mild-dip] restored hotMints=${hotLoaded} priceSamples=${ringLoaded} ` +
        `from ${cfg.hotMintsPath} / ${cfg.priceRingPath}`,
    );
  }
  // Seed ring from open entry prices so stream-only marks work immediately
  // after restart (disk ring often lags / misses live bags).
  let seeded = 0;
  const seedNow = Date.now();
  for (const [mint, pos] of Object.entries(state.open)) {
    if (!(pos.entryPriceUsd > 0)) continue;
    const last = mildDipPriceRing.lastPrice(mint, seedNow);
    // Reseed when missing OR too old for exit marks (openedAtMs would age out).
    const maxAge = cfg.markStreamMaxAgeMs > 0 ? cfg.markStreamMaxAgeMs : 0;
    const tooOld =
      last != null && maxAge > 0 && seedNow - last.tsMs > maxAge;
    if (last && !tooOld) continue;
    mildDipPriceRing.note(mint, pos.entryPriceUsd, {
      tsMs: seedNow,
      source: 'dex',
    });
    seeded += 1;
  }
  if (seeded > 0) {
    console.log(`[mild-dip] seeded price-ring from ${seeded} open entries (exit marks)`);
  }

  const oneshotDumpGrace = createOneshotDumpGraceTracker();
  const dumpSellTape = createDumpSellTape();
  const givebackDumpGate = createGivebackDumpGate();
  const leaderSellFeed = cfg.leaderMirror.leaderSellExitEnabled
    ? new LeaderSellFeed(cfg.leaderMirror.leaderSellTradesPath, {
        leaders: cfg.leaderMirror.leaders,
        maxAgeMs: cfg.leaderMirror.leaderSellExitMaxAgeMs,
        stats: { staleDropped: 0 },
      })
    : null;
  leaderSellFeed?.start();
  hydrateLeaderMirrorWatches(cfg, state, Date.now());
  if (cfg.leaderMirror.enabled) {
    const reconciledBuys = reconcileLeaderBuyEvents({
      path: cfg.leaderMirror.leaderSellTradesPath,
      leaders: cfg.leaderMirror.leaders,
      openMints: new Set(Object.keys(state.open)),
      nowMs: Date.now(),
    });
    let changed = false;
    for (const event of reconciledBuys) {
      if (state.open[event.mint]) continue;
      const watchKey = `${event.mint}:${event.leader}`;
      if (leaderMirrorWatches.has(watchKey)) continue;
      const startedAtMs = event.blockTimeMs;
      if (
        !leaderMirrorObservationFresh({
          leaderBuyTsMs: startedAtMs,
          nowMs: Date.now(),
          maxAgeMs: cfg.leaderMirror.observationMaxAgeMs,
        })
      ) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'leader_mirror_refusal',
          mint: event.mint,
          leader: event.leader,
          reason: 'leader_mirror_observation_stale',
          source: 'trade_reconciliation',
          synthetic: false,
        });
        continue;
      }
      const expiresAtMs =
        startedAtMs + leaderMirrorObservationWindowMs(cfg.leaderMirror);
      if (expiresAtMs <= Date.now()) continue;
      const hit: LeaderSeedHit = {
        mint: event.mint,
        leader: event.leader,
        signature: event.signature ?? undefined,
        fillPriceUsd: event.fillPriceUsd ?? undefined,
        sizeUsd: event.sizeUsd ?? undefined,
        blockTime: Math.floor(event.blockTimeMs / 1000),
        lastSeenAtMs: event.lastSeenAtMs,
        isAdd: event.isAdd,
      };
      const hitKey = leaderMirrorHitKey(hit);
      leaderMirrorWatches.set(watchKey, {
        hit,
        hitKey,
        startedAtMs,
        expiresAtMs,
        metricSource: leaderMirrorNeedsStructuralBackfill(hit, cfg.leaderMirror.requireDipCandle)
          ? 'backfill'
          : 'seed',
      });
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_observe_start',
        mint: event.mint,
        leader: event.leader,
        leaderFillPriceUsd: event.fillPriceUsd,
        sizeUsd: event.sizeUsd,
        metricSource: 'reconciliation',
        observeMs: cfg.leaderMirror.observeMs,
      });
      changed = true;
    }
    if (changed) persistLeaderMirrorWatches(cfg, state);
  }
  if (leaderSellFeed && Object.keys(state.open).length > 0) {
    const reconciled = reconcileLeaderSellEvents({
      path: cfg.leaderMirror.leaderSellTradesPath,
      leaders: cfg.leaderMirror.leaders,
      openMints: new Set(
        Object.entries(state.open)
          .filter(([, pos]) => pos.lane === 'leader_mirror' && pos.leaderMirrorLeader)
          .map(([mint]) => mint),
      ),
      nowMs: Date.now(),
    });
    let changed = false;
    for (const event of reconciled) {
      const pos = state.open[event.mint];
      if (!pos || pos.lane !== 'leader_mirror' || pos.leaderMirrorLeader !== event.leader) {
        continue;
      }
      if (
        !isLeaderSellEventValidForPosition({
          event,
          leader: pos.leaderMirrorLeader,
          leaderBuyTsMs: pos.leaderBuyTsMs,
          openedAtMs: pos.openedAtMs,
        })
      ) {
        continue;
      }
      if (pos.mirrorLeaderSellIntent) continue;
      pos.mirrorLeaderSellIntent = {
        leader: event.leader,
        signature: event.signature,
        leaderBlockTimeMs: event.blockTimeMs,
        detectedAtMs: Date.now(),
      };
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mirror_leader_sell_intent',
        mint: event.mint,
        symbol: pos.symbol,
        leader: event.leader,
        signature: event.signature,
        leaderBlockTimeMs: event.blockTimeMs,
        detectedAtMs: pos.mirrorLeaderSellIntent.detectedAtMs,
        source: 'startup_reconciliation',
      });
      changed = true;
    }
    if (changed) saveMildDipState(cfg.statePath, state);
  }
  let lastLateLeaderSellReconcileMs = 0;
  const reconcileLateLeaderSells = (nowMs: number): void => {
    if (
      !leaderSellFeed ||
      nowMs - lastLateLeaderSellReconcileMs <
        cfg.leaderMirror.leaderSellLateReconcileIntervalMs
    ) {
      return;
    }
    const openMints = new Set(
      Object.entries(state.open)
        .filter(
          ([, pos]) =>
            pos.lane === 'leader_mirror' &&
            pos.leaderMirrorLeader &&
            !pos.mirrorLeaderSellIntent,
        )
        .map(([mint]) => mint),
    );
    if (openMints.size === 0) return;
    lastLateLeaderSellReconcileMs = nowMs;
    const reconciled = reconcileLeaderSellEvents({
      path: cfg.leaderMirror.leaderSellTradesPath,
      leaders: cfg.leaderMirror.leaders,
      openMints,
      nowMs,
      windowMs: cfg.leaderMirror.leaderSellLateReconcileWindowMs,
      tailBytes: cfg.leaderMirror.leaderSellLateReconcileTailBytes,
    });
    let changed = false;
    for (const [mint, pos] of Object.entries(state.open)) {
      if (
        !pos ||
        pos.lane !== 'leader_mirror' ||
        pos.mirrorLeaderSellIntent
      ) {
        continue;
      }
      const event = selectLatestValidLeaderSellEventForPosition({
        events: reconciled.filter((candidate) => candidate.mint === mint),
        leader: pos.leaderMirrorLeader,
        leaderBuyTsMs: pos.leaderBuyTsMs,
        openedAtMs: pos.openedAtMs,
      });
      if (!event) continue;
      pos.mirrorLeaderSellIntent = {
        leader: event.leader,
        signature: event.signature,
        leaderBlockTimeMs: event.blockTimeMs,
        detectedAtMs: nowMs,
      };
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mirror_leader_sell_intent',
        mint: event.mint,
        symbol: pos.symbol,
        leader: event.leader,
        signature: event.signature,
        leaderBlockTimeMs: event.blockTimeMs,
        detectedAtMs: nowMs,
        lagMs: Math.max(0, nowMs - event.blockTimeMs),
        source: 'late_reconciliation',
      });
      changed = true;
    }
    if (changed) saveMildDipState(cfg.statePath, state);
  };
  let priceSampler: ReturnType<typeof createStreamPriceSampler> | null = null;
  const tapeShadowRing = cfg.tapeShadowEnabled && !cfg.leaderMirror.mirrorOnly
    ? new MildDipPriceRing({
        maxSamplesPerMint: 3_600,
        ttlMs: cfg.tapeWindowMs,
      })
    : null;
  const tapeStructuralRetry = new Map<string, number>();
  const tapeStructuralBatchTimes: number[] = [];
  let tapeStructuralBatchInFlight = false;
  let lastTapeStructuralBatchMs = 0;
  const tapeShadow = tapeShadowRing
    ? new MildDipTapeShadow({
        ring: tapeShadowRing,
        pairAgeRegistry: mildDipPairAgeRegistry,
        pairAgeMaxStaleMs: cfg.tapePairAgeMaxStaleMs,
        pairAgeMaxEntries: cfg.tapePairAgeMaxEntries,
        gates: {
          ...DEFAULT_MILD_DIP_TAPE_GATES,
          greenImp60MinPct: cfg.tapeGreenImp60MinPct,
          greenImp5MinPct: cfg.tapeGreenImp5MinPct,
          greenImp5MaxPct: cfg.tapeGreenImp5MaxPct,
          greenDd60MaxPct: cfg.tapeGreenDd60MaxPct,
          greenMinPairAgeHours: cfg.tapeGreenMinPairAgeHours,
          dipRangePosMaxPct: cfg.tapeDipRangePosMaxPct,
          dipDd60MaxPct: cfg.tapeDipDd60MaxPct,
          dipImp5MaxPct: cfg.tapeDipImp5MaxPct,
          dipMinPairAgeHours: cfg.tapeDipMinPairAgeHours,
          dipMaxPairAgeHours: cfg.tapeDipMaxPairAgeHours,
        },
        minIntervalMs: cfg.tapeMinIntervalMs,
        maxSignalsPerHour: cfg.tapeMaxSignalsPerHour,
        laneLimits: {
          green: {
            minIntervalMs: cfg.tapeGreenMeasureAll
              ? cfg.tapeGreenMeasureAllMinIntervalMs
              : cfg.tapeMinIntervalMs,
            maxSignalsPerHour: cfg.tapeGreenMeasureAll
              ? cfg.tapeGreenMeasureAllMaxSignalsPerHour
              : cfg.tapeMaxSignalsPerHour,
          },
          dip: {
            minIntervalMs: cfg.tapeMinIntervalMs,
            maxSignalsPerHour: cfg.tapeMaxSignalsPerHour,
          },
        },
        greenMeasureAll: cfg.tapeGreenMeasureAll,
        outcomeStaleMs: cfg.tapeOutcomeStaleMs,
        idleEvictMs: Math.max(cfg.tapeIdleEvictMs, cfg.tapeWindowMs),
        summaryIntervalMs: cfg.tapeSummaryIntervalMs,
        pendingSampleGraceMs: cfg.tapePendingSampleGraceMs,
        pathMaxPoints: cfg.tapePathMaxPoints,
        exitArmPct: cfg.tapeExitArmPct,
        exitTrailPct: cfg.tapeExitTrailPct,
        exitStopPct: cfg.tapeExitStopPct,
        exitTimeoutMs: cfg.tapeExitTimeoutMs,
        structuralSnapshot: resolveTapeStructuralSnapshot,
        ownFloors: {
          green: {
            minLiquidityUsd: cfg.tapeGreenMinLiqUsd,
            maxLiquidityUsd: cfg.tapeGreenMaxLiqUsd,
            minMarketCapUsd: cfg.tapeGreenMinMcapUsd,
            minVolume5mUsd: cfg.tapeGreenMinVol5mUsd,
            maxTurnover: cfg.tapeGreenMaxTurnover,
            minPairAgeHours: cfg.tapeGreenMinAgeHours,
          },
          dip: {
            minLiquidityUsd: cfg.tapeDipMinLiqUsd,
            maxLiquidityUsd: cfg.tapeDipMaxLiqUsd,
            minMarketCapUsd: cfg.tapeDipMinMcapUsd,
            minVolume5mUsd: cfg.tapeDipMinVol5mUsd,
            maxTurnover: cfg.tapeDipMaxTurnover,
            minPairAgeHours: cfg.tapeDipMinAgeHours,
          },
        },
        append: (event) => appendMildDipJournal(cfg.journalPath, event),
      })
    : null;
  if (tapeShadow) {
    const restored = loadMildDipTapeShadowState(cfg.tapeShadowStatePath, tapeShadow, Date.now());
    if (restored.samples > 0 || restored.pending > 0) {
      console.log(
        `[mild-dip] restored tape-shadow samples=${restored.samples} ` +
          `pending=${restored.pending} from ${cfg.tapeShadowStatePath}`,
      );
    }
  }
  async function resolveTapeStructuralSnapshot(
    mint: string,
    tsMs: number,
  ): Promise<MildDipTapeStructuralSnapshot | null> {
    const toSnapshot = (mintKey: string, metrics: {
      liquidityUsd: number | null;
      marketCapUsd: number | null;
      volume5mUsd: number | null;
      dexId: string | null;
      pairAgeHours: number | null;
    }): MildDipTapeStructuralSnapshot => ({
      liquidityUsd: metrics.liquidityUsd,
      marketCapUsd: metrics.marketCapUsd,
      volume5mUsd: metrics.volume5mUsd,
      turnover:
        metrics.liquidityUsd != null &&
        metrics.liquidityUsd > 0 &&
        metrics.volume5mUsd != null
          ? metrics.volume5mUsd / metrics.liquidityUsd
          : null,
      dexId: metrics.dexId,
      pairAgeHours:
        metrics.pairAgeHours ??
        mildDipPairAgeRegistry.pairAgeHours(mintKey, tsMs),
    });
    const fresh = getStructuralCache(mint, tsMs, cfg.fastPathStructuralCacheMs);
    const stale = getStructuralCache(mint, tsMs, cfg.fastPathStructuralStaleMs);
    return resolveTapeStructuralSnapshotFromCache(
      fresh ? toSnapshot(mint, fresh.metrics) : null,
      stale ? toSnapshot(mint, stale.metrics) : null,
    );
  }
  const maybePrefetchTapeStructural = (nowMs: number): void => {
    if (
      !tapeShadow ||
      !tapeShadowRing ||
      tapeStructuralBatchInFlight ||
      (lastTapeStructuralBatchMs > 0 &&
        nowMs - lastTapeStructuralBatchMs < cfg.tapeStructuralBatchMs)
    ) {
      return;
    }
    const cutoff = nowMs - 60 * 60_000;
    while (tapeStructuralBatchTimes.length > 0 && tapeStructuralBatchTimes[0]! <= cutoff) {
      tapeStructuralBatchTimes.shift();
    }
    if (
      cfg.tapeStructuralBatchMaxPerHour > 0 &&
      tapeStructuralBatchTimes.length >= cfg.tapeStructuralBatchMaxPerHour
    ) {
      tapeShadow.noteStructuralBatchCapHit();
      return;
    }
    const pending = tapeShadow.pendingMints(
      nowMs,
      cfg.tapePendingSampleGraceMs,
      cfg.tapePendingSampleMaxMints,
    );
    const candidates = selectTapeStructuralBatch(
      tapeShadowRing.watchedMints(nowMs).map((mint) => ({
        mint,
        pending: pending.has(mint),
        sampleCount10m: tapeShadowRing!.sampleCount(mint, 10 * 60_000, nowMs),
        fresh: Boolean(getStructuralCache(mint, nowMs, cfg.fastPathStructuralCacheMs)),
        retryUntilMs: tapeStructuralRetry.get(mint) ?? 0,
      })),
      nowMs,
      DEXSCREENER_BATCH_MAX,
    );
    if (candidates.length === 0) return;
    lastTapeStructuralBatchMs = nowMs;
    tapeStructuralBatchTimes.push(nowMs);
    tapeStructuralBatchInFlight = true;
    void prefetchDexScreenerPairDetailsManyWithMetadata(candidates, {
      nowMs,
      cacheTtlMs: cfg.fastPathStructuralCacheMs,
      allowedDexIds: cfg.entry.allowedDexIds,
    })
      .then((result) => {
        tapeShadow.noteStructuralBatchResult(result);
        for (const [mint, details] of result.detailsByMint) {
          structuralFromDexDetails(mint, details, nowMs, { notePriceRing: false });
        }
        for (const mint of result.requestedMints) {
          const retryMs = result.errorMints.includes(mint)
            ? cfg.tapeStructuralErrorRetryMs
            : result.missedMints.includes(mint)
              ? cfg.tapeStructuralMissRetryMs
              : 0;
          if (retryMs > 0) tapeStructuralRetry.set(mint, nowMs + retryMs);
          const createdAt = result.pairCreatedAtMs.get(mint);
          if (createdAt != null) mildDipPairAgeRegistry.notePairCreatedAt(mint, createdAt, nowMs);
        }
        tapeShadowStateSaver?.save();
      })
      .catch(() => {
        tapeShadow.noteStructuralBatchError(candidates.length);
        for (const mint of candidates) {
          tapeStructuralRetry.set(mint, nowMs + cfg.tapeStructuralErrorRetryMs);
        }
      })
      .finally(() => {
        tapeStructuralBatchInFlight = false;
      });
  };
  const shadowDiscoveryLastSampleAt = new Map<string, number>();
  const shadowDiscoveryCleanup = { lastAtMs: 0 };
  const shouldSampleTapeStreamPrice = (mint: string, nowMs: number): boolean => {
    if (
      shouldSampleStreamPrice(
        cfg,
        state,
        mint,
        nowMs,
        sampleWatchMs,
        mildDipHotMints,
      )
    ) {
      return true;
    }
    if (!cfg.tapeShadowEnabled || !tapeShadow) return false;

    const pendingDecision = tapeShadow.pendingSampleDecision(
      mint,
      nowMs,
      cfg.tapePendingSampleGraceMs,
      cfg.tapePendingSampleMaxMints,
    );
    if (pendingDecision === 'pending') {
      tapeShadow.noteSampling('pending');
      return true;
    }
    if (pendingDecision === 'limitRejected') {
      tapeShadow.noteSampling('limitRejected');
      return false;
    }
    if (cfg.tapeShadowSampleMaxMints <= 0) return false;
    const discoveryDecision = tapeShadowDiscoverySampleDecision(
      mint,
      nowMs,
      shadowDiscoveryLastSampleAt,
      cfg.tapeShadowSampleMaxMints,
      cfg.tapeShadowSampleMinGapMs,
      cfg.tapeWindowMs,
      shadowDiscoveryCleanup,
    );
    if (discoveryDecision === 'limitRejected') {
      tapeShadow.noteSampling('limitRejected');
      return false;
    }
    if (discoveryDecision === 'sample') {
      tapeShadow.noteSampling('shadowDiscovery');
      return true;
    }
    return false;
  };
  const tapeShadowStateSaver =
    tapeShadow && tapeShadowRing
      ? createMildDipTapeShadowStateSaver({
          filePath: cfg.tapeShadowStatePath,
          shadow: tapeShadow,
          ring: tapeShadowRing,
          saveIntervalMs: cfg.tapeStateSaveMs,
          idleEvictMs: Math.max(cfg.tapeIdleEvictMs, cfg.tapeWindowMs),
          pairAgeMaxStaleMs: cfg.tapePairAgeMaxStaleMs,
          pairAgeMaxEntries: cfg.tapePairAgeMaxEntries,
        })
      : null;
  let lastTapePairAgeBackfillMs = 0;
  let tapePairAgeBackfillInFlight = false;
  const maybeBackfillTapePairAge = (nowMs: number): void => {
    if (
      !tapeShadow ||
      tapePairAgeBackfillInFlight ||
      !tapePairAgeBackfillDue(
        lastTapePairAgeBackfillMs,
        nowMs,
        cfg.tapePairAgeBackfillMs,
      )
    ) {
      return;
    }
    const mints = tapeShadow.selectPairAgeBackfillMints(
      nowMs,
      cfg.tapeWindowMs,
      cfg.tapePairAgeRetryMs,
      DEXSCREENER_BATCH_MAX,
      (mint) =>
        getStructuralCache(mint, nowMs, cfg.fastPathStructuralStaleMs)?.metrics
          .pairAgeHours != null,
    );
    if (mints.length === 0) return;
    lastTapePairAgeBackfillMs = nowMs;
    tapePairAgeBackfillInFlight = true;
    for (const mint of mints) {
      mildDipPairAgeRegistry.notePairAgeAttempt(mint, nowMs);
    }
    void fetchDexScreenerPairCreatedAtMany(mints, {
      allowedDexIds: cfg.entry.allowedDexIds,
    })
      .then((resolved) => {
        let resolvedCount = 0;
        let nullCount = 0;
        for (const mint of mints) {
          const pairCreatedAtMs = resolved.get(mint) ?? null;
          if (
            pairCreatedAtMs != null &&
            mildDipPairAgeRegistry.notePairCreatedAt(mint, pairCreatedAtMs, nowMs)
          ) {
            resolvedCount += 1;
          } else {
            nullCount += 1;
          }
        }
        tapeShadow.notePairAgeBackfill(mints.length, resolvedCount, nullCount);
        tapeShadowStateSaver?.save();
      })
      .catch(() => {
        tapeShadow.notePairAgeBackfill(mints.length, 0, mints.length);
      })
      .finally(() => {
        tapePairAgeBackfillInFlight = false;
      });
  };
  const sampleWatchMs = Math.max(
    cfg.cooldownBounceLookbackMs,
    cfg.mintCooldownMs,
    cfg.lossCooldownMs,
    cfg.postExitWakeMs,
  );
  if (cfg.streamPriceSampleEnabled && !cfg.leaderMirror.mirrorOnly) {
    priceSampler = createStreamPriceSampler({
      rpcUrl: cfg.rpcUrl,
      minGapMsPerMint: cfg.streamPriceMinGapMs,
      concurrency: cfg.streamPriceConcurrency,
      txRetryEnabled: cfg.streamPriceTxRetryEnabled,
      txRetryMaxAttempts: cfg.streamPriceTxRetryMaxAttempts,
      txRetryDelayMs: cfg.streamPriceTxRetryDelayMs,
      txRetryMaxAgeMs: cfg.streamPriceTxRetryMaxAgeMs,
      shouldSample: shouldSampleTapeStreamPrice,
      /**
       * Force-fetch open bags so exit marks stay stream-fed — except green
       * ones, which pay for themselves out of the free Dex tape.
       *
       * Every forced sample is a `getTransaction` on the paid RPC, and a green
       * bag sits on a deliberately hot name: the lane requires 43+ buys per
       * five minutes, so ten minutes of forced sampling is ~150 calls. Against
       * a measured 41_986 stream `getTransaction` calls a day, a hundred green
       * bags would have added about a third.
       *
       * It buys nothing. The green exit grid (+30% / −6% / 10 min) was fitted
       * on a tape whose median gap is 26.8s, while our Dex marks on open bags
       * run at a median 6.1s — four times finer than the resolution the rule
       * was designed against.
       */
      forceFetch: (mint) => {
        const open = state.open[mint];
        return Boolean(open) && open?.lane !== 'green';
      },
      sellTape: dumpSellTape,
      maxPostResidualFrac: cfg.oneshotDumpMaxPostResidualFrac,
      onPriceSample: (sample) => {
        if (tapeShadow) {
          const structural = getStructuralCache(
            sample.mint,
            sample.tsMs,
            cfg.fastPathStructuralStaleMs,
          );
          tapeShadow.onPriceSample({
            ...sample,
            pairAgeHours:
              structural?.metrics.pairAgeHours ??
              mildDipPairAgeRegistry.pairAgeHours(sample.mint, sample.tsMs),
          });
        }
      },
      oneshot:
        cfg.oneshotDumpGraceEnabled && cfg.oneshotDumpGraceMs > 0
          ? {
              enabled: true,
              minSellUsd: cfg.oneshotDumpMinSellUsd,
              maxPostResidualFrac: cfg.oneshotDumpMaxPostResidualFrac,
            }
          : undefined,
      onOneshotDump: (ev) => {
        if (!state.open[ev.mint]) return;
        const until = oneshotDumpGrace.note(ev.mint, ev.tsMs || Date.now(), cfg.oneshotDumpGraceMs);
        const pos = state.open[ev.mint];
        appendMildDipJournal(cfg.journalPath, {
          kind: 'oneshot_dump_grace',
          mint: ev.mint,
          symbol: pos?.symbol ?? null,
          seller: ev.seller,
          signature: ev.signature,
          soldUsd: +ev.soldUsd.toFixed(2),
          residualFrac: +ev.residualFrac.toFixed(4),
          graceMs: cfg.oneshotDumpGraceMs,
          untilMs: until,
        });
        console.log(
          `[mild-dip] ONESHOT_DUMP_GRACE ${pos?.symbol ?? '?'} mint=${ev.mint.slice(0, 8)}… ` +
            `seller=${ev.seller.slice(0, 8)}… sold~$${ev.soldUsd.toFixed(0)} ` +
            `grace=${Math.round(cfg.oneshotDumpGraceMs / 1000)}s`,
        );
      },
    });
  }

  let streamHandle: { stop: () => void } | null = null;
  if (cfg.streamEnabled && !cfg.leaderMirror.mirrorOnly) {
    streamHandle = startMildDipHotMintStream({
      wsUrl: cfg.streamWsUrl || null,
      priceSampler,
      onMint: (mint, tsMs) => {
        // Immediate fast-path — do not wait for the 5s enrich batch.
        if (!cfg.fastPathEnabled) return;
        void tryFastPathForMint(cfg, state, mint, 'stream', tsMs).catch((err) => {
          console.warn(
            '[mild-dip] fast-path stream error',
            err instanceof Error ? err.message : err,
          );
        });
      },
    });
    stats.stream = streamHandle != null;
  }

  const buyImpactCap = process.env.LIVE_BUY_MAX_PRICE_IMPACT_PCT?.trim() || '0';
  const jupPriority = process.env.LIVE_JUPITER_SWAP_PRIORITY_LEVEL?.trim() || 'n/a';
  const jupFeeCapSol = process.env.LIVE_JUPITER_PRIORITY_MAX_SOL?.trim() || 'n/a';
  console.log(
    `[mild-dip] start mode=${cfg.executionMode} positionUsd=${cfg.positionUsd} quote=USDC ` +
      `thickUsd=${cfg.thickPositionUsd}` +
      `(mcap≥$${cfg.thickMinMarketCapUsd}/liq≥$${cfg.thickMinLiquidityUsd}/age≥${cfg.thickMinPairAgeHours}h) ` +
      `microUsd=${cfg.microPositionUsd}` +
      `(mcap$${cfg.microMinMarketCapUsd}–$${cfg.microMaxMarketCapUsd}/knifeOnly) ` +
      `entry=(${cfg.entry.minDipPct},${cfg.entry.maxDipPct}] ` +
      `h1RedShallow=${cfg.h1RedShallowEnabled ? 1 : 0}` +
      `(h1≤${cfg.h1RedShallowH1MaxPct}/pc5m∈(${cfg.h1RedShallowMinDipPct},${cfg.h1RedShallowMaxDipPct}]) ` +
      `flatMicro=${cfg.flatMicroDipEnabled ? 1 : 0}` +
      `(h1∈[${cfg.flatMicroH1MinPct},${cfg.flatMicroH1MaxPct}]/pc5m∈(${cfg.flatMicroMinDipPct},${cfg.flatMicroMaxDipPct}]) ` +
      `minLiq=$${cfg.entry.minLiquidityUsd} minVol5m=$${cfg.entry.minVolume5mUsd} ` +
      `minMcap=$${cfg.entry.minMarketCapUsd} ` +
      `waitDip=${cfg.waitDipEnabled ? 1 : 0}` +
      (cfg.waitDipEnabled
        ? `/${cfg.waitDipPct}%/+${cfg.waitDipMaxOvershootPct}pp` +
          `/chase${cfg.waitDipMaxChasePct}%` +
          `/qPrem${cfg.waitDipQuotePremiumPct}%` +
          `/${Math.round(cfg.waitDipMaxWatchMs / 1000)}s` +
          `/skipH1=1/skipRebuyWin=1 `
        : ' ') +
      `exit=W9.1 arm=${cfg.exit.armPct}% ` +
      (cfg.exit.mfeBankEnabled
        ? `mfeBank=+${cfg.exit.mfeBank1Pct}%×${cfg.exit.mfeBank1Fraction}` +
          `/+${cfg.exit.mfeBank2Pct}%×${cfg.exit.mfeBank2Fraction}` +
          `/sleeve=-${cfg.exit.mfeBankSleeveGivebackPct}%` +
          (cfg.exit.mfeBankSleeveLossPartialFraction > 0 &&
          cfg.exit.mfeBankSleeveLossPartialFraction < 1
            ? `/loss×${cfg.exit.mfeBankSleeveLossPartialFraction}`
            : '') +
          ` `
        : `partial=-${cfg.exit.partialGivebackPct}%×${cfg.exit.scaleOutFraction} ` +
          `fullGiveback=-${cfg.exit.givebackPct}% `) +
      `hardStop=-${cfg.exit.hardStopPnlPct}%` +
      (cfg.exit.hardStopPartialFraction > 0 && cfg.exit.hardStopPartialFraction < 1
        ? `×${cfg.exit.hardStopPartialFraction}`
        : '') +
      ` ` +
      `cliffDump=-${cfg.exit.cliffDumpPnlPct}% ` +
      `neverArmBounce=${cfg.exit.neverArmBouncePct > 0 ? 1 : 0}` +
      `/dump≤-${cfg.exit.neverArmBounceMinDumpPct}%` +
      `/bounce≥${cfg.exit.neverArmBouncePct}%` +
      (cfg.exit.neverArmBouncePartialFraction > 0 &&
      cfg.exit.neverArmBouncePartialFraction < 1
        ? `×${cfg.exit.neverArmBouncePartialFraction}/≥${cfg.exit.neverArmBounce2Pct}%`
        : '') +
      `/troughAge${Math.round(cfg.exit.neverArmBounceMinTroughAgeMs / 1000)}s` +
      `/stillRed≥${cfg.exit.neverArmBounceRequireRedPct}% ` +
      `neverArmFreefall=${cfg.exit.neverArmFreefallPnlPct > 0 ? 1 : 0}` +
      `/-${cfg.exit.neverArmFreefallPnlPct}%` +
      `/${Math.round(cfg.exit.neverArmFreefallMinMs / 1000)}s ` +
      `neverArmTimeRed=${cfg.exit.neverArmTimeRedMinMs > 0 ? 1 : 0}` +
      `/${Math.round(cfg.exit.neverArmTimeRedMinMs / 1000)}s` +
      `/pnl≤-${cfg.exit.neverArmTimeRedPnlPct}%` +
      (cfg.exit.neverArmTimeRedMaxPc5mPct > 0
        ? `/pc5m≤-${cfg.exit.neverArmTimeRedMaxPc5mPct}%`
        : '') +
      ` ` +
      `neverArmPatience=${Math.round(cfg.exit.neverArmPatienceMs / 1000)}s ` +
      `neverArmStale=${Math.round(cfg.exit.neverArmStaleMinMs / 1000)}s` +
      `/mfe≤${cfg.exit.neverArmStaleMaxMfePct}%/pnl≤-${cfg.exit.neverArmStalePnlPct}% ` +
      `neverArmDead=${Math.round(cfg.exit.neverArmDeadMinMs / 1000)}s/-${cfg.exit.neverArmDeadPnlPct}% ` +
      `neverArmVolFade=${Math.round(cfg.exit.neverArmVolFadeMinMs / 1000)}s/x${cfg.exit.neverArmVolFadeRatio}/$${cfg.exit.neverArmVolFadeFloorUsd}` +
      `/sample${Math.round(cfg.exit.neverArmVolFadeSampleMs / 1000)}s×${cfg.exit.neverArmVolFadeWeakWindows} ` +
      `neverArmMaxHold=${Math.round(cfg.exit.neverArmMaxHoldMs / 1000)}s ` +
      `scan=${cfg.scanIntervalMs}ms mark=${cfg.markIntervalMs}ms` +
      `/ring≤${cfg.markStreamMaxAgeMs}ms/bgDex@${cfg.markDexRefreshMs}ms×${cfg.markConcurrency} ` +
      `cacheTtl=${cfg.markCacheTtlMs}ms markConc=${cfg.markConcurrency} sellConc=${cfg.sellConcurrency} ` +
      `loadAlert=${cfg.loadAlertEnabled ? 1 : 0} ` +
      `stream=${stats.stream} streamPrice=${cfg.streamPriceSampleEnabled ? 1 : 0} ` +
      `oneshotGrace=${cfg.oneshotDumpGraceEnabled ? 1 : 0}` +
      `/${Math.round(cfg.oneshotDumpGraceMs / 1000)}s` +
      `/≥$${cfg.oneshotDumpMinSellUsd} ` +
      `orphanSweep=${cfg.orphanSweepEnabled ? 1 : 0}/max${cfg.orphanSweepMaxSells} ` +
      `dumpClassify=${cfg.dumpClassifyEnabled ? 1 : 0}` +
      `/wait${Math.round(cfg.dumpClassifyWaitMs / 1000)}s` +
      `/win${Math.round(cfg.dumpClassifyWindowMs / 1000)}s` +
      `/mass≥${cfg.dumpClassifyMassMinSellers} ` +
      `recoverDefer=${cfg.recoverDeferEnabled ? 1 : 0}` +
      `/≥${cfg.recoverDeferMinBouncePct}%` +
      `/cap≥${cfg.recoverDeferMaxPnlPct}%` +
      `/${Math.round(cfg.recoverDeferLookbackMs / 1000)}s ` +
      `leaderSeedEntry=${cfg.leaderSeedEntryEnabled ? 1 : 0} ` +
      `postExitWake=${Math.round(cfg.postExitWakeMs / 60_000)}m/max${cfg.postExitWakeMax} ` +
      `leaderAlign=${cfg.leaderAlignEnabled ? 1 : 0}` +
      `/${Math.round(cfg.leaderAlignMaxAgeMs / 1000)}s` +
      `/red≥${cfg.leaderAlignRequireRedPct}%` +
      (cfg.leaderAlignScaleInEnabled && cfg.leaderAlignScaleInUsd > 0
        ? `/scaleIn$${cfg.leaderAlignScaleInUsd}`
        : '/scaleIn=0') +
      ` ` +
      `streamDipEntry=${cfg.streamDipEntryEnabled ? 1 : 0}` +
      `/reqDex=${cfg.streamOnlyRequireDexDip ? 1 : 0}≤${cfg.streamOnlyDexMaxDipPct} ` +
      `/reqStreamPx=${cfg.requireStreamPriceEntry ? 1 : 0}` +
      (cfg.requireStreamPriceEntry
        ? `≤${Math.round(cfg.requireStreamPriceMaxAgeMs / 1000)}s `
        : ' ') +
      `fastPath=${cfg.fastPathEnabled ? 1 : 0}/chase${cfg.fastPathChasePct}` +
      `/skipBounce=${cfg.fastPathSkipBounce ? 1 : 0}` +
      `/rebuyBelowExit=${cfg.rebuyBelowExitPct}%/${Math.round(cfg.rebuyBelowExitMaxAgeMs / 1000)}s` +
      `/rebuyLiqDrop=${cfg.rebuyLiqDropEnabled ? 1 : 0}` +
      (cfg.rebuyLiqDropEnabled
        ? `/${Math.round(cfg.rebuyLiqDropMaxAgeMs / 3600_000)}h` +
          `/≥${cfg.rebuyLiqDropMinDropPct}%` +
          `/lossOnly=${cfg.rebuyLiqDropOnlyAfterLoss ? 1 : 0} `
        : ' ') +
      `/hotDexProbe=${cfg.fastPathHotDexProbeEnabled ? 1 : 0}` +
      `@${cfg.fastPathHotDexProbeGapMs}ms≤${cfg.fastPathHotDexProbeMaxPerMin}/min ` +
      `/enrichMax=${cfg.enrichMax} ` +
      `prebuy=${cfg.preBuyRevalidate} maxChasePct=${cfg.maxChasePct} ` +
      `slippageBps=${cfg.slippageBps} buyImpactCap=${buyImpactCap}% ` +
      `jupPriority=${jupPriority} jupFeeCapSol=${jupFeeCapSol} ` +
      `maxCooldownBouncePct=${cfg.maxCooldownBouncePct} ` +
      `lookback=${cfg.cooldownBounceLookbackMs}ms ` +
      `knifeStabilize=${cfg.knifeStabilizeEnabled ? 1 : 0}` +
      `(${cfg.knifeStabilizeMinDipPct},${cfg.knifeStabilizeMaxDipPct}]` +
      `/wait${Math.round(cfg.knifeStabilizeWaitMs / 1000)}s` +
      `/bounce[${cfg.knifeStabilizeMinBouncePct},${cfg.knifeStabilizeMaxBouncePct}] ` +
      `mildStabilize=${cfg.mildStabilizeEnabled ? 1 : 0}` +
      `/fresh=${cfg.mildStabilizeFreshEntryEnabled ? 1 : 0}` +
      `(dump(${cfg.mildStabilizeMinDumpPct},${cfg.mildStabilizeMaxDumpPct}]` +
      `/bounce[${cfg.mildStabilizeMinBouncePct},${cfg.mildStabilizeMaxBouncePct}]` +
      `/troughAge${Math.round(cfg.mildStabilizeTroughMinAgeMs / 1000)}s` +
      `/belowPeak≥${cfg.mildStabilizeMinBelowPeakPct}%) ` +
      `mintCooldown=${Math.round(cfg.mintCooldownMs / 1000)}s ` +
      `lossCooldown=${Math.round(cfg.lossCooldownMs / 1000)}s ` +
      `feeSolTopup=${cfg.feeSolTopupEnabled ? 1 : 0}` +
      `/every${
        cfg.feeSolTopupIntervalMs >= 3_600_000
          ? `${Math.round(cfg.feeSolTopupIntervalMs / 3_600_000)}h`
          : `${Math.round(cfg.feeSolTopupIntervalMs / 60_000)}m`
      }` +
      `/min$${cfg.feeSolTopupMinUsd}/buy$${cfg.feeSolTopupBuyUsd} ` +
      `sources=${cfg.discoverSources} open=${openCount(state)} wallet=${cfg.walletPubkeyExpected ?? 'n/a'}`,
  );

  let lastDataRetentionTickMs = 0;
  const diskHygieneCfg = {
    dataDirs: cfg.dataRetentionDirs.length > 0
      ? cfg.dataRetentionDirs
      : [path.dirname(cfg.statePath), path.resolve(path.dirname(cfg.statePath), '..', 'milddip')],
    journalPath: cfg.journalPath,
    compressAfterDays: cfg.dataRetentionCompressAfterDays,
    deleteAfterDays: cfg.dataRetentionDeleteAfterDays,
    deleteEnabled: cfg.dataRetentionDeleteEnabled,
    minFreeBytes: cfg.dataDiskMinFreeBytes,
    minFreePct: cfg.dataDiskMinFreePct,
    guardEnabled: cfg.dataDiskGuardEnabled,
  };

  // One-shot: reclaim rent stuck in already-empty ATAs from prior $5 tests.
  if (!opts?.once) {
    await reclaimEmptyAta(cfg, { reason: 'startup_sweep' });
    if (cfg.orphanSweepEnabled && cfg.orphanSweepMaxSells > 0) {
      try {
        const swept = await sweepUnmanagedOrphans({
          cfg,
          state,
          maxSells: cfg.orphanSweepMaxSells,
        });
        if (swept.candidates > 0) {
          console.log(
            `[mild-dip] orphanSweep candidates=${swept.candidates} ` +
              `sold=${swept.sold} failed=${swept.failed} skipped=${swept.skipped}`,
          );
        }
      } catch (err) {
        console.warn(
          '[mild-dip] orphanSweep failed',
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (cfg.dustBurnEnabled && cfg.dustBurnMaxPerPass > 0) {
      try {
        const burned = await burnDustOrphans({
          cfg,
          state,
          nowMs: Date.now(),
          maxBurns: cfg.dustBurnMaxPerPass,
        });
        if (burned.candidates > 0) {
          console.log(
            `[mild-dip] dustBurn candidates=${burned.candidates} ` +
              `burned=${burned.burned} failed=${burned.failed} skipped=${burned.skipped}`,
          );
        }
      } catch (err) {
        console.warn(
          '[mild-dip] dustBurn startup failed',
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (cfg.dataRetentionEnabled) {
      try {
        await runMildDipDataRetention(diskHygieneCfg);
      } catch (err) {
        console.warn('[mild-dip] startup data retention failed', err);
      }
    }
  }

  let lastScan = 0;
  let lastMark = 0;
  let lastFeeTopupTickMs = 0;
  let lastDustBurnTickMs = 0;
  let lastOrphanSweepTickMs = 0;
  let lastLeaderWakeMs = 0;
  let lastOwnTapeKnifeMs = 0;
  let lastStreamPriceStatsMs = 0;
  let lastMirrorQuoteStatsMs = 0;
  let lastLeaderSellFeedStatsMs = 0;
  let lastLeaderSellFeedStaleDropped = 0;
  let lastMirrorWakeMs = 0;
  let lastDiskCheckMs = 0;
  let lastLeaderBalanceReconcileMs = 0;
  const leaderFlatConfirmations = new Map<string, number>();
  let mirrorWakeInFlight = false;
  let leaderBalanceReconcileInFlight = false;
  let leaderBalanceReconcileCursor = 0;

  const reconcileLeaderBalances = async (nowMs: number): Promise<void> => {
    const positions = Object.entries(state.open).filter(
      ([, pos]) => pos.lane === 'leader_mirror' && Boolean(pos.leaderMirrorLeader),
    );
    if (positions.length === 0) return;
    const maxPerPass = Math.max(1, cfg.leaderMirror.leaderBalanceReconcileMaxPerPass);
    const start = leaderBalanceReconcileCursor % positions.length;
    const selected = Array.from(
      { length: Math.min(maxPerPass, positions.length) },
      (_, index) => positions[(start + index) % positions.length]!,
    );
    leaderBalanceReconcileCursor = (start + selected.length) % positions.length;
    for (const [mint] of selected) {
      const pos = state.open[mint];
      if (!pos || pos.lane !== 'leader_mirror' || !pos.leaderMirrorLeader) continue;
      if (nowMs - pos.openedAtMs < cfg.leaderMirror.leaderBalanceReconcileMinHoldMs) {
        leaderFlatConfirmations.delete(mint);
        continue;
      }
      const raw = await readLeaderBalance(cfg, pos.leaderMirrorLeader, mint);
      if (raw == null) {
        appendMildDipJournal(cfg.journalPath, {
          kind: 'leader_mirror_balance_reconcile',
          mint,
          leader: pos.leaderMirrorLeader,
          action: 'none',
          reason: 'rpc_error',
        });
        continue;
      }
      if (raw > 0n) {
        leaderFlatConfirmations.delete(mint);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'leader_mirror_balance_reconcile',
          mint,
          leader: pos.leaderMirrorLeader,
          action: 'none',
          reason: 'leader_balance_nonzero',
          balanceRaw: raw.toString(),
        });
        continue;
      }
      const confirmations = (leaderFlatConfirmations.get(mint) ?? 0) + 1;
      leaderFlatConfirmations.set(mint, confirmations);
      const reconcileAction = leaderFlatReconcileDecision({
        balanceRaw: raw,
        confirmations,
        requiredConfirmations: cfg.leaderMirror.leaderBalanceReconcileConfirmations,
        openedAtMs: pos.openedAtMs,
        nowMs,
        minHoldMs: cfg.leaderMirror.leaderBalanceReconcileMinHoldMs,
      });
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_balance_reconcile',
        mint,
        leader: pos.leaderMirrorLeader,
        action: reconcileAction,
        reason: 'leader_balance_zero',
        confirmations,
        required: cfg.leaderMirror.leaderBalanceReconcileConfirmations,
      });
      if (reconcileAction !== 'exit' || pos.mirrorLeaderSellIntent) continue;
      pos.mirrorLeaderSellIntent = {
        leader: pos.leaderMirrorLeader,
        signature: null,
        leaderBlockTimeMs: nowMs,
        detectedAtMs: nowMs,
      };
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mirror_leader_sell_intent',
        mint,
        symbol: pos.symbol,
        leader: pos.leaderMirrorLeader,
        signature: null,
        leaderBlockTimeMs: nowMs,
        detectedAtMs: nowMs,
        source: 'balance_reconciliation',
      });
      saveMildDipState(cfg.statePath, state);
    }
  };

  const tick = async (): Promise<void> => {
    if (opts?.signal?.aborted) return;
    const nowMs = Date.now();
    if (
      cfg.leaderMirror.enabled &&
      cfg.leaderMirror.leaderBalanceReconcileEnabled &&
      !leaderBalanceReconcileInFlight &&
      nowMs - lastLeaderBalanceReconcileMs >= cfg.leaderMirror.leaderBalanceReconcileIntervalMs
    ) {
      lastLeaderBalanceReconcileMs = nowMs;
      leaderBalanceReconcileInFlight = true;
      void reconcileLeaderBalances(nowMs)
        .catch((err) => {
          console.warn('[mild-dip] leader balance reconciliation failed', err);
        })
        .finally(() => {
          leaderBalanceReconcileInFlight = false;
        });
    }
    if (
      (cfg.dataDiskGuardEnabled && nowMs - lastDiskCheckMs >= 60_000) ||
      (cfg.dataRetentionEnabled &&
        nowMs - lastDataRetentionTickMs >= cfg.dataRetentionIntervalMs)
    ) {
      if (cfg.dataDiskGuardEnabled && nowMs - lastDiskCheckMs >= 60_000) {
        lastDiskCheckMs = nowMs;
        void checkMildDipDiskSpace(diskHygieneCfg).catch((err) => {
          console.warn('[mild-dip] periodic disk check failed', err);
        });
      }
      if (cfg.dataRetentionEnabled && nowMs - lastDataRetentionTickMs >= cfg.dataRetentionIntervalMs) {
        lastDataRetentionTickMs = nowMs;
        void runMildDipDataRetention(diskHygieneCfg).catch((err) => {
          console.warn('[mild-dip] periodic data retention failed', err);
        });
      }
    }
    const leaderSellEvents = leaderSellFeed?.read(nowMs) ?? [];
    if (leaderSellFeed && nowMs - lastLeaderSellFeedStatsMs >= 30_000) {
      lastLeaderSellFeedStatsMs = nowMs;
      const feedStats = leaderSellFeed.stats();
      if (feedStats.staleDropped > lastLeaderSellFeedStaleDropped) {
        lastLeaderSellFeedStaleDropped = feedStats.staleDropped;
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mirror_leader_sell_feed_stats',
          staleDropped: feedStats.staleDropped,
        });
      }
    }
    reconcileLateLeaderSells(nowMs);
    tickGreenMinuteJupiterRefresh({
      nowMs,
      enabled: cfg.green.jupiterMinuteEnabled && !cfg.leaderMirror.mirrorOnly,
      minGapMs: Math.max(
        cfg.green.jupiterMinuteMinGapMs,
        cfg.green.jupiterMinuteIntervalMs,
      ),
      ttlMs: cfg.green.jupiterMinuteTtlMs,
      maxInFlight: cfg.green.jupiterMinuteMaxInFlight,
      graceMs: cfg.green.jupiterMinuteGraceMs,
    });
    const opens = openCount(state);
    tapeShadow?.tick(nowMs);
    maybeBackfillTapePairAge(nowMs);
    maybePrefetchTapeStructural(nowMs);

    // 1.11.798 — surface dead stream-price tape (hot-mint WS can look fine alone).
    if (priceSampler && nowMs - lastStreamPriceStatsMs >= 30_000) {
      lastStreamPriceStatsMs = nowMs;
      const st = priceSampler.stats();
      const greenJupiter = greenMinuteJupiterStats(
        nowMs,
        cfg.green.jupiterMinuteTtlMs,
        'green_jupiter',
      );
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_stream_price_stats',
        queued: st.queued,
        inFlight: st.inFlight,
        sampled: st.sampled,
        skipped: st.skipped,
        lastSampleAtMs: st.lastSampleAtMs,
        lastSkipReason: st.lastSkipReason,
        skipReasonCounts: st.skipReasonCounts,
        txRetryAttempts: st.txRetryAttempts,
        txRetrySucceeded: st.txRetrySucceeded,
        greenJupiterQuoteAttempts: greenJupiter.quoteAttempts,
        greenJupiterQuoteSuccesses: greenJupiter.quoteSuccesses,
        greenJupiterQuoteErrors: greenJupiter.quoteErrors,
        greenJupiterCapRejected: greenJupiter.capRejected,
        greenJupiterActiveMints: greenJupiter.activeMints,
        greenJupiterInFlight: greenJupiter.inFlight,
        greenTapeMinuteFailureCounts: mildDipPriceRing.tapeMinuteFailureStats(),
        ringStreamN: mildDipPriceRing
          .watchedMints(nowMs)
          .filter((m) => mildDipPriceRing.lastPrice(m, nowMs)?.source === 'stream').length,
      });
      if (st.sampled === 0 && st.skipped > 50) {
        console.warn(
          `[mild-dip] stream-price tape quiet sampled=0 skipped=${st.skipped} ` +
            `lastSkip=${st.lastSkipReason ?? '?'} queued=${st.queued}`,
        );
      }
    }

    // Open-book exits own the loop. Stream-first marks must not wait on scan/Dex.
    const durableLeaderSell = Object.values(state.open).some(
      (pos) =>
        pos.lane === 'leader_mirror' &&
        pos.mirrorLeaderSellIntent &&
        mirrorLeaderSellRetryDue(pos.mirrorLeaderSellIntent.lastAttemptAtMs, nowMs),
    );
    if (
      opens > 0 &&
      (nowMs - lastMark >= cfg.markIntervalMs || leaderSellEvents.length > 0 || durableLeaderSell)
    ) {
      await tryExits(
        cfg,
        state,
        Date.now(),
        oneshotDumpGrace,
        dumpSellTape,
        givebackDumpGate,
        leaderSellFeed,
      );
      lastMark = Date.now();
      stats.lastMarkAtMs = lastMark;
      saveMildDipState(cfg.statePath, state);
    }

    // Fee SOL top-up after marks — never steal open-book cadence.
    if (nowMs - lastFeeTopupTickMs >= 30_000) {
      lastFeeTopupTickMs = nowMs;
      if (opens > 0) {
        void maybeTopUpFeeSol(cfg, nowMs).catch((err) => {
          console.warn('[mild-dip] fee-sol topup tick failed', err);
        });
      } else {
        try {
          await maybeTopUpFeeSol(cfg, nowMs);
        } catch (err) {
          console.warn('[mild-dip] fee-sol topup tick failed', err);
        }
      }
    }
    if (
      cfg.orphanSweepEnabled &&
      cfg.orphanSweepMaxSells > 0 &&
      nowMs - lastOrphanSweepTickMs >= cfg.orphanSweepIntervalMs
    ) {
      lastOrphanSweepTickMs = nowMs;
      void sweepUnmanagedOrphans({
        cfg,
        state,
        maxSells: cfg.orphanSweepMaxSells,
        nowMs,
      }).catch((err) => console.warn('[mild-dip] orphan sweep tick failed', err));
    }
    if (
      cfg.dustBurnEnabled &&
      cfg.dustBurnMaxPerPass > 0 &&
      nowMs - lastDustBurnTickMs >= cfg.dustBurnIntervalMs
    ) {
      lastDustBurnTickMs = nowMs;
      const runDustBurn = () =>
        burnDustOrphans({
          cfg,
          state,
          nowMs,
          maxBurns: cfg.dustBurnMaxPerPass,
        }).then((burned) => {
          if (burned.candidates > 0) {
            console.log(
              `[mild-dip] dustBurn candidates=${burned.candidates} ` +
                `burned=${burned.burned} failed=${burned.failed} skipped=${burned.skipped}`,
            );
          }
        });
      if (opens > 0) {
        void runDustBurn().catch((err) => {
          console.warn('[mild-dip] dustBurn tick failed', err);
        });
      } else {
        try {
          await runDustBurn();
        } catch (err) {
          console.warn('[mild-dip] dustBurn tick failed', err);
        }
      }
    }

    /**
     * 1.11.782/783 — own stream wake only (no leader-seed entry).
     * Do not await — marks stay on cadence. Slow enrich/scan still only when flat;
     * post-exit knife enrich is a separate throttled wake.
     */
    if (
      !cfg.leaderMirror.mirrorOnly &&
      cfg.fastPathEnabled &&
      nowMs - lastLeaderWakeMs >= 2_000
    ) {
      lastLeaderWakeMs = nowMs;
      void wakeStreamHotMints(cfg, state, nowMs)
        .then(() =>
          cfg.leaderSeedEntryEnabled ? wakeLeaderSeeds(cfg, state, nowMs) : Promise.resolve(0),
        )
        .catch((err) => {
          console.warn(
            '[mild-dip] stream wake failed',
            err instanceof Error ? err.message : err,
          );
        });
      void wakeWaitDipWatches(cfg, state, nowMs).catch((err) => {
        console.warn(
          '[mild-dip] wait-dip wake failed',
          err instanceof Error ? err.message : err,
        );
      });
    }
    if (
      cfg.leaderMirror.enabled &&
      nowMs - lastMirrorQuoteStatsMs >= 30_000
    ) {
      lastMirrorQuoteStatsMs = nowMs;
      const mirrorJupiter = greenMinuteJupiterStats(
        nowMs,
        Math.max(3 * cfg.leaderMirror.quoteMaxAgeMs, 30_000),
        'leader_mirror_jupiter',
      );
      appendMildDipJournal(cfg.journalPath, {
        kind: 'leader_mirror_quote_stats',
        activeMints: mirrorJupiter.activeMints,
        inFlight: mirrorJupiter.inFlight,
        quoteAttempts: mirrorJupiter.quoteAttempts,
        quoteSuccesses: mirrorJupiter.quoteSuccesses,
        quoteErrors: mirrorJupiter.quoteErrors,
        capRejected: mirrorJupiter.capRejected,
        knifeWaitWaiting: knifeWaitQuoteWaitingKeys.size,
        knifeWaitUncovered: knifeWaitQuoteUncoveredKeys.size,
      });
      knifeWaitQuoteWaitingKeys.clear();
      knifeWaitQuoteUncoveredKeys.clear();
    }
    if (
      !cfg.leaderMirror.mirrorOnly &&
      cfg.knifeStabilizeEnabled &&
      cfg.postExitWakeMs > 0 &&
      nowMs - lastOwnTapeKnifeMs >= 8_000
    ) {
      lastOwnTapeKnifeMs = nowMs;
      void wakeOwnTapeKnifeEnrich(cfg, state, nowMs).catch((err) => {
        console.warn(
          '[mild-dip] own-tape knife wake failed',
          err instanceof Error ? err.message : err,
        );
      });
    }

    if (
      cfg.leaderMirror.enabled &&
      nowMs - lastMirrorWakeMs >= cfg.leaderMirror.tickIntervalMs &&
      !mirrorWakeInFlight
    ) {
      lastMirrorWakeMs = nowMs;
      mirrorWakeInFlight = true;
      void wakeLeaderMirrors(cfg, state, nowMs, leaderSellFeed)
        .catch((err) => {
          console.warn(
            '[mild-dip] leader mirror tick failed',
            err instanceof Error ? err.message : err,
          );
        })
        .finally(() => {
          mirrorWakeInFlight = false;
        });
    }

    if (
      tryEntriesInFlight &&
      tryEntriesStartedAtMs > 0 &&
      nowMs - tryEntriesStartedAtMs >= TRY_ENTRIES_STALL_THRESHOLD_MS &&
      tryEntriesStallReportedAtMs !== tryEntriesStartedAtMs
    ) {
      const durationMs = nowMs - tryEntriesStartedAtMs;
      tryEntriesStallReportedAtMs = tryEntriesStartedAtMs;
      console.warn(
        `[mild-dip] scan stalled durationMs=${durationMs} thresholdMs=${TRY_ENTRIES_STALL_THRESHOLD_MS}`,
      );
      appendMildDipJournal(cfg.journalPath, {
        kind: 'mild_dip_scan_stall',
        startedAtMs: tryEntriesStartedAtMs,
        durationMs,
        thresholdMs: TRY_ENTRIES_STALL_THRESHOLD_MS,
      });
    }

    /**
     * Entries:
     * - Flat book: await full scan (boosts/profiles + fast-path).
     * - 1.11.795 — with opens: fire-and-forget scan on a slower cadence so a
     *   quiet/starved stream cannot freeze buys at "sells only". Never await
     *   (marks keep the tick).
     */
    /**
     * 1.11.863 — the floor with opens is now configurable and defaults to the
     * plain scan interval.
     *
     * A hard 15s floor cost us the moments that matter. Measured over 6h: the
     * gap between scan looks at one mint had a median of 128s and a p90 of
     * 28 minutes, and we held a record within ±5s of a leader buy only 13.4%
     * of the time. Since we almost always hold something, the slow branch was
     * the normal branch.
     *
     * It was not a budget problem. At 30 mints per DexScreener request and a
     * 120 RPM ceiling the batch path can carry 3_600 mints a minute; we were
     * scanning 35.
     */
    const scanGapMs =
      opens === 0
        ? cfg.scanIntervalMs
        : Math.max(cfg.scanIntervalMs, cfg.scanIntervalWithOpensMs);
    if (!cfg.leaderMirror.mirrorOnly && nowMs - lastScan >= scanGapMs) {
      lastScan = nowMs;
      stats.lastScanAtMs = lastScan;
      if (opens === 0) {
        await tryEntries(cfg, state, nowMs);
        saveMildDipState(cfg.statePath, state);
        try {
          saveMildDipHotMints(cfg.hotMintsPath);
          saveMildDipPriceRing(cfg.priceRingPath);
          tapeShadowStateSaver?.save();
        } catch (err) {
          console.warn('[mild-dip] persist hot/price ring failed', err);
        }
      } else {
        void tryEntries(cfg, state, Date.now())
          .then(() => {
            saveMildDipState(cfg.statePath, state);
            try {
              saveMildDipHotMints(cfg.hotMintsPath);
              saveMildDipPriceRing(cfg.priceRingPath);
              tapeShadowStateSaver?.save();
            } catch (err) {
              console.warn('[mild-dip] persist hot/price ring failed', err);
            }
          })
          .catch((err) => {
            console.warn(
              '[mild-dip] background tryEntries failed',
              err instanceof Error ? err.message : err,
            );
          });
      }
    }

    stats.open = openCount(state);
    stats.hotMints = mildDipHotMints.size(nowMs);
  };

  // Expose stats for heartbeat via closure property (compat) + module ref.
  (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats = stats;

  const shutdown = (): void => {
    streamHandle?.stop();
    streamHandle = null;
    priceSampler?.stop();
    try {
      saveMildDipHotMints(cfg.hotMintsPath);
      saveMildDipPriceRing(cfg.priceRingPath);
      tapeShadowStateSaver?.save(true);
    } catch {
      /* ignore */
    }
  };

  if (opts?.once) {
    try {
      await tick();
    } finally {
      shutdown();
      if (loopStatsRef === stats) loopStatsRef = null;
    }
    return;
  }

  opts?.signal?.addEventListener('abort', shutdown, { once: true });

  try {
    for (;;) {
      if (opts?.signal?.aborted) break;
      try {
        await tick();
      } catch (err) {
        console.error('[mild-dip] tick error', err);
        appendMildDipJournal(cfg.journalPath, {
          kind: 'mild_dip_tick_error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Tight sleep while bags are open so stream marks hit ≤ markInterval.
      const opensNow = openCount(state);
      const greenFeedTickMs = cfg.green.jupiterMinuteEnabled
        ? cfg.green.jupiterMinuteIntervalMs
        : Number.POSITIVE_INFINITY;
      await sleep(
        opensNow > 0
          ? Math.min(cfg.markIntervalMs, 1_000, greenFeedTickMs)
          : Math.min(cfg.markIntervalMs, 5_000, greenFeedTickMs),
      );
    }
  } finally {
    shutdown();
    if (loopStatsRef === stats) loopStatsRef = null;
  }
}

export function mildDipLoopStats(): MildDipLoopStats | null {
  return loopStatsRef ?? (runMildDipLoop as { __stats?: MildDipLoopStats }).__stats ?? null;
}
