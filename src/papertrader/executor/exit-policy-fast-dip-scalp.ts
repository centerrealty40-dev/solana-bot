/**
 * Fast-dip scalp exit policy (`fast_dip_scalp_v1`) — DISABLED lane by default.
 *
 * Unlike scalp_wave (kill off + escalation handoff), this keeps a REAL hard SL and a short
 * time-stop, matching the backtested scalp profile (60d, pumpswap 60s bars):
 *   entry ≤ −25% vs short rolling-high window · single-shot (no averaging) · SL −15% ·
 *   30m time-stop if no TP rung hit · front-loaded TP ladder (+10%/50%, +22%/30%) ·
 *   trailing runner on the remaining ~20% (arm +18% / step −6%).
 *
 * Wiring reuses the tested tracker machinery rather than a bespoke engine:
 *   - hard SL  → negative `dcaKillstop` ⇒ `classicKill` path,
 *   - time-stop → `timeoutHours` ⇒ generic TIMEOUT branch (suppressed once a TP rung is taken),
 *   - TP ladder → uniform `tpGridStepPnl` + `tpGridSellFractionByStep` (grid engine),
 *   - runner   → peak trail (`trailMode='peak'`, arm `trailTriggerX`, drop `trailDrop`).
 * Averaging-down is blocked explicitly in the tracker `mayDca` gate for this policy.
 *
 * NOTE: the grid uses a UNIFORM step, so the second rung lands at 2×step (≈+20%) rather than the
 * backtest's +22% — a deliberate, documented approximation for the disabled v1 lane.
 */
import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { resolveLiveOscarTradeLaneFromOpen } from '../live-oscar-scalp-wave.js';
import { parseFastDipScalpTpLadder } from '../live-oscar-fast-dip-scalp.js';
import { isLiveOscarTradingStrategyId } from '../../preset-c/live-oscar-family.js';

export function isFastDipScalpExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'fast_dip_scalp_v1' || resolveLiveOscarTradeLaneFromOpen(ot) === 'fast_dip_scalp';
}

function fastDipScalpSellFractions(cfg: PaperTraderConfig): number[] {
  return parseFastDipScalpTpLadder(cfg).map((r) => r.sellFrac);
}

/** First TP rung gain fraction (grid step); default 0.10. */
function fastDipScalpFirstRungGain(cfg: PaperTraderConfig): number {
  return parseFastDipScalpTpLadder(cfg)[0]?.gainFrac ?? 0.1;
}

/** Stamp fast_dip_scalp_v1 on open — one-shot, hard SL (kill on), TP ladder grid + peak trail. */
export function stampFastDipScalpExitPolicyOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId)) return false;
  if (resolveLiveOscarTradeLaneFromOpen(ot) !== 'fast_dip_scalp') return false;
  ot.liveExitPolicyId = 'fast_dip_scalp_v1';
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: fastDipScalpFirstRungGain(cfg),
    gridSellFractionByStep: fastDipScalpSellFractions(cfg),
    /** Real SL as negative kill fraction (−0.15 = −15% from avg). */
    dcaKillstop: -Math.abs(cfg.liveOscarFastDipScalpKillPct),
  };
  return true;
}

/** Effective exit params for tracker / cfgEffectiveForOpen. Kill ENABLED (hard SL). */
export function fastDipScalpEffectiveExitParams(cfg: PaperTraderConfig): Pick<
  PaperTraderConfig,
  | 'tpX'
  | 'dcaKillstop'
  | 'timeoutHours'
  | 'tpGridStepPnl'
  | 'tpGridSellFractionByStep'
  | 'trailMode'
  | 'trailTriggerX'
  | 'trailDrop'
  | 'slX'
> {
  const firstRungGain = fastDipScalpFirstRungGain(cfg);
  return {
    tpX: 1 + firstRungGain,
    dcaKillstop: -Math.abs(cfg.liveOscarFastDipScalpKillPct),
    timeoutHours: cfg.liveOscarFastDipScalpTimeStopMin / 60,
    tpGridStepPnl: firstRungGain,
    tpGridSellFractionByStep: fastDipScalpSellFractions(cfg),
    trailMode: 'peak',
    trailTriggerX: 1 + cfg.liveOscarFastDipScalpTrailArmPct,
    trailDrop: cfg.liveOscarFastDipScalpTrailStepPct,
    slX: 0,
  };
}
