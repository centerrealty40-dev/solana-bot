import type { PaperTraderConfig } from './config.js';
import {
  refreshWaveBGridOverrides,
  waveBReconcileMaxExecutedTpFromMarks,
  WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC,
  WAVE_B_V1_TP_GRID,
} from './executor/exit-policy-wave-b.js';
import {
  buildLiveStagedEntryState,
  markEntrySplitLeg1Filled,
} from './executor/live-staged-entry-gates.js';
import {
  isLiveOscarScalpWaveLaneEnabled,
  isLiveOscarScalpWaveTrade,
  resolveLiveOscarTradeLaneFromOpen,
  type LiveOscarTradeLane,
} from './live-oscar-scalp-wave.js';
import {
  resolveLiveOscarMcapTier,
  type LiveOscarTradeTier,
} from './live-oscar-mcap-tier.js';
import type { OpenTrade } from './types.js';
import { isLiveOscarTradingStrategyId } from '../preset-c/live-oscar-family.js';

export type ScalpPhaseEscalationTrigger = 'deep_dip' | 'timestop_no_tp' | 'discovery_handoff';

/** Scalp shallow zone floor (e.g. −15%): deeper dip → prod/low takes over. */
export function liveOscarScalpEscalationDeepDipPct(cfg: PaperTraderConfig): number {
  return Math.abs(cfg.liveOscarScalpWaveDipMinDropPct);
}

export function scalpEntryAnchorPriceUsd(ot: OpenTrade): number {
  const openLeg = ot.legs.find((l) => l.reason === 'open');
  const px = openLeg?.marketPrice ?? openLeg?.price ?? ot.avgEntryMarket ?? ot.avgEntry;
  return Number.isFinite(px) && px > 0 ? px : 0;
}

/** Drop % from scalp entry anchor (negative = deeper dip). */
export function computeDropFromScalpAnchor(ot: OpenTrade, curPriceUsd: number): number | null {
  const anchor = scalpEntryAnchorPriceUsd(ot);
  if (!(anchor > 0) || !(curPriceUsd > 0)) return null;
  return (curPriceUsd / anchor - 1) * 100;
}

export function isScalpWaveEscalationEligible(
  ot: Pick<
    OpenTrade,
    'liveOscarTradeLane' | 'liveOscarMcapTier' | 'liveExitPolicyId' | 'liveOscarPhaseEscalatedFrom'
  >,
): boolean {
  if (ot.liveOscarPhaseEscalatedFrom === 'scalp_wave') return false;
  return isLiveOscarScalpWaveTrade(ot);
}

export function isLiveOscarPhaseEscalationEnabled(cfg: PaperTraderConfig): boolean {
  return isLiveOscarTradingStrategyId(cfg.strategyId) && isLiveOscarScalpWaveLaneEnabled(cfg);
}

export function evaluateScalpPhaseEscalationTrigger(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  curPriceUsd: number;
  ageHours: number;
}): ScalpPhaseEscalationTrigger | null {
  const { cfg, ot, curPriceUsd, ageHours } = args;
  if (!isLiveOscarPhaseEscalationEnabled(cfg)) return null;
  if (!isScalpWaveEscalationEligible(ot)) return null;

  const dropPct = computeDropFromScalpAnchor(ot, curPriceUsd);
  const deepThreshold = liveOscarScalpEscalationDeepDipPct(cfg);
  if (dropPct != null && dropPct <= -deepThreshold - 1e-9) {
    return 'deep_dip';
  }

  const timeoutH = cfg.liveOscarScalpWaveTimeStopHours;
  const anchorPx = scalpEntryAnchorPriceUsd(ot);
  const tpX = 1 + cfg.liveOscarScalpWaveTpPct;
  const xAvg =
    anchorPx > 0 && curPriceUsd > 0 ? curPriceUsd / (ot.avgEntry > 0 ? ot.avgEntry : anchorPx) : 1;
  if (ageHours >= timeoutH - 1e-9 && xAvg < tpX - 1e-9) {
    return 'timestop_no_tp';
  }

  return null;
}

export function resolveEscalationMcapTier(
  cfg: PaperTraderConfig,
  mcapUsd: number | null | undefined,
): LiveOscarTradeTier {
  if (mcapUsd != null && mcapUsd > 0) {
    const t = resolveLiveOscarMcapTier(cfg, mcapUsd);
    if (t === 'micro' || t === 'low' || t === 'prod') return t;
  }
  return 'low';
}

function migrateScalpOpenToWaveB(ot: OpenTrade, pnlFrac?: number): void {
  ot.liveExitPolicyId = 'wave_b_v1';
  refreshWaveBGridOverrides(ot);
  if (!ot.ladderUsedIndices) ot.ladderUsedIndices = new Set();
  else ot.ladderUsedIndices.clear();
  if (!ot.ladderUsedLevels) ot.ladderUsedLevels = new Set();

  const peakFromOt =
    typeof ot.peakPnlPct === 'number' && Number.isFinite(ot.peakPnlPct) ? ot.peakPnlPct / 100 : 0;
  const peak = Math.max(peakFromOt, pnlFrac ?? 0, ot.liveWavePeakPnlFrac ?? 0);
  ot.liveWavePeakPnlFrac = peak;
  ot.liveWaveTrailAnchorPnlFrac = Math.max(ot.liveWaveTrailAnchorPnlFrac ?? 0, peak);
  ot.liveWaveTrailLevelsTaken = ot.liveWaveTrailLevelsTaken ?? [];
  ot.liveWaveMaxExecutedTpFrac = ot.liveWaveMaxExecutedTpFrac ?? 0;

  waveBReconcileMaxExecutedTpFromMarks(ot, WAVE_B_V1_TP_GRID.gridStepPnl);

  if (peak + 1e-6 >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) {
    ot.trailingArmed = true;
  }
}

/**
 * Hand off scalp_wave position to prod lane: wave_b_v1 exit + staged entry legs for deeper tiers.
 * Idempotent when already escalated.
 */
export function applyLiveOscarPhaseEscalation(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  trigger: ScalpPhaseEscalationTrigger;
  marketCapUsd?: number | null;
  curPriceUsd?: number;
}): boolean {
  const { cfg, ot, trigger, marketCapUsd, curPriceUsd } = args;
  if (!isLiveOscarPhaseEscalationEnabled(cfg)) return false;
  if (!isScalpWaveEscalationEligible(ot)) return false;

  const anchorPx = scalpEntryAnchorPriceUsd(ot);
  const tier = resolveEscalationMcapTier(cfg, marketCapUsd ?? ot.entryMarketCapUsd);

  ot.liveOscarPhaseEscalatedFrom = 'scalp_wave';
  ot.liveOscarTradeLane = 'prod';
  ot.liveOscarMcapTier = tier;

  const pnlFrac =
    anchorPx > 0 && curPriceUsd != null && curPriceUsd > 0 ? curPriceUsd / anchorPx - 1 : undefined;
  migrateScalpOpenToWaveB(ot, pnlFrac);

  if (cfg.liveStagedEntryEnabled && anchorPx > 0) {
    ot.liveStagedEntry = buildLiveStagedEntryState(
      cfg,
      { signalTs: ot.entryTs, signalPriceUsd: anchorPx },
      { marketCapUsd: marketCapUsd ?? ot.entryMarketCapUsd },
    );
    markEntrySplitLeg1Filled(ot.liveStagedEntry, ot);
    const leg2Usd = ot.liveStagedEntry.entrySplitLeg2Usd ?? 0;
    ot.liveStagedEntry.entrySplitLeg2Done = leg2Usd <= 0;
    ot.liveStagedEntry.secondLegDone = false;
    ot.liveStagedEntry.avgFirstLegDone = false;
    ot.liveStagedEntry.avgSecondLegDone = false;
    if (ot.liveStagedEntry.thirdLegUsd != null && ot.liveStagedEntry.thirdLegUsd > 0) {
      ot.liveStagedEntry.thirdLegDone = false;
    }
  }

  ot.liveKillstopBelowStreak = 0;
  if (ot.tpGridOverrides) {
    ot.tpGridOverrides = { ...ot.tpGridOverrides, dcaKillstop: 0 };
  }

  console.log(
    `[PHASE_ESCALATION] ${(ot.mint ?? '?').slice(0, 8)} $${ot.symbol ?? '?'} scalp_wave → ${tier} (${trigger}) lane=prod policy=wave_b_v1`,
  );
  return true;
}

export type LiveOscarMintOpenSkipReason =
  | 'lane_mint_mutex'
  | 'already_open'
  | 'phase_escalation_handoff'
  | null;

/** Mutex: allow prod/low discovery to take over an open scalp_wave position. */
export function liveOscarMintOpenSkipReasonForEscalation(args: {
  open: ReadonlyMap<string, OpenTrade>;
  mint: string;
  incomingTradeLane: LiveOscarTradeLane;
  cfg: PaperTraderConfig;
}): LiveOscarMintOpenSkipReason {
  const existing = args.open.get(args.mint);
  if (!existing) return null;
  const openLane = resolveLiveOscarTradeLaneFromOpen(existing);
  if (openLane === args.incomingTradeLane) return 'already_open';
  if (
    openLane === 'scalp_wave' &&
    args.incomingTradeLane === 'prod' &&
    isLiveOscarPhaseEscalationEnabled(args.cfg) &&
    isScalpWaveEscalationEligible(existing)
  ) {
    return 'phase_escalation_handoff';
  }
  return 'lane_mint_mutex';
}
