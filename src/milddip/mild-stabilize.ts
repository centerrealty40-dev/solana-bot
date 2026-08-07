/**
 * Mild bounce / stabilize branch (leader-style): after a dump from local peak,
 * buy the reclaim off the trough — not a fixed Dex pc5m threshold.
 *
 * Used as:
 *  - fresh entry when main band did not fire (shallow dump + bounce);
 *  - second $5 clip (scale-in) while a knife/main position is still open.
 */

import type { MildDipPriceRing } from './price-ring.js';

export type MildStabilizeGates = {
  enabled: boolean;
  /** Dump from peak must be > this (e.g. −25). */
  minDumpPct: number;
  /** Dump from peak must be ≤ this (e.g. −5). */
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
   * Scale-in only: trough must be at least this % below the open entry
   * (further dump after first clip). 0 = off.
   */
  scaleInMinDumpBelowEntryPct: number;
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

/** Scale-in guard: trough must sit below first-clip entry. */
export function mildStabilizeScaleInOk(args: {
  entryPriceUsd: number;
  troughPriceUsd: number | null;
  minDumpBelowEntryPct: number;
}): { pass: boolean; reason?: string } {
  const { entryPriceUsd, troughPriceUsd, minDumpBelowEntryPct } = args;
  if (!(entryPriceUsd > 0)) return { pass: false, reason: 'mild_stabilize_scale_in_bad_entry' };
  if (minDumpBelowEntryPct <= 0) return { pass: true };
  if (troughPriceUsd == null || !(troughPriceUsd > 0)) {
    return { pass: false, reason: 'mild_stabilize_scale_in_missing_trough' };
  }
  const belowPct = (1 - troughPriceUsd / entryPriceUsd) * 100;
  if (belowPct < minDumpBelowEntryPct) {
    return {
      pass: false,
      reason: `mild_stabilize_scale_in_dump=${belowPct.toFixed(2)}%<min=${minDumpBelowEntryPct}`,
    };
  }
  return { pass: true };
}
