/**
 * Mild bounce / stabilize branch (leader-style): after a dump from local peak,
 * buy the reclaim off the trough — not a fixed Dex pc5m threshold.
 *
 * Live default: scale-in only (`freshEntryEnabled=false`). Fresh flat bounce
 * entries were buying green-candle noise (Gymbmn / 7rMnp9).
 */

/** Whether fast-path may evaluate mild_stabilize for this candidate pass. */
export function mildStabilizeLaneAllowed(args: {
  enabled: boolean;
  freshEntryEnabled: boolean;
  mildStabilizeOnly: boolean;
  /** True when another dipSource already won this pass. */
  hasOtherDipSource: boolean;
}): boolean {
  if (!args.enabled) return false;
  if (args.mildStabilizeOnly) return true;
  if (!args.freshEntryEnabled) return false;
  return !args.hasOtherDipSource;
}

import type { MildDipPriceRing } from './price-ring.js';

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

/**
 * Scale-in guard (second $5 clip):
 * 1. trough must sit ≥ N% below first-clip entry;
 * 2. that trough must form *after* the first clip opened (not the same dump
 *    that triggered the first buy — HuZ2yj / 5HaLZz→4CCSBX same-price bug);
 * 3. current mark/fill must still be ≥ N% below entry (avg-down), not a
 *    reclaim back to the first-clip print.
 */
export function mildStabilizeScaleInOk(args: {
  entryPriceUsd: number;
  troughPriceUsd: number | null;
  minDumpBelowEntryPct: number;
  troughAtMs?: number | null;
  openedAtMs?: number | null;
  /** Live mark / intended fill — must stay below entry for avg-down. */
  markPriceUsd?: number | null;
}): { pass: boolean; reason?: string } {
  const {
    entryPriceUsd,
    troughPriceUsd,
    minDumpBelowEntryPct,
    troughAtMs,
    openedAtMs,
    markPriceUsd,
  } = args;
  if (!(entryPriceUsd > 0)) return { pass: false, reason: 'mild_stabilize_scale_in_bad_entry' };
  if (minDumpBelowEntryPct <= 0) return { pass: true };
  if (troughPriceUsd == null || !(troughPriceUsd > 0)) {
    return { pass: false, reason: 'mild_stabilize_scale_in_missing_trough' };
  }
  if (
    openedAtMs != null &&
    openedAtMs > 0 &&
    troughAtMs != null &&
    Number.isFinite(troughAtMs) &&
    troughAtMs <= openedAtMs
  ) {
    return { pass: false, reason: 'mild_stabilize_scale_in_trough_before_entry' };
  }
  const troughBelowPct = (1 - troughPriceUsd / entryPriceUsd) * 100;
  if (troughBelowPct < minDumpBelowEntryPct) {
    return {
      pass: false,
      reason: `mild_stabilize_scale_in_dump=${troughBelowPct.toFixed(2)}%<min=${minDumpBelowEntryPct}`,
    };
  }
  if (markPriceUsd != null && markPriceUsd > 0) {
    const markBelowPct = (1 - markPriceUsd / entryPriceUsd) * 100;
    if (markBelowPct < minDumpBelowEntryPct) {
      return {
        pass: false,
        reason: `mild_stabilize_scale_in_mark=${markBelowPct.toFixed(2)}%<min=${minDumpBelowEntryPct}`,
      };
    }
  }
  return { pass: true };
}
