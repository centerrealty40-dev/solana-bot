import { hlTwapEntrySide } from '../fade-whales.js';
import { hlTwapBtcAlignedBlockReason } from '../twap-btc-gate.js';
import { isDeniedWhale } from '../whale-denylist.js';
import { hlTwapUnrestrictedMode } from '../unrestricted.js';
import type { TwapWatchState } from '../detect.js';
import { hlTwapCoinMomentumBlockReason } from '../coin-momentum-gate.js';
import {
  computeCoinEntryPlan,
  opposingActiveTwapsForCoin,
  shouldCloseForImpactLoss,
  twapHourlyImpactPct,
  type CoinEntryPlan,
} from '../coin-twap-analysis.js';
import type { NormalizedTwapSignal, TwapSide } from '../types.js';
import { loadLiveOpensFromJournal, loadPendingLiveSchedules, type JournalSchedule } from './journal.js';
import { liveCoinPriorLossBlockReason, liveLossStreakBlockReason } from './loss-streak-cooldown.js';
import {
  evaluateCoinStackEntry,
  stackCfgFromLiveConfig,
} from './coin-stack-policy.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapLiveOpen } from './types.js';

export type LiveEntryDecision = {
  allow: boolean;
  reason: string;
  openAtMs?: number;
};

export { shouldCloseForImpactLoss, opposingActiveTwapsForCoin, computeCoinEntryPlan };

/** Gate B + A (prior loss, streak cooldown, coin dd24h) — long entries only. */
export function hlTwapCoinEntryGateBlockReason(
  coin: string,
  side: TwapSide,
  journalPath?: string,
): string | null {
  if (journalPath) {
    const priorLossBlock = liveCoinPriorLossBlockReason(coin, side, journalPath);
    if (priorLossBlock) return priorLossBlock;
    const streakBlock = liveLossStreakBlockReason(coin, side, journalPath);
    if (streakBlock) return streakBlock;
  }
  return hlTwapCoinMomentumBlockReason(coin, side);
}

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
  liveCfg?: HlTwapLiveConfig,
): LiveEntryDecision {
  if (hlTwapUnrestrictedMode()) {
    const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
    return { allow: plan.allow, reason: plan.reason, openAtMs: plan.openAtMs };
  }

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
    const coinGate = hlTwapCoinEntryGateBlockReason(sig.coin, entrySide, journalPath);
    if (coinGate) {
      return { allow: false, reason: coinGate };
    }
  } else {
    const coinMomBlock = hlTwapCoinMomentumBlockReason(sig.coin, entrySide);
    if (coinMomBlock) {
      return { allow: false, reason: coinMomBlock };
    }
  }

  if (liveCfg && !hlTwapUnrestrictedMode()) {
    const pending = journalPath ? loadPendingLiveSchedules(journalPath) : new Map<string, JournalSchedule>();
    const stack = evaluateCoinStackEntry(
      sig,
      entrySide,
      opens,
      pending,
      watchState,
      stackCfgFromLiveConfig(liveCfg),
    );
    if (!stack.allow) {
      return { allow: false, reason: stack.reason };
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
  liveCfg?: HlTwapLiveConfig,
): CoinEntryPlan {
  if (hlTwapUnrestrictedMode()) {
    const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
    const opens = loadLiveOpensFromJournal(journalPath);
    const pending = loadPendingLiveSchedules(journalPath);
    if (opens.has(sig.hash) || pending.has(sig.hash)) {
      return plan.allow ? { ...plan, allow: false, reason: 'already_tracked' } : plan;
    }
    return plan;
  }

  const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
  const opens = loadLiveOpensFromJournal(journalPath);
  const pending = loadPendingLiveSchedules(journalPath);
  if (opens.has(sig.hash) || pending.has(sig.hash)) {
    return plan.allow ? { ...plan, allow: false, reason: 'already_tracked' } : plan;
  }
  const decision = canScheduleLiveEntry(sig, watchState, opens, minImpactPct, journalPath, liveCfg);
  if (!decision.allow) {
    return { ...plan, allow: false, reason: decision.reason };
  }
  return plan;
}
