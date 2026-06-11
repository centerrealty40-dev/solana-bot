import { hlTwapEntrySide } from '../fade-whales.js';
import { hlTwapBtcAlignedBlockReason } from '../twap-btc-gate.js';
import { isBlocklistedWhale } from '../whale-blocklist.js';
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
import { drawdownHaltBlockReason } from './drawdown-stop.js';
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

/**
 * HL is one net position per coin — block opposite-side journal legs even in unrestricted mode.
 */
export function coinOppositeLegBlockReason(
  coin: string,
  entrySide: TwapSide,
  opens: Map<string, HlTwapLiveOpen>,
  pending?: Map<string, JournalSchedule>,
  excludeHash?: string,
): string | null {
  for (const p of opens.values()) {
    if (p.coin === coin && p.side !== entrySide) {
      return 'coin_has_opposite_side';
    }
  }
  if (pending) {
    for (const [hash, s] of pending) {
      if (hash === excludeHash) continue;
      if (s.coin === coin && s.side !== entrySide) {
        return 'coin_has_opposite_side';
      }
    }
  }
  return null;
}

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
  leverageForCoin?: (coin: string) => number,
): LiveEntryDecision {
  const entrySide = hlTwapEntrySide(sig.user, sig.side);
  const pending = journalPath ? loadPendingLiveSchedules(journalPath) : undefined;
  const oppositeBlock = coinOppositeLegBlockReason(sig.coin, entrySide, opens, pending, sig.hash);
  if (oppositeBlock) {
    return { allow: false, reason: oppositeBlock };
  }

  if (hlTwapUnrestrictedMode()) {
    const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
    return { allow: plan.allow, reason: plan.reason, openAtMs: plan.openAtMs };
  }

  if (isBlocklistedWhale(sig.user)) {
    return { allow: false, reason: 'whale_blocklist' };
  }

  if (isDeniedWhale(sig.user)) {
    return { allow: false, reason: 'whale_denylisted' };
  }

  const drawdownBlock = drawdownHaltBlockReason();
  if (drawdownBlock) {
    return { allow: false, reason: drawdownBlock };
  }

  const btcBlock = hlTwapBtcAlignedBlockReason(entrySide);
  if (btcBlock) {
    return { allow: false, reason: btcBlock };
  }

  const hourly = twapHourlyImpactPct(sig);
  if (minImpactPct > 0 && (hourly == null || hourly < minImpactPct)) {
    return { allow: false, reason: 'impact_below_min' };
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
    const stack = evaluateCoinStackEntry(
      sig,
      entrySide,
      opens,
      pending ?? new Map<string, JournalSchedule>(),
      watchState,
      stackCfgFromLiveConfig(liveCfg, leverageForCoin),
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
  leverageForCoin?: (coin: string) => number,
): CoinEntryPlan {
  if (hlTwapUnrestrictedMode()) {
    const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
    const opens = loadLiveOpensFromJournal(journalPath);
    const pending = loadPendingLiveSchedules(journalPath);
    if (opens.has(sig.hash) || pending.has(sig.hash)) {
      return plan.allow ? { ...plan, allow: false, reason: 'already_tracked' } : plan;
    }
    const entrySide = hlTwapEntrySide(sig.user, sig.side);
    const oppositeBlock = coinOppositeLegBlockReason(sig.coin, entrySide, opens, pending, sig.hash);
    if (oppositeBlock) {
      return { ...plan, allow: false, reason: oppositeBlock };
    }
    return plan;
  }

  const plan = computeCoinEntryPlan(sig, watchState, minImpactPct);
  const opens = loadLiveOpensFromJournal(journalPath);
  const pending = loadPendingLiveSchedules(journalPath);
  if (opens.has(sig.hash) || pending.has(sig.hash)) {
    return plan.allow ? { ...plan, allow: false, reason: 'already_tracked' } : plan;
  }
  const decision = canScheduleLiveEntry(
    sig,
    watchState,
    opens,
    minImpactPct,
    journalPath,
    liveCfg,
    leverageForCoin,
  );
  if (!decision.allow) {
    return { ...plan, allow: false, reason: decision.reason };
  }
  return plan;
}
