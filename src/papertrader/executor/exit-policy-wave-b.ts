/**
 * Live Oscar exit policy «wave B» (v1) — per-open policy id + legacy grid freeze for in-flight positions.
 * See product spec EXIT_WAVE_B (discussion 2026-05).
 */
import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { isLiveOscarTradingStrategyId } from '../../preset-c/live-oscar-family.js';
import { LADDER_PNL_EPS } from './tp-ladder-state.js';
import {
  stampVariantAOnOpen,
  isVariantAExitPolicy,
  isVariantAHybridExitPolicy,
} from './exit-policy-variant-a.js';
import { stampScalpWaveExitPolicyOnOpen } from './exit-policy-scalp-wave.js';

export type LiveExitPolicyId = 'legacy_grid' | 'wave_b_v1' | 'variant_a_v1' | 'variant_a_v2' | 'variant_a_v3';

/** Prod grid pinned for opens/restores without `liveExitPolicyId` (1.11.168 live-oscar). */
export const LEGACY_LIVE_OSCAR_TP_GRID = {
  gridStepPnl: 0.05,
  gridSellFractionByStep: [0.1, 0.3, 0.5, 0.7, 0.7],
  gridFirstRungRetraceMinPnlPct: 0.03,
} as const;

/**
 * Wave B v1 — escalating TP sell profile (both branches): rung k @ +k×2.5% PnL → k×5% of remainder.
 * +2.5%→5%, +5%→10%, +7.5%→15%, +10%→20%, … capped at 100% (rungs 21+).
 */
export const WAVE_B_ESCALATING_SELL_PROFILE: readonly number[] = [
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9,
  0.95, 1,
];

/**
 * Wave B v1 — averaging branch (≥1 `staged_avg`/`dca` leg).
 * Each +2.5% rung → escalating % of remainder (see profile).
 * Defensive trail (after +10% TP or peak): each −2.5% from peak anchor → 20% of remainder.
 * Breakeven full exit at ≤0% avg PnL only after TP ≥+7.5% taken. TP rungs above +2.5% reset after deep pullback.
 */
export const WAVE_B_V1_TP_GRID = {
  gridStepPnl: 0.025,
  gridSellFractionByStep: WAVE_B_ESCALATING_SELL_PROFILE,
  gridFirstRungRetraceMinPnlPct: 0,
} as const;

/**
 * Wave B v1 — default branch (no `staged_avg`/`dca` legs yet, entry split via `scale_in`/`entry_split` ignored).
 * Same +2.5% step and escalating sell profile as averaging branch.
 */
export const WAVE_B_V1_TP_GRID_NO_AVG = {
  gridStepPnl: 0.025,
  gridSellFractionByStep: WAVE_B_ESCALATING_SELL_PROFILE,
  gridFirstRungRetraceMinPnlPct: 0,
} as const;

/**
 * Wave B flat-take profile «half8_runner» (1.11.475, owner-approved) — early/flat take that REPLACES
 * the escalating ladder for opens stamped `liveWaveFlatTpMode='half8_runner'`. Each +8% step sells 50%
 * of the remainder (re-arms on pullback below the rung), then the defensive trail rides/exits the
 * runner on retrace from peak; breakeven floor (+7.5%) and kill (−50%) machinery stay intact.
 */
export const WAVE_B_FLAT_TP_HALF8_RUNNER = {
  gridStepPnl: 0.08,
  gridSellFractionByStep: [0.5],
  gridFirstRungRetraceMinPnlPct: 0,
} as const;

/**
 * Wave B flat-take profile «flat» (1.11.475) — sell 100% at +15% PnL, NO trail (suppressed below the
 * target); for opens stamped `liveWaveFlatTpMode='flat'`. Kill (−50%) stays intact.
 */
export const WAVE_B_FLAT_TP_FLAT15 = {
  gridStepPnl: 0.15,
  gridSellFractionByStep: [1],
  gridFirstRungRetraceMinPnlPct: 0,
} as const;

/**
 * True iff trade has at least one averaging leg (`dca` or `staged_avg`).
 * Entry split legs (`scale_in`, `entry_split`) are NOT averaging — they are the 500+500 split of the initial entry.
 */
export function hasAveragingLeg(ot: OpenTrade): boolean {
  return ot.legs.some((l) => l.reason === 'dca' || l.reason === 'staged_avg');
}

/**
 * Wave B grid profile selector. Opens stamped with a flat-take mode (1.11.475) use the flat profile;
 * otherwise averaging-aware escalating ladder. The flat stamp is set ONLY on new opens when the flag
 * is on (see `stampLiveOscarExitPolicyOnOpen`), so in-flight opens keep their escalating ladder.
 */
export function waveBTpGridProfileFor(ot: OpenTrade): {
  gridStepPnl: number;
  gridSellFractionByStep: readonly number[];
  gridFirstRungRetraceMinPnlPct: number;
} {
  if (ot.liveWaveFlatTpMode === 'half8_runner') return WAVE_B_FLAT_TP_HALF8_RUNNER;
  if (ot.liveWaveFlatTpMode === 'flat') return WAVE_B_FLAT_TP_FLAT15;
  return hasAveragingLeg(ot) ? WAVE_B_V1_TP_GRID : WAVE_B_V1_TP_GRID_NO_AVG;
}

/** Sell fraction of remainder for wave B TP grid step k (1-based): k×5%, cap 100%. */
export function waveBSellFractionForStep(kOneBased: number): number {
  if (kOneBased < 1) return 0;
  return Math.min(1, kOneBased * 0.05);
}

/** Key impulse level (+7.5%): breakeven full exit, trail arm, pre-arm kill disable. */
export const WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC = 0.075;
/** Defensive trail arms when peak or highest TP rung ≥ this (+7.5%). */
export const WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC = WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC;
/** Early kill-stop (PnL vs entry market) disabled after first touch of this level (+7.5%). */
export const WAVE_B_PRE_ARM_KILL_ARM_PNL_FRAC = WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC;

export function waveBEntryMarketUsd(ot: OpenTrade): number {
  return ot.avgEntryMarket > 0
    ? ot.avgEntryMarket
    : ot.legs[0]?.marketPrice ?? ot.legs[0]?.price ?? ot.avgEntry ?? 0;
}

export function waveBMarketPnlFrac(ot: OpenTrade, marketPx: number): number {
  const entryMkt = waveBEntryMarketUsd(ot);
  if (!(entryMkt > 0) || !(marketPx > 0)) return 0;
  return marketPx / entryMkt - 1;
}

/** Mark pre-arm complete once price touches +7.5% vs entry market (trail + kill-off gate). */
export function waveBUpdatePreArmReached(ot: OpenTrade, marketPx: number): void {
  if (ot.liveWavePreArmReached === true) return;
  if (waveBMarketPnlFrac(ot, marketPx) + LADDER_PNL_EPS >= WAVE_B_PRE_ARM_KILL_ARM_PNL_FRAC) {
    ot.liveWavePreArmReached = true;
  }
}

export function waveBPreArmKillEligible(ot: OpenTrade, killFrac: number, marketPx: number): boolean {
  if (!isWaveBExitPolicy(ot) || !(killFrac < 0)) return false;
  if (ot.liveWavePreArmReached === true) return false;
  return waveBMarketPnlFrac(ot, marketPx) <= killFrac + 1e-9;
}

/** Hard floor −9% (market and avg) — always, including after +7.5% touch. */
export function waveBAbsoluteKillEligible(
  ot: OpenTrade,
  killFrac: number,
  marketPx: number,
  pnlFracAvg: number,
): boolean {
  if (!isWaveBExitPolicy(ot) || !(killFrac < 0)) return false;
  if (waveBMarketPnlFrac(ot, marketPx) <= killFrac + 1e-9) return true;
  return pnlFracAvg <= killFrac + 1e-9;
}
/** Pullback at/below this level re-opens TP rungs (full or partial reset). */
export const WAVE_B_TP_IMPULSE_RESET_PNL_FRAC = 0.025;
/** @deprecated alias — use `WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC` / defensive arm at +7.5%. */
export const WAVE_B_ARM_MIN_PNL_FRAC = WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC;
export const WAVE_B_TRAIL_STEP_SELL_FRACTION = 0.2;
/** Wave B: if modeled remainder notional is below this, any TP/trail partial sells 100% (no dust). */
export const WAVE_B_TRAIL_FLUSH_REMAIN_USD = 100;
/** Max single-tick MTM jump vs last observed price for peak / trail / TP (anti ghost-quote). */
export const WAVE_B_MTM_MAX_TICK_JUMP_FRAC = 0.12;

/**
 * Clamp tradable MTM used for exit decisions when Jupiter/PG spikes in one tick (thin-route ghost).
 * Uses prior `lastObservedPriceUsd` (or entry) — call before updating last observed for the tick.
 */
export function clampLiveTrackerMtmForExit(ot: OpenTrade, curMetricUsd: number): number {
  if (!(curMetricUsd > 0)) return curMetricUsd;
  const prev =
    ot.lastObservedPriceUsd ??
    (ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.avgEntry > 0 ? ot.avgEntry : 0);
  if (!(prev > 0)) return curMetricUsd;
  const maxUp = prev * (1 + WAVE_B_MTM_MAX_TICK_JUMP_FRAC);
  const minDown = prev * (1 - WAVE_B_MTM_MAX_TICK_JUMP_FRAC);
  if (curMetricUsd > maxUp) return maxUp;
  if (curMetricUsd < minDown) return minDown;
  return curMetricUsd;
}

/**
 * Open restored with ghost peak (arm + anchor ≫ real PnL, no TRAIL_STEP yet): disarm before next tick sells.
 */
export function waveBRecoverPhantomPeakIfNeeded(ot: OpenTrade, pnlFrac: number): boolean {
  if ((!isWaveBExitPolicy(ot) && !isVariantAHybridExitPolicy(ot)) || !ot.trailingArmed) return false;
  const anchor = ot.liveWaveTrailAnchorPnlFrac ?? 0;
  if (anchor + LADDER_PNL_EPS < WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC + 0.02) return false;
  if (pnlFrac + LADDER_PNL_EPS >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) return false;
  if ((ot.partialSells ?? []).some((p) => p.reason === 'TRAIL_STEP')) return false;
  ot.liveWavePeakPnlFrac = Math.max(0, pnlFrac);
  ot.liveWaveTrailAnchorPnlFrac = Math.max(0, pnlFrac);
  ot.liveWaveTrailLevelsTaken = [];
  ot.trailingArmed = false;
  return true;
}

/** Highest TP grid threshold (PnL frac) already marked on this open (includes MTM peak for trail). */
export function waveBHighestTpGridThresholdTaken(ot: OpenTrade, stepPnl: number): number {
  let max = waveBExecutedTpGridThresholdTaken(ot, stepPnl);
  const peak = ot.liveWavePeakPnlFrac ?? 0;
  if (peak > max) max = peak;
  return max;
}

/** Max TP threshold from current ladder marks only (no persisted / MTM fields). */
export function waveBExecutedTpGridThresholdFromMarks(ot: OpenTrade, stepPnl: number): number {
  let max = 0;
  if (stepPnl > 0) {
    for (const idx of ot.ladderUsedIndices) {
      const t = (idx + 1) * stepPnl;
      if (t > max) max = t;
    }
  }
  for (const u of ot.ladderUsedLevels) {
    if (Number.isFinite(u) && u > max) max = u;
  }
  return max;
}

/** TP rungs actually taken via partial sells — excludes MTM-only `liveWavePeakPnlFrac`. */
export function waveBExecutedTpGridThresholdTaken(ot: OpenTrade, stepPnl: number): number {
  const fromMarks = waveBExecutedTpGridThresholdFromMarks(ot, stepPnl);
  const persisted = ot.liveWaveMaxExecutedTpFrac ?? 0;
  return Math.max(fromMarks, persisted);
}

/** Record executed TP rung — survives impulse reset for breakeven eligibility. */
export function waveBOnTpGridRungExecuted(ot: OpenTrade, thresholdFrac: number): void {
  if (!isWaveBExitPolicy(ot) || !(thresholdFrac > 0) || !Number.isFinite(thresholdFrac)) return;
  const prev = ot.liveWaveMaxExecutedTpFrac ?? 0;
  if (thresholdFrac > prev) ot.liveWaveMaxExecutedTpFrac = thresholdFrac;
}

/** Backfill persisted max from ladder marks / journal replay when field absent. */
export function waveBReconcileMaxExecutedTpFromMarks(ot: OpenTrade, stepPnl: number): void {
  if (!isWaveBExitPolicy(ot)) return;
  const fromMarks = waveBExecutedTpGridThresholdFromMarks(ot, stepPnl);
  waveBOnTpGridRungExecuted(ot, fromMarks);
}

/** Defensive trail: peak or TP ladder reached ≥ +7.5%. Suppressed for `flat` mode (sell 100% at target). */
export function waveBDefensiveTrailActive(ot: OpenTrade, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot)) return false;
  if (ot.liveWaveFlatTpMode === 'flat') return false;
  return waveBHighestTpGridThresholdTaken(ot, stepPnl) + LADDER_PNL_EPS >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC;
}

/**
 * Full close at ≤0% avg PnL only after +7.5% impulse (+7.5% TP taken or entry-market touch).
 * Before that gate: partial insurance 50% after +2.5%/+5%, then kill −9% if needed.
 */
export function waveBBreakevenExitEligible(ot: OpenTrade, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot)) return false;
  if (ot.liveWavePreArmReached === true) return true;
  return waveBExecutedTpGridThresholdTaken(ot, stepPnl) + LADDER_PNL_EPS >= WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC;
}

/** True when TP grid rungs +2.5% (idx 0) and +5% (idx 1) were both executed. */
export function waveBFirstTwoTpRungsTaken(ot: OpenTrade, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot) || !(stepPnl > 0)) return false;
  const t1 = stepPnl;
  const t2 = 2 * stepPnl;
  let hasFirst = ot.ladderUsedIndices.has(0);
  let hasSecond = ot.ladderUsedIndices.has(1);
  for (const u of ot.ladderUsedLevels) {
    if (!Number.isFinite(u)) continue;
    if (Math.abs(u - t1) <= LADDER_PNL_EPS) hasFirst = true;
    if (Math.abs(u - t2) <= LADDER_PNL_EPS) hasSecond = true;
  }
  return hasFirst && hasSecond;
}

/**
 * Wave B insurance peel: first two TP rungs taken, max executed TP still below +7.5% full-exit gate,
 * insurance not yet fired.
 */
export function waveBBreakevenInsuranceEligible(ot: OpenTrade, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot) || ot.liveWaveBreakevenInsuranceTaken) return false;
  if (!waveBFirstTwoTpRungsTaken(ot, stepPnl)) return false;
  return (
    waveBExecutedTpGridThresholdTaken(ot, stepPnl) + LADDER_PNL_EPS < WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC
  );
}

/** Wave B post-TP1 de-risk: ≥1 TP ladder partial taken, peel not yet fired. */
export function waveBPostTp1DeriskEligible(ot: OpenTrade): boolean {
  if (!isWaveBExitPolicy(ot) || ot.liveWavePostTp1DeriskTaken) return false;
  return ot.partialSells.some((p) => p.reason === 'TP_LADDER');
}

/** Wave B post-TP1 scratch: ≥1 TP ladder partial taken, full scratch not yet fired. */
export function waveBPostTp1ScratchEligible(ot: OpenTrade): boolean {
  if (!isWaveBExitPolicy(ot) || ot.liveWavePostTp1ScratchTaken) return false;
  return ot.partialSells.some((p) => p.reason === 'TP_LADDER');
}

/**
 * Clear all TP ladder marks so +2.5% / +5% / … can fire again on the next rally.
 * Resets trail descent state; keeps `liveWaveMaxExecutedTpFrac` for breakeven-exit gate.
 */
export function waveBClearAllTpLadderMarks(ot: OpenTrade, pnlFrac?: number): boolean {
  if (!isWaveBExitPolicy(ot)) return false;
  const hadMarks = ot.ladderUsedLevels.size > 0 || ot.ladderUsedIndices.size > 0;
  if (!hadMarks) return false;
  ot.ladderUsedLevels.clear();
  ot.ladderUsedIndices.clear();
  ot.liveWaveBreakevenInsuranceTaken = false;
  ot.liveWavePostTp1DeriskTaken = false;
  ot.liveWavePostTp1ScratchTaken = false;
  if (pnlFrac != null && Number.isFinite(pnlFrac)) {
    ot.liveWavePeakPnlFrac = Math.max(0, pnlFrac);
    ot.liveWaveTrailAnchorPnlFrac = Math.max(0, pnlFrac);
    ot.liveWaveTrailLevelsTaken = [];
    if (pnlFrac + LADDER_PNL_EPS < WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) {
      ot.trailingArmed = false;
    }
  }
  return true;
}

/**
 * Pre +7.5% oscillation cycles: re-arm TP ladder + insurance on each rally from below +2.5%.
 * Deep red dip (<0%): clear marks immediately; at 0% keep marks for insurance peel.
 */
export function waveBUpdatePreArmImpulseCycle(ot: OpenTrade, pnlFrac: number, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot) || !(stepPnl > 0) || ot.liveWavePreArmReached === true) return false;
  let changed = false;
  if (pnlFrac + LADDER_PNL_EPS < stepPnl) {
    ot.liveWaveImpulseBelowFirstRung = true;
    const executedMarks = waveBExecutedTpGridThresholdFromMarks(ot, stepPnl);
    if (executedMarks > 0 && pnlFrac + LADDER_PNL_EPS < 0) {
      changed = waveBClearAllTpLadderMarks(ot, pnlFrac) || changed;
    }
  } else if (ot.liveWaveImpulseBelowFirstRung === true) {
    ot.liveWaveImpulseBelowFirstRung = false;
    ot.liveWaveBreakevenInsuranceTaken = false;
    ot.liveWavePostTp1DeriskTaken = false;
    ot.liveWavePostTp1ScratchTaken = false;
    if (waveBExecutedTpGridThresholdFromMarks(ot, stepPnl) > 0) {
      changed = waveBClearAllTpLadderMarks(ot, pnlFrac) || changed;
    }
  }
  return changed;
}

/**
 * Post +7.5%: at/below +2.5% partial clear (rungs above +2.5% only).
 */
export function waveBMaybeResetTpImpulse(ot: OpenTrade, pnlFrac: number, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot) || !(stepPnl > 0)) return false;
  if (ot.liveWavePreArmReached !== true) {
    return waveBUpdatePreArmImpulseCycle(ot, pnlFrac, stepPnl);
  }
  const highest = waveBHighestTpGridThresholdTaken(ot, stepPnl);
  if (highest + LADDER_PNL_EPS < WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC) return false;
  if (pnlFrac > WAVE_B_TP_IMPULSE_RESET_PNL_FRAC + LADDER_PNL_EPS) return false;
  const floor = WAVE_B_TP_IMPULSE_RESET_PNL_FRAC;
  let changed = false;
  for (const u of [...ot.ladderUsedLevels]) {
    if (u > floor + LADDER_PNL_EPS) {
      ot.ladderUsedLevels.delete(u);
      changed = true;
    }
  }
  for (const idx of [...ot.ladderUsedIndices]) {
    const t = (idx + 1) * stepPnl;
    if (t > floor + LADDER_PNL_EPS) {
      ot.ladderUsedIndices.delete(idx);
      changed = true;
    }
  }
  return changed;
}

/** First untaken trail rung at or below current PnL (one partial per tracker tick). */
export function waveBNextTrailLevelToFire(
  anchorPnlFrac: number,
  stepPnl: number,
  pnlFrac: number,
  taken: readonly number[],
  defensiveMode = false,
): number | null {
  if (!(stepPnl > 0) || !Number.isFinite(anchorPnlFrac)) return null;
  if (
    !defensiveMode &&
    pnlFrac + LADDER_PNL_EPS < WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC
  )
    return null;
  for (const level of waveBTrailLevelsFromAnchor(anchorPnlFrac, stepPnl)) {
    if (pnlFrac > level + LADDER_PNL_EPS) return null;
    if (taken.some((x) => Math.abs(x - waveBTrailLevelKey(level)) <= LADDER_PNL_EPS)) continue;
    return level;
  }
  return null;
}

export function isWaveBExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'wave_b_v1';
}

export function isLegacyGridExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'legacy_grid' || ot.liveExitPolicyId == null;
}

export function waveBTrailSellFraction(cfg: PaperTraderConfig): number {
  const n = cfg.liveOscarExitPolicyWaveBTrailSellFraction;
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  return WAVE_B_TRAIL_STEP_SELL_FRACTION;
}

/** Remainder USD (modeled net) for exit sizing — matches `tryExecuteTpPartialSell` remainder line. */
export function waveBRemainderValueNetUsd(ot: OpenTrade, marketPriceUsd: number): number {
  if (!(ot.totalInvestedUsd > 0) || !(ot.remainingFraction > 0) || !(marketPriceUsd > 0)) return 0;
  const entryPx =
    ot.avgEntry > 1e-18 && Number.isFinite(ot.avgEntry) ? ot.avgEntry : marketPriceUsd;
  return ot.totalInvestedUsd * ot.remainingFraction * (marketPriceUsd / entryPx);
}

/**
 * TP/trail: полное закрытие, если остаток ≤ порога или после частичной продажи осталось бы < порога
 * (иначе — серия мелких TP по 5–10% при хвосте ~$110–130).
 */
export function waveBAdjustSellFractionForRemainder(
  remainingValueNetUsd: number,
  requestedFraction: number,
  _cfg?: PaperTraderConfig,
): number {
  if (!(requestedFraction > 1e-12)) return 0;
  if (remainingValueNetUsd <= WAVE_B_TRAIL_FLUSH_REMAIN_USD) return 1;
  const frac = Math.min(1, requestedFraction);
  const afterRemainUsd = remainingValueNetUsd * (1 - frac);
  if (afterRemainUsd < WAVE_B_TRAIL_FLUSH_REMAIN_USD) return 1;
  return frac;
}

/** Trail sell fraction; full exit when remainder notional is below flush threshold. */
export function waveBTrailSellFractionForRemainder(
  remainingValueNetUsd: number,
  cfg: PaperTraderConfig,
): number {
  return waveBAdjustSellFractionForRemainder(
    remainingValueNetUsd,
    waveBTrailSellFraction(cfg),
    cfg,
  );
}

/** Stamp policy on first open (before journal). */
export function stampLiveOscarExitPolicyOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): void {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId)) return;
  if (stampScalpWaveExitPolicyOnOpen(ot, cfg)) return;
  if (stampVariantAOnOpen(ot, cfg)) return;
  if (cfg.liveOscarExitPolicyWaveBEnabled) {
    ot.liveExitPolicyId = 'wave_b_v1';
    if (cfg.liveOscarWaveBFlatTpEnabled) {
      ot.liveWaveFlatTpMode = cfg.liveOscarWaveBFlatTpMode;
    }
    applyWaveBGridOverrides(ot);
    ot.liveWaveTrailAnchorPnlFrac = 0;
    ot.liveWaveTrailLevelsTaken = [];
    ot.liveWavePeakPnlFrac = 0;
    ot.liveWaveMaxExecutedTpFrac = 0;
    return;
  }
  ot.liveExitPolicyId = 'legacy_grid';
  const profile =
    cfg.tpGridSellFractionByStep.length > 0 ? [...cfg.tpGridSellFractionByStep] : undefined;
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: cfg.tpGridStepPnl,
    ...(profile ? { gridSellFractionByStep: profile } : {}),
    gridFirstRungRetraceMinPnlPct: cfg.tpGridFirstRungRetraceMinPnlPct,
  };
}

/**
 * After JSONL restore / on tracker tick: never let a legacy open pick up new global grid env.
 * Wave-B opens keep their stamped overrides.
 */
export function ensureLiveOscarExitPolicyPinned(ot: OpenTrade, cfg?: PaperTraderConfig): void {
  if (cfg != null && !isLiveOscarTradingStrategyId(cfg.strategyId)) return;
  if (isWaveBExitPolicy(ot) || isVariantAExitPolicy(ot) || isVariantAHybridExitPolicy(ot)) return;
  if (!ot.liveExitPolicyId) ot.liveExitPolicyId = 'legacy_grid';
  if (ot.liveExitPolicyId !== 'legacy_grid') return;
  const o = ot.tpGridOverrides ?? {};
  const needsPin =
    o.gridStepPnl == null ||
    !Array.isArray(o.gridSellFractionByStep) ||
    o.gridSellFractionByStep.length === 0;
  if (needsPin) {
    ot.tpGridOverrides = {
      ...o,
      gridStepPnl: LEGACY_LIVE_OSCAR_TP_GRID.gridStepPnl,
      gridSellFractionByStep: [...LEGACY_LIVE_OSCAR_TP_GRID.gridSellFractionByStep],
      gridFirstRungRetraceMinPnlPct: LEGACY_LIVE_OSCAR_TP_GRID.gridFirstRungRetraceMinPnlPct,
    };
  }
}

function applyWaveBGridOverrides(ot: OpenTrade): void {
  const p = waveBTpGridProfileFor(ot);
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: p.gridStepPnl,
    gridSellFractionByStep: [...p.gridSellFractionByStep],
    gridFirstRungRetraceMinPnlPct: p.gridFirstRungRetraceMinPnlPct,
  };
}

/**
 * Re-stamp wave B grid overrides on the trade after legs change (e.g. staged_avg fired).
 * No-op for non-wave-B trades. Idempotent — picks profile from current `legs` state.
 */
export function refreshWaveBGridOverrides(ot: OpenTrade): void {
  if (!isWaveBExitPolicy(ot)) return;
  applyWaveBGridOverrides(ot);
}

/**
 * Upgrade in-flight `legacy_grid` open to wave B (keeps `remainingFraction`, partials, `ladderUsedLevels`).
 * `ladderUsedIndices` cleared — grid mode uses PnL thresholds in `ladderUsedLevels`.
 */
export function migrateLegacyOpenToWaveB(ot: OpenTrade, pnlFrac?: number): boolean {
  if (isWaveBExitPolicy(ot)) return false;
  const wasLegacy = ot.liveExitPolicyId == null || ot.liveExitPolicyId === 'legacy_grid';
  if (!wasLegacy) return false;

  ot.liveExitPolicyId = 'wave_b_v1';
  applyWaveBGridOverrides(ot);
  ot.ladderUsedIndices.clear();

  const peakFromOt =
    typeof ot.peakPnlPct === 'number' && Number.isFinite(ot.peakPnlPct) ? ot.peakPnlPct / 100 : 0;
  const peak = Math.max(peakFromOt, pnlFrac ?? 0, ot.liveWavePeakPnlFrac ?? 0);
  ot.liveWavePeakPnlFrac = peak;
  ot.liveWaveTrailAnchorPnlFrac = Math.max(ot.liveWaveTrailAnchorPnlFrac ?? 0, peak);
  ot.liveWaveTrailLevelsTaken = ot.liveWaveTrailLevelsTaken ?? [];

  waveBReconcileMaxExecutedTpFromMarks(ot, WAVE_B_V1_TP_GRID.gridStepPnl);

  if (peak + LADDER_PNL_EPS >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) {
    ot.trailingArmed = true;
  }
  console.log(
    `[EXIT_POLICY] ${(ot.mint ?? '?').slice(0, 8)} $${ot.symbol ?? '?'} legacy_grid → wave_b_v1 remain=${(ot.remainingFraction * 100).toFixed(1)}% partials=${ot.partialSells.length} peakPnL=${(peak * 100).toFixed(1)}%`,
  );
  return true;
}

/**
 * Tracker boot/tick: wave B env on → migrate open legacy; off → pin prod legacy grid.
 */
/** @returns true if policy/grid changed this tick (caller should refresh `cfgEffectiveForOpen`). */
export function resolveLiveOscarExitPolicyForTick(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  pnlFrac?: number,
): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId)) return false;
  if (isWaveBExitPolicy(ot) || isVariantAExitPolicy(ot)) return false;
  if (cfg.liveOscarExitPolicyWaveBEnabled) {
    return migrateLegacyOpenToWaveB(ot, pnlFrac);
  }
  ensureLiveOscarExitPolicyPinned(ot, cfg);
  return false;
}

/** Variant B: on new PnL high, reset trail descent only — TP grid rungs stay one-shot (no re-arm spam). */
export function waveBOnNewHigh(ot: OpenTrade, pnlFrac: number, _stepPnl: number): void {
  const prev = ot.liveWavePeakPnlFrac ?? -Infinity;
  if (pnlFrac <= prev + LADDER_PNL_EPS) return;
  ot.liveWavePeakPnlFrac = pnlFrac;
  ot.liveWaveTrailAnchorPnlFrac = Math.max(ot.liveWaveTrailAnchorPnlFrac ?? 0, pnlFrac);
  ot.liveWaveTrailLevelsTaken = [];
}

export function waveBTrailLevelKey(levelPnlFrac: number): number {
  return Math.round(levelPnlFrac * 1_000_000) / 1_000_000;
}

export function waveBTrailLevelTaken(ot: OpenTrade, levelPnlFrac: number): boolean {
  const key = waveBTrailLevelKey(levelPnlFrac);
  return (ot.liveWaveTrailLevelsTaken ?? []).some((x) => Math.abs(x - key) <= LADDER_PNL_EPS);
}

export function waveBMarkTrailLevelTaken(ot: OpenTrade, levelPnlFrac: number): void {
  const key = waveBTrailLevelKey(levelPnlFrac);
  const arr = ot.liveWaveTrailLevelsTaken ?? [];
  if (arr.some((x) => Math.abs(x - key) <= LADDER_PNL_EPS)) return;
  ot.liveWaveTrailLevelsTaken = [...arr, key];
}

/** Descending trail thresholds from anchor (anchor − n×step). */
export function waveBTrailLevelsFromAnchor(anchorPnlFrac: number, stepPnl: number, maxLevels = 48): number[] {
  const out: number[] = [];
  if (!(stepPnl > 0) || !Number.isFinite(anchorPnlFrac)) return out;
  for (let n = 1; n <= maxLevels; n++) {
    const level = anchorPnlFrac - n * stepPnl;
    if (level < -LADDER_PNL_EPS) break;
    out.push(level);
  }
  return out;
}
