/**
 * Live tracker exit MTM from Jupiter SOL→token buy-probe vs latest PG `price_usd`.
 *
 * Goal: conservative tradable mark for TP / peak / trail — never mark above what Jupiter
 * can support, and never trust a lone Jupiter spike above snapshot (thin-route ghost pump).
 *
 * - **Up (ghost pump):** Jupiter ≫ snapshot → cap at snapshot.
 * - **Down (stale high snapshot):** Jupiter ≪ snapshot → trust Jupiter (USDUC-class bug).
 * - **In band:** min(snapshot, Jupiter) — sell-side conservative.
 */
export function liveTrackerMtmUsdSnapJupiterSymmetricBand(args: {
  snapPx: number;
  jupiterPx: number;
  maxPremiumOverSnapshotPct: number;
  /**
   * Avg entry / open anchor. When Jupiter is above anchor but PG snapshot is below anchor,
   * PG is stale-low (Cupsey 2026-07-09) — trust Jupiter for TP instead of capping to snapshot.
   */
  anchorPx?: number;
}): {
  useUsd: number;
  clampedFromJupiter: boolean;
  bandClamp: 'high' | 'low' | 'anchor_stale_low' | null;
} {
  const { snapPx, jupiterPx, maxPremiumOverSnapshotPct, anchorPx } = args;
  if (!(jupiterPx > 0)) {
    return { useUsd: snapPx > 0 ? snapPx : 0, clampedFromJupiter: false, bandClamp: null };
  }
  if (!(snapPx > 0) || !(maxPremiumOverSnapshotPct > 0)) {
    return { useUsd: jupiterPx, clampedFromJupiter: false, bandClamp: null };
  }
  const capMult = 1 + maxPremiumOverSnapshotPct / 100;
  if (jupiterPx > snapPx * capMult) {
    if (
      anchorPx != null &&
      anchorPx > 0 &&
      jupiterPx >= anchorPx - 1e-18 &&
      snapPx < anchorPx * (1 - 0.005)
    ) {
      return { useUsd: jupiterPx, clampedFromJupiter: true, bandClamp: 'anchor_stale_low' };
    }
    return { useUsd: snapPx, clampedFromJupiter: true, bandClamp: 'high' };
  }
  if (jupiterPx < snapPx / capMult) {
    return { useUsd: jupiterPx, clampedFromJupiter: true, bandClamp: 'low' };
  }
  const conservative = Math.min(snapPx, jupiterPx);
  return { useUsd: conservative, clampedFromJupiter: conservative !== jupiterPx, bandClamp: null };
}

/** @deprecated Use {@link liveTrackerMtmUsdSnapJupiterSymmetricBand} (same behavior; name was upward-only). */
export const liveTrackerMtmUsdPreferSnapshotOnUpwardGhost = liveTrackerMtmUsdSnapJupiterSymmetricBand;
