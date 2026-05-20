/**
 * Live Oscar exit policy «wave B» (v1) — per-open policy id + legacy grid freeze for in-flight positions.
 * See product spec EXIT_WAVE_B (discussion 2026-05).
 */
import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { LADDER_PNL_EPS } from './tp-ladder-state.js';

export type LiveExitPolicyId = 'legacy_grid' | 'wave_b_v1';

/** Prod grid pinned for opens/restores without `liveExitPolicyId` (1.11.168 live-oscar). */
export const LEGACY_LIVE_OSCAR_TP_GRID = {
  gridStepPnl: 0.05,
  gridSellFractionByStep: [0.1, 0.3, 0.5, 0.7, 0.7],
  gridFirstRungRetraceMinPnlPct: 0.03,
} as const;

/**
 * Wave B v1 — averaging branch (≥1 `staged_avg`/`dca` leg).
 * Phase 1 — +2.5% / +5% / +7.5%: 5% of remainder each.
 * Phase 2 — +10% and above: 10% per rung (2.5% steps, unlimited).
 * Defensive trail (after +10% TP or peak): each −2.5% from peak anchor → 20% of remainder.
 * Breakeven full exit at ≤0% avg PnL only after TP ≥+7.5% taken. TP rungs above +2.5% reset after deep pullback.
 */
export const WAVE_B_V1_TP_GRID = {
  gridStepPnl: 0.025,
  gridSellFractionByStep: [0.05, 0.05, 0.05, 0.1],
  gridFirstRungRetraceMinPnlPct: 0,
} as const;

/**
 * Wave B v1 — default branch (no `staged_avg`/`dca` legs yet, entry split via `scale_in`/`entry_split` ignored).
 * Phase 1 — +2.5% / +5%: silent (no sell), +7.5%: 10% of remainder.
 * Phase 2 — +10%…+20% each rung 25% of remainder, +22.5% 15%, beyond — 25% per 2.5% step (unlimited).
 * Same defensive trail / breakeven gating as averaging branch.
 */
export const WAVE_B_V1_TP_GRID_NO_AVG = {
  gridStepPnl: 0.025,
  gridSellFractionByStep: [0, 0, 0.1, 0.25, 0.25, 0.25, 0.25, 0.25, 0.15],
  gridFirstRungRetraceMinPnlPct: 0,
} as const;

/**
 * True iff trade has at least one averaging leg (`dca` or `staged_avg`).
 * Entry split legs (`scale_in`, `entry_split`) are NOT averaging — they are the 500+500 split of the initial entry.
 */
export function hasAveragingLeg(ot: OpenTrade): boolean {
  return ot.legs.some((l) => l.reason === 'dca' || l.reason === 'staged_avg');
}

/** Wave B grid profile selector — averaging-aware. */
export function waveBTpGridProfileFor(ot: OpenTrade): {
  gridStepPnl: number;
  gridSellFractionByStep: readonly number[];
  gridFirstRungRetraceMinPnlPct: number;
} {
  return hasAveragingLeg(ot) ? WAVE_B_V1_TP_GRID : WAVE_B_V1_TP_GRID_NO_AVG;
}

/** Sell fraction of remainder for averaging-branch TP grid step k (1-based). */
export function waveBSellFractionForStep(kOneBased: number): number {
  if (kOneBased >= 1 && kOneBased <= 3) return 0.05;
  if (kOneBased >= 4) return 0.1;
  return 0;
}

/** Min TP rung taken to allow breakeven full exit (vs staged avg only below this). */
export const WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC = 0.075;
/** Defensive trail arms when peak or highest TP rung ≥ this (+10%). */
export const WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC = 0.1;
/** After TP ≥+7.5%, pullback to ≤+2.5% re-opens TP rungs above +2.5% on the next rally. */
export const WAVE_B_TP_IMPULSE_RESET_PNL_FRAC = 0.025;
/** @deprecated alias — use `WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC` / defensive arm at +10%. */
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
  if (!isWaveBExitPolicy(ot) || !ot.trailingArmed) return false;
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

/** Highest TP grid threshold (PnL frac) already marked on this open. */
export function waveBHighestTpGridThresholdTaken(ot: OpenTrade, stepPnl: number): number {
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
  const peak = ot.liveWavePeakPnlFrac ?? 0;
  if (peak > max) max = peak;
  return max;
}

/** Defensive trail: peak or TP ladder reached ≥ +10%. */
export function waveBDefensiveTrailActive(ot: OpenTrade, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot)) return false;
  return waveBHighestTpGridThresholdTaken(ot, stepPnl) + LADDER_PNL_EPS >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC;
}

/** Full exit at avg breakeven allowed only after TP rung ≥ +7.5%. */
export function waveBBreakevenExitEligible(ot: OpenTrade, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot)) return false;
  return waveBHighestTpGridThresholdTaken(ot, stepPnl) + LADDER_PNL_EPS >= WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC;
}

/**
 * Deep pullback after ≥+7.5% TP: unmark grid rungs above +2.5% so +5% / +7.5% / +10% can fire again on rally.
 * @returns true if any marks were cleared this tick
 */
export function waveBMaybeResetTpImpulse(ot: OpenTrade, pnlFrac: number, stepPnl: number): boolean {
  if (!isWaveBExitPolicy(ot) || !(stepPnl > 0)) return false;
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
  if (cfg.strategyId !== 'live-oscar') return;
  if (cfg.liveOscarExitPolicyWaveBEnabled) {
    ot.liveExitPolicyId = 'wave_b_v1';
    applyWaveBGridOverrides(ot);
    ot.liveWaveTrailAnchorPnlFrac = 0;
    ot.liveWaveTrailLevelsTaken = [];
    ot.liveWavePeakPnlFrac = 0;
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
  if (cfg != null && cfg.strategyId !== 'live-oscar') return;
  if (isWaveBExitPolicy(ot)) return;
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
  if (cfg.strategyId !== 'live-oscar') return false;
  if (isWaveBExitPolicy(ot)) return false;
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
