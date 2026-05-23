/**
 * Live Oscar exit policy «Variant A» (v1) — discrete TP ladder, moon +50%, peak retrace trail,
 * smart 48h/96h timed exits, no price killstop. See backtest scripts-tmp/live-oscar-variant-a-*.ts.
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
  | 'trail';

export const VARIANT_A_DEFAULT_MOON_TARGET_PNL_FRAC = 0.5;
export const VARIANT_A_DEFAULT_TRAIL_ARM_PNL_FRAC = 0.35;
export const VARIANT_A_DEFAULT_TRAIL_RETRACE_PNL_FRAC = 0.12;
export const VARIANT_A_DEFAULT_SALVAGE24_MIN_PEAK_PCT = 5;
export const VARIANT_A_DEFAULT_MAX_HORIZON_HOURS = 96;

export function isVariantAExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'variant_a_v1';
}

export function isVariantAExitPolicyEnabled(cfg: PaperTraderConfig): boolean {
  return cfg.strategyId === 'live-oscar' && cfg.liveOscarExitPolicyVariantAEnabled;
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

/** Stamp policy on first open (before journal). Returns true when Variant A was applied. */
export function stampVariantAOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isVariantAExitPolicyEnabled(cfg)) return false;
  ot.liveExitPolicyId = 'variant_a_v1';
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: 0,
    gridSellFractionByStep: [],
    gridFirstRungRetraceMinPnlPct: 0,
  };
  ot.liveVariantARemainderPeakPnlFrac = 0;
  ot.liveVariantATrailArmed = false;
  ot.liveVariantASmart48Extended = false;
  ot.liveVariantASalvage24Checked = false;
  ot.liveVariantAH48Checked = false;
  ot.liveVariantAExitTag = undefined;
  return true;
}

/** Track remainder peak PnL (vs avg) for trail + salvage24. */
export function variantAUpdateRemainderPeak(ot: OpenTrade, pnlFrac: number, cfg: PaperTraderConfig): void {
  if (!isVariantAExitPolicy(ot)) return;
  const prev = ot.liveVariantARemainderPeakPnlFrac ?? -Infinity;
  if (pnlFrac > prev + LADDER_PNL_EPS) {
    ot.liveVariantARemainderPeakPnlFrac = pnlFrac;
  }
  if (pnlFrac + LADDER_PNL_EPS >= trailArmFrac(cfg)) {
    ot.liveVariantATrailArmed = true;
  }
}

export function variantAMoonExitTriggered(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  pnlFrac: number,
): boolean {
  if (!isVariantAExitPolicy(ot)) return false;
  return pnlFrac + LADDER_PNL_EPS >= moonTargetFrac(cfg);
}

export function variantATrailFullExitTriggered(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  pnlFrac: number,
): boolean {
  if (!isVariantAExitPolicy(ot) || !ot.liveVariantATrailArmed) return false;
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

/**
 * Timed exit tags for Variant A (salvage24, h48_loss, horizon). Sets checkpoint flags on `ot`.
 * @returns tag when a full exit should fire this tick; null otherwise.
 */
export function variantAEvalTimedExit(
  ot: OpenTrade,
  cfg: PaperTraderConfig,
  pnlFrac: number,
  ageH: number,
): VariantAExitTag | null {
  if (!isVariantAExitPolicy(ot)) return null;

  if (
    cfg.liveOscarVariantASalvage24Enabled &&
    !ot.liveVariantASalvage24Checked &&
    ageH >= 24
  ) {
    ot.liveVariantASalvage24Checked = true;
    const peakPct = (ot.liveVariantARemainderPeakPnlFrac ?? -Infinity) * 100;
    const minPeak = cfg.liveOscarVariantASalvage24MinPeakPct;
    if (peakPct + LADDER_PNL_EPS < minPeak && pnlFrac <= LADDER_PNL_EPS) {
      return 'salvage24';
    }
  }

  if (!ot.liveVariantAH48Checked && ageH >= 48) {
    ot.liveVariantAH48Checked = true;
    if (pnlFrac <= LADDER_PNL_EPS) return 'h48_loss';
    if (cfg.liveOscarVariantASmart48Enabled) {
      ot.liveVariantASmart48Extended = true;
    } else {
      return 'horizon48';
    }
  }

  const horizonH = variantAMaxHorizonHours(ot, cfg);
  if (ageH >= horizonH) {
    return ot.liveVariantASmart48Extended ? 'horizon96' : 'horizon48';
  }

  return null;
}

export function isVariantATimedLossExitTag(tag: VariantAExitTag | undefined): boolean {
  return tag === 'salvage24' || tag === 'h48_loss';
}

export function variantAExitTagLabel(tag: VariantAExitTag | undefined): string | null {
  if (!tag) return null;
  switch (tag) {
    case 'salvage24':
      return 'Variant A · salvage @24h (peak < +5%, PnL ≤ 0)';
    case 'h48_loss':
      return 'Variant A · smart48 loss cut @48h';
    case 'horizon48':
      return 'Variant A · horizon @48h';
    case 'horizon96':
      return 'Variant A · smart48 extended horizon @96h';
    case 'moon50':
      return 'Variant A · moon +50% full exit';
    case 'trail':
      return 'Variant A · peak retrace trail (arm +35%, retrace 12%)';
    default:
      return `Variant A · ${tag}`;
  }
}
