/**
 * Live tracker: Jupiter SOL→token probe can imply a much higher USD/token than the latest
 * PG pair snapshot (thin route, micro-notional, transient pool state). For TP / peak / trail
 * we optionally trust the snapshot when Jupiter is "too optimistic" vs snapshot on the upside.
 */
export function liveTrackerMtmUsdPreferSnapshotOnUpwardGhost(args: {
  snapPx: number;
  jupiterPx: number;
  maxPremiumOverSnapshotPct: number;
}): { useUsd: number; clampedFromJupiter: boolean } {
  const { snapPx, jupiterPx, maxPremiumOverSnapshotPct } = args;
  if (!(jupiterPx > 0)) {
    return { useUsd: snapPx > 0 ? snapPx : 0, clampedFromJupiter: false };
  }
  if (!(snapPx > 0) || !(maxPremiumOverSnapshotPct > 0)) {
    return { useUsd: jupiterPx, clampedFromJupiter: false };
  }
  const capMult = 1 + maxPremiumOverSnapshotPct / 100;
  if (jupiterPx > snapPx * capMult) {
    return { useUsd: snapPx, clampedFromJupiter: true };
  }
  return { useUsd: jupiterPx, clampedFromJupiter: false };
}
