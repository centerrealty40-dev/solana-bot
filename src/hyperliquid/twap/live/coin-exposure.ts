import { isDeniedWhale } from '../whale-denylist.js';
import type { TwapWatchState } from '../detect.js';
import {
  computeCoinEntryPlan,
  opposingActiveTwapsForCoin,
  shouldCloseForImpactLoss,
  twapHourlyImpactPct,
} from '../coin-twap-analysis.js';
import type { NormalizedTwapSignal } from '../types.js';
import type { HlTwapLiveOpen } from './types.js';

export type LiveEntryDecision = {
  allow: boolean;
  reason: string;
  openAtMs?: number;
};

export { shouldCloseForImpactLoss, opposingActiveTwapsForCoin, computeCoinEntryPlan };

/**
 * Each qualifying TWAP (unique hash) → separate $100 position.
 * Same coin + same side: stack (multiple whales / TWAPs).
 * Opposite side blocked only while **our** position is open (perps net).
 * Entry gating: see computeCoinEntryPlan (hourly impact %/h only).
 */
export function canScheduleLiveEntry(
  sig: NormalizedTwapSignal,
  watchState: TwapWatchState,
  opens: Map<string, HlTwapLiveOpen>,
  minImpactPct: number,
): LiveEntryDecision {
  if (isDeniedWhale(sig.user)) {
    return { allow: false, reason: 'whale_denylisted' };
  }

  const hourly = twapHourlyImpactPct(sig);
  if (minImpactPct > 0 && (hourly == null || hourly < minImpactPct)) {
    return { allow: false, reason: 'impact_below_min' };
  }

  const hasOpposite = [...opens.values()].some(
    (p) => p.coin === sig.coin && p.side !== sig.side,
  );
  if (hasOpposite) {
    return { allow: false, reason: 'coin_has_opposite_side' };
  }

  const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
  if (!plan.allow) {
    return { allow: false, reason: plan.reason };
  }
  return { allow: true, reason: plan.reason, openAtMs: plan.openAtMs };
}
