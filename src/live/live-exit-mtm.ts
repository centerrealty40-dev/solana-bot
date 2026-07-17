/**
 * Live exit MTM architecture — reference vs executable prices.
 *
 * **Reference** (PG / Birdeye): pool mid, vol/liq context, cross-check only.
 * **Executable** (Jupiter sell-probe, then buy-probe): tradable mark for exits.
 *
 * Invariants:
 * - TP / peak / trail arm advance only on executable-confirmed marks (sell-probe preferred).
 * - Raw PG alone must not drive exit MTM or peak (CHANCE / awakening vol-wick class).
 * - Sell-side conservative: min(trusted reference, executable) when both are trusted.
 * - PG wick-high (ref ≫ executable): drop reference for this tick.
 * - Jupiter pump ghost (executable ≫ ref): cap at reference unless anchor_stale_low (Cupsey).
 * - No executable this tick: caller falls back to last observed — not raw PG.
 */

export type LiveExitMtmBandClamp = 'high' | 'low' | 'anchor_stale_low' | null;

export type LiveExitMtmPgRejectReason = 'wick_high' | null;

export function pickJupiterExecutablePx(args: {
  jupiterSellPx: number | null | undefined;
  jupiterBuyPx: number | null | undefined;
}): { px: number | null; source: 'sell' | 'buy' | null } {
  const sell = args.jupiterSellPx;
  if (sell != null && sell > 0 && Number.isFinite(sell)) {
    return { px: sell, source: 'sell' };
  }
  const buy = args.jupiterBuyPx;
  if (buy != null && buy > 0 && Number.isFinite(buy)) {
    return { px: buy, source: 'buy' };
  }
  return { px: null, source: null };
}

/** Drop PG reference when it prints a fresh wick far above executable sell economics. */
export function rejectPgSnapshotWickHighForMtm(args: {
  snapPx: number;
  executablePx: number | null;
  maxPremiumOverExecutablePct: number;
}): {
  snapPx: number;
  rejected: boolean;
  reason: LiveExitMtmPgRejectReason;
} {
  const { executablePx, maxPremiumOverExecutablePct } = args;
  let snapPx = args.snapPx;
  if (!(snapPx > 0) || !(executablePx != null && executablePx > 0) || !(maxPremiumOverExecutablePct > 0)) {
    return { snapPx, rejected: false, reason: null };
  }
  const capMult = 1 + maxPremiumOverExecutablePct / 100;
  if (snapPx > executablePx * capMult) {
    return { snapPx: 0, rejected: true, reason: 'wick_high' };
  }
  return { snapPx, rejected: false, reason: null };
}

export function resolveLiveExitMtmMark(args: {
  snapPx: number;
  jupiterSellPx: number | null | undefined;
  jupiterBuyPx: number | null | undefined;
  maxPremiumOverSnapshotPct: number;
  anchorPx?: number;
}): {
  exitMtmUsd: number;
  /** 0 = do not advance peak / TP ladder on this tick (no trusted sell-probe). */
  peakMtmUsd: number;
  pgSnapUsed: number;
  pgRejected: boolean;
  pgRejectReason: LiveExitMtmPgRejectReason;
  jupiterExecutablePx: number | null;
  jupiterExecutableSource: 'sell' | 'buy' | null;
  clampedFromJupiter: boolean;
  bandClamp: LiveExitMtmBandClamp;
} {
  const { maxPremiumOverSnapshotPct, anchorPx } = args;
  const picked = pickJupiterExecutablePx({
    jupiterSellPx: args.jupiterSellPx,
    jupiterBuyPx: args.jupiterBuyPx,
  });
  const jupiterPx = picked.px;

  const wick = rejectPgSnapshotWickHighForMtm({
    snapPx: args.snapPx,
    executablePx: picked.source === 'sell' ? picked.px : args.jupiterSellPx ?? picked.px,
    maxPremiumOverExecutablePct: maxPremiumOverSnapshotPct,
  });
  const snapPx = wick.snapPx;

  if (jupiterPx == null || !(jupiterPx > 0)) {
    return {
      exitMtmUsd: 0,
      peakMtmUsd: 0,
      pgSnapUsed: snapPx,
      pgRejected: wick.rejected,
      pgRejectReason: wick.reason,
      jupiterExecutablePx: null,
      jupiterExecutableSource: null,
      clampedFromJupiter: false,
      bandClamp: null,
    };
  }

  const band = liveExitMtmSymmetricBand({
    snapPx,
    jupiterPx,
    maxPremiumOverSnapshotPct,
    anchorPx,
  });

  const sellTrusted = picked.source === 'sell';

  return {
    exitMtmUsd: band.useUsd,
    peakMtmUsd: sellTrusted ? band.useUsd : 0,
    pgSnapUsed: snapPx,
    pgRejected: wick.rejected,
    pgRejectReason: wick.reason,
    jupiterExecutablePx: jupiterPx,
    jupiterExecutableSource: picked.source,
    clampedFromJupiter: band.clampedFromJupiter,
    bandClamp: band.bandClamp,
  };
}

/** Symmetric PG ↔ executable band (internal); exported for legacy tests via mtm-snapshot-guard. */
export function liveExitMtmSymmetricBand(args: {
  snapPx: number;
  jupiterPx: number;
  maxPremiumOverSnapshotPct: number;
  anchorPx?: number;
}): {
  useUsd: number;
  clampedFromJupiter: boolean;
  bandClamp: LiveExitMtmBandClamp;
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
