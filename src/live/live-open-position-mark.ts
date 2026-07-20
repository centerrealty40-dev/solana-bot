/**
 * Unified live open-position exit mark (live-oscar family).
 *
 * ONE principle for the tracked mark used by kill / TP / trail / avg-down:
 *
 *   The mark is the freshest *trusted* price. Priority (highest first):
 *     1. executable — Jupiter sell-probe / hot exec-sell / stream fill (tradable, truest)
 *     2. reference_aggregator — a FRESH real-aggregator quote (Birdeye / DexScreener)
 *     3. pg_fresh — a PG snapshot still within `pgMaxAgeMs`
 *     4. hold — last observed / entry anchor (no fresh source this tick)
 *
 * Peak / TP eligibility (the anti-phantom rule):
 *   - Tiers 1–2 are peak-eligible: they may advance the peak and arm the trail / fire the
 *     TP ladder. Per-tick jump clamping still bounds single-tick ghost spikes upstream.
 *   - Tier 3 (raw PG) and tier 4 (hold) are NOT peak-eligible: a stale/pool-mid wick must
 *     never ratchet a false take-profit (ZEREBRO / FfpUuX wick class). They may still drive
 *     DOWNSIDE exits (kill) via the mark — downside is always conservative for exits.
 *
 * A stale source is dropped entirely: it never becomes the mark, and (see
 * `isDiscoveryQuoteDivergent`) never rejects a fresher external quote. This closes both the
 * phantom-high TP and the stale-PG freeze (Ge87 Jul 2026 RCA) under a single model.
 */

export type LiveMarkTier = 'executable' | 'reference_aggregator' | 'pg_fresh' | 'hold';

export type LiveMarkReferenceSource = 'birdeye' | 'dexscreener' | 'pg_snapshot' | null;

export interface ResolveLiveOpenPositionMarkArgs {
  /** Executable / tradable price this tick (Jupiter sell-probe, hot exec-sell, stream). Peak-eligible. */
  executableUsd?: number | null;
  /** Resolved reference price — freshest of Birdeye → DexScreener → PG (tracker `snapPx`). */
  referenceUsd: number | null;
  referenceSource: LiveMarkReferenceSource;
  /** Age of the reference price in ms (aggregator fetch age, or PG snapshot age). */
  referenceAgeMs: number | null;
  /** Max age for an aggregator (Birdeye/DexScreener) quote to be trusted as the mark + peak. */
  referenceMaxStaleMs: number;
  /** Max age for a PG snapshot to be usable at all (downside / hold only). */
  pgMaxAgeMs: number;
  lastObservedUsd?: number | null;
  anchorUsd?: number | null;
}

export interface LiveOpenPositionMark {
  markUsd: number;
  source: LiveMarkTier;
  /** true → caller may advance peak / arm TP (up-ratchet). false → downside / hold only. */
  peakEligible: boolean;
  reason: string;
}

function positiveFinite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

export function resolveLiveOpenPositionMark(
  args: ResolveLiveOpenPositionMarkArgs,
): LiveOpenPositionMark {
  const { executableUsd, referenceUsd, referenceSource, referenceAgeMs } = args;

  // 1) Executable — truest tradable mark; always peak-eligible.
  if (positiveFinite(executableUsd)) {
    return { markUsd: executableUsd, source: 'executable', peakEligible: true, reason: 'executable' };
  }

  const refFresh = referenceAgeMs == null || referenceAgeMs <= Math.max(0, args.referenceMaxStaleMs);

  // 2) Fresh real-aggregator quote (Birdeye / DexScreener) — peak-eligible.
  if (
    positiveFinite(referenceUsd) &&
    (referenceSource === 'birdeye' || referenceSource === 'dexscreener') &&
    refFresh
  ) {
    return {
      markUsd: referenceUsd,
      source: 'reference_aggregator',
      peakEligible: true,
      reason: `aggregator:${referenceSource}`,
    };
  }

  // 3) Fresh PG snapshot — downside / hold only, never advances the peak.
  const pgFresh = referenceAgeMs == null || referenceAgeMs <= Math.max(0, args.pgMaxAgeMs);
  if (positiveFinite(referenceUsd) && referenceSource === 'pg_snapshot' && pgFresh) {
    return { markUsd: referenceUsd, source: 'pg_fresh', peakEligible: false, reason: 'pg_fresh' };
  }

  // 4) No trusted fresh source this tick — hold at last observed / entry anchor. Never stale PG.
  const hold = positiveFinite(args.lastObservedUsd)
    ? args.lastObservedUsd
    : positiveFinite(args.anchorUsd)
      ? args.anchorUsd
      : 0;
  return {
    markUsd: hold,
    source: 'hold',
    peakEligible: false,
    reason: positiveFinite(referenceUsd) ? 'reference_stale_hold' : 'no_reference_hold',
  };
}
