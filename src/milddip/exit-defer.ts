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
 * 1.11.877 — the time cuts ask too. Keeping `never_arm_time_red` out of this on
 * the grounds that it is a "risk" exit is what let PrkyDd through: cut at
 * −15.13% with the tape still falling, back in 140 seconds later 1.06% lower.
 * Selling and re-entering at the same price is strictly worse than holding —
 * same exposure, same price, two extra legs of cost — so whenever we would
 * re-enter, the cut achieved nothing but the fee. What makes those exits safe is
 * not firing them early, it is the budget below and the hard floor underneath.
 *
 * Only the true floors stay out: `hard_stop` and `cliff_dump` answer to a hole
 * the entry gate cannot see, and their coherence is enforced on the other side —
 * a mint cut there is barred from re-entry by `rebuy_below_exit`, which since
 * 1.11.876 no probe walks around. Profit exits are never deferred either:
 * `tp_grid` and the banks are the point.
 */
import { evaluateMildDipEntry, type MildDipEntryGates } from './gates.js';
import type { MildDipExitReason } from './gates.js';
import { OPEN_MARK_METRICS_MAX_AGE_MS } from './open-mark-metrics.js';

/**
 * Every exit that is a judgement rather than a floor. The bag faded, or ran out
 * of patience — nothing broke that the entry gate cannot see for itself.
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
  // 1.11.877 — time cuts included: these are the ones that churned.
  'never_arm_time_red',
  'never_arm_timeout',
  'max_hold_underwater',
]);

/**
 * The floors. Always sold; their coherence is enforced on the entry side, where
 * `rebuy_below_exit` bars the mint and (since 1.11.876) no probe walks round it.
 */
export const NEVER_DEFER_REASONS: ReadonlySet<string> = new Set([
  'hard_stop',
  'cliff_dump',
  'hard_time_stop',
  'never_arm_freefall',
  'liq_drain',
  'mirror_leader_sell',
  'mirror_safety_cut',
]);

/**
 * 1.11.883 — exits taken *because* there is money on the table. Their whole
 * purpose fails if the fill lands under our cost, so they carry a price floor
 * into the executor and abandon the sell when the real quote cannot clear it.
 *
 * Everything else — the stops, the time cuts, dust — is getting out for reasons
 * that do not care what the fill is, and must never be blocked by a floor.
 */
export const MONEY_MOTIVATED_EXIT_REASONS: ReadonlySet<string> = new Set([
  'tp_grid',
  'mirror_tp_ladder',
  'mfe_bank_1',
  'mfe_bank_2',
  'mfe_bank_sleeve',
  'never_arm_bounce',
  'breakeven_stop',
  'peak_giveback',
  'peak_giveback_partial',
  'never_arm_giveback',
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

/**
 * 1.11.877 — the same window the never-arm exits already trust.
 *
 * A tighter one here was its own two-brains bug: `never_arm_time_red` fires on a
 * `pc5m` reading up to `OPEN_MARK_METRICS_MAX_AGE_MS` old, so refusing to *hold*
 * on that same reading let the sell win every argument the data was too stale to
 * settle. Good enough to sell is good enough to keep.
 */
const METRICS_MAX_AGE_MS = OPEN_MARK_METRICS_MAX_AGE_MS;

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
  if (!reason || NEVER_DEFER_REASONS.has(reason)) {
    return { defer: false, reasons: ['reason_is_a_floor'] };
  }
  if (!WOULD_BUY_DEFER_REASONS.has(reason)) {
    return { defer: false, reasons: ['reason_not_deferrable'] };
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
