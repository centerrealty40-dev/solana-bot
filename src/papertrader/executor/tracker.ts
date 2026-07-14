import type { PaperTraderConfig, DcaLevel, TpLadderLevel } from '../config.js';
import { parseDcaLevels } from '../config.js';
import {
  isLiveOscarFamilyTradingStrategyId,
  isLiveOscarTradingStrategyId,
} from '../../preset-c/live-oscar-family.js';
import { liveOscarTierDcaLevelsSpec } from '../live-oscar-mcap-tier.js';
import { resolveLiveOscarPositionCeilingUsd } from '../live-oscar-entry-sizing.js';
import { isLiveOscarScalpWaveTrade } from '../live-oscar-scalp-wave.js';
import { isRunnerProbeTrade, mintFromOpenMapKey } from '../live-oscar-runner-probe.js';
import { isRunnerLiteTrade } from '../live-oscar-runner-lite.js';
import {
  isRunnerProbeExitPolicy,
  runnerProbeDcaLevelsSpec,
  runnerProbeKillEligible,
  runnerProbeOptimisticTpPx,
  runnerProbeResetPeakAfterDca,
  runnerProbeTpEligible,
  stampRunnerProbeExitPolicyOnOpen,
} from './exit-policy-runner-probe.js';
import {
  stampRunnerLiteExitPolicyOnOpen,
  runnerLiteDcaLevelsSpec,
} from './exit-policy-runner-lite.js';
import {
  applyLiveOscarPhaseEscalation,
  computeDropFromScalpAnchor,
  evaluateScalpPhaseEscalationTrigger,
} from '../live-oscar-phase-escalation.js';
import { isScalpWaveExitPolicy } from './exit-policy-scalp-wave.js';
import { isFastDipScalpExitPolicy } from './exit-policy-fast-dip-scalp.js';
import { cfgEffectiveForOpen } from '../cfg-effective-for-open.js';
import {
  armPostExitReentryGateFromClosedTrade,
  recordAfterFullCloseForMintRepeatGateFromClosedTrade,
} from '../discovery/dip-clones.js';
import { markPresetCTelegramGateConsumedOnFullClose } from '../../preset-c/telegram-gate.js';
import {
  evaluatePresetCScalpExitAction,
  isPresetCScalpExitPolicy,
  presetCScalpDcaDue,
  presetCScalpDca2Due,
  presetCScalpKillEligible,
  presetCScalpBreakevenExitEligible,
  presetCScalpSignalPnlFrac,
} from './exit-policy-preset-c-scalp.js';
import { loadPresetCScalpConfig } from '../../preset-c/scalp-config.js';
import type {
  ClosedTrade,
  DexSource,
  ExitContext,
  ExitReason,
  LivePendingTpSellIntent,
  OpenTrade,
  PartialSell,
  PositionLeg,
  PriceVerifyVerdict,
  SnapshotCandidateRow,
} from '../types.js';
import { fetchLatestSnapshotQuote, getLiveMcUsd, getSolUsd } from '../pricing.js';
import { buildShadowPriceEvent } from '../stream/shadow-price.js';
import { buildShyftVsDexQuoteObservation } from '../stream/shyft-shadow-observe.js';
import { getShyftShadowStreamPrice, isShyftShadowEnabled } from '../stream/shadow-state.js';
import { resolvePrimaryPriceUsd, buildPricePrimaryEvent } from '../stream/price-primary.js';
import {
  resolveDiscoveryMarketQuote,
  buildBirdeyeCoverageGapEvent,
  buildBirdeyeTierInsufficientEvent,
} from '../pricing/discovery-market-quote.js';
import {
  notifyBirdeyeTierInsufficient,
  notifyBirdeyeCoverageGap,
} from '../../live/birdeye-telegram-alerts.js';
import { verifyExitPrice } from '../pricing/price-verify.js';
import { getPriorityFeeUsd } from '../pricing/priority-fee.js';
import {
  buildOptionalLiqWatchCloseStamp,
  evaluateLiqDrainState,
  loadLiqWatchLiqUsd,
  refreshOpenTradeEntryLiqAfterDca,
} from '../pricing/liq-watch.js';
import {
  evaluateVolCollapseState,
  loadCurrentVol1hUsd,
  refreshVolBaseline,
} from '../pricing/vol-watch.js';
import { applyEntryCosts, applyExitCosts, buildCloseCosts } from '../costs.js';
import type {
  LiveBuyPipelineResult,
  LiveExitSliceSuccessHook,
  LiveOscarPhase4Tracker,
  LiveTokenToSolSellResult,
} from '../../live/phase4-types.js';
import {
  isGhostMtmExitTick,
  liveHotTickProbeQuoteSanity,
  resolveLiveSellReferencePriceUsd,
  resolveObservedPriceUsdForJournal,
} from '../../live/sell-price-sanity.js';
import {
  collectTrackerHotTickAnchors,
  summarizeHotTickAnchorChecks,
} from '../../live/hot-tick-price-anchors.js';
import { fetchContextSwaps } from './context-swaps.js';
import {
  collectFiredLadderPnls,
  ladderRetraceTriggered,
  ladderPnlThresholdMark,
  ladderStepOrThresholdTaken,
  LADDER_PNL_EPS,
  markLadderStepFired,
} from './tp-ladder-state.js';
import { dcaCrossedDownward, dcaEffPrev, dcaStepOrTriggerTaken, markDcaStepFired } from './dca-state.js';
import { dcaKillstopEffective, tpGridEffective, type TpGridEffective } from './tp-grid-effective.js';
import {
  isWaveBExitPolicy,
  resolveLiveOscarExitPolicyForTick,
  waveBOnNewHigh,
  waveBMarkTrailLevelTaken,
  clampLiveTrackerMtmForExit,
  waveBRecoverPhantomPeakIfNeeded,
  waveBUpdatePreArmReached,
  waveBAbsoluteKillEligible,
  waveBNextTrailLevelToFire,
  waveBTrailSellFractionForRemainder,
  waveBAdjustSellFractionForRemainder,
  waveBRemainderValueNetUsd,
  waveBDefensiveTrailActive,
  waveBBreakevenExitEligible,
  waveBBreakevenAtZeroExitEligible,
  waveBBreakevenInsuranceEligible,
  waveBPreArmNoHalf8PartialEligible,
  waveBPreArmNoHalf8PullbackFullExitEligible,
  waveBPreArmNoHalf8ScenarioActive,
  waveBDip10FirstTp5PartialEligible,
  waveBUpdateDip10ReachedBeforeTp8,
  waveBPostTp1DeriskEligible,
  waveBMaybeResetTpImpulse,
  waveBOnTpGridRungExecuted,
  stampLiveOscarExitPolicyOnOpen,
  shouldApplyRemainderFlushOnPartialSell,
  resolveWaveBRemainderFlushUsd,
  WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC,
  WAVE_B_FLAT_TP_HALF8_RUNNER,
  WAVE_B_TRAIL_FLUSH_REMAIN_USD,
} from './exit-policy-wave-b.js';
import {
  isVariantAExitPolicy,
  isVariantALegacyV1ExitPolicy,
  isVariantAHybridExitPolicy,
  isVariantAScratchExitPolicy,
  isPartialGridTrailExitPolicy,
  variantAUpdateRemainderPeak,
  variantAMoonExitTriggered,
  variantATrailFullExitTriggered,
  variantAEvalTimedExit,
  variantAExitTagLabel,
  variantAHybridDefensiveTrailActive,
  variantAHybridMaybeResetTpImpulse,
  variantAHybridResetTpGridOnDca,
  variantAScratchEvalFlush,
  variantAScratchHadTp,
  variantAScratchMarkTpTaken,
  variantAScratchUpdatePeak,
  variantAScratchTpTimelineLabelRu,
  variantAScratchDustFlushRemainUsd,
  variantAHybridThinVolFlushReady,
} from './exit-policy-variant-a.js';
import { recordMintTimedLossCooldown } from '../../live/mint-timed-loss-cooldown.js';
import { recordMintScratchReentry } from '../../live/mint-scratch-reentry.js';
import { child } from '../../core/logger.js';
import { appendLiveBuyAnchorsAfterDca, applyLiveBuyAnchorsAfterOpen } from '../../live/live-buy-anchor.js';
import { entryBuySliceEligibleForOpen } from '../../live/entry-slice.js';
import {
  runLivePartialExitTailFlush,
  scheduleLivePostCloseTailSweep,
} from '../../live/post-close-tail-sweep.js';
import { fetchLiveWalletSplBalancesByMint } from '../../live/reconcile-live.js';
import {
  hasManagedWalletExposure,
  liveWalletBalanceReconcileMinUsd,
  oscarChainUsdFromRaw,
  planFullExitUsdNotional,
  planPartialSellUsdNotional,
  reconcileOpenPositionWalletBalance,
  resyncRemainingFractionFromChain,
  journalRemainingUsd,
  shouldForceCloseJournalZeroChainTail,
  WALLET_RECONCILE_REMAINING_EPS,
} from '../../live/wallet-balance-exit-reconcile.js';
import type { LiveOscarConfig } from '../../live/config.js';
import { serializeClosedTrade, serializeOpenTrade } from '../../live/strategy-snapshot.js';
import { tryLiveEntryScaleInTrackerStep } from '../../live/entry-scale-in.js';
import {
  onLiveOscarFullCloseNegativeTradeDenylist,
  onLiveOscarFullCloseUpdateWhitelistLossStreak,
} from '../../live/mint-whitelist.js';
import { onLiveOscarFirstMintProbeFullClose } from '../../live/mint-first-probe.js';
import { stagedAveragingConfigured, buildLiveStagedEntryState } from './live-staged-entry-gates.js';
import { entrySplitAllLegsDone } from '../entry-split-legs.js';
import { tryPaperOnlyScaleInTrackerStep } from './paper-entry-scale-in.js';
import { makeOpenTradeFromEntry } from './open.js';
import {
  armWaveBPostTp1ScratchReentryFromOpenTrade,
  consumeWaveBPostTp1ScratchReentry,
  listWaveBPostTp1ScratchReentryPending,
  waveBPostTp1ScratchFullExitDue,
  waveBPostTp1ScratchReentryDue,
  waveBPostTp1ScratchReentryExpired,
} from './wave-b-post-tp1-scratch-reentry.js';
import {
  appendFlashKillPriceSample,
  evaluateFlashCrashKill,
  isFlashKillDcaBlocked,
  markFlashKillDcaBlocked,
  stampFlashKillLastBuyLeg,
} from './flash-crash-kill.js';
import {
  liveStagedEntryAddWindowOpen,
  liveStagedEntryTtlPreservesPlan,
  liveStagedEntrySignalTtlExpired,
  openTradeNeedsEntrySplitFastPoll,
  resolveStagedEntryTradableUsd,
} from './live-staged-entry-gates.js';
import { maybeRefreshPendingLegPgForOpenTrade } from '../pricing/pending-leg-pg-refresh.js';
import { tryLiveStagedEntryV2TrackerStep, usesLegacyStagedAdds } from './live-staged-entry-lifecycle.js';
import { reconcileE2OpenOnTrackerTick } from './live-oscar-e2-open-reconcile.js';
import { isPaperOscarIdealizedStackStrategyId } from '../paper-oscar-v21.js';
import { liveFetchBuyQuote } from '../../live/jupiter.js';
import { liveTrackerMtmUsdSnapJupiterSymmetricBand } from '../../live/mtm-snapshot-guard.js';
import {
  getOpenPositionExecSellUsd,
  isOpenPositionExecSellFresh,
  clearOpenPositionExecSellUsd,
} from '../../live/open-position-exec-price.js';
import { partialReasonToExitReason, livePartialSellDrainedWallet } from '../../live/wallet-zero-policy.js';
import {
  isPolicyAllowedFullExitReason,
  isPolicyAllowedPartialSell,
  livePolicyBlocksHealSyncSells,
  livePolicyOnlyExitsEnabled,
  recordPostHealChurnBlock,
} from '../../live/policy-only-exits.js';
import { isOscarHandoffClosedMint } from '../../live/copy-leader-attribution.js';
import { runMemSwanLiquidationSweep } from '../../live/mem-swan-liquidate.js';
import { recordMemSwanPortfolioMark, runMemSwanPortfolioSweep } from '../../live/mem-swan-portfolio.js';
import { tokenUsdFromBuyQuoteFitDecimals } from '../../live/phase5-gates.js';
import { scheduleMtmShadowTrackerProbe } from '../../live/mtm-shadow.js';
import {
  notifyLiveTrackerJupiterFallback,
  notifyLiveTrackerJupiterMtmClampedToSnapshot,
  notifyLiveTrackerSnapshotJupiterDivergence,
} from '../../core/telegram/jupiter-alerts.js';

const log = child('tracker');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FAILED_TP_SELL_RETRY_WINDOW_MS = 180_000;

export function retryableFailedTpSell(sellOut: LiveTokenToSolSellResult): boolean {
  if (sellOut.ok) return false;
  if (sellOut.preflightSkipReason === 'wallet_spl_balance_zero') return false;
  if (sellOut.preflightSkipReason === 'ghost_price_quote_rejected') return true;
  if (sellOut.terminalKind === 'sim_err' || sellOut.terminalKind === 'send_failed') return true;
  if (sellOut.terminalKind === 'preflight') {
    const msg = (sellOut.terminalMessage ?? sellOut.preflightSkipReason ?? '').toLowerCase();
    return (
      msg.includes('rpc') ||
      msg.includes('quote_stale') ||
      msg.includes('no_quote') ||
      msg.includes('swap_build') ||
      msg.includes('429') ||
      msg.includes('timeout')
    );
  }
  return false;
}

export function failedTpSellProtectBelowPnlFrac(reason: PartialSell['reason']): number {
  return reason === 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL' ? 0 : Number.NEGATIVE_INFINITY;
}

export function failedTpSellReasonSupportsPending(reason: PartialSell['reason']): boolean {
  return (
    reason === 'TP_LADDER' ||
    reason === 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL' ||
    reason === 'WAVE_B_DIP10_FIRST_TP5_PARTIAL'
  );
}

function samePendingTpSellIntent(a: LivePendingTpSellIntent | undefined, b: {
  reason: PartialSell['reason'];
  ladderStepIndex: number;
  ladderPnlPct: number;
}): boolean {
  if (!a) return false;
  return (
    a.reason === b.reason &&
    a.ladderStepIndex === b.ladderStepIndex &&
    Math.abs(a.ladderPnlPct - b.ladderPnlPct) <= LADDER_PNL_EPS
  );
}

/** Закрытие по TIMEOUT отключается после прогресса по позиции (ожидание отработки сетки после долгого удержания). Сплит scale-in не считается DCA. */
function timeoutSuppressedByProgress(ot: OpenTrade): boolean {
  if (isScalpWaveExitPolicy(ot)) return false;
  if (isRunnerProbeExitPolicy(ot)) return false;
  if (ot.partialSells.length > 0) return true;
  return ot.legs.some((l) => l.reason === 'dca');
}

/** Paper Oscar IDEALIZED (v2.1/v2.2) — до триггера ± или пока ждём вторую ногу: без TP/kill/trail (таймаут и liq — как обычно). */
function paperOscarIdealizedExitMute(ot: OpenTrade): boolean {
  if (ot.livePendingScaleIn) return true;
  const complete = ot.legs.some((l) => l.reason === 'scale_in');
  if (complete && !ot.liveExitProfileMode) return true;
  return false;
}

function paperOscarIdealizedNeutralFull(ot: OpenTrade): boolean {
  return (
    ot.legs.some((l) => l.reason === 'scale_in') &&
    !ot.livePendingScaleIn &&
    !ot.liveExitProfileMode
  );
}

function liveStagedEntrySignalDropPct(ot: OpenTrade, curMetric: number): number | null {
  const st = ot.liveStagedEntry;
  if (!st || !(st.signalPriceUsd > 0) || !(curMetric > 0)) return null;
  return (curMetric / st.signalPriceUsd - 1) * 100;
}

function liveStagedEntryKillHit(ot: OpenTrade, curMetric: number): boolean {
  const st = ot.liveStagedEntry;
  if (!st || !(st.killDropPct > 0)) return false;
  const dropPct = liveStagedEntrySignalDropPct(ot, curMetric);
  return dropPct != null && dropPct <= -st.killDropPct;
}

function scheduleTailAfterLiveClose(
  liveOscarCfg: LiveOscarConfig | undefined,
  mint: string,
  symbol: string,
  decimals: number,
  priceUsdPerToken: number,
  dexSource?: string,
  exitReason?: ExitReason,
): void {
  const px = priceUsdPerToken > 0 ? priceUsdPerToken : 1e-12;
  scheduleLivePostCloseTailSweep({
    liveCfg: liveOscarCfg,
    mint,
    symbol,
    decimals,
    priceUsdPerToken: px,
    dexSource,
    exitReason,
  });
}

function liveSellReferencePriceUsd(ot: OpenTrade): number | undefined {
  const ref = resolveLiveSellReferencePriceUsd({
    lastObservedPriceUsd: ot.lastObservedPriceUsd,
    avgEntryMarket: ot.avgEntryMarket,
    avgEntry: ot.avgEntry,
  });
  return ref != null && ref > 0 ? ref : undefined;
}

function exitReasonToPartialSellReason(exitReason: ExitReason): PartialSell['reason'] {
  switch (exitReason) {
    case 'TRAIL':
      return 'TRAIL';
    case 'KILLSTOP':
    case 'SL':
      return 'KILLSTOP';
    case 'TIMEOUT':
    case 'TIME_STOP':
      return 'TIMEOUT';
    case 'VOL_COLLAPSE':
      return 'THIN_VOL_FLUSH';
    case 'FLASH_CRASH_KILL':
      return 'FLASH_CRASH_KILL';
    case 'BREAKEVEN_EXIT':
      return 'BREAKEVEN_TRIM';
    default:
      return 'TP_LADDER';
  }
}

async function syncOpenTradeAfterLiveExitSlice(args: {
  mint: string;
  ot: OpenTrade;
  marketSell: number;
  liveOscarCfg: LiveOscarConfig;
  reconcileMinUsd: number;
  partialReason: PartialSell['reason'];
  sliceInfo: Parameters<LiveExitSliceSuccessHook>[0];
}): Promise<void> {
  const { mint, ot, marketSell, liveOscarCfg, reconcileMinUsd, partialReason, sliceInfo } = args;
  const spotSol = getSolUsd();
  let proceedsUsd = 0;
  let proceedsUsdSource: PartialSell['proceedsUsdSource'] = 'model';
  if (spotSol > 0 && sliceInfo.wsolOutLamports > 0n) {
    proceedsUsd = (Number(sliceInfo.wsolOutLamports) / 1e9) * spotSol;
    proceedsUsdSource = 'chain_sol';
  }

  let postSellOscarUsd = 0;
  const chainMap = await fetchLiveWalletSplBalancesByMint(liveOscarCfg);
  if (chainMap) {
    const bal = chainMap.get(mint) ?? 0n;
    if (bal > 0n && marketSell > 0) {
      postSellOscarUsd = oscarChainUsdFromRaw({
        raw: bal,
        decimals: ot.tokenDecimals ?? 6,
        priceUsd: marketSell,
        mint,
      }).oscarUsd;
    }
  }

  const prevRem = ot.remainingFraction;
  resyncRemainingFractionFromChain({
    ot,
    chainOscarUsd: postSellOscarUsd,
    minUsd: reconcileMinUsd,
    afterOnChainSell: true,
  });
  const nextRem = ot.remainingFraction;

  if (livePartialSellDrainedWallet(sliceInfo.sellAmountSource, sliceInfo.walletDrained)) {
    ot.remainingFraction = 0;
  } else if (prevRem > nextRem + 1e-9 && prevRem > 1e-9) {
    const sellFraction = Math.min(1, Math.max(0, 1 - nextRem / prevRem));
    const investedSoldUsd = ot.totalInvestedUsd * prevRem * sellFraction;
    const pnlUsd = proceedsUsd > 0 ? proceedsUsd - investedSoldUsd : 0;
    ot.partialSells.push({
      ts: Date.now(),
      price: marketSell,
      marketPrice: marketSell,
      sellFraction,
      reason: partialReason,
      proceedsUsd: proceedsUsd > 0 ? proceedsUsd : investedSoldUsd,
      grossProceedsUsd: proceedsUsd > 0 ? proceedsUsd : investedSoldUsd,
      pnlUsd,
      grossPnlUsd: pnlUsd,
      ...(sliceInfo.wsolOutLamports > 0n
        ? { solProceedsLamports: sliceInfo.wsolOutLamports.toString() }
        : {}),
      proceedsUsdSource,
      ...(sliceInfo.txSignature ? { exitTxSignature: sliceInfo.txSignature } : {}),
      ...(sliceInfo.priceImpactPct != null ? { priceImpactPct: sliceInfo.priceImpactPct } : {}),
    });
    ot.lastPartialSellTs = Date.now();
  }

  runLivePartialExitTailFlush({
    liveCfg: liveOscarCfg,
    mint,
    symbol: ot.symbol,
    decimals: ot.tokenDecimals ?? 6,
    hintPriceUsdPerToken: marketSell,
    dexSource: ot.source,
  });
}

export { ladderRetraceTriggered } from './tp-ladder-state.js';

/** Token count for partial sell slip — actual chain fill, not planned exit-slice notional. */
export function resolvePartialSellTokensSold(args: {
  tokenAmountRawSold?: string;
  tokenDecimals: number;
  actualProceedsUsd?: number;
  marketSell: number;
  tokenSizingUsdForSwap: number;
  investedSoldUsd: number;
  avgEntry: number;
}): number {
  const {
    tokenAmountRawSold,
    tokenDecimals,
    actualProceedsUsd,
    marketSell,
    tokenSizingUsdForSwap,
    investedSoldUsd,
    avgEntry,
  } = args;
  if (typeof tokenAmountRawSold === 'string' && /^\d+$/.test(tokenAmountRawSold) && tokenAmountRawSold !== '0') {
    const dec = Math.min(24, Math.max(0, Math.floor(tokenDecimals)));
    const tokens = Number(BigInt(tokenAmountRawSold)) / 10 ** dec;
    if (tokens > 1e-18 && Number.isFinite(tokens)) return tokens;
  }
  if (
    actualProceedsUsd != null &&
    actualProceedsUsd > 0 &&
    marketSell > 1e-18 &&
    Number.isFinite(marketSell)
  ) {
    return actualProceedsUsd / marketSell;
  }
  if (marketSell > 1e-18 && Number.isFinite(marketSell)) {
    return tokenSizingUsdForSwap / marketSell;
  }
  return investedSoldUsd / avgEntry;
}

export function computeSlipRealizedPct(
  marketSell: number,
  effectiveSell: number,
): number | undefined {
  if (!(marketSell > 0 && effectiveSell > 0)) return undefined;
  return +(((marketSell - effectiveSell) / marketSell) * 100).toFixed(4);
}

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
  /** After full close — e.g. clear staged entry signal so re-entry cannot bypass dip gate. */
  onMintFullClose?: (mint: string, openTrade?: OpenTrade) => void;
  /** Preset C scalp — check pending −10% entries between discovery ticks. */
  processPresetCScalpDeferredEntries?: () => Promise<void>;
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

/** Journal remainder fraction immediately before partial `lastIdx` (product of prior sellFractions). */
function journalRemainderFractionBeforePartial(ot: OpenTrade, lastIdx: number): number {
  let rem = 1;
  for (let i = 0; i < lastIdx; i++) {
    rem *= 1 - (ot.partialSells[i]?.sellFraction ?? 0);
  }
  return rem;
}

function inferMtmFlushProceedsUsd(ot: OpenTrade, lastIdx: number): number {
  const last = ot.partialSells[lastIdx];
  if (!last) return 0;
  const rem = last.remainingFractionBeforePartial ?? journalRemainderFractionBeforePartial(ot, lastIdx);
  const px = last.marketPrice > 0 ? last.marketPrice : last.price;
  if (!(rem > 1e-9 && px > 0 && ot.avgEntry > 0 && ot.totalInvestedUsd > 0)) return last.proceedsUsd || 0;
  return ot.totalInvestedUsd * rem * (px / ot.avgEntry);
}

function partialUnwindProceedsUsdForClose(ot: OpenTrade): number {
  const partials = ot.partialSells;
  if (!partials.length) return 0;
  let sum = 0;
  for (let i = 0; i < partials.length; i++) {
    const p = partials[i]!;
    const isLast = i === partials.length - 1;
    const chain = p.proceedsUsd || 0;
    if (!isLast) {
      sum += chain;
      continue;
    }
    const mtm = p.mtmFlushProceedsUsd ?? inferMtmFlushProceedsUsd(ot, i);
    const useMtm =
      p.walletDrainedFlush === true ||
      (p.mtmFlushProceedsUsd != null && p.mtmFlushProceedsUsd > chain) ||
      (ot.remainingFraction <= 1e-6 &&
        (p.slipRealizedPct ?? 0) >= 15 &&
        mtm > chain * 1.12 &&
        chain > 0);
    sum += useMtm ? mtm : chain;
  }
  return sum;
}

function applyPartialUnwindCloseProceedsReconcile(ct: ClosedTrade, ot: OpenTrade): void {
  if (!ot.partialSells.length) return;
  const invested = ot.totalInvestedUsd;
  if (!(invested > 0)) return;
  const chainTotal = totalProceedsNet(ot);
  const reconciled = partialUnwindProceedsUsdForClose(ot);
  if (!(reconciled > chainTotal + 0.5)) return;
  ct.totalProceedsUsd = reconciled;
  ct.grossTotalProceedsUsd = reconciled;
  ct.netPnlUsd = reconciled - invested;
  ct.grossPnlUsd = ct.netPnlUsd;
  ct.pnlPct = (ct.netPnlUsd / invested) * 100;
  ct.grossPnlPct = ct.pnlPct;
  const last = ot.partialSells[ot.partialSells.length - 1]!;
  const exitPx = last.marketPrice > 0 ? last.marketPrice : last.price;
  if (exitPx > 0) {
    ct.effective_exit_price = exitPx;
    ct.theoretical_exit_price = exitPx;
    ct.exitMcUsd = exitPx;
  } else if (ot.avgEntry > 0) {
    ct.effective_exit_price = ot.avgEntry * (reconciled / invested);
  }
  if (ct.exitContext && typeof ct.exitContext === 'object') {
    ct.exitContext = {
      ...ct.exitContext,
      closePnlPct: +ct.pnlPct.toFixed(2),
    };
  }
  if (ct.costs) {
    ct.costs = {
      ...ct.costs,
      gross_pnl_usd: ct.grossPnlUsd,
      net_pnl_usd: ct.netPnlUsd,
    };
  }
}

function stampFullExitTxSignature(ct: ClosedTrade, sellOut: LiveTokenToSolSellResult): void {
  const s = sellOut.txSignature;
  if (typeof s === 'string' && s.length > 16) ct.fullExitTxSignature = s;
}

/** После live `sell_full`: подставить фактические SOL→USD последней ноги (раньше оставался только modeled effectiveSell). */
function applyLiveFullCloseProceedsFromChain(args: {
  ct: ClosedTrade;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  sellOut: LiveTokenToSolSellResult;
  marketSell: number;
  networkFeeUsdPerTx: number;
}): void {
  const { ct, ot, cfg, sellOut, marketSell, networkFeeUsdPerTx } = args;
  const spotSol = getSolUsd() ?? 0;
  if (!(sellOut.solProceedsLamports != null && sellOut.solProceedsLamports > 0n && spotSol > 0)) {
    return;
  }
  const actualFinalUsd = (Number(sellOut.solProceedsLamports) / 1e9) * spotSol;
  const partialNet = totalProceedsNet(ot);
  const partialGross = totalProceedsGross(ot);
  const modeledFinalUsd = ct.totalProceedsUsd - partialNet;
  const chainImplausible =
    modeledFinalUsd > 2 &&
    actualFinalUsd <
      Math.min(modeledFinalUsd * 0.2, Math.max(0.5, modeledFinalUsd * 0.35)) &&
    marketSell >= ot.avgEntry * 0.97;
  if (chainImplausible) {
    log.warn(
      {
        mint: ot.mint.slice(0, 8),
        actualFinalUsd,
        modeledFinalUsd,
      },
      'live full close: chain SOL→USD implausible vs modeled; keeping modeled final proceeds',
    );
    return;
  }
  const totalProceedsUsd = partialNet + actualFinalUsd;
  const grossTotalProceedsUsd = partialGross + actualFinalUsd;
  const netPnlUsd = totalProceedsUsd - ot.totalInvestedUsd;
  const grossPnlUsd = grossTotalProceedsUsd - ot.totalInvestedUsd;
  const networkFeeUsdTotal = (ot.legs.length + ot.partialSells.length + 1) * networkFeeUsdPerTx;
  const investedRem = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
  const tokensClose = investedRem > 0 && ot.avgEntry > 0 ? investedRem / ot.avgEntry : 0;
  let effectiveExit = ct.effective_exit_price;
  if (tokensClose > 1e-18 && Number.isFinite(actualFinalUsd)) {
    effectiveExit = actualFinalUsd / tokensClose;
  }
  ct.totalProceedsUsd = totalProceedsUsd;
  ct.grossTotalProceedsUsd = grossTotalProceedsUsd;
  ct.netPnlUsd = netPnlUsd;
  ct.grossPnlUsd = grossPnlUsd;
  ct.grossPnlPct = ot.totalInvestedUsd > 0 ? (grossPnlUsd / ot.totalInvestedUsd) * 100 : 0;
  ct.pnlPct = ot.totalInvestedUsd > 0 ? (netPnlUsd / ot.totalInvestedUsd) * 100 : 0;
  ct.effective_exit_price = effectiveExit;
  ct.costs = buildCloseCosts({
    cfg,
    trade: ot,
    exit: { effectivePrice: effectiveExit, marketPrice: marketSell },
    networkFeeUsdTotal,
    slipDynamicBpsEntry: 0,
    slipDynamicBpsExit: 0,
    netPnlUsd,
    grossPnlUsd,
  });
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
  volDrop?: { dropPct: number; baselineUsd: number; currentVolUsd: number; sustainedMs: number } | null;
}): ExitContext {
  const { cfg, ot, closePnlPct, ageH, exitReason, curMetric, xAvg, tpLadder, liqDrop, volDrop } = args;
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
      if (isVariantAExitPolicy(ot) && ot.liveVariantAExitTag === 'moon50') {
        triggerLabel = variantAExitTagLabel('moon50') ?? 'Variant A · moon +50%';
        break;
      }
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
      if (isVariantAExitPolicy(ot) && ot.liveVariantAExitTag === 'trail') {
        triggerLabel = variantAExitTagLabel('trail') ?? 'Variant A · trail';
        break;
      }
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
      if (isVariantAExitPolicy(ot) && ot.liveVariantAExitTag) {
        triggerLabel = variantAExitTagLabel(ot.liveVariantAExitTag) ?? `Variant A · ${ot.liveVariantAExitTag}`;
      } else {
        triggerLabel = `TIMEOUT ${cfg.timeoutHours}h${ot.trailingArmed ? ' (trail was armed)' : ' (trail NEVER armed; need ' + cfg.trailTriggerX.toFixed(2) + 'x)'}`;
      }
      break;
    case 'BREAKEVEN_EXIT':
      triggerLabel = isPresetCScalpExitPolicy(ot)
        ? `Preset C breakeven exit (TP≥+5% taken, cur ${closePnlPct.toFixed(1)}% vs avg, full exit)`
        : waveBPreArmNoHalf8ScenarioActive(ot) && ot.liveWavePreArmNoHalf8PartialTaken
          ? `Wave B pre-arm/no-TP8 pullback exit (partial @ +5%, cur ${closePnlPct.toFixed(1)}% vs avg, full exit)`
          : `Wave B breakeven exit (TP≥+7.5% taken, cur ${closePnlPct.toFixed(1)}% vs avg, full exit)`;
      break;
    case 'KILLSTOP':
      if (ot.liveStagedEntry) {
        const signalDropPct = liveStagedEntrySignalDropPct(ot, curMetric);
        triggerLabel = `Signal killstop −${ot.liveStagedEntry.killDropPct}% (cur ${signalDropPct?.toFixed(1) ?? 'n/a'}% vs signal, full exit)`;
      } else {
        triggerLabel = `DCA killstop ${(killEff * 100).toFixed(0)}% (cur ${closePnlPct.toFixed(1)}% vs avg, ${dcaLegsAdded} DCA legs)`;
      }
      break;
    case 'TIME_STOP':
      triggerLabel = `hard time-stop ${cfg.liveOscarHardTimeStopHours}h (capital rotation — profit-agnostic full exit)`;
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
    case 'VOL_COLLAPSE':
      if (volDrop) {
        const sustainedH = (volDrop.sustainedMs / 3_600_000).toFixed(1);
        triggerLabel = `vol collapse ${volDrop.dropPct.toFixed(1)}% ($${Math.round(volDrop.baselineUsd).toLocaleString()} → $${Math.round(volDrop.currentVolUsd).toLocaleString()} 1h vol, sustained ${sustainedH}h)`;
      } else {
        triggerLabel = `vol collapse (no detail)`;
      }
      break;
    case 'FLASH_CRASH_KILL':
      triggerLabel = `Flash crash kill (velocity / post-fill guard)`;
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
    case 'WAVE_B_POST_TP1_SCRATCH':
      triggerLabel = `Wave B post-TP1 scratch (signal drop ≤−${cfg.liveOscarWaveBPostTp1ScratchDropPct}%, full exit)`;
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
  const ct: ClosedTrade = {
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
  applyPartialUnwindCloseProceedsReconcile(ct, ot);
  return ct;
}

type TpPartialSellResult = 'ok' | 'defer_next' | 'abort_mint' | 'wallet_zero';

function armFailedTpSellRetry(args: {
  mint: string;
  ot: OpenTrade;
  sellOut: LiveTokenToSolSellResult;
  sellFraction: number;
  ladderStepIndex: number;
  ladderRungsTotal: number;
  ladderPnlPct: number;
  tpGrid: boolean;
  partialReason: PartialSell['reason'];
  logLabelPct: string;
  timelineLabelRu?: string;
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
}): void {
  const now = Date.now();
  const existing = samePendingTpSellIntent(args.ot.livePendingTpSell, {
    reason: args.partialReason,
    ladderStepIndex: args.ladderStepIndex,
    ladderPnlPct: args.ladderPnlPct,
  })
    ? args.ot.livePendingTpSell
    : undefined;
  const pending: LivePendingTpSellIntent = {
    id: existing?.id ?? `failed_tp_${now}_${Math.random().toString(36).slice(2, 8)}`,
    createdTs: existing?.createdTs ?? now,
    updatedTs: now,
    retryUntilTs: existing?.retryUntilTs ?? now + FAILED_TP_SELL_RETRY_WINDOW_MS,
    attempts: (existing?.attempts ?? 0) + 1,
    sellFraction: args.sellFraction,
    reason: args.partialReason,
    ladderStepIndex: args.ladderStepIndex,
    ladderRungsTotal: args.ladderRungsTotal,
    ladderPnlPct: args.ladderPnlPct,
    tpGrid: args.tpGrid,
    logLabelPct: args.logLabelPct,
    ...(args.timelineLabelRu ? { timelineLabelRu: args.timelineLabelRu } : {}),
    triggerPnlFrac: args.ladderPnlPct,
    protectBelowPnlFrac: failedTpSellProtectBelowPnlFrac(args.partialReason),
    terminalKind: args.sellOut.terminalKind,
    terminalMessage: (args.sellOut.terminalMessage ?? args.sellOut.preflightSkipReason)?.slice(0, 400),
  };
  args.ot.livePendingTpSell = pending;
  args.journalLiveStrategy?.({
    kind: 'failed_tp_retry_pending',
    mint: args.mint,
    reason: pending.reason,
    retryId: pending.id,
    attempts: pending.attempts,
    retryUntilTs: pending.retryUntilTs,
    ladderPnlPct: pending.ladderPnlPct,
    sellFraction: pending.sellFraction,
    terminalKind: pending.terminalKind,
    terminalMessage: pending.terminalMessage,
  });
}

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
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
  markLadder: () => void;
  logLabelPct: string;
  /** Default `TP_LADDER`; use `BREAKEVEN_TRIM` for Live Oscar post-first-TP breakeven peel. */
  partialReason?: PartialSell['reason'];
  timelineLabelRu?: string;
  /** Live: Oscar-attributed chain USD for this mint (wallet source of truth). */
  chainOscarUsd?: number;
  /** Pending retry path owns the existing intent and should not create another pending record. */
  suppressPendingRetry?: boolean;
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
    liveOscarCfg,
    stats,
    markLadder,
    logLabelPct,
    partialReason: partialReasonArg,
    timelineLabelRu,
    chainOscarUsd: chainOscarUsdArg,
    suppressPendingRetry,
  } = args;
  const partialReason: PartialSell['reason'] = partialReasonArg ?? 'TP_LADDER';
  const reconcileMinUsd = liveWalletBalanceReconcileMinUsd(liveOscarCfg);
  const marketSell = curMetric;
  let chainOscarUsd = chainOscarUsdArg ?? 0;
  if (livePhase4 && liveOscarCfg && marketSell > 0 && chainOscarUsd <= 0) {
    const chainMap = await fetchLiveWalletSplBalancesByMint(liveOscarCfg);
    const raw = chainMap?.get(mint) ?? 0n;
    if (raw > 0n) {
      chainOscarUsd = oscarChainUsdFromRaw({
        raw,
        decimals: ot.tokenDecimals ?? 6,
        priceUsd: marketSell,
        mint,
      }).oscarUsd;
      resyncRemainingFractionFromChain({ ot, chainOscarUsd, minUsd: reconcileMinUsd });
    }
  }
  if (livePhase4 && !isPolicyAllowedPartialSell(partialReason, liveOscarCfg)) {
    return 'defer_next';
  }
  if (
    !(ot.remainingFraction > WALLET_RECONCILE_REMAINING_EPS) &&
    !hasManagedWalletExposure({ ot, chainOscarUsd, minUsd: reconcileMinUsd })
  ) {
    return 'ok';
  }
  if (rawSellFrac <= 1e-12) {
    markLadder();
    return 'ok';
  }
  const minPartialInterval = cfg.livePartialTpMinIntervalMs;
  if (minPartialInterval > 0 && ot.lastPartialSellTs != null) {
    const elapsed = Date.now() - ot.lastPartialSellTs;
    if (elapsed < minPartialInterval) return 'defer_next';
  }
  const remainUsdForFlush = waveBRemainderValueNetUsd(ot, marketSell);
  let sellFraction = Math.min(1, rawSellFrac);
  if (shouldApplyRemainderFlushOnPartialSell(cfg.strategyId, ot)) {
    const flushUsd = resolveWaveBRemainderFlushUsd(liveOscarCfg);
    sellFraction = waveBAdjustSellFractionForRemainder(remainUsdForFlush, sellFraction, cfg, flushUsd);
  }
  const remainingFractionBeforePartial = ot.remainingFraction;
  /** Cost basis of the slice we intend to peel off (fraction of remaining invested USD). */
  const investedSoldUsd = ot.totalInvestedUsd * ot.remainingFraction * sellFraction;
  /**
   * Token amount for Jupiter must match `sellFraction` of *remaining tokens*, not `investedSoldUsd / marketSell`.
   * Remaining tokens ~ (TI×R) / avgEntryMarket; at profit that is larger than investedSoldUsd/marketSell,
   * but `remainingFraction` still decrements by (1−sellFraction) → drift vs wallet if we undersell on-chain.
   */
  const entryPxForTokenSizing =
    ot.avgEntryMarket > 1e-18 && Number.isFinite(ot.avgEntryMarket)
      ? ot.avgEntryMarket
      : ot.avgEntry > 1e-18 && Number.isFinite(ot.avgEntry)
        ? ot.avgEntry
        : marketSell;
  const tokenSizingUsdForSwap =
    livePhase4 && chainOscarUsd > 0
      ? planPartialSellUsdNotional({
          ot,
          chainOscarUsd,
          sellFraction,
          marketPrice: marketSell,
        })
      : marketSell > 1e-18 && entryPxForTokenSizing > 1e-18 && Number.isFinite(marketSell)
        ? investedSoldUsd * (marketSell / entryPxForTokenSizing)
        : investedSoldUsd;
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
    usdNotional: tokenSizingUsdForSwap,
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
  let chainPartialProceeds = false;
  const partialSellsBeforeSlice = ot.partialSells.length;
  if (livePhase4 && marketSell > 0 && tokenSizingUsdForSwap > 1e-6) {
    sellOut = await livePhase4.tryTokenToSolSell({
      mint,
      symbol: ot.symbol,
      usdNotional: tokenSizingUsdForSwap,
      priceUsdPerToken: marketSell,
      referencePriceUsd: liveSellReferencePriceUsd(ot),
      decimals: ot.tokenDecimals ?? 6,
      intentKind: 'sell_partial',
      onSliceSuccess: async (sliceInfo) => {
        if (!liveOscarCfg) return;
        await syncOpenTradeAfterLiveExitSlice({
          mint,
          ot,
          marketSell,
          liveOscarCfg,
          reconcileMinUsd,
          partialReason,
          sliceInfo,
        });
        journalLiveStrategy?.({
          kind: 'live_position_partial_sell',
          mint,
          openTrade: serializeOpenTrade(ot),
        });
      },
    });
    chainPartialProceeds =
      sellOut.solProceedsLamports != null && sellOut.solProceedsLamports > 0n;
    if (!sellOut.ok && !chainPartialProceeds) {
      if (sellOut.preflightSkipReason === 'wallet_spl_balance_zero') return 'wallet_zero';
      if (
        !suppressPendingRetry &&
        failedTpSellReasonSupportsPending(partialReason) &&
        retryableFailedTpSell(sellOut)
      ) {
        armFailedTpSellRetry({
          mint,
          ot,
          sellOut,
          sellFraction,
          ladderStepIndex,
          ladderRungsTotal,
          ladderPnlPct,
          tpGrid,
          partialReason,
          logLabelPct,
          timelineLabelRu,
          journalLiveStrategy,
        });
        return 'defer_next';
      }
      return 'abort_mint';
    }
    if (!sellOut.ok && chainPartialProceeds) {
      log.warn(
        {
          mint: mint.slice(0, 8),
          symbol: ot.symbol,
          preflightSkipReason: sellOut.preflightSkipReason,
          solProceedsLamports: sellOut.solProceedsLamports?.toString(),
        },
        'live partial sell exit-slice partial chain success — journaling proceeds before handling failure',
      );
      if (ot.partialSells.length > partialSellsBeforeSlice) {
        markLadder();
        return sellOut.preflightSkipReason === 'wallet_spl_balance_zero' ||
          livePartialSellDrainedWallet(sellOut.sellAmountSource, sellOut.walletDrained)
          ? 'wallet_zero'
          : 'defer_next';
      }
    }
    if (sellOut.ok && (sellOut.solProceedsLamports == null || sellOut.solProceedsLamports <= 0n)) {
      log.warn(
        { mint: mint.slice(0, 8), symbol: ot.symbol },
        'live partial sell ok but missing solProceedsLamports — using modeled proceedsUsd',
      );
    }
  }
  const sellChainRecorded = sellOut.ok || chainPartialProceeds;
  const exitSliceJournaled = ot.partialSells.length > partialSellsBeforeSlice;

  if (exitSliceJournaled && sellChainRecorded) {
    markLadder();
    if (
      sellOut.preflightSkipReason === 'wallet_spl_balance_zero' ||
      livePartialSellDrainedWallet(sellOut.sellAmountSource, sellOut.walletDrained) ||
      ot.remainingFraction <= WALLET_RECONCILE_REMAINING_EPS
    ) {
      return 'wallet_zero';
    }
    return 'ok';
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
    const tokensSold = resolvePartialSellTokensSold({
      tokenAmountRawSold: sellOut.tokenAmountRawSold,
      tokenDecimals: ot.tokenDecimals ?? 6,
      actualProceedsUsd: actualUsd,
      marketSell,
      tokenSizingUsdForSwap,
      investedSoldUsd,
      avgEntry: ot.avgEntry,
    });
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

  const exitTxSig =
    typeof sellOut.txSignature === 'string' && sellOut.txSignature.length > 16 ? sellOut.txSignature : undefined;

  /**
   * 1.11.168: stamp Jupiter priceImpactPct (если live tracker отдал) и фактический
   * realized slippage (% deviation effective vs market price). Позволяет ретро
   * посчитать leakage без cross-reference с execution_attempt JSONL.
   */
  const priceImpactPctFromQuote =
    sellOut.priceImpactPct != null && Number.isFinite(sellOut.priceImpactPct)
      ? Math.max(0, Math.min(1, sellOut.priceImpactPct))
      : undefined;
  const slipRealizedPct = computeSlipRealizedPct(marketSell, effectiveSell);

  const ps: PartialSell = {
    ts: Date.now(),
    price: effectiveSell,
    marketPrice: marketSell,
    sellFraction,
    reason: partialReason,
    proceedsUsd,
    grossProceedsUsd,
    pnlUsd,
    grossPnlUsd,
    ...(solProceedsLamports ? { solProceedsLamports } : {}),
    proceedsUsdSource,
    ...(exitTxSig ? { exitTxSignature: exitTxSig } : {}),
    ...(priceImpactPctFromQuote != null ? { priceImpactPct: priceImpactPctFromQuote } : {}),
    ...(slipRealizedPct != null ? { slipRealizedPct } : {}),
    ...(partialReason === 'TRAIL_STEP' && Number.isFinite(ladderPnlPct)
      ? { trailLevelPnlFrac: ladderPnlPct }
      : {}),
    ...(typeof timelineLabelRu === 'string' && timelineLabelRu.trim().length > 0
      ? { timelineLabelRu: timelineLabelRu.trim() }
      : {}),
  };
  ot.partialSells.push(ps);
  ot.lastPartialSellTs = ps.ts;
  ot.remainingFraction *= 1 - sellFraction;
  if (partialReason === 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL' && sellChainRecorded) {
    ot.liveWavePreArmNoHalf8PartialTaken = true;
  }
  let walletDrainedFlush = false;
  if (
    liveOscarCfg?.strategyEnabled &&
    liveOscarCfg.executionMode === 'live' &&
    livePhase4 &&
    sellChainRecorded &&
    livePartialSellDrainedWallet(sellOut.sellAmountSource, sellOut.walletDrained)
  ) {
    ot.remainingFraction = 0;
    walletDrainedFlush = true;
    log.info(
      {
        mint: mint.slice(0, 8),
        symbol: ot.symbol,
        sellAmountSource: sellOut.sellAmountSource,
      },
      'live partial sell drained wallet — sync remainingFraction=0',
    );
  } else if (
    liveOscarCfg?.strategyEnabled &&
    liveOscarCfg.executionMode === 'live' &&
    livePhase4 &&
    (sellChainRecorded || sellOut.preflightSkipReason === 'wallet_spl_balance_zero')
  ) {
    const chainMap = await fetchLiveWalletSplBalancesByMint(liveOscarCfg);
    const bal = chainMap?.get(mint);
    if (chainMap != null && (!bal || bal === 0n)) {
      ot.remainingFraction = 0;
      walletDrainedFlush = true;
      log.info(
        { mint: mint.slice(0, 8), symbol: ot.symbol },
        'live partial TP: SPL balance 0 after sell — sync remainingFraction=0 (avoid false orphan)',
      );
    } else if (chainMap != null && bal != null && bal > 0n && marketSell > 0) {
      const postSellOscarUsd = oscarChainUsdFromRaw({
        raw: bal,
        decimals: ot.tokenDecimals ?? 6,
        priceUsd: marketSell,
        mint,
      }).oscarUsd;
      resyncRemainingFractionFromChain({ ot, chainOscarUsd: postSellOscarUsd, minUsd: reconcileMinUsd });
    }
  }
  if (
    walletDrainedFlush &&
    remainingFractionBeforePartial > 1e-6 &&
    marketSell > 0 &&
    ot.avgEntry > 0
  ) {
    const mtmFlushProceedsUsd =
      ot.totalInvestedUsd * remainingFractionBeforePartial * (marketSell / ot.avgEntry);
    ps.walletDrainedFlush = true;
    ps.remainingFractionBeforePartial = remainingFractionBeforePartial;
    ps.mtmFlushProceedsUsd = mtmFlushProceedsUsd;
    if (proceedsUsd < mtmFlushProceedsUsd * 0.85) {
      ps.price = marketSell;
      ps.pnlUsd = mtmFlushProceedsUsd - ot.totalInvestedUsd * remainingFractionBeforePartial;
      ps.grossPnlUsd = ps.pnlUsd;
    }
  }
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
    reason: partialReason,
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
    ...(exitTxSig ? { exitTxSignature: exitTxSig } : {}),
    ...(cfg.liveExitModeAbEnabled && ot.liveExitProfileMode
      ? { liveExitProfileMode: ot.liveExitProfileMode }
      : {}),
    ...(typeof timelineLabelRu === 'string' && timelineLabelRu.trim().length > 0
      ? { timelineLabelRu: timelineLabelRu.trim() }
      : {}),
  });
  journalLiveStrategy?.({
    kind: 'live_position_partial_sell',
    mint,
    openTrade: serializeOpenTrade(ot),
  });
  if (sellChainRecorded) {
    runLivePartialExitTailFlush({
      liveCfg: liveOscarCfg,
      mint,
      symbol: ot.symbol,
      decimals: ot.tokenDecimals ?? 6,
      hintPriceUsdPerToken: marketSell,
      dexSource: ot.source,
    });
  }
  console.log(
    `[${logLabelPct}] ${mint.slice(0, 8)} $${ot.symbol} sold=${(sellFraction * 100).toFixed(0)}% pnl=$${pnlUsd.toFixed(2)} remain=${(ot.remainingFraction * 100).toFixed(0)}%`,
  );
  if (sellChainRecorded) {
    if (
      walletDrainedFlush ||
      sellOut.preflightSkipReason === 'wallet_spl_balance_zero' ||
      livePartialSellDrainedWallet(sellOut.sellAmountSource, sellOut.walletDrained)
    ) {
      return 'wallet_zero';
    }
    return 'ok';
  }
  if (!sellOut.ok) return 'abort_mint';
  return 'ok';
}

async function tryExecutePendingFailedTpSell(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  pnlFrac: number;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
}): Promise<'none' | 'executed' | 'pending' | 'protect_full_exit'> {
  const { mint, ot, cfg, curMetric, pnlFrac, journalAppend, journalLiveStrategy, livePhase4, liveOscarCfg, stats } =
    args;
  const pending = ot.livePendingTpSell;
  if (!pending) return 'none';

  if (
    pending.reason === 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL' &&
    Number.isFinite(pending.protectBelowPnlFrac) &&
    pnlFrac <= pending.protectBelowPnlFrac + LADDER_PNL_EPS
  ) {
    journalLiveStrategy?.({
      kind: 'failed_tp_retry_pending',
      mint,
      reason: pending.reason,
      retryId: pending.id,
      phase: 'protective_full_exit',
      attempts: pending.attempts,
      pnlFrac,
      protectBelowPnlFrac: pending.protectBelowPnlFrac,
      terminalKind: pending.terminalKind,
      terminalMessage: pending.terminalMessage,
    });
    return 'protect_full_exit';
  }

  const now = Date.now();
  const priceStillValid = pnlFrac + LADDER_PNL_EPS >= pending.triggerPnlFrac;
  if (!priceStillValid && now > pending.retryUntilTs) {
    journalLiveStrategy?.({
      kind: 'failed_tp_retry_pending',
      mint,
      reason: pending.reason,
      retryId: pending.id,
      phase: 'expired',
      attempts: pending.attempts,
      pnlFrac,
      triggerPnlFrac: pending.triggerPnlFrac,
      retryUntilTs: pending.retryUntilTs,
    });
    ot.livePendingTpSell = undefined;
    return 'none';
  }

  pending.attempts += 1;
  pending.updatedTs = now;
  const r = await tryExecuteTpPartialSell({
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction: pending.sellFraction,
    ladderStepIndex: pending.ladderStepIndex,
    ladderRungsTotal: pending.ladderRungsTotal,
    ladderPnlPct: pending.ladderPnlPct,
    tpGrid: pending.tpGrid,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    markLadder: () => {
      if (pending.reason === 'TP_LADDER') {
        markLadderStepFired(ot, pending.ladderStepIndex, pending.ladderPnlPct);
        if (isWaveBExitPolicy(ot)) waveBOnTpGridRungExecuted(ot, pending.ladderPnlPct);
      } else if (pending.reason === 'WAVE_B_DIP10_FIRST_TP5_PARTIAL') {
        waveBOnTpGridRungExecuted(ot, WAVE_B_FLAT_TP_HALF8_RUNNER.gridStepPnl);
      }
    },
    logLabelPct: `${pending.logLabelPct}-retry`,
    partialReason: pending.reason,
    timelineLabelRu: pending.timelineLabelRu,
    suppressPendingRetry: true,
  });

  if (r === 'ok' || r === 'wallet_zero') {
    if (pending.reason === 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL') {
      ot.liveWavePreArmNoHalf8PartialTaken = true;
    } else if (pending.reason === 'WAVE_B_DIP10_FIRST_TP5_PARTIAL') {
      ot.liveWaveDip10FirstTp5PartialTaken = true;
    }
    ot.livePendingTpSell = undefined;
    journalLiveStrategy?.({
      kind: 'failed_tp_retry_executed',
      mint,
      reason: pending.reason,
      retryId: pending.id,
      attempts: pending.attempts,
      pnlFrac,
      sellFraction: pending.sellFraction,
    });
    return 'executed';
  }

  journalLiveStrategy?.({
    kind: 'failed_tp_retry_pending',
    mint,
    reason: pending.reason,
    retryId: pending.id,
    phase: 'retry_failed',
    attempts: pending.attempts,
    pnlFrac,
    triggerPnlFrac: pending.triggerPnlFrac,
    retryUntilTs: pending.retryUntilTs,
    result: r,
  });
  return 'pending';
}

/** Wave B: partial trail sells on −stepPnl descents from `liveWaveTrailAnchorPnlFrac`. */
async function tryWaveBTrailPartialSells(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  xAvg: number;
  tgEff: TpGridEffective;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
}): Promise<void> {
  const {
    mint,
    ot,
    cfg,
    curMetric,
    xAvg,
    tgEff,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
  } = args;
  if (!isPartialGridTrailExitPolicy(ot) || !(tgEff.stepPnl > 0)) return;
  const defensive = isVariantAHybridExitPolicy(ot)
    ? variantAHybridDefensiveTrailActive(ot, tgEff.stepPnl)
    : waveBDefensiveTrailActive(ot, tgEff.stepPnl);
  if (!defensive) return;
  if (!ot.trailingArmed) ot.trailingArmed = true;
  const pnlFrac = xAvg - 1;
  const peakFrac = ot.liveWavePeakPnlFrac ?? pnlFrac;
  /** Pullback phase only — at/new ATH TP grid runs; trail resumes after `waveBOnNewHigh` on the next peak. */
  if (pnlFrac >= peakFrac - LADDER_PNL_EPS) return;
  const anchor = ot.liveWaveTrailAnchorPnlFrac ?? pnlFrac;
  if (anchor + LADDER_PNL_EPS < WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) return;
  const level = waveBNextTrailLevelToFire(
    anchor,
    tgEff.stepPnl,
    pnlFrac,
    ot.liveWaveTrailLevelsTaken ?? [],
    true,
  );
  if (level == null) return;
  const remainingValueNet = waveBRemainderValueNetUsd(ot, curMetric);
  const flushUsd = resolveWaveBRemainderFlushUsd(liveOscarCfg);
  const sellFraction = waveBTrailSellFractionForRemainder(remainingValueNet, cfg, flushUsd);
  const trailFlush = sellFraction >= 1 - 1e-12;
  const r = await tryExecuteTpPartialSell({
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction,
    ladderStepIndex: 0,
    ladderRungsTotal: 0,
    ladderPnlPct: level,
    tpGrid: false,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    markLadder: () => waveBMarkTrailLevelTaken(ot, level),
    logLabelPct: trailFlush
      ? `TRAIL_FLUSH_remain<${WAVE_B_TRAIL_FLUSH_REMAIN_USD}$`
      : `TRAILstep@${(level * 100).toFixed(1)}%`,
    partialReason: 'TRAIL_STEP',
    timelineLabelRu: trailFlush
      ? `Live Oscar wave B · trail: остаток < $${WAVE_B_TRAIL_FLUSH_REMAIN_USD} — полное закрытие хвоста (+${(level * 100).toFixed(1)}% PnL)`
      : `Live Oscar wave B · trail −${(tgEff.stepPnl * 100).toFixed(1)}% от хая (+${(level * 100).toFixed(1)}% PnL) · ${(sellFraction * 100).toFixed(0)}% остатка`,
  });
  void r;
}

/** Wave B: after first two TP rungs (+2.5% / +5%), one insurance peel at breakeven (≤0% vs avg). */
async function tryWaveBBreakevenInsurance(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  xAvg: number;
  tgEff: TpGridEffective;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
}): Promise<void> {
  const {
    mint,
    ot,
    cfg,
    curMetric,
    xAvg,
    tgEff,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
  } = args;
  if (
    !isLiveOscarTradingStrategyId(cfg.strategyId) ||
    !cfg.liveOscarWaveBBreakevenInsuranceEnabled ||
    !isWaveBExitPolicy(ot) ||
    waveBBreakevenExitEligible(ot, tgEff.stepPnl) ||
    ot.liveWaveBreakevenInsuranceTaken ||
    ot.remainingFraction <= 1e-9 ||
    !(ot.avgEntry > 0) ||
    !(curMetric > 0)
  ) {
    return;
  }
  const pnlFrac = xAvg - 1;
  const pnlThreshold = cfg.liveOscarWaveBBreakevenInsurancePnlFrac;
  if (pnlFrac > pnlThreshold + LADDER_PNL_EPS) return;
  if (!waveBBreakevenInsuranceEligible(ot, tgEff.stepPnl)) return;

  const trimFrac = Math.min(0.99, Math.max(0.01, cfg.liveOscarWaveBBreakevenInsuranceFraction));
  const remainingValueNet = waveBRemainderValueNetUsd(ot, curMetric);
  const sellFraction = waveBAdjustSellFractionForRemainder(remainingValueNet, trimFrac, cfg);
  const r = await tryExecuteTpPartialSell({
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction,
    ladderStepIndex: 0,
    ladderRungsTotal: 0,
    ladderPnlPct: pnlFrac,
    tpGrid: false,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    markLadder: () => {},
    logLabelPct: `wave-b-insurance-${(trimFrac * 100).toFixed(0)}pct-at-breakeven`,
    partialReason: 'WAVE_B_BREAKEVEN_INSURANCE',
    timelineLabelRu:
      'Live Oscar wave B · после +2.5%/+5% TP откат к безубытку — страховка ' +
      `${(trimFrac * 100).toFixed(0)}% остатка`,
  });
  if (r === 'ok') {
    ot.liveWaveBreakevenInsuranceTaken = true;
  }
}

/** Wave B half8_runner: pre-arm (+7.5%) without +8% TP — lock 50% at +5% vs avg once. */
async function tryWaveBPreArmNoHalf8PartialExit(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  xAvg: number;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
}): Promise<void> {
  const {
    mint,
    ot,
    cfg,
    curMetric,
    xAvg,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
  } = args;
  if (
    !isLiveOscarTradingStrategyId(cfg.strategyId) ||
    !isWaveBExitPolicy(ot) ||
    !(ot.avgEntry > 0) ||
    !(curMetric > 0) ||
    ot.remainingFraction <= 1e-9
  ) {
    return;
  }
  if (ot.livePendingTpSell?.reason === 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL') return;
  const pnlFrac = xAvg - 1;
  if (!waveBPreArmNoHalf8PartialEligible(ot, cfg, pnlFrac)) return;

  const trimFrac = Math.min(0.99, Math.max(0.01, cfg.liveOscarWaveBPreArmNoHalf8PartialFraction));
  const remainingValueNet = waveBRemainderValueNetUsd(ot, curMetric);
  const sellFraction = waveBAdjustSellFractionForRemainder(remainingValueNet, trimFrac, cfg);
  const partialPnlPct = cfg.liveOscarWaveBPreArmNoHalf8PartialPnlFrac * 100;
  const r = await tryExecuteTpPartialSell({
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction,
    ladderStepIndex: 0,
    ladderRungsTotal: 0,
    ladderPnlPct: pnlFrac,
    tpGrid: false,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    markLadder: () => {},
    logLabelPct: `wave-b-pre-arm-no-half8-${(trimFrac * 100).toFixed(0)}pct-at-${partialPnlPct.toFixed(1)}pct`,
    partialReason: 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL',
    timelineLabelRu:
      `Live Oscar wave B · pre-arm без +8% TP — фиксация ${(trimFrac * 100).toFixed(0)}% остатка @ +${partialPnlPct.toFixed(1)}% vs avg`,
  });
  if (r === 'ok' || r === 'wallet_zero') {
    ot.liveWavePreArmNoHalf8PartialTaken = true;
  }
}

/** Wave B half8_runner E+2: signal −10% before +8% — lock 50% at +5% vs avg once (replaces half8 +8%). */
async function tryWaveBDip10FirstTp5PartialExit(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  xAvg: number;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
}): Promise<void> {
  const {
    mint,
    ot,
    cfg,
    curMetric,
    xAvg,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
  } = args;
  if (
    !isLiveOscarTradingStrategyId(cfg.strategyId) ||
    !isWaveBExitPolicy(ot) ||
    !(ot.avgEntry > 0) ||
    !(curMetric > 0) ||
    ot.remainingFraction <= 1e-9
  ) {
    return;
  }
  const pnlFrac = xAvg - 1;
  if (!waveBDip10FirstTp5PartialEligible(ot, cfg, pnlFrac)) return;

  const trimFrac = Math.min(0.99, Math.max(0.01, cfg.liveOscarDip10FirstTp5PartialFraction));
  const remainingValueNet = waveBRemainderValueNetUsd(ot, curMetric);
  const sellFraction = waveBAdjustSellFractionForRemainder(remainingValueNet, trimFrac, cfg);
  const partialPnlPct = cfg.liveOscarDip10FirstTp5PartialPnlFrac * 100;
  const r = await tryExecuteTpPartialSell({
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction,
    ladderStepIndex: 0,
    ladderRungsTotal: 0,
    ladderPnlPct: pnlFrac,
    tpGrid: false,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    markLadder: () => {
      waveBOnTpGridRungExecuted(ot, WAVE_B_FLAT_TP_HALF8_RUNNER.gridStepPnl);
    },
    logLabelPct: `wave-b-dip10-first-${(trimFrac * 100).toFixed(0)}pct-at-${partialPnlPct.toFixed(1)}pct`,
    partialReason: 'WAVE_B_DIP10_FIRST_TP5_PARTIAL',
    timelineLabelRu:
      `Live Oscar wave B · −10% до +8% — фиксация ${(trimFrac * 100).toFixed(0)}% остатка @ +${partialPnlPct.toFixed(1)}% vs avg`,
  });
  if (r === 'ok') {
    ot.liveWaveDip10FirstTp5PartialTaken = true;
  }
}

/** Wave B: after first TP partial, peel configured fraction when PnL vs avg falls to deep drawdown. */
async function tryWaveBPostTp1Derisk(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  xAvg: number;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
}): Promise<void> {
  const {
    mint,
    ot,
    cfg,
    curMetric,
    xAvg,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
  } = args;
  if (
    !isLiveOscarTradingStrategyId(cfg.strategyId) ||
    !cfg.liveOscarWaveBPostTp1DeriskEnabled ||
    cfg.liveOscarWaveBPostTp1ScratchReentryEnabled ||
    !isWaveBExitPolicy(ot) ||
    ot.liveWavePostTp1DeriskTaken ||
    ot.remainingFraction <= 1e-9 ||
    !(ot.avgEntry > 0) ||
    !(curMetric > 0)
  ) {
    return;
  }
  const pnlFrac = xAvg - 1;
  const pnlThreshold = cfg.liveOscarWaveBPostTp1DeriskPnlFrac;
  if (pnlFrac > pnlThreshold + LADDER_PNL_EPS) return;
  if (!waveBPostTp1DeriskEligible(ot)) return;

  const trimFrac = Math.min(0.99, Math.max(0.01, cfg.liveOscarWaveBPostTp1DeriskFraction));
  const remainingValueNet = waveBRemainderValueNetUsd(ot, curMetric);
  const sellFraction = waveBAdjustSellFractionForRemainder(remainingValueNet, trimFrac, cfg);
  const r = await tryExecuteTpPartialSell({
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction,
    ladderStepIndex: 0,
    ladderRungsTotal: 0,
    ladderPnlPct: pnlFrac,
    tpGrid: false,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    markLadder: () => {},
    logLabelPct: `wave-b-post-tp1-derisk-${(trimFrac * 100).toFixed(0)}pct-at-${(pnlThreshold * 100).toFixed(0)}pnl`,
    partialReason: 'WAVE_B_POST_TP1_DERISK',
    timelineLabelRu:
      'Live Oscar wave B · после 1-й фиксации TP просадка до ' +
      `${(pnlThreshold * 100).toFixed(0)}% vs avg — de-risk ${(trimFrac * 100).toFixed(0)}% остатка`,
  });
  if (r === 'ok') {
    ot.liveWavePostTp1DeriskTaken = true;
  }
}

async function tryWaveBPostTp1ScratchReentryOpens(args: {
  cfg: PaperTraderConfig;
  open: Map<string, OpenTrade>;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
}): Promise<void> {
  const { cfg, open, journalAppend, journalLiveStrategy, livePhase4 } = args;
  if (!isLiveOscarTradingStrategyId(cfg.strategyId) || !cfg.liveOscarWaveBPostTp1ScratchReentryEnabled) return;

  const now = Date.now();
  for (const pending of listWaveBPostTp1ScratchReentryPending()) {
    const mint = pending.mint;
    if (open.has(mint)) continue;
    if (waveBPostTp1ScratchReentryExpired(cfg, pending, now)) {
      consumeWaveBPostTp1ScratchReentry(mint, journalAppend);
      journalAppend({
        kind: 'eval-skip-open',
        mint,
        symbol: pending.symbol,
        source: pending.source,
        reason: 'wave_b_post_tp1_scratch_reentry_expired',
      });
      continue;
    }

    let curMetric = 0;
    try {
      const quote = await fetchLatestSnapshotQuote(
        mint,
        pending.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
      );
      curMetric = Number(quote.priceUsd ?? 0);
    } catch {
      continue;
    }
    if (!(curMetric > 0)) continue;
    if (!waveBPostTp1ScratchReentryDue(pending, curMetric)) continue;

    const row = {
      mint,
      symbol: pending.symbol,
      ts: new Date(),
      launch_ts: null,
      age_min: 0,
      price_usd: curMetric,
      liquidity_usd: 0,
      volume_5m: 0,
      volume_1h: 0,
      buys_5m: 0,
      sells_5m: 0,
      market_cap_usd: pending.entryMarketCapUsd ?? null,
      source: pending.source ?? 'raydium',
      holder_count: 0,
      token_age_min: 0,
      pair_address: pending.pairAddress ?? null,
    };
    let ot = makeOpenTradeFromEntry({
      cfg,
      row,
      lane: pending.lane,
      dex: pending.dex,
      liquidityUsd: null,
      firstLegUsdOverride: pending.reentryUsd,
    });
    ot.liveStagedEntry = buildLiveStagedEntryState(
      cfg,
      { signalTs: pending.signalTs, signalPriceUsd: pending.signalPriceUsd },
      { marketCapUsd: pending.entryMarketCapUsd },
    );
    if (pending.liveOscarMcapTier) ot.liveOscarMcapTier = pending.liveOscarMcapTier;
    if (pending.tokenDecimals != null) ot.tokenDecimals = pending.tokenDecimals;
    stampLiveOscarExitPolicyOnOpen(ot, cfg);

    journalAppend({
      kind: 'wave_b_post_tp1_scratch_reentry',
      mint,
      symbol: pending.symbol,
      signalPriceUsd: pending.signalPriceUsd,
      reentryDropPct: pending.reentryDropPct,
      reentryUsd: pending.reentryUsd,
      entryPriceUsd: curMetric,
    });

    if (livePhase4) {
      const buyOut = await livePhase4.trySolToTokenBuy({
        mint,
        symbol: pending.symbol,
        usdNotional: pending.reentryUsd,
        intentKind: 'buy_scale_in',
        entryBuySliceEligible: entryBuySliceEligibleForOpen(cfg, ot),
      });
      if (!buyOut.ok) {
        journalLiveStrategy?.({
          kind: 'execution_skip',
          reason: 'wave_b_post_tp1_scratch_reentry_buy_failed',
          detail: mint.slice(0, 12),
        });
        continue;
      }
      applyLiveBuyAnchorsAfterOpen(ot, buyOut);
    }

    open.set(mint, ot);
    consumeWaveBPostTp1ScratchReentry(mint, journalAppend);
    journalAppend({
      kind: 'open',
      mint: ot.mint,
      symbol: ot.symbol,
      lane: ot.lane,
      source: ot.source,
      dex: ot.dex,
      entryTs: ot.entryTs,
      entryMcUsd: ot.entryMcUsd,
      entryMarketPrice: ot.legs[0]?.marketPrice ?? ot.entryMcUsd,
      snapshotEntryPriceUsd: curMetric,
      legs: ot.legs,
      totalInvestedUsd: ot.totalInvestedUsd,
      avgEntry: ot.avgEntry,
      avgEntryMarket: ot.avgEntryMarket,
      pairAddress: ot.pairAddress,
      entryLiqUsd: ot.entryLiqUsd,
      eval_reasons: ['wave_b_post_tp1_scratch_reentry'],
      liveStagedEntry: ot.liveStagedEntry,
      liveExitPolicyId: ot.liveExitPolicyId,
      liveOscarMcapTier: ot.liveOscarMcapTier,
    });
    journalLiveStrategy?.({
      kind: 'live_position_open',
      mint,
      entryPath: 'wave_b_post_tp1_scratch_reentry',
      openTrade: serializeOpenTrade(ot),
    });
    console.log(
      `[WAVE_B_POST_TP1_SCRATCH_REENTRY] ${mint.slice(0, 8)} $${pending.symbol} $${pending.reentryUsd.toFixed(0)} @ ${curMetric.toExponential(4)} (signal ${pending.signalPriceUsd.toExponential(4)})`,
    );
  }
}

/** Variant A v3: scratch flush @0% avg (or gap @ avg) after ≥1 TP; dust flush <$100. */
async function tryVariantAScratchPartialFlush(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  xAvg: number;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
}): Promise<void> {
  const { mint, ot, cfg, curMetric, xAvg, journalAppend, journalLiveStrategy, livePhase4, liveOscarCfg, stats } =
    args;
  if (!isVariantAScratchExitPolicy(ot) || ot.remainingFraction <= 1e-9) return;

  const pnlFrac = xAvg - 1;
  const prev = ot.liveVariantAScratchPrevPnlFrac ?? pnlFrac;
  variantAScratchUpdatePeak(ot, pnlFrac);

  if (variantAScratchHadTp(ot) && !ot.liveVariantAScratchFlushedAtZero) {
    const flush = variantAScratchEvalFlush(ot, cfg, pnlFrac, prev);
    if (flush.kind === 'flush_all') {
      const mtm = flush.useAvgPrice && ot.avgEntry > 0 ? ot.avgEntry : curMetric;
      ot.liveVariantAExitTag = flush.tag;
      ot.liveVariantAScratchFlushedAtZero = true;
      const partialReason = flush.tag === 'scratch_gap_flush' ? 'SCRATCH_GAP_FLUSH' : 'SCRATCH_FLUSH0';
      await tryExecuteTpPartialSell({
        mint,
        ot,
        cfg,
        curMetric: mtm,
        sellFraction: 1,
        ladderStepIndex: 0,
        ladderRungsTotal: 0,
        ladderPnlPct: flush.useAvgPrice ? 0 : pnlFrac,
        tpGrid: false,
        journalAppend,
        journalLiveStrategy,
        livePhase4,
        liveOscarCfg,
        stats,
        markLadder: () => {},
        logLabelPct: flush.tag,
        partialReason,
        timelineLabelRu: flush.timelineLabelRu,
      });
    }
  }

  ot.liveVariantAScratchPrevPnlFrac = pnlFrac;

  if (ot.remainingFraction <= 1e-9) return;
  const invRem = ot.totalInvestedUsd * ot.remainingFraction;
  const remUsd = invRem * (curMetric / ot.avgEntry);
  if (remUsd > 0 && remUsd < variantAScratchDustFlushRemainUsd()) {
    await tryExecuteTpPartialSell({
      mint,
      ot,
      cfg,
      curMetric,
      sellFraction: 1,
      ladderStepIndex: 0,
      ladderRungsTotal: 0,
      ladderPnlPct: pnlFrac,
      tpGrid: false,
      journalAppend,
      journalLiveStrategy,
      livePhase4,
      liveOscarCfg,
      stats,
      markLadder: () => {},
      logLabelPct: 'SCRATCH_DUST_FLUSH',
      partialReason: 'SCRATCH_FLUSH0',
      timelineLabelRu: `Live Oscar scratch · остаток < $${variantAScratchDustFlushRemainUsd()} — полное закрытие хвоста`,
    });
  }
}

/** Variant A v2: thin market after first TP → flush remainder (`thin_combo_peak`). */
async function tryVariantAHybridThinVolFlush(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  xAvg: number;
  vol5mUsd: number | null;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
}): Promise<void> {
  const { mint, ot, cfg, curMetric, xAvg, vol5mUsd, journalAppend, journalLiveStrategy, livePhase4, liveOscarCfg, stats } =
    args;
  if (!isVariantAHybridExitPolicy(ot) || ot.remainingFraction <= 1e-9) return;
  const pnlFrac = xAvg - 1;
  if (!variantAHybridThinVolFlushReady(ot, cfg, pnlFrac, vol5mUsd)) return;

  ot.liveThinVolFlushDone = true;
  const v5 = vol5mUsd ?? 0;
  const entryV5 = ot.liveThinVolEntryVol5mUsd ?? 0;
  await tryExecuteTpPartialSell({
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction: 1,
    ladderStepIndex: 0,
    ladderRungsTotal: 0,
    ladderPnlPct: pnlFrac,
    tpGrid: false,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    markLadder: () => {},
    logLabelPct: `thin-vol-flush+${(pnlFrac * 100).toFixed(1)}%`,
    partialReason: 'THIN_VOL_FLUSH',
    timelineLabelRu:
      'Live Oscar · после TP объём высох (vol5m < $20k и <50% от входа, 2 тика) — ' +
      `пик ≥ +8%, сейчас +${(pnlFrac * 100).toFixed(1)}% — полное закрытие остатка ` +
      `(vol5m=$${Math.round(v5).toLocaleString()}, entry vol5m=$${Math.round(entryV5).toLocaleString()})`,
  });
}

function afterFullCloseReentryGate(
  args: Pick<TrackerArgs, 'onMintFullClose'>,
  cfg: PaperTraderConfig,
  ct: ClosedTrade,
  openTrade?: OpenTrade,
): void {
  recordAfterFullCloseForMintRepeatGateFromClosedTrade(
    cfg,
    ct,
    openTrade ? { openTrade } : undefined,
  );
  markPresetCTelegramGateConsumedOnFullClose(cfg.strategyId, openTrade);
  args.onMintFullClose?.(ct.mint, openTrade);
}

function hookLiveWhitelistAfterFullClose(
  liveOscarCfg: LiveOscarConfig | undefined,
  cfg: PaperTraderConfig,
  mint: string,
  symbol: string,
  netPnlUsd: number,
  liveMintFirstProbe?: boolean,
  firstMintKillDropPct?: number,
  variantAExitTag?: OpenTrade['liveVariantAExitTag'],
  ot?: OpenTrade,
  exitRefPriceUsd?: number,
): void {
  onLiveOscarFullCloseUpdateWhitelistLossStreak({
    liveOscarCfg,
    strategyId: cfg.strategyId,
    mint,
    symbol,
    netPnlUsd,
  });
  onLiveOscarFirstMintProbeFullClose({
    liveOscarCfg,
    strategyId: cfg.strategyId,
    mint,
    symbol,
    netPnlUsd,
    liveMintFirstProbe: liveMintFirstProbe === true,
    killDropPct: firstMintKillDropPct,
  });
  onLiveOscarFullCloseNegativeTradeDenylist({
    liveOscarCfg,
    strategyId: cfg.strategyId,
    mint,
    symbol,
    netPnlUsd,
  });
  recordMintTimedLossCooldown(mint, variantAExitTag);
  if (ot && isVariantAScratchExitPolicy(ot) && exitRefPriceUsd != null && exitRefPriceUsd > 0) {
    recordMintScratchReentry(mint, exitRefPriceUsd);
  }
}

/** Infer policy exit when chain is empty but journal missed partials (avoid PERIODIC_HEAL mis-tag). */
function inferWalletZeroPolicyExitReason(ot: OpenTrade): ExitReason | undefined {
  if (ot.trailingArmed) return 'TRAIL';
  if ((ot.liveWaveTrailAnchorPnlFrac ?? 0) > 0) return 'TRAIL';
  if (ot.liveWavePreArmReached) return 'TRAIL';
  if ((ot.liveWaveMaxExecutedTpFrac ?? 0) > 0) return 'TP';
  return undefined;
}

/**
 * Live: wallet SPL=0 while journal still open — close with last policy partial reason (TP/TRAIL/KILL),
 * never RECONCILE_ORPHAN. If no recorded partials, alert and keep open for policy retry.
 */
async function closeOpenTradeWalletZeroPolicySync(args: {
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
  onMintFullClose?: TrackerArgs['onMintFullClose'];
  /** When wallet SPL=0 during a policy exit attempt with no journaled partials yet. */
  forcedExitReason?: ExitReason;
}): Promise<boolean> {
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
    forcedExitReason,
  } = args;

  if (isOscarHandoffClosedMint(mint)) return false;

  if (verifyReconcileOrphanWalletZero) {
    let allow: boolean;
    try {
      allow = await verifyReconcileOrphanWalletZero(mint);
    } catch {
      allow = false;
    }
    if (!allow) return false;
  }

  if (ot.partialSells.length === 0) {
    let exitReason = forcedExitReason;
    if (!exitReason) {
      exitReason = inferWalletZeroPolicyExitReason(ot);
    }
    if (!exitReason) {
      const ageMs = Date.now() - (ot.entryTs > 0 ? ot.entryTs : 0);
      const graceMs = 120_000;
      if (ageMs >= graceMs) {
        exitReason = 'PERIODIC_HEAL';
        log.warn(
          {
            mint: mint.slice(0, 8),
            symbol: ot.symbol,
            investedUsd: ot.totalInvestedUsd,
            ageSec: +(ageMs / 1000).toFixed(0),
          },
          'live wallet SPL=0, journal open without partials — hygiene close (PERIODIC_HEAL, not RECONCILE_ORPHAN)',
        );
      } else {
        journalLiveStrategy?.({
          kind: 'risk_note',
          reason: 'wallet_zero_open_no_policy_exit',
          mint,
          detail: {
            symbol: ot.symbol,
            investedUsd: ot.totalInvestedUsd,
            remainingFraction: ot.remainingFraction,
            ageSec: +(ageMs / 1000).toFixed(0),
            graceSec: graceMs / 1000,
          },
        });
        log.error(
          { mint: mint.slice(0, 8), symbol: ot.symbol, investedUsd: ot.totalInvestedUsd },
          'live wallet SPL=0 but journal open with no policy partials — waiting grace before hygiene close',
        );
        return false;
      }
    }
    const marketSell =
      ot.lastObservedPriceUsd ?? ot.avgEntryMarket ?? ot.avgEntry;
    if (!(marketSell > 0)) return false;
    const ageH = (Date.now() - ot.entryTs) / 3_600_000;
    const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
    const perTxNd = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
    const ct = buildClosedTrade({
      cfg,
      ot,
      marketSell,
      effectiveSell: marketSell,
      exitReason,
      ageH,
      networkFeeUsdPerTx: perTxNd,
    });
    const xAvg = ot.avgEntry > 0 && marketSell > 0 ? marketSell / ot.avgEntry : 0;
    const exitCtx = buildExitContext({
      cfg,
      ot,
      closePnlPct: ct.pnlPct,
      ageH,
      exitReason,
      curMetric: marketSell,
      xAvg,
      tpLadder,
    });
    ct.exitContext = exitCtx;
    clearExitCloseDeferForMint(mint);
    clearExitPartialDeferForMint(mint);
    open.delete(mint);
    closed.push(ct);
    const statKey: ExitReason = exitReason === 'KILLSTOP' ? 'SL' : exitReason;
    if (stats.closed[statKey] != null) stats.closed[statKey]++;
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
      walletZeroForcedExit: true,
      forcedExitReason: exitReason,
      ...(liqWatchStamp ? { liqWatch: liqWatchStamp } : {}),
    });
    journalLiveStrategy?.({
      kind: 'live_position_close',
      mint,
      closedTrade: serializeClosedTrade(ct),
    });
    afterFullCloseReentryGate(args, cfg, ct, ot);
    if (exitReason === 'PERIODIC_HEAL' && liveOscarCfg) {
      recordPostHealChurnBlock(mint, liveOscarCfg);
    }
    hookLiveWhitelistAfterFullClose(
      liveOscarCfg,
      cfg,
      mint,
      ot.symbol,
      ct.netPnlUsd,
      ot.liveMintFirstProbe === true,
      ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
      ot.liveVariantAExitTag,
      ot,
      ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
    );
    scheduleTailAfterLiveClose(
      liveOscarCfg,
      mint,
      ot.symbol,
      ot.tokenDecimals ?? 6,
      marketSell,
      ot.source,
      ct.exitReason,
    );
    peakStateByMint.delete(mint);
    return true;
  }

  const lastPartial = ot.partialSells[ot.partialSells.length - 1]!;
  const exitReason = partialReasonToExitReason(lastPartial.reason);
  const marketSell =
    lastPartial.marketPrice > 0
      ? lastPartial.marketPrice
      : ot.lastObservedPriceUsd ?? ot.avgEntryMarket ?? ot.avgEntry;
  const ageH = (Date.now() - ot.entryTs) / 3_600_000;
  const pfClose = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
  const perTxNd = pfClose.usd > 0 ? pfClose.usd : cfg.networkFeeUsd;
  const ct = buildClosedTrade({
    cfg,
    ot,
    marketSell,
    effectiveSell: lastPartial.price > 0 ? lastPartial.price : marketSell,
    exitReason,
    ageH,
    networkFeeUsdPerTx: perTxNd,
  });
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
  if (lastPartial.price > 0) {
    ct.effective_exit_price = lastPartial.price;
  }
  ct.theoretical_exit_price = marketSell;
  ct.exitMcUsd = marketSell > 0 ? marketSell : 0;
  ct.costs = buildCloseCosts({
    cfg,
    trade: ot,
    exit: { effectivePrice: ct.effective_exit_price, marketPrice: marketSell },
    networkFeeUsdTotal: 0,
    slipDynamicBpsEntry: 0,
    slipDynamicBpsExit: 0,
    netPnlUsd: ct.netPnlUsd,
    grossPnlUsd: ct.grossPnlUsd,
  });
  const xAvg = ot.avgEntry > 0 && marketSell > 0 ? marketSell / ot.avgEntry : 0;
  const exitCtx = buildExitContext({
    cfg,
    ot,
    closePnlPct: ct.pnlPct,
    ageH,
    exitReason,
    curMetric: marketSell,
    xAvg,
    tpLadder,
  });
  ct.exitContext = exitCtx;
  clearExitCloseDeferForMint(mint);
  clearExitPartialDeferForMint(mint);
  open.delete(mint);
  closed.push(ct);
  const statKey: ExitReason =
    exitReason === 'KILLSTOP' ? 'SL' : exitReason === 'FLASH_CRASH_KILL' ? exitReason : exitReason;
  if (stats.closed[statKey] != null) stats.closed[statKey]++;
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
    walletZeroPolicySync: true,
    lastPartialReason: lastPartial.reason,
    ...(liqWatchStamp ? { liqWatch: liqWatchStamp } : {}),
  });
  journalLiveStrategy?.({
    kind: 'live_position_close',
    mint,
    closedTrade: serializeClosedTrade(ct),
  });
  afterFullCloseReentryGate(args, cfg, ct, ot);
  hookLiveWhitelistAfterFullClose(
    liveOscarCfg,
    cfg,
    mint,
    ot.symbol,
    ct.netPnlUsd,
    ot.liveMintFirstProbe === true,
    ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
    ot.liveVariantAExitTag,
    ot,
    ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
  );
  scheduleTailAfterLiveClose(
    liveOscarCfg,
    mint,
    ot.symbol,
    ot.tokenDecimals ?? 6,
    marketSell,
    ot.source,
    ct.exitReason,
  );
  peakStateByMint.delete(mint);
  console.log(
    `[${exitReason}] ${mint.slice(0, 8)} $${ot.symbol} wallet-zero sync (last partial ${lastPartial.reason})`,
  );
  return true;
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
  onMintFullClose?: TrackerArgs['onMintFullClose'];
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
  afterFullCloseReentryGate(args, cfg, ct, ot);
  hookLiveWhitelistAfterFullClose(
    liveOscarCfg,
    cfg,
    mint,
    ot.symbol,
    ct.netPnlUsd,
    ot.liveMintFirstProbe === true,
    ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
    ot.liveVariantAExitTag,
    ot,
    ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
  );
  /** Не планируем post-close tail sweep: закрытие уже из-за рассинхрона с цепью; через `livePostCloseTailSweepDelayMs`
   * отложенный `sell_full` может снять **новую** позицию по тому же mint (см. отмену при `live_position_open`). */
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
  onMintFullClose?: TrackerArgs['onMintFullClose'];
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
  afterFullCloseReentryGate({ onMintFullClose: args.onMintFullClose }, cfg, ct);
  hookLiveWhitelistAfterFullClose(
    liveOscarCfg,
    cfg,
    mint,
    ot.symbol,
    ct.netPnlUsd,
    ot.liveMintFirstProbe === true,
    ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
    ot.liveVariantAExitTag,
    ot,
    ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
  );
  scheduleTailAfterLiveClose(
    liveOscarCfg,
    mint,
    ot.symbol,
    ot.tokenDecimals ?? 6,
    marketSell,
    ot.source,
    'CAPITAL_ROTATE',
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
  onMintFullClose?: TrackerArgs['onMintFullClose'];
  mint: string;
  marketSell: number;
  /** Exit reason to record (default `PERIODIC_HEAL`). Callers like mem-swan pass a policy-allowed reason. */
  exitReason?: ExitReason;
  /** When true, skip the LIVE_POLICY_ONLY_EXITS guard (defensive regime liquidation). */
  bypassPolicyBlock?: boolean;
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
  const reason: ExitReason = args.exitReason ?? 'PERIODIC_HEAL';
  const ot = open.get(mint);
  if (!ot || !(marketSell > 0)) return false;
  if (!livePhase4) return false;
  if (!args.bypassPolicyBlock && livePolicyBlocksHealSyncSells(args.liveOscarCfg)) {
    log.warn(
      { mint: mint.slice(0, 8), symbol: ot.symbol },
      'trackerForceFullExitLive blocked (LIVE_POLICY_ONLY_EXITS — no PERIODIC_HEAL on-chain sell)',
    );
    return false;
  }

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
    exitReason: reason,
    ageH,
    networkFeeUsdPerTx: perTxClose,
  });
  const xAvg = marketSell / ot.avgEntry;

  const okSell = await livePhase4.tryTokenToSolSell({
    mint,
    symbol: ot.symbol,
    usdNotional: usdForSell,
    priceUsdPerToken: marketSell,
    referencePriceUsd: liveSellReferencePriceUsd(ot),
    decimals: ot.tokenDecimals ?? 6,
    intentKind: 'sell_full',
    emergencyExit: args.bypassPolicyBlock === true,
  });
  if (!okSell.ok) return false;

  applyLiveFullCloseProceedsFromChain({
    ct,
    ot,
    cfg,
    sellOut: okSell,
    marketSell,
    networkFeeUsdPerTx: perTxClose,
  });
  stampFullExitTxSignature(ct, okSell);
  const exitContextMain = buildExitContext({
    cfg,
    ot,
    closePnlPct: ct.pnlPct,
    ageH,
    exitReason: reason,
    curMetric: marketSell,
    xAvg,
    tpLadder,
  });
  ct.exitContext = exitContextMain;

  clearExitCloseDeferForMint(mint);
  clearExitPartialDeferForMint(mint);
  open.delete(mint);
  closed.push(ct);
  if (stats.closed[reason] != null) stats.closed[reason]++;
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
    exit_effective_price: ct.effective_exit_price,
    exit_swaps: exitSwaps,
    mcUsdLive: mcUsdLive_close,
    priorityFee: pfClose,
    exitContext: exitContextMain,
    ...(reason === 'PERIODIC_HEAL' ? { periodicHeal: true } : {}),
    ...(liqWatchExit ? { liqWatch: liqWatchExit } : {}),
  });
  journalLiveStrategy?.({
    kind: 'live_position_close',
    mint,
    closedTrade: serializeClosedTrade(ct),
  });
  afterFullCloseReentryGate({ onMintFullClose: args.onMintFullClose }, cfg, ct);
  hookLiveWhitelistAfterFullClose(
    liveOscarCfg,
    cfg,
    mint,
    ot.symbol,
    ct.netPnlUsd,
    ot.liveMintFirstProbe === true,
    ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
    ot.liveVariantAExitTag,
    ot,
    ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
  );
  scheduleTailAfterLiveClose(
    liveOscarCfg,
    mint,
    ot.symbol,
    ot.tokenDecimals ?? 6,
    marketSell,
    ot.source,
    reason,
  );
  peakStateByMint.delete(mint);
  console.log(
    `[${reason}] ${mint.slice(0, 8)} $${ot.symbol} pnl_net=${ct.pnlPct >= 0 ? '+' : ''}${ct.pnlPct.toFixed(1)}% age=${ageH.toFixed(1)}h`,
  );
  return true;
}

async function tryPresetCScalpPartialExit(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  open: Map<string, OpenTrade>;
  closed: ClosedTrade[];
  tpLadder: TpLadderLevel[];
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
  stats: TrackerStats;
  btcCtx: TrackerArgs['btcCtx'];
  verifyReconcileOrphanWalletZero?: TrackerArgs['verifyReconcileOrphanWalletZero'];
  onMintFullClose?: TrackerArgs['onMintFullClose'];
}): Promise<'partial' | 'none'> {
  const {
    mint,
    ot,
    cfg,
    curMetric,
    open,
    closed,
    tpLadder,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    btcCtx,
    verifyReconcileOrphanWalletZero,
    onMintFullClose,
  } = args;
  if (!isPresetCScalpExitPolicy(ot) || !(curMetric > 0) || ot.remainingFraction <= 1e-6) return 'none';

  const action = evaluatePresetCScalpExitAction(ot, cfg, curMetric);
  if (action.kind !== 'partial') return 'none';

  const r = await tryExecuteTpPartialSell({
    mint,
    ot,
    cfg,
    curMetric,
    sellFraction: action.sellFraction,
    ladderStepIndex: 0,
    ladderRungsTotal: 0,
    ladderPnlPct: 0,
    tpGrid: true,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
    stats,
    markLadder: action.mark,
    logLabelPct: action.label,
    timelineLabelRu: action.label,
  });
  if (r === 'wallet_zero') {
    const forcedExitReason: ExitReason = action.label.toLowerCase().includes('trail') ? 'TRAIL' : 'TP';
    await closeOpenTradeWalletZeroPolicySync({
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
      onMintFullClose,
      forcedExitReason,
    });
    return 'partial';
  }
  return r === 'ok' ? 'partial' : 'none';
}

async function tryPresetCScalpDcaLeg(args: {
  mint: string;
  ot: OpenTrade;
  cfg: PaperTraderConfig;
  curMetric: number;
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  livePhase4?: LiveOscarPhase4Tracker;
  liveOscarCfg?: LiveOscarConfig;
}): Promise<void> {
  const { mint, ot, cfg, curMetric, journalAppend, journalLiveStrategy, livePhase4 } = args;
  if (!isPresetCScalpExitPolicy(ot)) return;

  const scalp = loadPresetCScalpConfig();

  type ScalpDcaSpec = {
    due: boolean;
    addUsd: number;
    dropPct: number;
    reason: string;
    logTag: string;
    markDone: () => void;
  };

  const legs: ScalpDcaSpec[] = [
    {
      due: !ot.presetCScalpDcaLegDone && presetCScalpDcaDue(ot, curMetric, scalp),
      addUsd: scalp.dcaUsd,
      dropPct: scalp.dcaDropPct,
      reason: 'preset_c_scalp_dca',
      logTag: 'PRESET_C_SCALP_DCA',
      markDone: () => {
        ot.presetCScalpDcaLegDone = true;
      },
    },
    {
      due: !ot.presetCScalpDca2LegDone && presetCScalpDca2Due(ot, curMetric, scalp),
      addUsd: scalp.dca2Usd,
      dropPct: scalp.dca2DropPct,
      reason: 'preset_c_scalp_dca2',
      logTag: 'PRESET_C_SCALP_DCA2',
      markDone: () => {
        ot.presetCScalpDca2LegDone = true;
      },
    },
  ];

  for (const leg of legs) {
    if (!leg.due || !(leg.addUsd > 0)) continue;

    let dcaBuyRes: LiveBuyPipelineResult | undefined;
    if (livePhase4) {
      dcaBuyRes = await livePhase4.trySolToTokenBuy({
        mint,
        symbol: ot.symbol,
        usdNotional: leg.addUsd,
        entryBuySliceEligible: entryBuySliceEligibleForOpen(cfg, ot),
        positionCeilingUsd: resolveLiveOscarPositionCeilingUsd(cfg, ot),
        tokenDecimals: ot.tokenDecimals,
        dexSource: ot.source,
      });
      if (!dcaBuyRes.ok) return;
    }

    const addUsd = leg.addUsd;
    const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, curMetric, ot.dex, addUsd, null);
    ot.legs.push({
      ts: Date.now(),
      price: effectiveBuy,
      marketPrice: curMetric,
      sizeUsd: addUsd,
      reason: 'dca',
      triggerPct: -leg.dropPct / 100,
    });
    leg.markDone();
    ot.totalInvestedUsd += addUsd;
    const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
    ot.avgEntry = num / ot.totalInvestedUsd;
    const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
    ot.avgEntryMarket = numM / ot.totalInvestedUsd;
    ot.remainingFraction = 1;
    if (livePhase4 && dcaBuyRes) {
      appendLiveBuyAnchorsAfterDca(ot, dcaBuyRes);
    }
    if (cfg.liqWatchEnabled) {
      await refreshOpenTradeEntryLiqAfterDca(ot, cfg);
    }
    journalAppend({
      kind: 'dca_add',
      mint,
      ts: Date.now(),
      price: effectiveBuy,
      marketPrice: curMetric,
      sizeUsd: addUsd,
      reason: leg.reason,
      timelineLabelRu: `Preset C scalp DCA $${addUsd.toFixed(0)} @ −${leg.dropPct}% от сигнала`,
    });
    journalLiveStrategy?.({
      kind: 'live_position_dca',
      mint,
      openTrade: serializeOpenTrade(ot),
      timelineLabelRu: `Preset C scalp DCA −${leg.dropPct}%`,
    });
    console.log(
      `[${leg.logTag}] ${mint.slice(0, 8)} $${ot.symbol} +$${addUsd.toFixed(0)} @ −${leg.dropPct}% signal`,
    );
    return;
  }
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
    for (const [openKey, ot] of open.entries()) {
      const m = mintFromOpenMapKey(openKey);
      if (!oz.has(m) && !oz.has(openKey)) continue;
      if (graceMs > 0 && ot.entryTs > 0 && nowOrphan - ot.entryTs < graceMs) continue;
      if (isOscarHandoffClosedMint(m)) continue;
        const liveWalletZeroPolicy =
          liveOscarCfg?.strategyEnabled &&
          (liveOscarCfg.executionMode === 'live' || liveOscarCfg.executionMode === 'simulate');
      if (liveWalletZeroPolicy) {
        const synced = await closeOpenTradeWalletZeroPolicySync({
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
          onMintFullClose: args.onMintFullClose,
        });
        if (synced) reconciledOrphans += 1;
      } else {
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
          onMintFullClose: args.onMintFullClose,
        });
        reconciledOrphans += 1;
      }
    }
  }

  if (args.processPresetCScalpDeferredEntries) {
    await args.processPresetCScalpDeferredEntries();
  }

  // Black-swan liquidation sweeps (rising edge → force-close every open position, once per
  // episode; cheap no-op otherwise). Two independent detectors:
  //   1. mem-swan: external top-N runner index over PG snapshots (market-wide swan).
  //   2. mem-swan-portfolio: OUR own open book's equal-weight drawdown (fires when our capital
  //      is bleeding hard; independent of the PG runner universe / collector health). Uses marks
  //      collected during the *previous* tick's loop.
  if (liveOscarCfg?.executionMode === 'live' && (liveOscarCfg.liveMemSwanEnabled || liveOscarCfg.liveMemSwanPortEnabled)) {
    const forceExitLive = async (openKey: string, marketSell: number): Promise<boolean> =>
      trackerForceFullExitLive({
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
        onMintFullClose: args.onMintFullClose,
        mint: openKey,
        marketSell,
        exitReason: 'KILLSTOP',
        bypassPolicyBlock: true,
      });
    if (liveOscarCfg.liveMemSwanEnabled) {
      await runMemSwanLiquidationSweep({ liveCfg: liveOscarCfg, open, forceExitLive });
    }
    if (liveOscarCfg.liveMemSwanPortEnabled) {
      await runMemSwanPortfolioSweep({ liveCfg: liveOscarCfg, open, forceExitLive });
    }
  }

  if (open.size === 0) {
    await tryWaveBPostTp1ScratchReentryOpens({
      cfg,
      open,
      journalAppend,
      journalLiveStrategy,
      livePhase4,
      liveOscarCfg,
    });
    return;
  }

  const liveWalletReconcileActive =
    liveOscarCfg?.strategyEnabled &&
    (liveOscarCfg.executionMode === 'live' || liveOscarCfg.executionMode === 'simulate');
  const liveChainMap = liveWalletReconcileActive
    ? await fetchLiveWalletSplBalancesByMint(liveOscarCfg!)
    : null;

  const mints = [...open.keys()];

  for (const openKey of mints) {
    const ot = open.get(openKey);
    if (!ot) continue;
    /** Composite open-map key (`mint::runner_probe`) — bare mint for PG/Jupiter/journal. */
    const mint = mintFromOpenMapKey(openKey);
    if (isRunnerProbeExitPolicy(ot)) stampRunnerProbeExitPolicyOnOpen(ot, cfg);
    if (isRunnerLiteTrade(ot)) stampRunnerLiteExitPolicyOnOpen(ot, cfg);
    resolveLiveOscarExitPolicyForTick(ot, cfg);
    let effCfg = cfgEffectiveForOpen(cfg, ot);
    const tradeDcaLevels =
      isLiveOscarScalpWaveTrade(ot)
        ? []
        : isRunnerLiteTrade(ot)
          ? parseDcaLevels(runnerLiteDcaLevelsSpec(cfg))
          : isRunnerProbeTrade(ot)
            ? parseDcaLevels(runnerProbeDcaLevelsSpec(cfg))
            : ot.liveOscarMcapTier === 'low' || ot.liveOscarMcapTier === 'micro'
              ? parseDcaLevels(liveOscarTierDcaLevelsSpec(cfg, ot.liveOscarMcapTier))
              : dcaLevels;
    if (ot.liveOscarMcapTier === 'low') {
      effCfg = { ...effCfg, positionUsd: cfg.liveOscarLowMcapPositionUsd };
    } else if (ot.liveOscarMcapTier === 'micro') {
      effCfg = { ...effCfg, positionUsd: cfg.liveOscarMicroMcapPositionUsd };
    } else if (isLiveOscarScalpWaveTrade(ot)) {
      effCfg = { ...effCfg, positionUsd: cfg.liveOscarScalpWavePositionUsd };
    } else if (isRunnerProbeTrade(ot)) {
      effCfg = { ...effCfg, positionUsd: cfg.runnerProbePositionUsd };
    } else if (isRunnerLiteTrade(ot)) {
      effCfg = { ...effCfg, positionUsd: cfg.runnerLitePositionUsd };
    }

    /** Старые журналы/live-снимки ставили A на открытии; для live-oscar сплит ≠ DCA — сбрасываем до «не назначен». */
    if (
      isLiveOscarTradingStrategyId(cfg.strategyId) &&
      cfg.liveExitModeAbEnabled &&
      ot.liveExitProfileMode === 'A' &&
      ot.partialSells.length === 0 &&
      ot.dcaUsedIndices.size === 0 &&
      ot.dcaUsedLevels.size === 0 &&
      ot.legs.length > 0 &&
      ot.legs.every((l) => l.reason === 'open' || l.reason === 'scale_in')
    ) {
      ot.liveExitProfileMode = undefined;
    }

    let snapPx = 0;
    let snapVol5m: number | null = null;
    let snapTsMs: number | null = null;
    try {
      const quote = await fetchLatestSnapshotQuote(
        mint,
        ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
      );
      snapPx = Number(quote.priceUsd ?? 0);
      snapVol5m = quote.volume5mUsd;
      snapTsMs = quote.snapshotTsMs ?? null;
    } catch (err) {
      console.warn(`tracker fetch failed for ${mint}: ${(err as Error).message}`);
    }

    /** Birdeye REST primary for MTM baseline: Birdeye → DexScreener → PG before Jupiter probe. */
    if (cfg.birdeyePrimaryEnabled && isLiveOscarTradingStrategyId(cfg.strategyId)) {
      const pgRow: SnapshotCandidateRow = {
        mint,
        symbol: ot.symbol ?? mint.slice(0, 8),
        ts: snapTsMs != null ? new Date(snapTsMs) : new Date(),
        launch_ts: null,
        age_min: null,
        price_usd: snapPx > 0 ? snapPx : 0,
        liquidity_usd: 0,
        volume_5m: snapVol5m ?? 0,
        volume_1h: 0,
        buys_5m: 0,
        sells_5m: 0,
        market_cap_usd: null,
        source: ot.source ?? 'pumpswap',
        holder_count: 0,
        token_age_min: 0,
        pair_address: ot.pairAddress ?? null,
      };
      const mtmQuote = await resolveDiscoveryMarketQuote({
        enabled: true,
        mint,
        pgRow,
        birdeyeTtlMs: cfg.birdeyeMarketTtlMs,
        birdeyeMaxStaleMs: cfg.birdeyeMaxStaleMs,
        coverageGapMinMs: cfg.birdeyeCoverageGapMinMs,
      });
      if (mtmQuote.birdeyeTierInsufficient) {
        const tierEv = buildBirdeyeTierInsufficientEvent({
          mint,
          lane: 'mtm',
          errorKind: mtmQuote.birdeyeErrorKind,
        });
        journalAppend(tierEv);
        journalLiveStrategy?.(tierEv);
        notifyBirdeyeTierInsufficient({
          mint,
          lane: 'mtm',
          errorKind: mtmQuote.birdeyeErrorKind,
          surface: 'mtm',
        });
      }
      if (
        mtmQuote.coverageGap &&
        mtmQuote.pgSnapshotAgeMs != null &&
        mtmQuote.pgSnapshotAgeMs > cfg.birdeyeCoverageGapMinMs
      ) {
        const gapEv = buildBirdeyeCoverageGapEvent({
          mint,
          lane: 'mtm',
          pgSnapshotAgeMs: mtmQuote.pgSnapshotAgeMs,
          coverageGapMinMs: cfg.birdeyeCoverageGapMinMs,
          source: mtmQuote.source,
        });
        journalAppend(gapEv);
        journalLiveStrategy?.(gapEv);
        notifyBirdeyeCoverageGap({
          mint,
          lane: 'mtm',
          pgSnapshotAgeMs: mtmQuote.pgSnapshotAgeMs,
          coverageGapMinMs: cfg.birdeyeCoverageGapMinMs,
          resolvedSource: mtmQuote.source,
          surface: 'mtm',
        });
      }
      if (mtmQuote.source !== 'pg_snapshot' && mtmQuote.priceUsd != null && mtmQuote.priceUsd > 0) {
        journalAppend({
          kind: 'live_birdeye_market_quote',
          mint,
          lane: 'mtm',
          source: mtmQuote.source,
          pgPriceUsd: snapPx > 0 ? snapPx : null,
          pgMcapUsd: null,
          pgLiqUsd: null,
          pgVol5mUsd: snapVol5m,
          pgSnapshotAgeMs: mtmQuote.pgSnapshotAgeMs,
          quotePriceUsd: mtmQuote.priceUsd,
          quoteMcapUsd: mtmQuote.marketCapUsd,
          quoteLiqUsd: mtmQuote.liquidityUsd,
          quoteVol5mUsd: mtmQuote.volume5mUsd,
        });
        journalLiveStrategy?.({
          kind: 'live_birdeye_market_quote',
          mint,
          lane: 'mtm',
          source: mtmQuote.source,
          pgPriceUsd: snapPx > 0 ? snapPx : null,
          pgMcapUsd: null,
          pgLiqUsd: null,
          pgVol5mUsd: snapVol5m,
          pgSnapshotAgeMs: mtmQuote.pgSnapshotAgeMs,
          quotePriceUsd: mtmQuote.priceUsd,
          quoteMcapUsd: mtmQuote.marketCapUsd,
          quoteLiqUsd: mtmQuote.liquidityUsd,
          quoteVol5mUsd: mtmQuote.volume5mUsd,
        });
        snapPx = mtmQuote.priceUsd;
        if (mtmQuote.volume5mUsd != null && mtmQuote.volume5mUsd > 0) {
          snapVol5m = mtmQuote.volume5mUsd;
        }
      }
    }

    /**
     * Shyft primary MTM: snapshot stream at tick start. Jupiter buy-probe can take >5s; using
     * `Date.now()` after the probe makes a fresh stream look stale vs `SHYFT_MAX_STALE_MS` and
     * falls back to PG ghost (NEST 2026-07-03 wave_b instant TP).
     */
    let shyftPrimaryTickMs: number | null = null;
    let shyftPrimaryStreamAtTick: ReturnType<typeof getShyftShadowStreamPrice> = null;
    if (
      cfg.shyftPricePrimaryEnabled &&
      cfg.shyftPricePrimaryMtmEnabled &&
      isLiveOscarFamilyTradingStrategyId(cfg.strategyId) &&
      isShyftShadowEnabled()
    ) {
      shyftPrimaryTickMs = Date.now();
      shyftPrimaryStreamAtTick = getShyftShadowStreamPrice(mint, shyftPrimaryTickMs);
    }
    // Stage 1.1 shadow (observability only, default OFF): pair the PG MTM price with the freshest Shyft
    // stream price to measure PG lag. NEVER influences any exit/MTM decision below.
    if (cfg.liveOscarShyftShadowEnabled && isLiveOscarTradingStrategyId(cfg.strategyId) && isShyftShadowEnabled()) {
      const nowShadow = Date.now();
      const streamShadow = getShyftShadowStreamPrice(mint, nowShadow);
      if (streamShadow) {
        const shadowEvent = buildShadowPriceEvent({
          mint,
          lane: 'mtm',
          surface: 'mtm',
          streamPriceUsd: streamShadow.priceUsd,
          pgPriceUsd: snapPx > 0 ? snapPx : null,
          streamTsMs: streamShadow.streamTsMs,
          pgSnapshotTsMs: snapTsMs,
          streamSlot: streamShadow.slot,
          nowMs: nowShadow,
        });
        journalAppend(shadowEvent);
        journalLiveStrategy?.(shadowEvent);
        void buildShyftVsDexQuoteObservation({
          mint,
          lane: 'mtm',
          surface: 'mtm',
          stream: streamShadow,
          prodPriceUsd: snapPx > 0 ? snapPx : null,
          prodMcapUsd: null,
          prodLiqUsd: null,
          defiTtlMs: cfg.shyftDefiMcapTtlMs,
          nowMs: nowShadow,
        })
          .then((vsDex) => {
            if (!vsDex) return;
            journalAppend(vsDex);
            journalLiveStrategy?.(vsDex);
          })
          .catch(() => {
            /* observability only */
          });
      }
    }
    let curMetric = snapPx > 0 ? snapPx : 0;
    let ghostExitTick = false;
    let entrySplitJupiterPx: number | undefined;
    let chainOscarUsdForMint = 0;
    if (liveChainMap && snapPx > 0) {
      const wrEarly = reconcileOpenPositionWalletBalance({
        liveCfg: liveOscarCfg,
        ot,
        mint,
        chainMap: liveChainMap,
        priceUsd: snapPx,
      });
      chainOscarUsdForMint = wrEarly?.chainOscarUsd ?? 0;
    }

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
      const remUsd = Math.max(
        ot.totalInvestedUsd * 0.05,
        planFullExitUsdNotional({ ot, chainOscarUsd: chainOscarUsdForMint }),
      );
      /**
       * 1.11.230 — больше размер MTM probe = меньше price-impact distortion на тонких маршрутах.
       * Jupiter Pro оплачен; нагрузка на quote-endpoint не критична. Раньше: [5..45] @12% remUsd.
       * Теперь: [`liveTrackerMtmProbeMinUsd`..`liveTrackerMtmProbeMaxUsd`] @`liveTrackerMtmProbeFraction`.
       * По умолчанию: [20..200] @10% — для $1000 позиции probe = $100 (vs $45 раньше).
       */
      const probeUsd = Math.max(
        liveOscarCfg.liveTrackerMtmProbeMinUsd,
        Math.min(liveOscarCfg.liveTrackerMtmProbeMaxUsd, remUsd * liveOscarCfg.liveTrackerMtmProbeFraction),
      );
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
              entrySplitJupiterPx = jpx;
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
              void scheduleMtmShadowTrackerProbe({
                liveCfg: liveOscarCfg,
                paperStrategyId: cfg.strategyId,
                ot,
                mint,
                snapshotPgUsd: snapPx,
                probeUsdPrimary: probeUsd,
                solUsd,
                decimalsHint: ot.tokenDecimals ?? fittedDec,
                anchorPx,
                primaryJupiterUsd: jpx,
                primaryQuoteResponse: fq.quoteResponse,
              });
              const divergeVsAnchor =
                anchorPx > 0 ? Math.abs(anchorPx - jpx) / Math.max(anchorPx, 1e-18) : 0;
              /**
               * При jpx ниже якоря относительное расхождение всегда ≤ 1 (максимум −100%% к якорю).
               * Режим `divergeVsAnchor > 2` возможен только при сильном пампе (jpx ≫ anchor).
               * Тогда не подменяем Jupiter устаревшим PG — иначе MTM занижается и лестница TP не срабатывает.
               */
              const jupiterSaneVsEntry =
                !(anchorPx > 0) || divergeVsAnchor <= 2 || jpx >= anchorPx - 1e-18;
              if (jupiterSaneVsEntry) {
                const maxPrem = liveOscarCfg.liveTrackerJupiterMaxPremiumOverSnapshotPct;
                const { useUsd: mtmPick, clampedFromJupiter, bandClamp } = liveTrackerMtmUsdSnapJupiterSymmetricBand({
                  snapPx,
                  jupiterPx: jpx,
                  maxPremiumOverSnapshotPct: maxPrem,
                  anchorPx,
                });
                curMetric = mtmPick;
                ot.liveFlashLastSnapshotPx = snapPx;
                ot.liveFlashLastJupiterPx = jpx;
                if (clampedFromJupiter) {
                  const premPct = snapPx > 0 ? +(((jpx / snapPx - 1) * 100).toFixed(2)) : null;
                  if (bandClamp === 'low') {
                    log.warn(
                      {
                        mint: mint.slice(0, 8),
                        symbol: ot.symbol,
                        snapshotPx: snapPx,
                        jupiterPx: jpx,
                        maxPremiumPct: maxPrem,
                        jupiterDiscountVsSnapPct: premPct,
                        mtmUsd: mtmPick,
                      },
                      'live tracker: Jupiter below snapshot band; using Jupiter MTM (stale snapshot guard)',
                    );
                  } else {
                    log.warn(
                      {
                        mint: mint.slice(0, 8),
                        symbol: ot.symbol,
                        snapshotPx: snapPx,
                        jupiterPx: jpx,
                        maxPremiumPct: maxPrem,
                        jupiterPremiumVsSnapPct: premPct,
                        mtmUsd: mtmPick,
                      },
                      'live tracker: Jupiter buy-probe above snapshot premium cap; using PG snapshot for MTM (anti-ghost)',
                    );
                  }
                  void notifyLiveTrackerJupiterMtmClampedToSnapshot({
                    strategyId: cfg.strategyId,
                    mint,
                    symbol: ot.symbol,
                    snapshotPx: snapPx,
                    jupiterPx: jpx,
                    probeUsd,
                    maxPremiumPct: maxPrem,
                    bandClamp: bandClamp === 'low' ? 'low' : 'high',
                  });
                } else if (snapPx > 0 && jpx > 0 && jpx < snapPx - 1e-18) {
                  const divergeVsSnap = Math.abs(snapPx - jpx) / Math.max(jpx, 1e-18);
                  if (divergeVsSnap > 0.035) {
                    log.warn(
                      {
                        mint: mint.slice(0, 8),
                        symbol: ot.symbol,
                        snapshotPx: snapPx,
                        jupiterPx: jpx,
                        divergePct: +(divergeVsSnap * 100).toFixed(2),
                        mtmUsd: mtmPick,
                      },
                      'live tracker: PG snapshot above Jupiter; MTM uses min(snapshot,Jupiter) for exits',
                    );
                    void notifyLiveTrackerJupiterMtmClampedToSnapshot({
                      strategyId: cfg.strategyId,
                      mint,
                      symbol: ot.symbol,
                      snapshotPx: snapPx,
                      jupiterPx: jpx,
                      probeUsd,
                      maxPremiumPct: maxPrem,
                      bandClamp: 'low',
                    });
                  }
                } else if (snapPx > 0) {
                  const divergeVsSnap = Math.abs(snapPx - jpx) / Math.max(jpx, 1e-18);
                  if (divergeVsSnap > 0.035 && jpx > snapPx + 1e-18) {
                    log.warn(
                      {
                        mint: mint.slice(0, 8),
                        symbol: ot.symbol,
                        snapshotPx: snapPx,
                        jupiterPx: jpx,
                        divergePct: +(divergeVsSnap * 100).toFixed(2),
                      },
                      'live tracker: PG snapshot vs Jupiter tradable price; using conservative MTM for decisions',
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
                  }
                } else {
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

    /**
     * Stage 1.2 (1.11.468): Shyft stream price PRIMARY for live-oscar MTM, freshness-gated
     * (`shyftMaxStaleMs`) with PG/Jupiter fallback. Placed before the exec-sell override so a fresh
     * executable fill still wins over the stream. **Default OFF** (`shyftPricePrimaryEnabled`) — when
     * OFF this block is skipped and `curMetric` is byte-for-byte the current PG/Jupiter value.
     */
    if (
      cfg.shyftPricePrimaryEnabled &&
      cfg.shyftPricePrimaryMtmEnabled &&
      isLiveOscarFamilyTradingStrategyId(cfg.strategyId) &&
      isShyftShadowEnabled() &&
      shyftPrimaryTickMs != null
    ) {
      const streamPrimary = shyftPrimaryStreamAtTick;
      const picked = resolvePrimaryPriceUsd({
        enabled: true,
        pgPriceUsd: curMetric > 0 ? curMetric : null,
        streamPriceUsd: streamPrimary?.priceUsd ?? null,
        streamTsMs: streamPrimary?.streamTsMs ?? null,
        nowMs: shyftPrimaryTickMs,
        maxStaleMs: cfg.shyftMaxStaleMs,
      });
      if (picked.source === 'stream' && picked.priceUsd != null && picked.priceUsd > 0 && streamPrimary) {
        const primaryEvent = buildPricePrimaryEvent({
          mint,
          lane: 'mtm',
          surface: 'mtm',
          baselinePriceUsd: curMetric > 0 ? curMetric : null,
          streamPriceUsd: streamPrimary.priceUsd,
          streamTsMs: streamPrimary.streamTsMs,
          streamAgeMs: picked.streamAgeMs,
          streamSlot: streamPrimary.slot,
          nowMs: shyftPrimaryTickMs,
        });
        journalAppend(primaryEvent);
        journalLiveStrategy?.(primaryEvent);
        curMetric = picked.priceUsd;
      }
    }

    /** 1.11.458 — executable sell from hot tick overrides buy-probe MTM for kill/exit decisions. */
    if (liveOscarCfg && isOpenPositionExecSellFresh(mint, liveOscarCfg.liveOpenHotExecPriceMaxAgeMs)) {
      const execSell = getOpenPositionExecSellUsd(mint);
      if (execSell != null && execSell > 0) {
        const execSanity = liveHotTickProbeQuoteSanity({
          quotePriceUsd: execSell,
          anchors: collectTrackerHotTickAnchors({
            lastObservedPriceUsd: ot.lastObservedPriceUsd,
            avgEntryMarket: ot.avgEntryMarket,
            avgEntry: ot.avgEntry,
            tickMtmUsd: snapPx > 0 ? snapPx : null,
            shyftStreamRefUsd: getShyftShadowStreamPrice(mint)?.priceUsd ?? null,
          }),
        });
        if (execSanity.ok) {
          curMetric = execSell;
          ot.liveFlashLastJupiterPx = execSell;
        } else {
          const anchorSummary = summarizeHotTickAnchorChecks(execSanity.anchorChecks);
          log.warn(
            {
              mint: mint.slice(0, 8),
              symbol: ot.symbol,
              execSellUsd: execSell,
              anchorChecks: execSanity.anchorChecks,
              observedRefUsd: anchorSummary.observedRefUsd,
              pgRefUsd: anchorSummary.pgRefUsd,
              dexRefUsd: anchorSummary.dexRefUsd,
            },
            'live tracker: ignoring ghost hot-tick exec sell price',
          );
          clearOpenPositionExecSellUsd(mint);
        }
      }
    }

    await sleep(liveOscarCfg?.liveTrackerInterMintDelayMs ?? 120);

    /** Raw PG/Jupiter MTM before ±12% exit clamp — staged entry / signal-kill vs anchor use this, not clamped exit MTM. */
    const rawTrackerPriceUsd = curMetric > 0 ? curMetric : 0;
    const prevObservedPriceUsd =
      ot.lastObservedPriceUsd ??
      (ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.avgEntry > 0 ? ot.avgEntry : 0);
    let exitMtmForJournal = rawTrackerPriceUsd;
    if (rawTrackerPriceUsd > 0 && (isLiveOscarTradingStrategyId(cfg.strategyId) || isWaveBExitPolicy(ot) || isVariantAExitPolicy(ot))) {
      const exitMtm = clampLiveTrackerMtmForExit(ot, rawTrackerPriceUsd);
      exitMtmForJournal = exitMtm > 0 ? exitMtm : rawTrackerPriceUsd;
      if (exitMtm > 0 && Math.abs(exitMtm - rawTrackerPriceUsd) / Math.max(rawTrackerPriceUsd, 1e-18) > 0.002) {
        log.warn(
          {
            mint: mint.slice(0, 8),
            symbol: ot.symbol,
            rawMtmUsd: +rawTrackerPriceUsd.toFixed(8),
            exitMtmUsd: +exitMtm.toFixed(8),
          },
          'live tracker: MTM tick jump clamped for exit decisions (ghost quote guard)',
        );
      }
      curMetric = exitMtmForJournal;
    }

    ghostExitTick =
      rawTrackerPriceUsd > 0 &&
      exitMtmForJournal > 0 &&
      prevObservedPriceUsd > 0 &&
      isGhostMtmExitTick({
        previousObservedUsd: prevObservedPriceUsd,
        rawUsd: rawTrackerPriceUsd,
        clampedUsd: exitMtmForJournal,
      });

    if (rawTrackerPriceUsd > 0) {
      ot.lastObservedPriceUsd = resolveObservedPriceUsdForJournal(rawTrackerPriceUsd, exitMtmForJournal);
      if (cfg.flashCrashKillEnabled && isLiveOscarTradingStrategyId(cfg.strategyId)) {
        appendFlashKillPriceSample(ot, Date.now(), curMetric);
      }
      // Own-book swan detector: record this fresh mark (consumed at the next tick top).
      if (
        liveOscarCfg?.executionMode === 'live' &&
        liveOscarCfg.liveMemSwanPortEnabled &&
        curMetric > 0
      ) {
        recordMemSwanPortfolioMark(mint, curMetric);
      }
    }

    if (liveChainMap && curMetric > 0) {
      const wr = reconcileOpenPositionWalletBalance({
        liveCfg: liveOscarCfg,
        ot,
        mint,
        chainMap: liveChainMap,
        priceUsd: curMetric,
      });
      chainOscarUsdForMint = wr?.chainOscarUsd ?? chainOscarUsdForMint;
    }

    if (isWaveBExitPolicy(ot) && curMetric > 0) {
      reconcileE2OpenOnTrackerTick(ot, cfg, rawTrackerPriceUsd > 0 ? rawTrackerPriceUsd : curMetric);
      waveBUpdatePreArmReached(ot, curMetric);
      waveBUpdateDip10ReachedBeforeTp8(
        ot,
        curMetric,
        liveStagedEntrySignalDropPct(ot, curMetric),
        cfg.liveOscarDip10FirstTp5SignalDropPct,
      );
    }

    if (ot.avgEntry > 0 && isPartialGridTrailExitPolicy(ot)) {
      const pnlFracTick = curMetric / ot.avgEntry - 1;
      const anchorBefore = ot.liveWaveTrailAnchorPnlFrac ?? 0;
      if (waveBRecoverPhantomPeakIfNeeded(ot, pnlFracTick)) {
        log.warn(
          {
            mint: mint.slice(0, 8),
            symbol: ot.symbol,
            pnlPct: +(pnlFracTick * 100).toFixed(2),
            anchorPctBefore: +(anchorBefore * 100).toFixed(2),
          },
          'live tracker: wave B phantom peak disarmed (ghost MTM had armed trail)',
        );
      }
    }

    const ageH = (Date.now() - ot.entryTs) / 3_600_000;

    const scalpEscalationTrigger = evaluateScalpPhaseEscalationTrigger({
      cfg,
      ot,
      curPriceUsd: curMetric,
      ageHours: ageH,
    });
    if (scalpEscalationTrigger) {
      const escalated = applyLiveOscarPhaseEscalation({
        cfg,
        ot,
        trigger: scalpEscalationTrigger,
        curPriceUsd: curMetric,
        marketCapUsd: ot.entryMarketCapUsd,
      });
      if (escalated) {
        const dropPct = computeDropFromScalpAnchor(ot, curMetric);
        journalAppend({
          kind: 'live_phase_escalation',
          mint,
          symbol: ot.symbol,
          fromLane: 'scalp_wave',
          toLane: 'prod',
          toTier: ot.liveOscarMcapTier,
          trigger: scalpEscalationTrigger,
          liveExitPolicyId: ot.liveExitPolicyId,
          ...(dropPct != null ? { dropFromEntryPct: +dropPct.toFixed(3) } : {}),
        });
        journalLiveStrategy?.({
          kind: 'live_phase_escalation',
          mint,
          symbol: ot.symbol,
          fromLane: 'scalp_wave',
          toLane: 'prod',
          toTier: ot.liveOscarMcapTier,
          trigger: scalpEscalationTrigger,
          openTrade: serializeOpenTrade(ot),
        });
        resolveLiveOscarExitPolicyForTick(ot, cfg);
        effCfg = cfgEffectiveForOpen(cfg, ot);
      }
    }

    // ----- W7.5 — liquidity drain watch (before TP/SL/TRAIL and NO_DATA stall close) -----
    if (cfg.liqWatchEnabled && ot.pairAddress && (ot.entryLiqUsd ?? 0) > 0) {
      const positionAgeMs = Math.max(0, Date.now() - ot.entryTs);
      const load = await loadLiqWatchLiqUsd({
        mint,
        symbol: ot.symbol,
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
      } else if (verdict.kind === 'skipped' && verdict.reason === 'liq-disagreement') {
        ot.liqWatchConsecutiveFailures = 0;
        ot.liqWatchLastLiqUsd = load.liqUsd;
        ot.liqWatchLastDropPct = load.liqUsd != null && ot.entryLiqUsd
          ? +(((ot.entryLiqUsd - load.liqUsd) / ot.entryLiqUsd) * 100).toFixed(3)
          : null;
        journalAppend({
          kind: 'liq_watch_disagreement',
          mint,
          symbol: ot.symbol,
          entryLiqUsd: ot.entryLiqUsd,
          pgLiqUsd: verdict.pgLiqUsd ?? load.pgLiqUsd ?? null,
          referenceLiqUsd: verdict.referenceLiqUsd ?? load.referenceLiqUsd ?? null,
          referenceSource: load.referenceSource ?? null,
          disagreementPct: verdict.disagreementPct ?? null,
          thresholdPct: cfg.liqWatchDisagreementPct,
          loadFrom: load.from,
        });
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
        let liqSellOut: LiveTokenToSolSellResult = { ok: true };
        if (livePhase4 && marketSell > 0 && investedRemaining > 1e-6) {
          liqSellOut = await livePhase4.tryTokenToSolSell({
            mint,
            symbol: ot.symbol,
            usdNotional: investedRemaining,
            priceUsdPerToken: marketSell,
            referencePriceUsd: liveSellReferencePriceUsd(ot),
            decimals: ot.tokenDecimals ?? 6,
            intentKind: 'sell_full',
          });
          if (!liqSellOut.ok) continue;
        }
        applyLiveFullCloseProceedsFromChain({
          ct,
          ot,
          cfg,
          sellOut: liqSellOut,
          marketSell,
          networkFeeUsdPerTx: perTxClose,
        });
        stampFullExitTxSignature(ct, liqSellOut);
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
        clearExitCloseDeferForMint(mint);
        clearExitPartialDeferForMint(mint);
        open.delete(openKey);
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
          exit_effective_price: ct.effective_exit_price,
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
        afterFullCloseReentryGate(args, cfg, ct);
        hookLiveWhitelistAfterFullClose(
    liveOscarCfg,
    cfg,
    mint,
    ot.symbol,
    ct.netPnlUsd,
    ot.liveMintFirstProbe === true,
    ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
    ot.liveVariantAExitTag,
    ot,
    ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
  );
        scheduleTailAfterLiveClose(
          liveOscarCfg,
          mint,
          ot.symbol,
          ot.tokenDecimals ?? 6,
          marketSell,
          ot.source,
          'LIQ_DRAIN',
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

    // ----- VOL_COLLAPSE — rolling-volume drain watch (sibling of LIQ_DRAIN) -----
    if (cfg.volWatchEnabled && ot.pairAddress) {
      const positionAgeMsVol = Math.max(0, Date.now() - ot.entryTs);
      const volLoad = await loadCurrentVol1hUsd({
        pairAddress: ot.pairAddress,
        source: ot.source as DexSource,
        cfg,
      });
      const baselineSeed = ot.volWatchBaselineUsd ?? ot.entryVol1hUsd ?? null;
      const baselineUsd = refreshVolBaseline(baselineSeed, volLoad.volUsd);
      ot.volWatchBaselineUsd = baselineUsd;
      const volVerdict = evaluateVolCollapseState({
        cfg,
        baselineUsd,
        currentVolUsd: volLoad.volUsd,
        collapseSinceTs: ot.volWatchCollapseSinceTs ?? null,
        positionAgeMs: positionAgeMsVol,
      });
      ot.volWatchCollapseSinceTs = volVerdict.collapseSinceTs;
      if (volVerdict.kind !== 'skipped' && volVerdict.currentVolUsd != null) {
        ot.volWatchLastVolUsd = volVerdict.currentVolUsd;
        ot.volWatchLastDropPct = volVerdict.dropPct ?? null;
      }

      if (volVerdict.kind === 'force-close' && cfg.volWatchForceClose) {
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
          exitReason: 'VOL_COLLAPSE',
          ageH,
          networkFeeUsdPerTx: perTxClose,
        });
        let volSellOut: LiveTokenToSolSellResult = { ok: true };
        if (livePhase4 && marketSell > 0 && investedRemaining > 1e-6) {
          volSellOut = await livePhase4.tryTokenToSolSell({
            mint,
            symbol: ot.symbol,
            usdNotional: investedRemaining,
            priceUsdPerToken: marketSell,
            referencePriceUsd: liveSellReferencePriceUsd(ot),
            decimals: ot.tokenDecimals ?? 6,
            intentKind: 'sell_full',
          });
          if (!volSellOut.ok) continue;
        }
        applyLiveFullCloseProceedsFromChain({
          ct,
          ot,
          cfg,
          sellOut: volSellOut,
          marketSell,
          networkFeeUsdPerTx: perTxClose,
        });
        stampFullExitTxSignature(ct, volSellOut);
        const volDrop = {
          dropPct: volVerdict.dropPct,
          baselineUsd: volVerdict.baselineUsd,
          currentVolUsd: volVerdict.currentVolUsd,
          sustainedMs: volVerdict.sustainedMs,
        };
        const exitContext = buildExitContext({
          cfg: effCfg,
          ot,
          closePnlPct: ct.pnlPct,
          ageH,
          exitReason: 'VOL_COLLAPSE',
          curMetric: marketSell,
          xAvg: ot.avgEntry > 0 ? marketSell / ot.avgEntry : 1,
          tpLadder,
          volDrop,
        });
        ct.exitContext = exitContext;
        clearExitCloseDeferForMint(mint);
        clearExitPartialDeferForMint(mint);
        open.delete(openKey);
        closed.push(ct);
        stats.closed.VOL_COLLAPSE++;
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
          exit_effective_price: ct.effective_exit_price,
          exit_swaps: exitSwaps,
          mcUsdLive: mcUsdLive_close,
          priorityFee: pfClose,
          exitContext,
          volWatch: {
            source: volLoad.from,
            baselineUsd: volVerdict.baselineUsd,
            entryVol1hUsd: ot.entryVol1hUsd ?? null,
            currentVolUsd: volVerdict.currentVolUsd,
            dropPct: volVerdict.dropPct,
            sustainedMs: volVerdict.sustainedMs,
            ageMs: volLoad.ageMs,
            ts: volVerdict.ts,
          },
        });
        journalLiveStrategy?.({
          kind: 'live_position_close',
          mint,
          closedTrade: serializeClosedTrade(ct),
        });
        afterFullCloseReentryGate(args, cfg, ct);
        hookLiveWhitelistAfterFullClose(
          liveOscarCfg,
          cfg,
          mint,
          ot.symbol,
          ct.netPnlUsd,
          ot.liveMintFirstProbe === true,
          ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
          ot.liveVariantAExitTag,
          ot,
          ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
        );
        scheduleTailAfterLiveClose(
          liveOscarCfg,
          mint,
          ot.symbol,
          ot.tokenDecimals ?? 6,
          marketSell,
          ot.source,
          'VOL_COLLAPSE',
        );
        peakStateByMint.delete(mint);
        console.log(
          `[VOL_COLLAPSE] ${mint.slice(0, 8)} $${ot.symbol} drop=${volVerdict.dropPct.toFixed(1)}% vol1h=$${volVerdict.currentVolUsd.toFixed(0)} sustained=${(volVerdict.sustainedMs / 3_600_000).toFixed(1)}h`,
        );
        continue;
      } else if (volVerdict.kind === 'force-close' && !cfg.volWatchForceClose) {
        log.warn(
          {
            mint: mint.slice(0, 8),
            dropPct: volVerdict.dropPct,
            currentVolUsd: volVerdict.currentVolUsd,
            sustainedH: +(volVerdict.sustainedMs / 3_600_000).toFixed(2),
          },
          'vol-watch force-close suppressed (shadow)',
        );
      }

      if (cfg.volWatchStampOnTrack) {
        journalAppend({
          kind: 'vol_watch_tick',
          mint,
          verdict: volVerdict,
        });
      }
    }

    if (!(curMetric > 0)) {
      if (ageH >= effCfg.timeoutHours && !isWaveBExitPolicy(ot) && !isVariantAExitPolicy(ot) && !isScalpWaveExitPolicy(ot)) {
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
        open.delete(openKey);
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
        afterFullCloseReentryGate(args, cfg, ct);
        hookLiveWhitelistAfterFullClose(
    liveOscarCfg,
    cfg,
    mint,
    ot.symbol,
    ct.netPnlUsd,
    ot.liveMintFirstProbe === true,
    ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
    ot.liveVariantAExitTag,
    ot,
    ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
  );
        peakStateByMint.delete(mint);
        console.log(`[NO_DATA] ${mint.slice(0, 8)} $${ot.symbol}`);
      }
      continue;
    }

    const firstPrice = ot.legs[0]?.price || ot.entryMcUsd;
    const dropFromFirstPct = curMetric / firstPrice - 1;
    let xAvg = curMetric / ot.avgEntry;
    let pnlPctVsAvg = (xAvg - 1) * 100;

    const isPaperOscarIdealized = isPaperOscarIdealizedStackStrategyId(cfg.strategyId);
    if (isPaperOscarIdealized && paperOscarIdealizedNeutralFull(ot)) {
      const pnlFracPre = xAvg - 1;
      const armBFrac = cfg.idealizedOscarModeBArmFrac;
      if (pnlFracPre <= armBFrac + LADDER_PNL_EPS) {
        const addUsd = cfg.positionUsd * 0.2;
        const marketBuy = curMetric;
        const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);
        ot.legs.push({
          ts: Date.now(),
          price: effectiveBuy,
          marketPrice: marketBuy,
          sizeUsd: addUsd,
          reason: 'dca',
          triggerPct: armBFrac,
        });
        stampFlashKillLastBuyLeg(ot, marketBuy, Date.now());
        ot.totalInvestedUsd += addUsd;
        const numB = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
        ot.avgEntry = numB / ot.totalInvestedUsd;
        const numMB = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
        ot.avgEntryMarket = numMB / ot.totalInvestedUsd;
        ot.remainingFraction = 1;
        ot.liveExitProfileMode = 'B';
        effCfg = cfgEffectiveForOpen(cfg, ot);
        if (isRunnerProbeExitPolicy(ot)) {
          runnerProbeResetPeakAfterDca(ot, curMetric);
        } else if (curMetric > ot.peakMcUsd) {
          ot.peakMcUsd = curMetric;
          ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
        } else {
          ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
        }
        ot.trailingArmed = ot.trailingArmed && curMetric / ot.avgEntry >= effCfg.trailTriggerX;
        const mcUsdLiveV21b = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        const pfV21b = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);
        journalAppend({
          kind: 'paper_oscar_v21_arm',
          mint,
          ts: Date.now(),
          mode: 'B',
          marketPrice: curMetric,
          pnlFracToAvg: +pnlFracPre.toFixed(6),
          avgEntry: ot.avgEntry,
        });
        journalAppend({
          kind: 'dca_add',
          mint,
          ts: Date.now(),
          price: effectiveBuy,
          marketPrice: marketBuy,
          sizeUsd: addUsd,
          dcaStepIndex: 0,
          dcaLevelsTotal: 1,
          triggerPct: armBFrac,
          avgEntry: ot.avgEntry,
          avgEntryMarket: ot.avgEntryMarket,
          totalInvestedUsd: ot.totalInvestedUsd,
          legCount: ot.legs.length,
          mcUsdLive: mcUsdLiveV21b,
          priorityFee: pfV21b,
          timelineLabelRu: `Paper Oscar IDEALIZED · режим B (${(armBFrac * 100).toFixed(0)}% к avg) · докуп 20% нотионала`,
          liveExitProfileMode: 'B',
        });
        console.log(
          `[PAPER_V21_B] ${mint.slice(0, 8)} $${ot.symbol} +$${addUsd.toFixed(0)} avgEff=${ot.avgEntry.toFixed(8)}`,
        );
      } else if (pnlFracPre >= 0.05 - LADDER_PNL_EPS) {
        ot.liveExitProfileMode = 'A';
        effCfg = cfgEffectiveForOpen(cfg, ot);
        journalAppend({
          kind: 'paper_oscar_v21_arm',
          mint,
          ts: Date.now(),
          mode: 'A',
          marketPrice: curMetric,
          pnlFracToAvg: +pnlFracPre.toFixed(6),
          avgEntry: ot.avgEntry,
        });
        const tgA = tpGridEffective(ot, effCfg);
        const rArm = await tryExecuteTpPartialSell({
          mint,
          ot,
          cfg: effCfg,
          curMetric,
          sellFraction: Math.min(1, tgA.sellFraction),
          ladderStepIndex: 0,
          ladderRungsTotal: 0,
          ladderPnlPct: 0.05,
          tpGrid: true,
          journalAppend,
          journalLiveStrategy,
          livePhase4,
          liveOscarCfg,
          stats,
          markLadder: () => ladderPnlThresholdMark(ot.ladderUsedLevels, 0.05),
          logLabelPct: 'TPgrid+5%',
        });
        if (rArm !== 'abort_mint') {
          effCfg = cfgEffectiveForOpen(cfg, ot);
        }
        console.log(`[PAPER_V21_A] ${mint.slice(0, 8)} $${ot.symbol} arm=${rArm}`);
      }
    }

    if (ot.avgEntry > 0) {
      xAvg = curMetric / ot.avgEntry;
      pnlPctVsAvg = (xAvg - 1) * 100;
      if (resolveLiveOscarExitPolicyForTick(ot, cfg, xAvg - 1)) {
        effCfg = cfgEffectiveForOpen(cfg, ot);
      }
    }

    const idealizedMute = isPaperOscarIdealized && paperOscarIdealizedExitMute(ot);
    let tgEff = tpGridEffective(ot, effCfg);
    let killEff = dcaKillstopEffective(ot, effCfg);

    const liveOscarAb = isLiveOscarTradingStrategyId(cfg.strategyId) && cfg.liveExitModeAbEnabled;
    const entrySplitComplete = ot.legs.some((l) => l.reason === 'scale_in');

    const peakCandidate = isRunnerProbeExitPolicy(ot)
      ? runnerProbeOptimisticTpPx(ot, curMetric, snapPx)
      : curMetric;
    if (!(isPaperOscarIdealized && idealizedMute) && peakCandidate > ot.peakMcUsd) {
      const wasArmed = ot.trailingArmed;
      const peakMetric = peakCandidate;
      const pnlFracPeak = ot.avgEntry > 0 ? peakMetric / ot.avgEntry - 1 : 0;
      if (isPresetCScalpExitPolicy(ot)) {
        ot.peakPnlPctAnchor = Math.max(
          ot.peakPnlPctAnchor ?? -Infinity,
          presetCScalpSignalPnlFrac(ot, curMetric) * 100,
        );
      }
      if (isWaveBExitPolicy(ot) || isVariantAHybridExitPolicy(ot)) {
        waveBOnNewHigh(ot, pnlFracPeak, tgEff.stepPnl);
      } else if (isVariantALegacyV1ExitPolicy(ot)) {
        variantAUpdateRemainderPeak(ot, pnlFracPeak, cfg);
      }
      ot.peakMcUsd = isRunnerProbeExitPolicy(ot) ? peakMetric : curMetric;
      ot.peakPnlPct = isRunnerProbeExitPolicy(ot) ? pnlFracPeak * 100 : pnlPctVsAvg;
      /**
       * Peak trailing only after ≥2 partial TP rungs when using TP grid or discrete ladder — avoids full exit
       * on retrace right after a shallow first rung (~2.5%).
       */
      const usesTpSlices = tgEff.stepPnl > 0 || tpLadder.length > 0;
      const tpSlicesDone = ot.partialSells.filter((p) => p.reason === 'TP_LADDER').length;
      if (isWaveBExitPolicy(ot) || isVariantAHybridExitPolicy(ot)) {
        if (pnlFracPeak + LADDER_PNL_EPS >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) ot.trailingArmed = true;
      } else if (xAvg >= effCfg.trailTriggerX && (!usesTpSlices || tpSlicesDone >= 2)) {
        ot.trailingArmed = true;
      }
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

    /** Усреднение до второй ноги сплита допустимо (−6%% к первой ноге снимает план второй ноги — см. `entry-scale-in.ts`). */
    const liveOscarNoDcaInModeA = liveOscarAb && ot.liveExitProfileMode === 'A';

    const mayDca =
      !(isPaperOscarIdealized && idealizedMute) &&
      !ot.liveStagedEntry &&
      !isFastDipScalpExitPolicy(ot) &&
      !isFlashKillDcaBlocked(cfg, ot, Date.now()) &&
      (tgEff.stepPnl <= 0 || ot.partialSells.length === 0 || isVariantAHybridExitPolicy(ot)) &&
      !(isVariantAScratchExitPolicy(ot) && variantAScratchHadTp(ot)) &&
      (tradeDcaLevels.length > 0 || killEff < 0) &&
      ot.remainingFraction > 0 &&
      !liveOscarNoDcaInModeA;

    const stagedEntryPriceUsd = resolveStagedEntryTradableUsd({
      snapPx,
      rawTrackerPriceUsd,
      entrySplitJupiterPx,
      fallbackCurMetric: curMetric,
    });
    const st = ot.liveStagedEntry;
    if (st && ot.remainingFraction > 0 && !liveStagedEntryKillHit(ot, stagedEntryPriceUsd)) {
      if (st.entrySplitV2) {
        if (openTradeNeedsEntrySplitFastPoll(ot)) {
          await maybeRefreshPendingLegPgForOpenTrade({
            cfg,
            ot,
            mint,
            journalAppend,
          });
        }
        await tryLiveStagedEntryV2TrackerStep({
          cfg,
          ot,
          mint,
          curMetric: stagedEntryPriceUsd,
          entrySplitMetricUsd: entrySplitJupiterPx,
          livePhase4,
          journalAppend,
          journalLiveStrategy,
        });
      }
      const signalDropPct = liveStagedEntrySignalDropPct(ot, stagedEntryPriceUsd);
      /** Staged доборы до якоря сигнала: раньше блокировались после любого partial TP; теперь — до 2-й ступени TP-сетки (`TP_LADDER`), затем запрет. */
      const tpLadderPartials = ot.partialSells.filter((p) => p.reason === 'TP_LADDER').length;
      const hasThird = (st.thirdLegUsd ?? 0) > 0;
      const thirdDone = hasThird ? st.thirdLegDone === true : true;
      const nowMs = Date.now();
      /** TTL — только до входа; на открытой позиции с незакрытыми ногами окно доборов не режем по времени. */
      const stagedAddWindowOpen = liveStagedEntryAddWindowOpen({
        cfg,
        st,
        signalTs: st.signalTs,
        nowMs,
      });
      const stagedAddAllowed = stagedAddWindowOpen && tpLadderPartials < 2;
      const totalStagedAddLegs = st.thirdLegUsd && st.thirdLegUsd > 0 ? 2 : 1;
      const tryStagedAddLeg = async (args: {
        stepIndex: number;
        legLabelRu: string;
        addUsd: number;
        dropPct: number;
        signalDropPct: number;
        markDone: () => void;
      }): Promise<boolean> => {
        const { stepIndex, legLabelRu, addUsd, dropPct, signalDropPct, markDone } = args;
        let dcaBuyRes: LiveBuyPipelineResult | undefined;
        if (livePhase4) {
          if (!open.has(openKey)) return false;
          dcaBuyRes = await livePhase4.trySolToTokenBuy({
            mint,
            symbol: ot.symbol,
            usdNotional: addUsd,
            entryBuySliceEligible: entryBuySliceEligibleForOpen(cfg, ot),
            positionCeilingUsd: resolveLiveOscarPositionCeilingUsd(cfg, ot),
            tokenDecimals: ot.tokenDecimals,
            dexSource: ot.source,
          });
          if (!dcaBuyRes.ok) return false;
        }
        const marketBuy = stagedEntryPriceUsd;
        const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, marketBuy, ot.dex, addUsd, null);
        ot.legs.push({
          ts: Date.now(),
          price: effectiveBuy,
          marketPrice: marketBuy,
          sizeUsd: addUsd,
          reason: 'dca',
          triggerPct: -dropPct / 100,
        });
        stampFlashKillLastBuyLeg(ot, marketBuy, Date.now());
        markDone();
        ot.livePendingScaleIn = null;
        ot.liveKillstopBelowStreak = 0;
        ot.totalInvestedUsd += addUsd;
        const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
        ot.avgEntry = num / ot.totalInvestedUsd;
        const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
        ot.avgEntryMarket = numM / ot.totalInvestedUsd;
        markDcaStepFired(ot, stepIndex, -dropPct / 100);
        variantAHybridResetTpGridOnDca(ot);
        ot.remainingFraction = 1;
        if (isRunnerProbeExitPolicy(ot)) {
          runnerProbeResetPeakAfterDca(ot, curMetric);
        } else if (curMetric > ot.peakMcUsd) {
          ot.peakMcUsd = curMetric;
          ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
        } else {
          ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
        }
        ot.trailingArmed = ot.trailingArmed && curMetric / ot.avgEntry >= effCfg.trailTriggerX;
        if (cfg.liveExitModeAbEnabled && !isRunnerProbeExitPolicy(ot)) ot.liveExitProfileMode = 'B';
        if (livePhase4 && dcaBuyRes) {
          appendLiveBuyAnchorsAfterDca(ot, dcaBuyRes);
        }
        if (cfg.liqWatchEnabled) {
          await refreshOpenTradeEntryLiqAfterDca(ot, cfg);
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
          dcaStepIndex: stepIndex,
          dcaLevelsTotal: totalStagedAddLegs,
          triggerPct: -dropPct / 100,
          avgEntry: ot.avgEntry,
          avgEntryMarket: ot.avgEntryMarket,
          totalInvestedUsd: ot.totalInvestedUsd,
          legCount: ot.legs.length,
          mcUsdLive: mcUsdLive_dca,
          priorityFee: pfDca,
          timelineLabelRu: `${legLabelRu} $${addUsd.toFixed(0)} на −${dropPct}% от сигнала · добор staged-entry · режим выхода B`,
          liveExitProfileMode: 'B' as const,
          liveStagedEntry: { ...st, signalDropPct: +signalDropPct.toFixed(3) },
        });
        journalLiveStrategy?.({
          kind: 'live_position_dca',
          mint,
          openTrade: serializeOpenTrade(ot),
          timelineLabelRu: `${legLabelRu} $${addUsd.toFixed(0)} на −${dropPct}% от сигнала`,
        });
        console.log(
          `[STAGED_DCA] ${mint.slice(0, 8)} $${ot.symbol} ${legLabelRu} +$${addUsd.toFixed(0)} signalDrop=${signalDropPct.toFixed(2)}% avgEff=${ot.avgEntry.toFixed(8)}`,
        );
        return true;
      };

      if (usesLegacyStagedAdds(st) && st.mintFirstProbe !== true) {
        if (signalDropPct != null && stagedAddAllowed && !st.secondLegDone && signalDropPct <= -st.secondDropPct) {
          await tryStagedAddLeg({
            stepIndex: 0,
            legLabelRu: 'Усреднение staged (legacy)',
            addUsd: st.secondLegUsd,
            dropPct: st.secondDropPct,
            signalDropPct,
            markDone: () => {
              st.secondLegDone = true;
            },
          });
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
          await tryStagedAddLeg({
            stepIndex: 1,
            legLabelRu: 'Усреднение staged (legacy)',
            addUsd: st.thirdLegUsd,
            dropPct: st.thirdDropPct,
            signalDropPct,
            markDone: () => {
              st.thirdLegDone = true;
            },
          });
        }
      }

      /**
       * Пока `liveStagedEntry` висит на открытой сделке, ветка KILLSTOP использует только signal-kill
       * (`liveStagedEntryKillHit`), а PnL-kill к средней требует `!ot.liveStagedEntry` — без сброса плана
       * усреднённая позиция в режиме B могла уходить в минус без срабатывания `PAPER_DCA_KILLSTOP` / mode B kill.
       * Снимаем план после всех запланированных ног, при ≥2 partial `TP_LADDER`, или по TTL сигнала, если
       * доборы уже не продлеваются (см. `stagedAddWindowOpen` / `ttlPreservesStagedPlan`).
       */
      {
        const v2AvgDone =
          st.entrySplitV2 === true
            ? entrySplitAllLegsDone(st) &&
              (!stagedAveragingConfigured(st) ||
                (st.avgThirdLegUsd != null && st.avgThirdLegUsd > 0
                  ? st.avgSecondLegDone === true
                  : st.avgFirstLegDone === true))
            : false;
        const stagedLegsComplete = st.entrySplitV2 ? v2AvgDone : st.secondLegDone === true && thirdDone;
        const ttlExpired = liveStagedEntrySignalTtlExpired(cfg, st.signalTs, nowMs);
        const ttlPreservesStagedPlan = liveStagedEntryTtlPreservesPlan(st);
        if (stagedLegsComplete || tpLadderPartials >= 2 || (ttlExpired && !ttlPreservesStagedPlan)) {
          ot.liveStagedEntry = undefined;
        }
      }
    }

    if (isPresetCScalpExitPolicy(ot)) {
      const scalpMetric =
        snapPx > 0 ? snapPx : rawTrackerPriceUsd > 0 ? rawTrackerPriceUsd : curMetric;
      await tryPresetCScalpDcaLeg({
        mint,
        ot,
        cfg,
        curMetric: scalpMetric,
        journalAppend,
        journalLiveStrategy,
        livePhase4,
        liveOscarCfg,
      });
    }

    if (mayDca) {
      for (let dcaIdx = 0; dcaIdx < tradeDcaLevels.length; dcaIdx++) {
        const lvl = tradeDcaLevels[dcaIdx]!;
        if (dcaStepOrTriggerTaken(ot, dcaIdx, lvl.triggerPct)) continue;
        /** §2 V2: в нейтрали после сплита триггер DCA — просадка к `avgEntry`; после назначения B — классика vs первая нога. */
        const usePnlVsAvgForDca =
          liveOscarAb && ot.liveExitProfileMode == null && entrySplitComplete && ot.avgEntry > 0;
        const effPrevDrop = usePnlVsAvgForDca
          ? ot.dcaLastEvalPnlVsAvgFrac != null && Number.isFinite(ot.dcaLastEvalPnlVsAvgFrac)
            ? ot.dcaLastEvalPnlVsAvgFrac
            : Number.POSITIVE_INFINITY
          : dcaEffPrev(ot);
        const currDropMetric = usePnlVsAvgForDca ? curMetric / ot.avgEntry - 1 : dropFromFirstPct;
        if (!dcaCrossedDownward(effPrevDrop, currDropMetric, lvl.triggerPct)) continue;
        const addUsd = effCfg.positionUsd * lvl.addFraction;
        if (
          liveOscarCfg?.liveMaxPositionUsd != null &&
          ot.totalInvestedUsd + addUsd > liveOscarCfg.liveMaxPositionUsd + 1e-6
        ) {
          continue;
        }
        let dcaBuyRes: LiveBuyPipelineResult | undefined;
        if (livePhase4) {
          if (!open.has(openKey)) continue;
          dcaBuyRes = await livePhase4.trySolToTokenBuy({
            mint,
            symbol: ot.symbol,
            usdNotional: addUsd,
            entryBuySliceEligible: entryBuySliceEligibleForOpen(cfg, ot),
            positionCeilingUsd: resolveLiveOscarPositionCeilingUsd(cfg, ot),
            tokenDecimals: ot.tokenDecimals,
            dexSource: ot.source,
          });
          if (!dcaBuyRes.ok) continue;
        }
        /** Усреднение реально состоялось — план второй ноги сплита больше не нужен (не снимаем pending при неудачном свопе DCA). */
        ot.livePendingScaleIn = null;
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
        stampFlashKillLastBuyLeg(ot, marketBuy, Date.now());
        if (isLiveOscarTradingStrategyId(cfg.strategyId)) ot.liveKillstopBelowStreak = 0;
        ot.totalInvestedUsd += addUsd;
        const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
        ot.avgEntry = num / ot.totalInvestedUsd;
        const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
        ot.avgEntryMarket = numM / ot.totalInvestedUsd;
        markDcaStepFired(ot, dcaIdx, lvl.triggerPct);
        variantAHybridResetTpGridOnDca(ot);
        ot.remainingFraction = 1;
        if (isRunnerProbeExitPolicy(ot)) {
          runnerProbeResetPeakAfterDca(ot, curMetric);
        } else if (curMetric > ot.peakMcUsd) {
          ot.peakMcUsd = curMetric;
          ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
        } else {
          ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
        }
        ot.trailingArmed = ot.trailingArmed && curMetric / ot.avgEntry >= effCfg.trailTriggerX;
        if (cfg.liveExitModeAbEnabled && !isRunnerProbeExitPolicy(ot)) ot.liveExitProfileMode = 'B';
        if (livePhase4 && dcaBuyRes) {
          appendLiveBuyAnchorsAfterDca(ot, dcaBuyRes);
        }
        if (cfg.liqWatchEnabled) {
          await refreshOpenTradeEntryLiqAfterDca(ot, cfg);
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
          dcaLevelsTotal: tradeDcaLevels.length,
          triggerPct: lvl.triggerPct,
          avgEntry: ot.avgEntry,
          avgEntryMarket: ot.avgEntryMarket,
          totalInvestedUsd: ot.totalInvestedUsd,
          legCount: ot.legs.length,
          mcUsdLive: mcUsdLive_dca,
          priorityFee: pfDca,
          ...(cfg.liveExitModeAbEnabled
            ? {
                timelineLabelRu: `DCA шаг ${dcaIdx + 1}/${tradeDcaLevels.length} (${(lvl.triggerPct * 100).toFixed(0)}%) · режим выхода B`,
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
          `[DCA] ${mint.slice(0, 8)} $${ot.symbol} +$${addUsd.toFixed(0)} @trigger=${(lvl.triggerPct * 100).toFixed(0)}% step=${dcaIdx + 1}/${tradeDcaLevels.length} avgEff=${ot.avgEntry.toFixed(8)}`,
        );
      }
    }

    effCfg = cfgEffectiveForOpen(cfg, ot);
    tgEff = tpGridEffective(ot, effCfg);
    killEff = dcaKillstopEffective(ot, effCfg);

    const neutralBelowFirstTpAfterFullSplit =
      liveOscarAb &&
      ot.liveExitProfileMode == null &&
      entrySplitComplete &&
      ot.avgEntry > 0 &&
      curMetric / ot.avgEntry - 1 + LADDER_PNL_EPS < tgEff.stepPnl;
    const skipTpGridLiveOscarNeutral = neutralBelowFirstTpAfterFullSplit;
    let pendingTpProtectiveExit: ExitReason | null = null;

    if (!(isPaperOscarIdealized && idealizedMute) && ot.avgEntry > 0 && ot.remainingFraction > 0) {
      const pendingTp = await tryExecutePendingFailedTpSell({
        mint,
        ot,
        cfg: effCfg,
        curMetric,
        pnlFrac: xAvg - 1,
        journalAppend,
        journalLiveStrategy,
        livePhase4,
        liveOscarCfg,
        stats,
      });
      if (pendingTp === 'pending') {
        continue;
      }
      if (pendingTp === 'protect_full_exit') {
        pendingTpProtectiveExit = 'KILLSTOP';
        ot.livePendingTpSell = undefined;
      }
      if (pendingTp === 'executed' && ot.avgEntry > 0) {
        xAvg = curMetric / ot.avgEntry;
        pnlPctVsAvg = (xAvg - 1) * 100;
        tgEff = tpGridEffective(ot, effCfg);
      }
    }

    if (!pendingTpProtectiveExit && !(isPaperOscarIdealized && idealizedMute) && ot.avgEntry > 0 && ot.remainingFraction > 0) {
      await tryWaveBDip10FirstTp5PartialExit({
        mint,
        ot,
        cfg: effCfg,
        curMetric,
        xAvg,
        journalAppend,
        journalLiveStrategy,
        livePhase4,
        liveOscarCfg,
        stats,
      });
      if (ot.avgEntry > 0) {
        xAvg = curMetric / ot.avgEntry;
        pnlPctVsAvg = (xAvg - 1) * 100;
      }
    }

    if (
      !(isPaperOscarIdealized && idealizedMute) &&
      !pendingTpProtectiveExit &&
      !skipTpGridLiveOscarNeutral &&
      !isPresetCScalpExitPolicy(ot) &&
      tgEff.stepPnl > 0 &&
      ot.remainingFraction > 0
    ) {
      const pnlFrac = xAvg - 1;
      const step = tgEff.stepPnl;
      if (isWaveBExitPolicy(ot)) {
        waveBMaybeResetTpImpulse(ot, pnlFrac, step);
      } else if (isVariantAHybridExitPolicy(ot)) {
        variantAHybridMaybeResetTpImpulse(ot, pnlFrac, step);
      }
      let maxK = Math.floor((pnlFrac + LADDER_PNL_EPS) / step);
      if (tgEff.maxRungs != null && tgEff.maxRungs >= 1) {
        maxK = Math.min(maxK, tgEff.maxRungs);
      }
      for (let k = 1; k <= maxK; k++) {
        const threshold = k * step;
        if (ladderStepOrThresholdTaken(ot, k - 1, threshold)) continue;
        if (pnlFrac + LADDER_PNL_EPS < threshold) break;
        if (
          isLiveOscarTradingStrategyId(cfg.strategyId) &&
          cfg.liveExitModeAbEnabled &&
          ot.liveExitProfileMode == null &&
          k === 1
        ) {
          ot.liveExitProfileMode = 'A';
        }
        /**
         * 1.11.167: восходящий sellFraction-профиль по ступени k. Если профиль не задан
         * (`sellFractionByStep === []`), возвращается плоский `tpGridSellFraction`. Это
         * позволяет жирнее фиксировать прибыль на средних ступенях (10-20%), сохраняя
         * хвост позиции для крупных пампов на дальних ступенях.
         */
        const sellFracForStep = Math.min(1, tgEff.sellFractionForStep(k));
        const r = await tryExecuteTpPartialSell({
          mint,
          ot,
          cfg: effCfg,
          curMetric,
          sellFraction: sellFracForStep,
          ladderStepIndex: k - 1,
          ladderRungsTotal: 0,
          ladderPnlPct: threshold,
          tpGrid: true,
          journalAppend,
          journalLiveStrategy,
          livePhase4,
          liveOscarCfg,
          stats,
          markLadder: () => {
            markLadderStepFired(ot, k - 1, threshold);
            if (isWaveBExitPolicy(ot)) waveBOnTpGridRungExecuted(ot, threshold);
          },
          logLabelPct: `TPgrid+${(threshold * 100).toFixed(0)}%`,
        });
        if (r === 'abort_mint') {
          break;
        }
        if (r === 'defer_next') {
          break;
        }
        /** Wave B: at most one cash partial per tick — spreads ladder across price steps, not one MTM print. */
        if ((isWaveBExitPolicy(ot) || isVariantAHybridExitPolicy(ot)) && sellFracForStep > 1e-12) {
          break;
        }
      }
    }

    if (
      !(isPaperOscarIdealized && idealizedMute) &&
      !pendingTpProtectiveExit &&
      !skipTpGridLiveOscarNeutral &&
      !isVariantAHybridExitPolicy(ot) &&
      tpLadder.length > 0 &&
      ot.remainingFraction > 0
    ) {
      for (let stepIdx = 0; stepIdx < tpLadder.length; stepIdx++) {
        const lvl = tpLadder[stepIdx]!;
        if (ladderStepOrThresholdTaken(ot, stepIdx, lvl.pnlPct)) continue;
        if (xAvg - 1 >= lvl.pnlPct) {
          if (
            isLiveOscarTradingStrategyId(cfg.strategyId) &&
            cfg.liveExitModeAbEnabled &&
            ot.liveExitProfileMode == null &&
            stepIdx === 0
          ) {
            ot.liveExitProfileMode = 'A';
          }
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
            liveOscarCfg,
            stats,
            markLadder: () => markLadderStepFired(ot, stepIdx, lvl.pnlPct),
            logLabelPct: `TP+${(lvl.pnlPct * 100).toFixed(0)}%`,
            ...(isVariantAScratchExitPolicy(ot)
              ? { timelineLabelRu: variantAScratchTpTimelineLabelRu(lvl.pnlPct, lvl.sellFraction) }
              : {}),
          });
          if (r === 'abort_mint') {
            continue;
          }
          if (r === 'defer_next') {
            continue;
          }
          if (r === 'ok' && isVariantAScratchExitPolicy(ot)) {
            variantAScratchMarkTpTaken(ot);
          }
        }
      }
    }

    if (ot.avgEntry > 0) {
      xAvg = curMetric / ot.avgEntry;
      pnlPctVsAvg = (xAvg - 1) * 100;
    }
    effCfg = cfgEffectiveForOpen(cfg, ot);

    /** Live Oscar: после первой `TP_LADDER` — при возврате к средней (≤ безубытка) один раз снять настраиваемую долю остатка. */
    if (
      isLiveOscarTradingStrategyId(cfg.strategyId) &&
      cfg.liveOscarBreakevenTrimAfterFirstTpEnabled &&
      !isWaveBExitPolicy(ot) &&
      !isVariantAExitPolicy(ot) &&
      !ot.liveBreakevenTrimDone &&
      ot.partialSells.some((p) => p.reason === 'TP_LADDER') &&
      ot.avgEntry > 0 &&
      curMetric > 0 &&
      ot.remainingFraction > 1e-9 &&
      xAvg <= 1 + LADDER_PNL_EPS
    ) {
      const trimFrac = Math.min(0.99, Math.max(0.01, cfg.liveOscarBreakevenTrimFraction));
      const rBe = await tryExecuteTpPartialSell({
        mint,
        ot,
        cfg: effCfg,
        curMetric,
        sellFraction: trimFrac,
        ladderStepIndex: 0,
        ladderRungsTotal: 0,
        ladderPnlPct: 0,
        tpGrid: false,
        journalAppend,
        journalLiveStrategy,
        livePhase4,
        liveOscarCfg,
        stats,
        markLadder: () => {},
        logLabelPct: `breakeven-trim-${(trimFrac * 100).toFixed(0)}pct-after-first-tp`,
        partialReason: 'BREAKEVEN_TRIM',
        timelineLabelRu:
          'Live Oscar · после 1-й фиксации TP откат к средней цене входа — частичная продажа ' +
          `${(trimFrac * 100).toFixed(0)}% остатка`,
      });
      if (rBe === 'ok') {
        ot.liveBreakevenTrimDone = true;
      }
    }

    if (ot.avgEntry > 0) {
      xAvg = curMetric / ot.avgEntry;
      pnlPctVsAvg = (xAvg - 1) * 100;
    }
    if (isPresetCScalpExitPolicy(ot)) {
      await tryPresetCScalpPartialExit({
        mint,
        ot,
        cfg: effCfg,
        curMetric,
        open,
        closed,
        tpLadder,
        journalAppend,
        journalLiveStrategy,
        livePhase4,
        liveOscarCfg,
        stats,
        btcCtx,
        verifyReconcileOrphanWalletZero,
        onMintFullClose: args.onMintFullClose,
      });
      if (ot.avgEntry > 0) {
        xAvg = curMetric / ot.avgEntry;
        pnlPctVsAvg = (xAvg - 1) * 100;
      }
    }
    await tryWaveBBreakevenInsurance({
      mint,
      ot,
      cfg: effCfg,
      curMetric,
      xAvg,
      tgEff,
      journalAppend,
      journalLiveStrategy,
      livePhase4,
      liveOscarCfg,
      stats,
    });
    await tryWaveBPreArmNoHalf8PartialExit({
      mint,
      ot,
      cfg: effCfg,
      curMetric,
      xAvg,
      journalAppend,
      journalLiveStrategy,
      livePhase4,
      liveOscarCfg,
      stats,
    });
    await tryWaveBPostTp1Derisk({
      mint,
      ot,
      cfg: effCfg,
      curMetric,
      xAvg,
      journalAppend,
      journalLiveStrategy,
      livePhase4,
      liveOscarCfg,
      stats,
    });

    /** Same tick as 2nd partial TP: peak block ran before `partialSells` grew — arm peak trailing if still at ATH. */
    if (!(isPaperOscarIdealized && idealizedMute) && ot.avgEntry > 0) {
      effCfg = cfgEffectiveForOpen(cfg, ot);
      tgEff = tpGridEffective(ot, effCfg);
      const xPost = curMetric / ot.avgEntry;
      const usesTpSlicesPost = tgEff.stepPnl > 0 || tpLadder.length > 0;
      const tpSlicesDonePost = ot.partialSells.filter((p) => p.reason === 'TP_LADDER').length;
      const pnlFracPost = xPost - 1;
      if (isWaveBExitPolicy(ot) || isVariantAHybridExitPolicy(ot)) {
        if (curMetric + 1e-18 >= ot.peakMcUsd && pnlFracPost + LADDER_PNL_EPS >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) {
          ot.trailingArmed = true;
        }
      } else if (
        curMetric + 1e-18 >= ot.peakMcUsd &&
        xPost >= effCfg.trailTriggerX &&
        (!usesTpSlicesPost || tpSlicesDonePost >= 2)
      ) {
        ot.trailingArmed = true;
      }
    }

    if (ot.avgEntry > 0) {
      xAvg = curMetric / ot.avgEntry;
    }
    await tryWaveBTrailPartialSells({
      mint,
      ot,
      cfg: effCfg,
      curMetric,
      xAvg,
      tgEff,
      journalAppend,
      journalLiveStrategy,
      livePhase4,
      liveOscarCfg,
      stats,
    });

    if (ot.avgEntry > 0) {
      xAvg = curMetric / ot.avgEntry;
      pnlPctVsAvg = (xAvg - 1) * 100;
    }
    await tryVariantAScratchPartialFlush({
      mint,
      ot,
      cfg: effCfg,
      curMetric,
      xAvg,
      journalAppend,
      journalLiveStrategy,
      livePhase4,
      liveOscarCfg,
      stats,
    });

    if (ot.avgEntry > 0) {
      xAvg = curMetric / ot.avgEntry;
      pnlPctVsAvg = (xAvg - 1) * 100;
    }
    await tryVariantAHybridThinVolFlush({
      mint,
      ot,
      cfg: effCfg,
      curMetric,
      xAvg,
      vol5mUsd: snapVol5m,
      journalAppend,
      journalLiveStrategy,
      livePhase4,
      liveOscarCfg,
      stats,
    });

    if (ot.avgEntry > 0) {
      xAvg = curMetric / ot.avgEntry;
      pnlPctVsAvg = (xAvg - 1) * 100;
    }

    /** Variant A v1: remainder peak for legacy moon/trail. */
    if (isVariantALegacyV1ExitPolicy(ot) && ot.avgEntry > 0) {
      variantAUpdateRemainderPeak(ot, pnlPctVsAvg / 100, cfg);
    }

    /**
     * Вторая нога (25%) — в конце тика: на этом же проходе уже обработаны DCA и partial TP.
     * Если сработало усреднение или частичный TP — pending снят выше, до сюда не доходим (вторая нога не нужна).
     */
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
        verifyStillOpen: () => open.has(openKey),
      });
    }

    if (!livePhase4 && isPaperOscarIdealized && ot.livePendingScaleIn && ot.partialSells.length === 0) {
      await tryPaperOnlyScaleInTrackerStep({
        cfg,
        ot,
        mint,
        curMetric,
        journalAppend,
        verifyStillOpen: () => open.has(openKey),
      });
    }

    if (ot.avgEntry > 0) {
      xAvg = curMetric / ot.avgEntry;
      pnlPctVsAvg = (xAvg - 1) * 100;
    }
    effCfg = cfgEffectiveForOpen(cfg, ot);
    killEff = dcaKillstopEffective(ot, effCfg);

    let exitReason: ExitReason | null = pendingTpProtectiveExit;

    if (
      cfg.flashCrashKillEnabled &&
      isLiveOscarTradingStrategyId(cfg.strategyId) &&
      !livePolicyOnlyExitsEnabled(liveOscarCfg) &&
      ot.avgEntry > 0 &&
      curMetric > 0 &&
      ot.remainingFraction > 1e-6
    ) {
      const flashNow = Date.now();
      const flash = evaluateFlashCrashKill(cfg, ot, flashNow, curMetric, {
        jupiterPx: ot.liveFlashLastJupiterPx,
        snapshotPx: ot.liveFlashLastSnapshotPx,
      });
      if (flash.kind === 'partial') {
        markFlashKillDcaBlocked(ot, cfg, flashNow);
        const flashPartial = await tryExecuteTpPartialSell({
          mint,
          ot,
          cfg,
          curMetric,
          sellFraction: flash.sellFraction,
          ladderStepIndex: -1,
          ladderRungsTotal: 0,
          ladderPnlPct: pnlPctVsAvg,
          tpGrid: false,
          journalAppend,
          journalLiveStrategy,
          livePhase4,
          liveOscarCfg,
          stats,
          markLadder: () => {},
          logLabelPct: flash.trigger,
          partialReason: 'FLASH_CRASH_KILL',
          timelineLabelRu: `Flash-килл: ${flash.trigger} · продажа ${(flash.sellFraction * 100).toFixed(0)}% остатка`,
        });
        if (flashPartial === 'abort_mint') continue;
        console.log(
          `[FLASH_KILL_PARTIAL] ${mint.slice(0, 8)} $${ot.symbol} sold=${(flash.sellFraction * 100).toFixed(0)}% ${flash.trigger}`,
        );
      } else if (flash.kind === 'full') {
        markFlashKillDcaBlocked(ot, cfg, flashNow);
        exitReason = 'FLASH_CRASH_KILL';
        console.log(`[FLASH_KILL] ${mint.slice(0, 8)} $${ot.symbol} ${flash.trigger}`);
      }
    }

    if (!exitReason && !(isPaperOscarIdealized && idealizedMute)) {
      if (isVariantALegacyV1ExitPolicy(ot) && ot.avgEntry > 0) {
        const pnlFracVa = pnlPctVsAvg / 100;
        if (variantAMoonExitTriggered(ot, effCfg, pnlFracVa)) {
          ot.liveVariantAExitTag = 'moon50';
          exitReason = 'TP';
        } else {
          const timedTag = variantAEvalTimedExit(ot, effCfg, pnlFracVa, ageH);
          if (timedTag) {
            ot.liveVariantAExitTag = timedTag;
            exitReason = 'TIMEOUT';
          } else if (variantATrailFullExitTriggered(ot, effCfg, pnlFracVa)) {
            ot.liveVariantAExitTag = 'trail';
            exitReason = 'TRAIL';
          }
        }
      } else if (isVariantAHybridExitPolicy(ot) && ot.avgEntry > 0) {
        const timedTag = variantAEvalTimedExit(ot, effCfg, pnlPctVsAvg / 100, ageH);
        if (timedTag) {
          ot.liveVariantAExitTag = timedTag;
          exitReason = 'TIMEOUT';
        }
      } else if (isVariantAScratchExitPolicy(ot) && ot.avgEntry > 0) {
        const timedTag = variantAEvalTimedExit(ot, effCfg, pnlPctVsAvg / 100, ageH);
        if (timedTag) {
          ot.liveVariantAExitTag = timedTag;
          exitReason = 'TIMEOUT';
        }
      }

      const inSignalKillTerritory = liveStagedEntryKillHit(ot, stagedEntryPriceUsd);
      if (
        !exitReason &&
        waveBPostTp1ScratchFullExitDue(effCfg, ot, curMetric)
      ) {
        ot.liveWavePostTp1ScratchTaken = true;
        exitReason = 'WAVE_B_POST_TP1_SCRATCH';
      }
      const waveBKill =
        isWaveBExitPolicy(ot) &&
        killEff < 0 &&
        waveBAbsoluteKillEligible(ot, killEff, curMetric, pnlPctVsAvg / 100);
      const presetCScalpKill =
        isPresetCScalpExitPolicy(ot) && presetCScalpKillEligible(ot, curMetric);
      const runnerProbeKill =
        isRunnerProbeExitPolicy(ot) && runnerProbeKillEligible(ot, curMetric, snapPx, cfg);
      const classicKill =
        !isWaveBExitPolicy(ot) &&
        !isPresetCScalpExitPolicy(ot) &&
        !isRunnerProbeExitPolicy(ot) &&
        !ot.liveStagedEntry &&
        killEff < 0 &&
        pnlPctVsAvg / 100 <= killEff;
      const inKillTerritory =
        !isVariantAExitPolicy(ot) &&
        (inSignalKillTerritory || waveBKill || presetCScalpKill || runnerProbeKill || classicKill);
      if (inKillTerritory) {
        if (ghostExitTick) {
          ot.liveKillstopBelowStreak = 0;
          log.warn(
            {
              mint: mint.slice(0, 8),
              symbol: ot.symbol,
              rawMtmUsd: +rawTrackerPriceUsd.toFixed(8),
              exitMtmUsd: +exitMtmForJournal.toFixed(8),
              prevObservedUsd: +prevObservedPriceUsd.toFixed(8),
            },
            'live tracker: KILLSTOP suppressed on ghost MTM tick',
          );
        } else if (waveBKill || presetCScalpKill || runnerProbeKill) {
          ot.liveKillstopBelowStreak = 0;
          exitReason = 'KILLSTOP';
        } else {
        const debounceKillAfterReplenish =
          isLiveOscarTradingStrategyId(cfg.strategyId) && ot.legs.length > 1 && !inSignalKillTerritory;
        if (debounceKillAfterReplenish) {
          const nextStreak = (ot.liveKillstopBelowStreak ?? 0) + 1;
          ot.liveKillstopBelowStreak = nextStreak;
          if (nextStreak >= 2) exitReason = 'KILLSTOP';
          else {
            console.log(
              `[KILLSTOP_DEBOUNCE] ${mint.slice(0, 8)} $${ot.symbol} streak=${nextStreak}/2 legs=${ot.legs.length} pnlVsAvg=${pnlPctVsAvg.toFixed(2)}% killEff=${(killEff * 100).toFixed(1)}%`,
            );
          }
        } else {
          ot.liveKillstopBelowStreak = 0;
          exitReason = 'KILLSTOP';
        }
        }
      } else {
        ot.liveKillstopBelowStreak = 0;
      }

      if (!exitReason) {
        if (
          isPresetCScalpExitPolicy(ot) &&
          presetCScalpBreakevenExitEligible(ot, curMetric) &&
          (ot.presetCScalpTp5Taken || ot.presetCScalpTp10Taken)
        ) {
          exitReason = 'BREAKEVEN_EXIT';
        } else if (isPresetCScalpExitPolicy(ot)) {
          const scalpFull = evaluatePresetCScalpExitAction(ot, cfg, curMetric);
          if (scalpFull.kind === 'full_exit') exitReason = scalpFull.reason;
        } else if (
          isWaveBExitPolicy(ot) &&
          waveBPreArmNoHalf8PullbackFullExitEligible(ot, effCfg, pnlPctVsAvg / 100) &&
          ot.avgEntry > 0
        ) {
          exitReason = 'BREAKEVEN_EXIT';
        } else if (
          isWaveBExitPolicy(ot) &&
          waveBBreakevenAtZeroExitEligible(ot, tgEff.stepPnl) &&
          ot.avgEntry > 0 &&
          pnlPctVsAvg <= 0
        ) {
          exitReason = 'BREAKEVEN_EXIT';
        } else if (runnerProbeTpEligible(ot, curMetric, snapPx, cfg)) exitReason = 'TP';
        else if (xAvg >= effCfg.tpX) exitReason = 'TP';
        else if (effCfg.slX > 0 && xAvg <= effCfg.slX) exitReason = 'SL';
        else if (
          effCfg.trailMode === 'ladder_retrace' &&
          !isWaveBExitPolicy(ot) &&
          !isVariantAExitPolicy(ot) &&
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
      }
    }
    if (
      !exitReason &&
      !isWaveBExitPolicy(ot) &&
      !isVariantAExitPolicy(ot) &&
      !isScalpWaveExitPolicy(ot) &&
      ageH >= effCfg.timeoutHours &&
      !timeoutSuppressedByProgress(ot)
    )
      exitReason = 'TIMEOUT';
    if (
      !exitReason &&
      isScalpWaveExitPolicy(ot) &&
      ageH >= effCfg.timeoutHours
    )
      exitReason = 'TIMEOUT';
    /**
     * Wave B time-stop (1.11.475): legacy Wave B has no time-stop; applied ONLY to opens stamped with a
     * flat-take mode (`liveWaveFlatTpMode`), so in-flight (pre-change) opens are never force-closed.
     */
    if (
      !exitReason &&
      isWaveBExitPolicy(ot) &&
      ot.liveWaveFlatTpMode != null &&
      cfg.liveOscarWaveBTimeStopHours > 0 &&
      ageH >= cfg.liveOscarWaveBTimeStopHours
    )
      exitReason = 'TIMEOUT';
    /**
     * Hard profit-agnostic time-stop (downhill capital rotation): once a position is older than the
     * configured hours, force a real full exit regardless of exit policy, PnL, or progress. Fires only
     * after TP/kill/trail were evaluated above, so wins still exit on their own signal within the window.
     * `TIME_STOP` is policy-allowed (executes on-chain sell, unlike journal-only TIMEOUT). `0` disables.
     */
    if (
      !exitReason &&
      curMetric > 0 &&
      cfg.liveOscarHardTimeStopHours > 0 &&
      ageH >= cfg.liveOscarHardTimeStopHours
    )
      exitReason = 'TIME_STOP';
    if (!exitReason && liveOscarCfg) {
      const reconcileMinUsd = liveWalletBalanceReconcileMinUsd(liveOscarCfg);
      const journalZero = ot.remainingFraction <= WALLET_RECONCILE_REMAINING_EPS;
      if (
        ot.partialSells.length > 0 &&
        shouldForceCloseJournalZeroChainTail({
          remainingFraction: ot.remainingFraction,
          chainOscarUsd: chainOscarUsdForMint,
          journalRemainingUsd: journalRemainingUsd(ot),
          minUsd: reconcileMinUsd,
          tailFlushThresholdUsd: liveOscarCfg.liveTailFlushThresholdUsd,
          partialSellCount: ot.partialSells.length,
        })
      ) {
        const lastPartial = ot.partialSells[ot.partialSells.length - 1]!;
        exitReason = partialReasonToExitReason(lastPartial.reason);
      } else if (journalZero && !(chainOscarUsdForMint >= reconcileMinUsd)) {
        exitReason = 'TP';
      }
    }

    if (
      exitReason &&
      livePhase4 &&
      !isPolicyAllowedFullExitReason(exitReason, liveOscarCfg)
    ) {
      journalLiveStrategy?.({
        kind: 'risk_note',
        reason: 'policy_only_exit_blocked',
        mint,
        detail: { exitReason, symbol: ot.symbol },
      });
      log.info(
        { mint: mint.slice(0, 8), symbol: ot.symbol, exitReason },
        'policy-only exits: blocked non-policy full exit (no Jupiter sell)',
      );
      continue;
    }

    if (exitReason) {
      const reconcileMinUsd = liveWalletBalanceReconcileMinUsd(liveOscarCfg);
      const marketSell = curMetric;
      const investedRemaining = planFullExitUsdNotional({
        ot,
        chainOscarUsd: chainOscarUsdForMint,
      });
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
      /** Block re-entry while Jupiter full sell is still retrying (MENSA-class race). */
      armPostExitReentryGateFromClosedTrade(cfg, ct);
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
        /** TIMEOUT / TIME_STOP bypass verify immediately; other reasons escalate after `priceVerifyExitMaxDefersEscalation` defers. */
        ignoreBlockOnFail: escalateCloseVerify || exitReason === 'TIMEOUT' || exitReason === 'TIME_STOP',
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

      let sellFullOut: LiveTokenToSolSellResult = { ok: true };
      if (livePhase4 && marketSell > 0 && investedRemaining > 1e-6) {
        sellFullOut = await livePhase4.tryTokenToSolSell({
          mint,
          symbol: ot.symbol,
          usdNotional: investedRemaining,
          priceUsdPerToken: marketSell,
          referencePriceUsd: liveSellReferencePriceUsd(ot),
          decimals: ot.tokenDecimals ?? 6,
          intentKind: 'sell_full',
          onSliceSuccess: async (sliceInfo) => {
            if (!liveOscarCfg) return;
            await syncOpenTradeAfterLiveExitSlice({
              mint,
              ot,
              marketSell,
              liveOscarCfg,
              reconcileMinUsd,
              partialReason: exitReasonToPartialSellReason(exitReason),
              sliceInfo,
            });
            journalLiveStrategy?.({
              kind: 'live_position_partial_sell',
              mint,
              openTrade: serializeOpenTrade(ot),
            });
          },
        });
        const chainCloseProceeds =
          sellFullOut.solProceedsLamports != null && sellFullOut.solProceedsLamports > 0n;
        if (!sellFullOut.ok && !chainCloseProceeds) {
          if (sellFullOut.preflightSkipReason === 'wallet_spl_balance_zero') {
            const synced = await closeOpenTradeWalletZeroPolicySync({
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
              onMintFullClose: args.onMintFullClose,
              forcedExitReason: exitReason,
            });
            if (synced) {
              peakStateByMint.delete(mint);
              continue;
            }
          }
          continue;
        }
        if (!sellFullOut.ok && chainCloseProceeds) {
          log.warn(
            {
              mint: mint.slice(0, 8),
              symbol: ot.symbol,
              preflightSkipReason: sellFullOut.preflightSkipReason,
              solProceedsLamports: sellFullOut.solProceedsLamports?.toString(),
            },
            'live full exit exit-slice partial chain success — retry remainder next tick',
          );
          continue;
        }
      }
      applyLiveFullCloseProceedsFromChain({
        ct,
        ot,
        cfg,
        sellOut: sellFullOut,
        marketSell,
        networkFeeUsdPerTx: perTxClose,
      });
      stampFullExitTxSignature(ct, sellFullOut);
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
      open.delete(openKey);
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
        exit_effective_price: ct.effective_exit_price,
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
      afterFullCloseReentryGate(args, cfg, ct);
      if (exitReason === 'WAVE_B_POST_TP1_SCRATCH') {
        armWaveBPostTp1ScratchReentryFromOpenTrade(ot, cfg, journalAppend);
      }
      hookLiveWhitelistAfterFullClose(
    liveOscarCfg,
    cfg,
    mint,
    ot.symbol,
    ct.netPnlUsd,
    ot.liveMintFirstProbe === true,
    ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct,
    ot.liveVariantAExitTag,
    ot,
    ct.effective_exit_price > 0 ? ct.effective_exit_price : ct.theoretical_exit_price,
  );
      scheduleTailAfterLiveClose(
        liveOscarCfg,
        mint,
        ot.symbol,
        ot.tokenDecimals ?? 6,
        marketSell,
        ot.source,
        ct.exitReason,
      );
      peakStateByMint.delete(mint);
      const arrow = ct.pnlPct >= 0 ? '+' : '';
      console.log(
        `[${exitReason}] ${mint.slice(0, 8)} $${ot.symbol} pnl_net=${arrow}${ct.pnlPct.toFixed(1)}%/$${ct.netPnlUsd.toFixed(2)} legs=${ot.legs.length} sells=${ot.partialSells.length} age=${ageH.toFixed(1)}h`,
      );
    }

    if (curMetric > 0 && open.has(openKey)) {
      const ote = open.get(openKey);
      if (ote) {
        if (Number.isFinite(dropFromFirstPct)) ote.dcaLastEvalDropFromFirstPct = dropFromFirstPct;
        const splitOk = ote.legs.some((l) => l.reason === 'scale_in');
        if (
          isLiveOscarTradingStrategyId(cfg.strategyId) &&
          cfg.liveExitModeAbEnabled &&
          ote.liveExitProfileMode == null &&
          splitOk &&
          ote.avgEntry > 0
        ) {
          ote.dcaLastEvalPnlVsAvgFrac = curMetric / ote.avgEntry - 1;
        }
      }
    }
  }

  await tryWaveBPostTp1ScratchReentryOpens({
    cfg,
    open,
    journalAppend,
    journalLiveStrategy,
    livePhase4,
    liveOscarCfg,
  });
}
