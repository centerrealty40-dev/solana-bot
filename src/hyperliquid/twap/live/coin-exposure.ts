import { hlTwapEntrySide } from '../fade-whales.js';
import { hlTwapBtcAlignedBlockReason } from '../twap-btc-gate.js';
import { isDeniedWhale } from '../whale-denylist.js';
import type { TwapWatchState } from '../detect.js';
import {
  computeCoinEntryPlan,
  opposingActiveTwapsForCoin,
  shouldCloseForImpactLoss,
  twapHourlyImpactPct,
  type CoinEntryPlan,
} from '../coin-twap-analysis.js';
import type { NormalizedTwapSignal } from '../types.js';
import { loadLiveOpensFromJournal, loadPendingLiveSchedules } from './journal.js';
import { liveLossStreakBlockReason } from './loss-streak-cooldown.js';
import type { HlTwapLiveOpen } from './types.js';

export type LiveEntryDecision = {
  allow: boolean;
  reason: string;
  openAtMs?: number;
};

export { shouldCloseForImpactLoss, opposingActiveTwapsForCoin, computeCoinEntryPlan };

/**
 * Each qualifying TWAP (unique hash) → separate $100 position.
 * Same coin + same side: stack (multiple whales / TWAPs).
 * Opposite side blocked only while **our** position is open (perps net).
 * Entry gating: computeCoinEntryPlan + BTC aligned gate + opposite-side exposure.
 */
export function canScheduleLiveEntry(
  sig: NormalizedTwapSignal,
  watchState: TwapWatchState,
  opens: Map<string, HlTwapLiveOpen>,
  minImpactPct: number,
  journalPath?: string,
): LiveEntryDecision {
  if (isDeniedWhale(sig.user)) {
    return { allow: false, reason: 'whale_denylisted' };
  }

  const entrySide = hlTwapEntrySide(sig.user, sig.side);
  const btcBlock = hlTwapBtcAlignedBlockReason(entrySide);
  if (btcBlock) {
    return { allow: false, reason: btcBlock };
  }

  const hourly = twapHourlyImpactPct(sig);
  if (minImpactPct > 0 && (hourly == null || hourly < minImpactPct)) {
    return { allow: false, reason: 'impact_below_min' };
  }

  const hasOpposite = [...opens.values()].some(
    (p) => p.coin === sig.coin && p.side !== entrySide,
  );
  if (hasOpposite) {
    return { allow: false, reason: 'coin_has_opposite_side' };
  }

  const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
  if (!plan.allow) {
    return { allow: false, reason: plan.reason };
  }

  if (journalPath) {
    const streakBlock = liveLossStreakBlockReason(sig.coin, entrySide, journalPath);
    if (streakBlock) {
      return { allow: false, reason: streakBlock };
    }
  }

  return { allow: true, reason: plan.reason, openAtMs: plan.openAtMs };
}

/** Audit snapshot: same gates as scheduleLiveTrade (journal dedupe + canScheduleLiveEntry). */
export function resolveLiveEntryAuditPlan(
  sig: NormalizedTwapSignal,
  watchState: TwapWatchState,
  journalPath: string,
  minImpactPct: number,
): CoinEntryPlan {
  const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
  const opens = loadLiveOpensFromJournal(journalPath);
  const pending = loadPendingLiveSchedules(journalPath);
  if (opens.has(sig.hash) || pending.has(sig.hash)) {
    return plan.allow ? { ...plan, allow: false, reason: 'already_tracked' } : plan;
  }
  const decision = canScheduleLiveEntry(sig, watchState, opens, minImpactPct, journalPath);
  if (!decision.allow) {
    return { ...plan, allow: false, reason: decision.reason };
  }
  return plan;
}
