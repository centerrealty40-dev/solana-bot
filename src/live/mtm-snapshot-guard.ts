/**
 * Live tracker exit MTM from Jupiter executable probe vs latest PG `price_usd`.
 *
 * Canonical implementation: {@link liveExitMtmSymmetricBand} in `live-exit-mtm.ts`.
 * This module keeps the historical export name for call sites and tests.
 */
import { liveExitMtmSymmetricBand } from './live-exit-mtm.js';

export type { LiveExitMtmBandClamp } from './live-exit-mtm.js';

/**
 * @deprecated Prefer {@link resolveLiveExitMtmMark} (sell-probe + PG wick reject + peak gate).
 */
export function liveTrackerMtmUsdSnapJupiterSymmetricBand(args: {
  snapPx: number;
  jupiterPx: number;
  maxPremiumOverSnapshotPct: number;
  anchorPx?: number;
}): {
  useUsd: number;
  clampedFromJupiter: boolean;
  bandClamp: 'high' | 'low' | 'anchor_stale_low' | null;
} {
  return liveExitMtmSymmetricBand(args);
}

/** @deprecated Alias — same behavior. */
export const liveTrackerMtmUsdPreferSnapshotOnUpwardGhost = liveTrackerMtmUsdSnapJupiterSymmetricBand;
