/**
 * Mild bounce / stabilize branch (leader-style): after a dump from local peak,
 * buy the reclaim off the trough — not a fixed Dex pc5m threshold.
 *
 * Fresh flat entries are gated by `freshEntryEnabled` (live default off —
 * Gymbmn / 7rMnp9 green-candle noise). Second-clip scale-in was removed
 * (1.11.730) after net-negative live impact.
 */

import type { MildDipPriceRing } from './price-ring.js';

/** Whether fast-path may evaluate mild_stabilize for this candidate pass. */
export function mildStabilizeLaneAllowed(args: {
  enabled: boolean;
  freshEntryEnabled: boolean;
  /** True when another dipSource already won this pass. */
  hasOtherDipSource: boolean;
}): boolean {
  if (!args.enabled) return false;
  if (!args.freshEntryEnabled) return false;
  return !args.hasOtherDipSource;
}

export type MildStabilizeGates = {
  enabled: boolean;
  /** Dump from peak must be > this (e.g. −25). */
  minDumpPct: number;
  /** Dump from peak must be ≤ this (e.g. −8). */
  maxDumpPct: number;
  /** Min bounce % off trough. */
  minBouncePct: number;
  /** Max bounce % off trough (chase). */
  maxBouncePct: number;
  /** Trough must be at least this old (ms) — avoid buying the print of the low. */
  troughMinAgeMs: number;
  /** Lookback for peak/trough. */
  lookbackMs: number;
  /**
   * Last mark must stay ≥ this % below the local peak (anti green-candle-to-top).
   * Gymbmn / 25rbPvD: −5% wiggle then full reclaim (~0% below peak) — reject.
   * 0 = off.
   */
  minBelowPeakPct: number;
};

export type MildStabilizeVerdict = {
  pass: boolean;
  dumpPct: number | null;
  bouncePct: number | null;
  troughPriceUsd: number | null;
  troughAtMs: number | null;
  peakPriceUsd: number | null;
  lastPriceUsd: number | null;
  reasons: string[];
};

export function evaluateMildStabilizeFromRing(
  ring: MildDipPriceRing,
  mint: string,
  nowMs: number,
  gates: MildStabilizeGates,
): MildStabilizeVerdict {
  const reasons: string[] = [];
  if (!gates.enabled) {
    return {
      pass: false,
      dumpPct: null,
      bouncePct: null,
      troughPriceUsd: null,
      troughAtMs: null,
      peakPriceUsd: null,
      lastPriceUsd: null,
      reasons: ['mild_stabilize_disabled'],
    };
  }

  const peak = ring.maxPrice(mint, gates.lookbackMs, nowMs);
  const trough = ring.minPrice(mint, gates.lookbackMs, nowMs);
  const last = ring.lastPrice(mint, nowMs);
  if (!peak || !trough || !last || !(peak.priceUsd > 0) || !(trough.priceUsd > 0) || !(last.priceUsd > 0)) {
    return {
      pass: false,
      dumpPct: null,
      bouncePct: null,
      troughPriceUsd: trough?.priceUsd ?? null,
      troughAtMs: trough?.tsMs ?? null,
      peakPriceUsd: peak?.priceUsd ?? null,
      lastPriceUsd: last?.priceUsd ?? null,
      reasons: ['mild_stabilize_missing_ring'],
    };
  }

  const dumpPct = (trough.priceUsd / peak.priceUsd - 1) * 100;
  const bouncePct = (last.priceUsd / trough.priceUsd - 1) * 100;
  const troughAgeMs = nowMs - trough.tsMs;

  if (!(dumpPct > gates.minDumpPct && dumpPct <= gates.maxDumpPct)) {
    reasons.push(
      `mild_stabilize_dump=${dumpPct.toFixed(2)}_outside_(${gates.minDumpPct},${gates.maxDumpPct}]`,
    );
  }
  if (!(bouncePct >= gates.minBouncePct && bouncePct <= gates.maxBouncePct)) {
    reasons.push(
      `mild_stabilize_bounce=${bouncePct.toFixed(2)}_outside_[${gates.minBouncePct},${gates.maxBouncePct}]`,
    );
  }
  if (troughAgeMs < gates.troughMinAgeMs) {
    reasons.push(`mild_stabilize_trough_age=${troughAgeMs}ms<${gates.troughMinAgeMs}`);
  }
  if (gates.minBelowPeakPct > 0) {
    const belowPeakPct = (1 - last.priceUsd / peak.priceUsd) * 100;
    if (belowPeakPct < gates.minBelowPeakPct) {
      reasons.push(
        `mild_stabilize_below_peak=${belowPeakPct.toFixed(2)}%<min=${gates.minBelowPeakPct}`,
      );
    }
  }

  return {
    pass: reasons.length === 0,
    dumpPct,
    bouncePct,
    troughPriceUsd: trough.priceUsd,
    troughAtMs: trough.tsMs,
    peakPriceUsd: peak.priceUsd,
    lastPriceUsd: last.priceUsd,
    reasons,
  };
}
