/**
 * Live tracker: Jupiter SOL→token buy-probe can diverge from the latest PG `price_usd`.
 * - **Up:** thin route / micro-notional can imply a much **higher** USD/token than the pool snapshot
 *   (false pump for TP). When above `maxPremiumOverSnapshotPct`, trust the snapshot.
 * - **Down:** the same probe can sit **below** the snapshot (stale route, partial fill math, illiquidity).
 *   When below the symmetric **floor** (`snap / (1+p%)`), trust the snapshot so TP / peak / trail
 *   are not permanently blocked while the pool snapshot already shows the rung.
 */
export function liveTrackerMtmUsdSnapJupiterSymmetricBand(args: {
  snapPx: number;
  jupiterPx: number;
  maxPremiumOverSnapshotPct: number;
}): { useUsd: number; clampedFromJupiter: boolean; bandClamp: 'high' | 'low' | null } {
  const { snapPx, jupiterPx, maxPremiumOverSnapshotPct } = args;
  if (!(jupiterPx > 0)) {
    return { useUsd: snapPx > 0 ? snapPx : 0, clampedFromJupiter: false, bandClamp: null };
  }
  if (!(snapPx > 0) || !(maxPremiumOverSnapshotPct > 0)) {
    return { useUsd: jupiterPx, clampedFromJupiter: false, bandClamp: null };
  }
  const capMult = 1 + maxPremiumOverSnapshotPct / 100;
  if (jupiterPx > snapPx * capMult) {
    return { useUsd: snapPx, clampedFromJupiter: true, bandClamp: 'high' };
  }
  if (jupiterPx < snapPx / capMult) {
    return { useUsd: snapPx, clampedFromJupiter: true, bandClamp: 'low' };
  }
  return { useUsd: jupiterPx, clampedFromJupiter: false, bandClamp: null };
}

/** @deprecated Use {@link liveTrackerMtmUsdSnapJupiterSymmetricBand} (same behavior; name was upward-only). */
export const liveTrackerMtmUsdPreferSnapshotOnUpwardGhost = liveTrackerMtmUsdSnapJupiterSymmetricBand;
