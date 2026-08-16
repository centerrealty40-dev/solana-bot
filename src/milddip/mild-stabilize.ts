/**
 * Mild bounce / stabilize branch (leader-style): after a dump from local peak,
 * buy the reclaim off the trough — not a fixed Dex pc5m threshold.
 *
 * Fresh flat entries are gated by `freshEntryEnabled` (live default off —
 * Gymbmn / 7rMnp9 green-candle noise). Second-clip scale-in was removed
 * (1.11.730) after net-negative live impact.
 */

import type { MildDipPriceRing } from './price-ring.js';

export const MILD_STABILIZE_HOURLY_WINDOW_MS = 3_600_000;
const mildStabilizeAttemptStamps: number[] = [];
const mildStabilizeSkipTelemetryStamps: number[] = [];

function pruneStamps(stamps: number[], nowMs: number): void {
  const cutoff = nowMs - MILD_STABILIZE_HOURLY_WINDOW_MS;
  while (stamps.length > 0 && stamps[0]! < cutoff) stamps.shift();
}

/**
 * Reserve the slot immediately before the lane's buy call. A slot is counted
 * for every attempted buy, including a transaction that later fails.
 */
export function takeMildStabilizeAttemptSlot(
  maxPerHour: number,
  nowMs: number,
): { allowed: boolean; count: number; limit: number } {
  if (!(maxPerHour > 0)) return { allowed: true, count: 0, limit: 0 };
  pruneStamps(mildStabilizeAttemptStamps, nowMs);
  if (mildStabilizeAttemptStamps.length >= maxPerHour) {
    return {
      allowed: false,
      count: mildStabilizeAttemptStamps.length,
      limit: maxPerHour,
    };
  }
  mildStabilizeAttemptStamps.push(nowMs);
  return {
    allowed: true,
    count: mildStabilizeAttemptStamps.length,
    limit: maxPerHour,
  };
}

/** Reserve one global skip-telemetry event inside the rolling hour. */
export function takeMildStabilizeSkipTelemetrySlot(
  maxPerHour: number,
  nowMs: number,
): boolean {
  if (!(maxPerHour > 0)) return false;
  pruneStamps(mildStabilizeSkipTelemetryStamps, nowMs);
  if (mildStabilizeSkipTelemetryStamps.length >= maxPerHour) return false;
  mildStabilizeSkipTelemetryStamps.push(nowMs);
  return true;
}

/** Keep the skip journal focused on plausible, non-trivial ring verdicts. */
export function mildStabilizeSkipTelemetryEligible(args: {
  pass: boolean;
  reasons: string[];
  dumpPct: number | null;
  troughAgeMs: number | null;
  minDumpPct: number;
}): boolean {
  if (args.pass || args.reasons.includes('mild_stabilize_missing_ring')) return false;
  if (args.dumpPct == null || !Number.isFinite(args.dumpPct)) return false;
  if (!(args.dumpPct <= args.minDumpPct)) return false;
  if (args.troughAgeMs === 0 && args.dumpPct <= -90) return false;
  return true;
}

/** Test helper. */
export function __resetMildStabilizeBudgetsForTests(): void {
  mildStabilizeAttemptStamps.length = 0;
  mildStabilizeSkipTelemetryStamps.length = 0;
}

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

/**
 * Live Dex must still print a dump — ring bounce alone is green-candle reclaim.
 * Missing Dex fails closed when requireDexDip is on.
 */
export function mildStabilizeDexDipOk(args: {
  requireDexDip: boolean;
  dexPc5m: number | null | undefined;
  dexMaxDipPct: number;
}): boolean {
  if (!args.requireDexDip) return true;
  const pc = args.dexPc5m;
  if (pc == null || !Number.isFinite(pc)) return false;
  return pc <= args.dexMaxDipPct;
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

  // Dump = peak → trough AFTER peak. Window-min before the peak is the
  // pump base — using it as "dump" buys tops (EjD5 / stream wick class).
  const pt = ring.troughAfterPeak(mint, gates.lookbackMs, nowMs);
  const last = ring.lastPrice(mint, nowMs);
  const peak = pt?.peak ?? null;
  const trough = pt?.trough ?? null;
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
