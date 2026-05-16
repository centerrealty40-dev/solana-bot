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

/** Wave B v1: +2.5% zero TP, +5% 10%, then 20% per +2.5% step. */
export const WAVE_B_V1_TP_GRID = {
  gridStepPnl: 0.025,
  gridSellFractionByStep: [0, 0.1, 0.2],
  gridFirstRungRetraceMinPnlPct: 0,
} as const;

export const WAVE_B_ARM_MIN_PNL_FRAC = 0.075;
export const WAVE_B_TRAIL_STEP_SELL_FRACTION = 0.3;

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
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: WAVE_B_V1_TP_GRID.gridStepPnl,
    gridSellFractionByStep: [...WAVE_B_V1_TP_GRID.gridSellFractionByStep],
    gridFirstRungRetraceMinPnlPct: WAVE_B_V1_TP_GRID.gridFirstRungRetraceMinPnlPct,
  };
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

  if (peak + LADDER_PNL_EPS >= WAVE_B_ARM_MIN_PNL_FRAC) {
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

/** Variant B: on new PnL high, re-enable TP rungs below peak and reset trail descent. */
export function waveBOnNewHigh(ot: OpenTrade, pnlFrac: number, stepPnl: number): void {
  if (!(stepPnl > 0)) return;
  const prev = ot.liveWavePeakPnlFrac ?? -Infinity;
  if (pnlFrac <= prev + LADDER_PNL_EPS) return;
  ot.liveWavePeakPnlFrac = pnlFrac;
  ot.liveWaveTrailAnchorPnlFrac = Math.max(ot.liveWaveTrailAnchorPnlFrac ?? 0, pnlFrac);
  ot.liveWaveTrailLevelsTaken = [];

  for (const t of [...ot.ladderUsedLevels]) {
    if (t < pnlFrac - LADDER_PNL_EPS) ot.ladderUsedLevels.delete(t);
  }
  for (const idx of [...ot.ladderUsedIndices]) {
    const th = (idx + 1) * stepPnl;
    if (th < pnlFrac - LADDER_PNL_EPS) ot.ladderUsedIndices.delete(idx);
  }
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
