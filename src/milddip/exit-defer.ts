/**
 * 1.11.874 — ask the entry side before a soft exit.
 *
 * The exit engine and the entry gate were two independent opinions about the
 * same token, and they disagreed in the most expensive way possible. GCa9TZ was
 * sold at −10.48% on `breakeven_stop`; ninety-eight seconds later the entry gate
 * bought it back 7.7% lower and the ladder banked two rungs on it. The bag was
 * worth holding the whole time — we paid a full round trip (entry overpay
 * median 1.80%, plus both sell sides) to swap it for itself.
 *
 * So before a soft exit fires, the same `evaluateMildDipEntry` that opens a
 * position is asked whether it would open this one now. If it would, the sell
 * is held: nothing about the name has stopped qualifying, and selling only to
 * buy it back is a fee.
 *
 * Risk exits are never deferred — `hard_stop`, `cliff_dump` and the timeouts
 * answer to something the entry gate cannot see. Profit exits are never
 * deferred either: `tp_grid` and the banks are the point.
 */
import { evaluateMildDipEntry, type MildDipEntryGates } from './gates.js';
import type { MildDipExitReason } from './gates.js';

/**
 * Soft exits: the bag faded, nothing broke. These are the ones that were
 * followed by an immediate rebuy of the same mint.
 */
export const WOULD_BUY_DEFER_REASONS: ReadonlySet<string> = new Set([
  'peak_giveback',
  'peak_giveback_partial',
  'mfe_bank_sleeve',
  'never_arm_giveback',
  'never_arm_stale',
  'never_arm_dead',
  'never_arm_vol_fade',
  'breakeven_stop',
]);

export type ExitDeferGates = {
  enabled: boolean;
  /**
   * Cumulative ms one bag may hold a soft exit this way. The deferral is a
   * claim that the entry gate still likes the name, not a licence to sit: past
   * this the soft exit fires whatever the gate says, and the risk floors were
   * never deferred in the first place.
   */
  maxTotalMs: number;
};

export type ExitDeferMetrics = {
  pc5mPct: number | null;
  volume5mUsd: number | null;
  liquidityUsd: number | null;
  /** Age of the reading; stale metrics cannot claim the gate still passes. */
  ageMs: number;
};

export type ExitDeferVerdict = {
  defer: boolean;
  /** Why not, for the journal: no reason to log a pass we did not take. */
  reasons: string[];
};

/** Metrics not re-read on the exit path, carried from the entry snapshot. */
export type ExitDeferCarriedEntryMetrics = {
  marketCapUsd: number | null;
  pairAgeHours: number | null;
};

const METRICS_MAX_AGE_MS = 60_000;

/**
 * Would the entry gate open this position right now?
 *
 * `pc5m`, `vol5m` and liquidity come from the live open-mark refresh. Market cap
 * is scaled from the entry snapshot by the price move, which is exact for a
 * fixed supply, and pair age simply grew by the hold. That is the same function
 * with the best inputs the exit path has, rather than a second opinion written
 * beside it.
 */
export function shouldDeferSoftExit(args: {
  reason: MildDipExitReason;
  gates: ExitDeferGates;
  entryGates: MildDipEntryGates;
  metrics: ExitDeferMetrics | null;
  carried: ExitDeferCarriedEntryMetrics;
  /** Mark now vs the mark at entry, for scaling the carried market cap. */
  priceRatioSinceEntry: number | null;
  heldMs: number;
  deferredMsSoFar: number;
  dexId?: string | null;
}): ExitDeferVerdict {
  const { gates, reason } = args;
  if (!gates.enabled) return { defer: false, reasons: ['disabled'] };
  if (!reason || !WOULD_BUY_DEFER_REASONS.has(reason)) {
    return { defer: false, reasons: ['reason_not_soft'] };
  }
  if (gates.maxTotalMs > 0 && args.deferredMsSoFar >= gates.maxTotalMs) {
    return { defer: false, reasons: ['defer_budget_spent'] };
  }
  const m = args.metrics;
  if (!m) return { defer: false, reasons: ['no_metrics'] };
  if (m.ageMs > METRICS_MAX_AGE_MS) {
    return { defer: false, reasons: [`metrics_stale_${Math.round(m.ageMs / 1000)}s`] };
  }

  const ratio =
    args.priceRatioSinceEntry != null &&
    Number.isFinite(args.priceRatioSinceEntry) &&
    args.priceRatioSinceEntry > 0
      ? args.priceRatioSinceEntry
      : 1;
  const mcap =
    args.carried.marketCapUsd != null && args.carried.marketCapUsd > 0
      ? args.carried.marketCapUsd * ratio
      : null;
  const ageHours =
    args.carried.pairAgeHours != null && args.carried.pairAgeHours >= 0
      ? args.carried.pairAgeHours + Math.max(0, args.heldMs) / 3_600_000
      : null;

  const verdict = evaluateMildDipEntry(
    {
      priceChange5mPct: m.pc5mPct,
      priceChange1hPct: null,
      volume5mUsd: m.volume5mUsd,
      volume1hUsd: null,
      liquidityUsd: m.liquidityUsd,
      marketCapUsd: mcap,
      pairAgeHours: ageHours,
      dexId: args.dexId ?? null,
      buys5m: null,
      sells5m: null,
    },
    args.entryGates,
  );
  return { defer: verdict.pass, reasons: verdict.reasons };
}
