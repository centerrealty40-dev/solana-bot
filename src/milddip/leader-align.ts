/**
 * Leader-align near-exit (1.11.761): when a soft exit is about to fire and a
 * tracked leader just bought the same mint, defer the sell and optionally
 * average-in once. Narrow — not a general scale-in on every mild dip.
 */

import type { MildDipExitReason } from './gates.js';

/** Soft exits we may hold when a leader is averaging into the dump. */
export const LEADER_ALIGN_DEFER_REASONS = new Set<NonNullable<MildDipExitReason>>([
  'never_arm_bounce',
  'never_arm_time_red',
  'mfe_bank_sleeve',
  'never_arm_giveback',
  'peak_giveback',
  'peak_giveback_partial',
  'never_arm_stale',
  'never_arm_dead',
  'never_arm_vol_fade',
]);

export type LeaderAlignHit = {
  mint: string;
  lastSeenAtMs: number;
  leader?: string;
  signature?: string;
  fillPriceUsd?: number;
  sizeUsd?: number;
  blockTime?: number;
  isAdd?: boolean;
  class?: string;
};

export type LeaderAlignDeferVerdict = {
  defer: boolean;
  scaleIn: boolean;
  reasons: string[];
  hit: LeaderAlignHit | null;
  leaderAgeMs: number | null;
};

/**
 * Pure gate: should we hold this soft exit and (optionally) average-in?
 *
 * Narrowness knobs:
 * - reason must be in LEADER_ALIGN_DEFER_REASONS (not cliff / hard_stop / MFE banks)
 * - leader buy must be fresher than maxAgeMs
 * - we must already be red vs entry (pnl ≤ −requireRedPct)
 * - leader fill (or mark) must be ≤ entry (true average-down)
 * - scale-in only once per bag and only when enabled
 */
export function evaluateLeaderAlignDefer(args: {
  enabled: boolean;
  shouldExit: boolean;
  reason: MildDipExitReason;
  pnlPct: number;
  entryPriceUsd: number;
  markPriceUsd: number;
  nowMs: number;
  hit: LeaderAlignHit | null | undefined;
  maxAgeMs: number;
  /** Still-red floor vs entry (default 3). 0 = allow flat/green. */
  requireRedPct: number;
  /** Require leader fill/mark ≤ entry × (1 − minBelowEntryPct/100). 0 = ≤ entry. */
  minBelowEntryPct: number;
  scaleInEnabled: boolean;
  scaleInDone: boolean;
  /** If true, only leader isAdd averages count (not first bag open). */
  requireLeaderAdd: boolean;
}): LeaderAlignDeferVerdict {
  if (!args.enabled) {
    return { defer: false, scaleIn: false, reasons: ['leader_align_off'], hit: null, leaderAgeMs: null };
  }
  if (!args.shouldExit || !args.reason) {
    return { defer: false, scaleIn: false, reasons: ['not_exiting'], hit: null, leaderAgeMs: null };
  }
  if (!LEADER_ALIGN_DEFER_REASONS.has(args.reason)) {
    return {
      defer: false,
      scaleIn: false,
      reasons: [`reason_not_alignable=${args.reason}`],
      hit: null,
      leaderAgeMs: null,
    };
  }
  if (args.requireRedPct > 0 && !(args.pnlPct <= -args.requireRedPct + 1e-9)) {
    return {
      defer: false,
      scaleIn: false,
      reasons: [`pnl=${args.pnlPct.toFixed(2)}%>red=-${args.requireRedPct}`],
      hit: null,
      leaderAgeMs: null,
    };
  }

  const hit = args.hit && args.hit.mint ? args.hit : null;
  if (!hit) {
    return { defer: false, scaleIn: false, reasons: ['no_leader_hit'], hit: null, leaderAgeMs: null };
  }
  const ageMs = Math.max(0, args.nowMs - hit.lastSeenAtMs);
  if (!(args.maxAgeMs > 0) || ageMs > args.maxAgeMs) {
    return {
      defer: false,
      scaleIn: false,
      reasons: [`leader_stale_ageMs=${ageMs}>${args.maxAgeMs}`],
      hit,
      leaderAgeMs: ageMs,
    };
  }
  if (args.requireLeaderAdd && hit.isAdd !== true) {
    return {
      defer: false,
      scaleIn: false,
      reasons: ['leader_not_add'],
      hit,
      leaderAgeMs: ageMs,
    };
  }

  const entry = args.entryPriceUsd;
  if (!(entry > 0)) {
    return { defer: false, scaleIn: false, reasons: ['bad_entry'], hit, leaderAgeMs: ageMs };
  }
  const fillPx =
    typeof hit.fillPriceUsd === 'number' && hit.fillPriceUsd > 0
      ? hit.fillPriceUsd
      : args.markPriceUsd > 0
        ? args.markPriceUsd
        : null;
  if (fillPx == null || !(fillPx > 0)) {
    return { defer: false, scaleIn: false, reasons: ['no_align_price'], hit, leaderAgeMs: ageMs };
  }
  const maxPx = entry * (1 - Math.max(0, args.minBelowEntryPct) / 100);
  if (fillPx > maxPx + 1e-15) {
    return {
      defer: false,
      scaleIn: false,
      reasons: [
        `align_px=${fillPx}>max=${maxPx}` +
          (args.minBelowEntryPct > 0 ? `(entry-${args.minBelowEntryPct}%)` : '(entry)'),
      ],
      hit,
      leaderAgeMs: ageMs,
    };
  }

  const scaleIn =
    args.scaleInEnabled &&
    !args.scaleInDone &&
    // Never average up — fill must be at/below entry (already checked).
    true;

  return {
    defer: true,
    scaleIn,
    reasons: [],
    hit,
    leaderAgeMs: ageMs,
  };
}

/** Weighted average entry after a successful scale-in fill. */
export function averageEntryAfterScaleIn(args: {
  prevEntryUsd: number;
  prevSizeUsd: number;
  addFillUsd: number;
  addSizeUsd: number;
}): number | null {
  const { prevEntryUsd, prevSizeUsd, addFillUsd, addSizeUsd } = args;
  if (
    !(prevEntryUsd > 0) ||
    !(prevSizeUsd > 0) ||
    !(addFillUsd > 0) ||
    !(addSizeUsd > 0)
  ) {
    return null;
  }
  const tot = prevSizeUsd + addSizeUsd;
  if (!(tot > 0)) return null;
  return (prevEntryUsd * prevSizeUsd + addFillUsd * addSizeUsd) / tot;
}
