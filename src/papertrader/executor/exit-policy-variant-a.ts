/**
 * Live Oscar exit policy «Variant A»
 * - v1 legacy: discrete TP + moon50 + full trail + smart48/96h
 * - v2 hybrid: infinite +5% grid, partial trail @+10% (prod for new opens)
 * - v3 scratch: harvest +5%→30%, ladder up, flush @0% avg, gap tail −3% (in-flight only)
 */
import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { LADDER_PNL_EPS } from './tp-ladder-state.js';

export type VariantAExitTag =
  | 'salvage24'
  | 'h48_loss'
  | 'horizon48'
  | 'horizon96'
  | 'moon50'
  | 'trail'
  | 'scratch_flush0'
  | 'scratch_gap_flush'
  | 'hybrid_harvest_flush0'
  | 'hybrid_harvest_gap_flush';

export const VARIANT_A_V1_POLICY_ID = 'variant_a_v1';
export const VARIANT_A_V2_POLICY_ID = 'variant_a_v2';
export const VARIANT_A_V3_POLICY_ID = 'variant_a_v3';

/** v3 scratch harvest ladder (PnL vs avg → sell fraction of remainder). */
export const VARIANT_A_V3_SCRATCH_TP_LADDER: readonly { pnl: number; sell: number }[] = [
  { pnl: 0.05, sell: 0.3 },
  { pnl: 0.1, sell: 0.15 },
  { pnl: 0.15, sell: 0.15 },
  { pnl: 0.2, sell: 0.1 },
  { pnl: 0.25, sell: 0.1 },
  { pnl: 0.3, sell: 0.1 },
];

export const VARIANT_A_V2_TP_GRID_STEP_PNL = 0.05;
export const VARIANT_A_V2_TP_SELL_FRAC = 0.1;
export const VARIANT_A_V2_TRAIL_ARM_PNL_FRAC = 0.1;
export const VARIANT_A_V2_TP_REARM_FLOOR_PNL_FRAC = 0.025;
export const VARIANT_A_V2_TP_REARM_MIN_TAKEN_PNL_FRAC = 0.1;

/** After first +5% grid TP: exit 50% at +2.5%, remainder at avg; no DCA/trail/downside. */
export const VARIANT_A_V2_HARVEST_TP5_PNL_FRAC = 0.05;
export const VARIANT_A_V2_HARVEST_HALF_PNL_FRAC = 0.025;

export type VariantAHybridHarvestAction =
  | { kind: 'none' }
  | {
      kind: 'sell_half';
      sellFraction: number;
      timelineLabelRu: string;
    }
  | {
      kind: 'flush_all';
      useAvgPrice: boolean;
      tag: 'hybrid_harvest_flush0' | 'hybrid_harvest_gap_flush';
      timelineLabelRu: string;
    };

export const VARIANT_A_DEFAULT_MOON_TARGET_PNL_FRAC = 0.5;
export const VARIANT_A_DEFAULT_TRAIL_ARM_PNL_FRAC = 0.35;
export const VARIANT_A_DEFAULT_TRAIL_RETRACE_PNL_FRAC = 0.12;
export const VARIANT_A_DEFAULT_SALVAGE24_MIN_PEAK_PCT = 5;
export const VARIANT_A_DEFAULT_MAX_HORIZON_HOURS = 96;
export const VARIANT_A_DEFAULT_SCRATCH_GAP_TAIL_PNL_FRAC = 0.03;
export const VARIANT_A_SCRATCH_DUST_FLUSH_REMAIN_USD = 100;

export type VariantAScratchFlushAction =
  | { kind: 'none' }
  | {
      kind: 'flush_all';
      /** Sell at avg entry (breakeven) rather than current MTM. */
      useAvgPrice: boolean;
      tag: VariantAExitTag;
      timelineLabelRu: string;
    };

export function isVariantAExitPolicy(ot: OpenTrade): boolean {
  const id = ot.liveExitPolicyId;
  return id === VARIANT_A_V1_POLICY_ID || id === VARIANT_A_V2_POLICY_ID || id === VARIANT_A_V3_POLICY_ID;
}

export function isVariantALegacyV1ExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === VARIANT_A_V1_POLICY_ID;
}

export function isVariantAHybridExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === VARIANT_A_V2_POLICY_ID;
}

export function isVariantAScratchExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === VARIANT_A_V3_POLICY_ID;
}

export function isPartialGridTrailExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'wave_b_v1' || isVariantAHybridExitPolicy(ot);
}

export function isVariantAExitPolicyEnabled(cfg: PaperTraderConfig): boolean {
  return cfg.strategyId === 'live-oscar' && cfg.liveOscarExitPolicyVariantAEnabled;
}

export function variantAScratchGapTailPnlFrac(cfg: PaperTraderConfig): number {
  const n = cfg.liveOscarVariantAScratchGapTailPct;
  return Number.isFinite(n) && n > 0 ? n : VARIANT_A_DEFAULT_SCRATCH_GAP_TAIL_PNL_FRAC;
}

export function variantAScratchHadTp(ot: OpenTrade): boolean {
  if (ot.liveVariantAScratchHadTp) return true;
  return ot.partialSells.some((p) => p.reason === 'TP_LADDER');
}

export function variantAScratchMarkTpTaken(ot: OpenTrade): void {
  if (!isVariantAScratchExitPolicy(ot)) return;
  ot.liveVariantAScratchHadTp = true;
}

function moonTargetFrac(cfg: PaperTraderConfig): number {
  const n = cfg.liveOscarVariantAMoonTargetPct;
  return Number.isFinite(n) && n > 0 ? n : VARIANT_A_DEFAULT_MOON_TARGET_PNL_FRAC;
}

function trailArmFrac(cfg: PaperTraderConfig): number {
  const n = cfg.liveOscarVariantATrailArmPct;
  return Number.isFinite(n) && n > 0 ? n : VARIANT_A_DEFAULT_TRAIL_ARM_PNL_FRAC;
}

function trailRetraceFrac(cfg: PaperTraderConfig): number {
  const n = cfg.liveOscarVariantATrailRetracePct;
  return Number.isFinite(n) && n > 0 ? n : VARIANT_A_DEFAULT_TRAIL_RETRACE_PNL_FRAC;
}

function hybridPeakPnlFrac(ot: OpenTrade): number {
  if (isVariantAScratchExitPolicy(ot)) {
    return ot.liveVariantAScratchPeakPnlFrac ?? -Infinity;
  }
  return ot.liveWavePeakPnlFrac ?? ot.liveVariantARemainderPeakPnlFrac ?? -Infinity;
}

function highestTpGridThresholdTaken(ot: OpenTrade, stepPnl: number): number {
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

export function variantAHybridDefensiveTrailActive(ot: OpenTrade, stepPnl: number): boolean {
  if (!isVariantAHybridExitPolicy(ot)) return false;
  if (variantAHybridHarvestActive(ot, stepPnl)) return false;
  return highestTpGridThresholdTaken(ot, stepPnl) + LADDER_PNL_EPS >= VARIANT_A_V2_TRAIL_ARM_PNL_FRAC;
}

export function variantAHybridMaybeResetTpImpulse(ot: OpenTrade, pnlFrac: number, stepPnl: number): boolean {
  if (!isVariantAHybridExitPolicy(ot) || !(stepPnl > 0)) return false;
  if (variantAHybridHarvestActive(ot, stepPnl)) return false;
  const highest = highestTpGridThresholdTaken(ot, stepPnl);
  if (highest + LADDER_PNL_EPS < VARIANT_A_V2_TP_REARM_MIN_TAKEN_PNL_FRAC) return false;
  if (pnlFrac > VARIANT_A_V2_TP_REARM_FLOOR_PNL_FRAC + LADDER_PNL_EPS) return false;
  const floor = VARIANT_A_V2_TP_REARM_FLOOR_PNL_FRAC;
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

export function variantAHybridResetTpGridOnDca(ot: OpenTrade): boolean {
  if (!isVariantAHybridExitPolicy(ot)) return false;
  if (variantAHybridHarvestActive(ot, VARIANT_A_V2_TP_GRID_STEP_PNL)) return false;
  if (ot.ladderUsedIndices.size === 0 && ot.ladderUsedLevels.size === 0) return false;
  ot.ladderUsedIndices.clear();
  ot.ladderUsedLevels.clear();
  return true;
}

/** True when +5% grid TP rung was taken (or explicitly flagged on open). */
export function variantAHybridTp5Taken(ot: OpenTrade, stepPnl: number): boolean {
  if (!isVariantAHybridExitPolicy(ot)) return false;
  if (ot.liveVariantAHybridTp5Taken) return true;
  const thresh = VARIANT_A_V2_HARVEST_TP5_PNL_FRAC;
  if (stepPnl > 0) {
    const idx = Math.round(thresh / stepPnl) - 1;
    if (idx >= 0 && ot.ladderUsedIndices.has(idx)) return true;
  }
  for (const u of ot.ladderUsedLevels) {
    if (Math.abs(u - thresh) <= LADDER_PNL_EPS) return true;
  }
  return false;
}

export function variantAHybridMarkTp5Taken(ot: OpenTrade): void {
  if (!isVariantAHybridExitPolicy(ot)) return;
  ot.liveVariantAHybridTp5Taken = true;
}

/** Post +5% TP: no further grid/trail/DCA — two-step harvest exit only. */
export function variantAHybridHarvestActive(ot: OpenTrade, stepPnl: number): boolean {
  if (!isVariantAHybridExitPolicy(ot)) return false;
  if (ot.liveVariantAHybridHarvestComplete) return false;
  return variantAHybridTp5Taken(ot, stepPnl);
}

/**
 * After +5% TP: sell 50% of remainder at ≤+2.5%; flush 100% at ≤0% avg (gap-aware).
 * Does not allow holding through negative PnL vs avg.
 */
export function variantAHybridEvalHarvest(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  pnlFrac: number,
  prevPnlFrac: number,
): VariantAHybridHarvestAction {
  if (!variantAHybridHarvestActive(ot, VARIANT_A_V2_TP_GRID_STEP_PNL)) return { kind: 'none' };
  if (ot.liveVariantAHybridHarvestComplete) return { kind: 'none' };

  const halfAt = VARIANT_A_V2_HARVEST_HALF_PNL_FRAC;
  const tail = variantAScratchGapTailPnlFrac(cfg);

  if (!ot.liveVariantAHybridHarvestHalfDone && pnlFrac <= halfAt + LADDER_PNL_EPS) {
    return {
      kind: 'sell_half',
      sellFraction: 0.5,
      timelineLabelRu:
        'Live Oscar v2 hybrid · после TP +5% фиксация 50% остатка на +2.5% (без ухода в минус)',
    };
  }

  const crossedZero = prevPnlFrac > LADDER_PNL_EPS && pnlFrac <= LADDER_PNL_EPS;
  const atOrBelowTail = pnlFrac <= -tail + LADDER_PNL_EPS;

  if (atOrBelowTail && prevPnlFrac > LADDER_PNL_EPS) {
    return {
      kind: 'flush_all',
      useAvgPrice: true,
      tag: 'hybrid_harvest_gap_flush',
      timelineLabelRu:
        `Live Oscar v2 hybrid · пропуск 0% — полное закрытие у avg (gap ≤ −${(tail * 100).toFixed(0)}% от avg)`,
    };
  }

  if (crossedZero || pnlFrac <= LADDER_PNL_EPS) {
    return {
      kind: 'flush_all',
      useAvgPrice: false,
      tag: 'hybrid_harvest_flush0',
      timelineLabelRu:
        'Live Oscar v2 hybrid · после TP +5% закрытие остатка у avg (0%) — без DCA и усреднения',
    };
  }

  return { kind: 'none' };
}

export function variantAHybridHarvestReentryRefPriceUsd(ot: OpenTrade): number | null {
  if (!isVariantAHybridExitPolicy(ot) || !ot.liveVariantAHybridHarvestComplete) return null;
  return ot.avgEntry > 1e-18 && Number.isFinite(ot.avgEntry) ? ot.avgEntry : null;
}

/**
 * After ≥1 TP: on pullback to ≤0% avg flush remainder; if PG gaps through 0, flush at avg when ≤−gapTail%.
 */
export function variantAScratchEvalFlush(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  pnlFrac: number,
  prevPnlFrac: number,
): VariantAScratchFlushAction {
  if (!isVariantAScratchExitPolicy(ot) || !variantAScratchHadTp(ot)) return { kind: 'none' };
  if (ot.liveVariantAScratchFlushedAtZero) return { kind: 'none' };

  const tail = variantAScratchGapTailPnlFrac(cfg);
  const crossedZero = prevPnlFrac > LADDER_PNL_EPS && pnlFrac <= LADDER_PNL_EPS;
  const atOrBelowTail = pnlFrac <= -tail + LADDER_PNL_EPS;

  if (atOrBelowTail && prevPnlFrac > LADDER_PNL_EPS) {
    return {
      kind: 'flush_all',
      useAvgPrice: true,
      tag: 'scratch_gap_flush',
      timelineLabelRu:
        `Live Oscar scratch · пропуск 0% в данных — полное закрытие остатка у avg (gap ≤ −${(tail * 100).toFixed(0)}% от avg)`,
    };
  }

  if (crossedZero || pnlFrac <= LADDER_PNL_EPS) {
    return {
      kind: 'flush_all',
      useAvgPrice: false,
      tag: 'scratch_flush0',
      timelineLabelRu:
        'Live Oscar scratch · после TP откат к avg (0%) — полное закрытие остатка (без DCA, re-entry после −10% от exit)',
    };
  }

  return { kind: 'none' };
}

export function variantAScratchUpdatePeak(ot: OpenTrade, pnlFrac: number): void {
  if (!isVariantAScratchExitPolicy(ot)) return;
  const prev = ot.liveVariantAScratchPeakPnlFrac ?? -Infinity;
  if (pnlFrac > prev + LADDER_PNL_EPS) ot.liveVariantAScratchPeakPnlFrac = pnlFrac;
}

/** Stamp policy on first open (before journal). Returns true when Variant A was applied. */
export function stampVariantAOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isVariantAExitPolicyEnabled(cfg)) return false;
  ot.liveExitPolicyId = VARIANT_A_V2_POLICY_ID;
  ot.liveVariantAScratchHadTp = false;
  ot.liveVariantAScratchPrevPnlFrac = 0;
  ot.liveVariantAScratchPeakPnlFrac = 0;
  ot.liveVariantAScratchFlushedAtZero = false;
  ot.liveVariantARemainderPeakPnlFrac = 0;
  ot.liveVariantATrailArmed = false;
  ot.liveVariantASmart48Extended = false;
  ot.liveVariantASalvage24Checked = false;
  ot.liveVariantAH48Checked = false;
  ot.liveVariantAExitTag = undefined;
  ot.liveVariantAHybridTp5Taken = false;
  ot.liveVariantAHybridHarvestHalfDone = false;
  ot.liveVariantAHybridHarvestComplete = false;
  ot.liveVariantAHybridHarvestPrevPnlFrac = 0;
  return true;
}

export function variantAUpdateRemainderPeak(ot: OpenTrade, pnlFrac: number, cfg: PaperTraderConfig): void {
  if (!isVariantALegacyV1ExitPolicy(ot)) return;
  const prev = ot.liveVariantARemainderPeakPnlFrac ?? -Infinity;
  if (pnlFrac > prev + LADDER_PNL_EPS) ot.liveVariantARemainderPeakPnlFrac = pnlFrac;
  if (pnlFrac + LADDER_PNL_EPS >= trailArmFrac(cfg)) ot.liveVariantATrailArmed = true;
}

export function variantAMoonExitTriggered(ot: OpenTrade, cfg: PaperTraderConfig, pnlFrac: number): boolean {
  if (!isVariantALegacyV1ExitPolicy(ot)) return false;
  return pnlFrac + LADDER_PNL_EPS >= moonTargetFrac(cfg);
}

export function variantATrailFullExitTriggered(ot: OpenTrade, cfg: PaperTraderConfig, pnlFrac: number): boolean {
  if (!isVariantALegacyV1ExitPolicy(ot) || !ot.liveVariantATrailArmed) return false;
  const peak = ot.liveVariantARemainderPeakPnlFrac ?? pnlFrac;
  return pnlFrac <= peak - trailRetraceFrac(cfg) + LADDER_PNL_EPS;
}

export function variantAMaxHorizonHours(ot: OpenTrade, cfg: PaperTraderConfig): number {
  if (cfg.liveOscarVariantASmart48Enabled && ot.liveVariantASmart48Extended) {
    const h = cfg.liveOscarVariantAMaxHorizonHours;
    return Number.isFinite(h) && h > 0 ? h : VARIANT_A_DEFAULT_MAX_HORIZON_HOURS;
  }
  return cfg.timeoutHours;
}

export function variantAEvalTimedExit(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  pnlFrac: number,
  ageH: number,
): VariantAExitTag | null {
  if (!isVariantAExitPolicy(ot)) return null;
  if (isVariantAScratchExitPolicy(ot) && variantAScratchHadTp(ot)) return null;
  if (
    isVariantAHybridExitPolicy(ot) &&
    (variantAHybridTp5Taken(ot, VARIANT_A_V2_TP_GRID_STEP_PNL) ||
      ot.partialSells.some((p) => p.reason === 'TP_LADDER'))
  ) {
    return null;
  }

  const peakPct = hybridPeakPnlFrac(ot) * 100;

  if (cfg.liveOscarVariantASalvage24Enabled && !ot.liveVariantASalvage24Checked && ageH >= 24) {
    ot.liveVariantASalvage24Checked = true;
    const minPeak = cfg.liveOscarVariantASalvage24MinPeakPct;
    if (peakPct + LADDER_PNL_EPS < minPeak && pnlFrac <= LADDER_PNL_EPS) return 'salvage24';
  }

  if (!ot.liveVariantAH48Checked && ageH >= 48) {
    ot.liveVariantAH48Checked = true;
    if (pnlFrac <= LADDER_PNL_EPS) return 'h48_loss';
    if (isVariantAScratchExitPolicy(ot) || isVariantAHybridExitPolicy(ot)) return null;
    if (cfg.liveOscarVariantASmart48Enabled) ot.liveVariantASmart48Extended = true;
    else return 'horizon48';
  }

  if (isVariantAScratchExitPolicy(ot) || isVariantAHybridExitPolicy(ot)) return null;

  const horizonH = variantAMaxHorizonHours(ot, cfg);
  if (ageH >= horizonH) return ot.liveVariantASmart48Extended ? 'horizon96' : 'horizon48';

  return null;
}

export function isVariantATimedLossExitTag(tag: VariantAExitTag | undefined): boolean {
  return tag === 'salvage24' || tag === 'h48_loss';
}

export function variantAScratchDustFlushRemainUsd(): number {
  return VARIANT_A_SCRATCH_DUST_FLUSH_REMAIN_USD;
}

export function variantAExitTagLabel(tag: VariantAExitTag | undefined): string | null {
  if (!tag) return null;
  switch (tag) {
    case 'salvage24':
      return 'Variant A scratch · salvage @24h (peak < +5%, TP не было, PnL ≤ 0)';
    case 'h48_loss':
      return 'Variant A scratch · loss cut @48h (TP не было)';
    case 'scratch_flush0':
      return 'Variant A scratch · flush 100% @ avg после TP';
    case 'scratch_gap_flush':
      return 'Variant A scratch · gap flush @ avg (≤ −3% от avg)';
    case 'hybrid_harvest_flush0':
      return 'Variant A v2 hybrid · harvest flush 100% @ avg после TP +5%';
    case 'hybrid_harvest_gap_flush':
      return 'Variant A v2 hybrid · harvest gap flush @ avg';
    case 'horizon48':
      return 'Variant A · horizon @48h';
    case 'horizon96':
      return 'Variant A · smart48 extended horizon @96h';
    case 'moon50':
      return 'Variant A · moon +50% full exit';
    case 'trail':
      return 'Variant A · peak retrace trail (legacy v1)';
    default:
      return `Variant A · ${tag}`;
  }
}

export function liveOscarHybridStrategyNoteRu(): string {
  return (
    'Live Oscar · Variant A v2 hybrid (prod):\n' +
    '• Вход: $750+$750 split; DCA −10%/−20% до первого TP +5%.\n' +
    '• TP +5%: 10% остатка, затем harvest — 50% на +2.5%, остаток @ avg (без минуса/DCA/trail).\n' +
    '• Re-entry: цена ≤ ref×(1−5%), ref = avg выхода; остальные гейты (BS, объём) без изменений.\n' +
    '• До TP +5%: сетка/trail/timed salvage24/h48 как раньше (trail с +10%).'
  );
}

export function liveOscarScratchStrategyNoteRu(cfg: PaperTraderConfig): string {
  const tail = (variantAScratchGapTailPnlFrac(cfg) * 100).toFixed(0);
  return (
    'Live Oscar · Variant A v3 scratch-harvest (in-flight):\n' +
    '• TP ladder (vs avg): +5%→30%, +10%→15%, +15%→15%, +20%→10%, +25%→10%, +30%→10% остатка.\n' +
    '• После любого TP: DCA запрещён.\n' +
    '• Откат к avg (0%): продажа 100% остатка (scratch flush).\n' +
    `• Gap через 0%: flush у avg при ≤−${tail}% от avg.\n` +
    '• Хвост < $100: dust flush. Timed loss только без TP.'
  );
}

export function variantAScratchTpTimelineLabelRu(pnlPct: number, sellFrac: number): string {
  return `Live Oscar scratch · TP +${(pnlPct * 100).toFixed(0)}% → ${(sellFrac * 100).toFixed(0)}% остатка`;
}
