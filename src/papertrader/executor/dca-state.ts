import type { DcaLevel } from '../config.js';
import type { OpenTrade } from '../types.js';
import { LADDER_PNL_EPS, ladderPnlThresholdMark, ladderPnlThresholdTaken } from './tp-ladder-state.js';

export { LADDER_PNL_EPS as DCA_TRIG_EPS };

export function dcaStepOrTriggerTaken(ot: OpenTrade, stepIdx: number, triggerPct: number): boolean {
  if (ot.dcaUsedIndices.has(stepIdx)) return true;
  return ladderPnlThresholdTaken(ot.dcaUsedLevels, triggerPct);
}

export function markDcaStepFired(ot: OpenTrade, stepIdx: number, triggerPct: number): void {
  ot.dcaUsedIndices.add(stepIdx);
  ladderPnlThresholdMark(ot.dcaUsedLevels, triggerPct);
}

/**
 * If journal lines lost `triggerPct` / step index, recover consumed DCA rungs from `legs[]`
 * (one-time after loadStore, strategy-config aware).
 */
export function reconcileOpenTradeDcaFromLegs(ot: OpenTrade, dcaLevels: DcaLevel[]): void {
  for (const leg of ot.legs) {
    if (leg.reason !== 'dca' || leg.triggerPct === undefined || !Number.isFinite(leg.triggerPct)) continue;
    for (let i = 0; i < dcaLevels.length; i++) {
      const lvl = dcaLevels[i]!;
      if (Math.abs(lvl.triggerPct - leg.triggerPct) <= LADDER_PNL_EPS) {
        markDcaStepFired(ot, i, lvl.triggerPct);
        break;
      }
    }
  }
}

/**
 * True the first time drawdown (vs first leg) crosses a DCA trigger **from above** in one tick.
 * Blocks re-arming the same % after a relief rally (e.g. -10% → -5% → -8% re-tests)
 * unless the level is already consumed in `dcaUsed*` (catch-up is rare).
 */
export function dcaCrossedDownward(
  effPrev: number,
  /** Current drawdown fraction (e.g. -0.08 for -8% vs first leg). */
  curr: number,
  /** Trigger as negative fraction, e.g. -0.07. */
  trigger: number,
): boolean {
  return effPrev > trigger - LADDER_PNL_EPS && curr <= trigger + LADDER_PNL_EPS;
}

export function dcaEffPrev(ot: OpenTrade): number {
  const p = ot.dcaLastEvalDropFromFirstPct;
  return p != null && Number.isFinite(p) ? p : Number.POSITIVE_INFINITY;
}
