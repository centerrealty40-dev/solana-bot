/**
 * Ask the green entry gate before a green exit fires.
 *
 * own2 sold a green bag on `green_trail` and bought the same mint back seconds
 * later: over 14.6h and 248 sells, 34 pairs re-entered within a minute at a
 * mean 0.44% *higher* price, $3.63 of SOL fees for nothing; widening the window
 * to 300s gives 68 pairs, +1.6%, $8.97. `exit-defer.ts` already asks the dip
 * gate, but green re-enters through `evaluateGreenLane`, so the green round
 * trip was never covered.
 *
 * The gate consulted here is built by the same function the entry path uses, so
 * the exit cannot hold on a lane the entry would not open — one brain, not a
 * second opinion.
 */
import {
  evaluateGreenLane,
  type GreenLaneGates,
  type GreenLaneInput,
} from './green-lane.js';
import type { MildDipConfig } from './config.js';
import { OPEN_MARK_METRICS_MAX_AGE_MS } from './open-mark-metrics.js';

export function effectiveRunnerTapeCap(
  relax: boolean,
  runnerValue: number,
  normalValue: number,
): number {
  return relax ? (runnerValue > 0 ? runnerValue : Number.POSITIVE_INFINITY) : normalValue;
}

/** The green lane gates, with runner relaxation applied — entry and exit share this. */
export function greenLaneGatesFrom(
  green: MildDipConfig['green'],
  runnerRelax: boolean,
): GreenLaneGates {
  return {
    enabled: true,
    minTurnover5mLiq: green.minTurnover5mLiq,
    minVolume5mUsd: green.minVolume5mUsd,
    minVolume1hUsd: green.minVolume1hUsd,
    minPc5mPct: green.minPc5mPct,
    maxPc5mPct: green.maxPc5mPct,
    maxRallyIntoPeakPct: green.maxRallyIntoPeakPct,
    maxBounceFromTroughPct: runnerRelax
      ? green.runnerMaxBounceFromTroughPct
      : green.maxBounceFromTroughPct,
    minDumpFromPeakPct: green.minDumpFromPeakPct,
    tapeMinuteGatesEnabled: green.tapeMinuteGatesEnabled,
    minTapeRet1mPct: green.minTapeRet1mPct,
    maxTapePrior5mPct: effectiveRunnerTapeCap(
      runnerRelax,
      green.runnerMaxTapePrior5mPct,
      green.maxTapePrior5mPct,
    ),
    requirePc1h: green.requirePc1h,
    minPc1hPct: green.minPc1hPct,
    minBuys5m: green.minBuys5m,
    maxBuyShare5m: green.maxBuyShare5m,
    minLiquidityUsd: runnerRelax ? green.runnerMinLiquidityUsd : green.minLiquidityUsd,
    minPairAgeHours: runnerRelax ? green.runnerMinPairAgeHours : green.minPairAgeHours,
    maxRet1mPct: green.maxRet1mPct,
    maxTapeRet1mPct: effectiveRunnerTapeCap(
      runnerRelax,
      green.runnerMaxTapeRet1mPct,
      green.maxTapeRet1mPct,
    ),
  };
}

/**
 * The green exits that are a judgement about a fading move, not a floor.
 * `green_stop`, `green_tp`, `green_max_hold` and `hard_time_stop` answer to
 * limits the entry gate has no say over, and always sell.
 */
export const GREEN_WOULD_BUY_HOLD_REASONS: ReadonlySet<string> = new Set([
  'green_trail',
  'green_no_move',
]);

export type GreenExitHoldVerdict = { hold: boolean; reasons: string[] };

export function shouldHoldGreenExitWouldBuy(args: {
  reason: string | null;
  enabled: boolean;
  maxTotalMs: number;
  deferredMsSoFar: number;
  metricsAgeMs: number | null;
  greenGates: GreenLaneGates;
  input: GreenLaneInput;
}): GreenExitHoldVerdict {
  if (!args.enabled) return { hold: false, reasons: ['disabled'] };
  if (args.reason == null || !GREEN_WOULD_BUY_HOLD_REASONS.has(args.reason)) {
    return { hold: false, reasons: ['reason_not_holdable'] };
  }
  if (args.maxTotalMs > 0 && args.deferredMsSoFar >= args.maxTotalMs) {
    return { hold: false, reasons: ['hold_budget_spent'] };
  }
  const ageMs = args.metricsAgeMs;
  if (ageMs == null) return { hold: false, reasons: ['no_metrics'] };
  if (ageMs > OPEN_MARK_METRICS_MAX_AGE_MS) {
    return { hold: false, reasons: [`metrics_stale_${Math.round(ageMs / 1000)}s`] };
  }
  const verdict = evaluateGreenLane(args.input, args.greenGates);
  if (verdict.pass) return { hold: true, reasons: verdict.reasons };
  if (!verdict.reasons.includes('green_tape_insufficient')) {
    return { hold: false, reasons: verdict.reasons };
  }
  // Own tape had no minute sample on this tick; that is missing data, not a
  // verdict. Fall back to the gate's own Dex-based branch (pc5m bounds +
  // maxRet1mPct) rather than releasing the exit on a data gap.
  const fb = evaluateGreenLane(args.input, {
    ...args.greenGates,
    tapeMinuteGatesEnabled: false,
  });
  return { hold: fb.pass, reasons: ['tape_fallback_dex', ...fb.reasons] };
}
