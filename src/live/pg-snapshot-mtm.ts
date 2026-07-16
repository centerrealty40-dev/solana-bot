import { snapshotPriceAgeMs } from '../papertrader/stale-price.js';

/**
 * Drop PG snapshot price for live exit MTM when the row is too old (e.g. collector gap on
 * remote PG — FfpUuX Jul 2026 used a 15-day-old $0.000464 row and fired phantom TP).
 */
export function rejectStalePgSnapshotForMtm(args: {
  snapPx: number;
  snapTsMs: number | null | undefined;
  nowMs: number;
  maxAgeMs: number;
}): {
  snapPx: number;
  snapTsMs: number | null;
  rejected: boolean;
  ageMs: number | null;
} {
  const { nowMs, maxAgeMs } = args;
  let snapPx = args.snapPx;
  const snapTsMs = args.snapTsMs ?? null;
  if (!(snapPx > 0) || !(maxAgeMs > 0)) {
    return { snapPx, snapTsMs, rejected: false, ageMs: snapshotPriceAgeMs(snapTsMs, nowMs) };
  }
  const ageMs = snapshotPriceAgeMs(snapTsMs, nowMs);
  if (ageMs == null) {
    return { snapPx: 0, snapTsMs: null, rejected: true, ageMs: null };
  }
  if (ageMs > maxAgeMs) {
    return { snapPx: 0, snapTsMs: null, rejected: true, ageMs };
  }
  return { snapPx, snapTsMs, rejected: false, ageMs };
}
