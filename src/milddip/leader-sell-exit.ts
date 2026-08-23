import type { LeaderSellEvent } from './leader-sell-feed.js';

export const MIRROR_LEADER_SELL_RETRY_INTERVAL_MS = 5_000;

export function mirrorLeaderSellRetryDue(
  lastAttemptAtMs: number | undefined,
  nowMs: number,
): boolean {
  return (
    lastAttemptAtMs == null ||
    nowMs - lastAttemptAtMs >= MIRROR_LEADER_SELL_RETRY_INTERVAL_MS
  );
}

export type LeaderSellExitReason =
  | 'disabled'
  | 'wrong_lane'
  | 'leader_not_allowed'
  | 'stale'
  | 'before_entry'
  | 'min_hold'
  | 'leader_sell';

export type LeaderSellExitDecision = {
  shouldExit: boolean;
  reason: LeaderSellExitReason;
};

export function isLeaderSellEventValidForPosition(args: {
  event: LeaderSellEvent;
  leader?: string | null;
  leaderBuyTsMs?: number | null;
  openedAtMs?: number | null;
}): boolean {
  if (args.leader && args.event.leader !== args.leader) return false;
  const minimumBlockTimeMs = Math.max(
    args.leaderBuyTsMs ?? Number.NEGATIVE_INFINITY,
    args.openedAtMs ?? Number.NEGATIVE_INFINITY,
  );
  return args.event.blockTimeMs >= minimumBlockTimeMs;
}

export function selectNewerLeaderSellEvent(
  durableEvent: LeaderSellEvent | null,
  feedEvent: LeaderSellEvent | null,
): LeaderSellEvent | null {
  if (!durableEvent) return feedEvent;
  if (!feedEvent) return durableEvent;
  return feedEvent.blockTimeMs >= durableEvent.blockTimeMs ? feedEvent : durableEvent;
}

export function selectLatestValidLeaderSellEventForPosition(args: {
  events: readonly LeaderSellEvent[];
  leader?: string | null;
  leaderBuyTsMs?: number | null;
  openedAtMs?: number | null;
}): LeaderSellEvent | null {
  let latest: LeaderSellEvent | null = null;
  for (const event of args.events) {
    if (
      !isLeaderSellEventValidForPosition({
        event,
        leader: args.leader,
        leaderBuyTsMs: args.leaderBuyTsMs,
        openedAtMs: args.openedAtMs,
      })
    ) {
      continue;
    }
    if (latest == null || event.blockTimeMs > latest.blockTimeMs) latest = event;
  }
  return latest;
}

export function decideLeaderSellExit(args: {
  enabled: boolean;
  lane: string | null | undefined;
  leaders: readonly string[];
  event: LeaderSellEvent | null | undefined;
  openedAtMs?: number;
  nowMs: number;
  maxAgeMs: number;
  minHoldMs?: number;
}): LeaderSellExitDecision {
  if (!args.enabled) return { shouldExit: false, reason: 'disabled' };
  if (args.lane !== 'leader_mirror') return { shouldExit: false, reason: 'wrong_lane' };
  if (!args.event) return { shouldExit: false, reason: 'leader_not_allowed' };
  if (!args.leaders.includes(args.event.leader)) {
    return { shouldExit: false, reason: 'leader_not_allowed' };
  }
  if (args.maxAgeMs > 0 && args.nowMs - args.event.blockTimeMs > args.maxAgeMs) {
    return { shouldExit: false, reason: 'stale' };
  }
  if (args.openedAtMs != null && args.event.blockTimeMs < args.openedAtMs) {
    return { shouldExit: false, reason: 'before_entry' };
  }
  if (
    args.openedAtMs != null &&
    args.minHoldMs &&
    args.minHoldMs > 0 &&
    args.nowMs - args.openedAtMs < args.minHoldMs
  ) {
    return { shouldExit: false, reason: 'min_hold' };
  }
  return { shouldExit: true, reason: 'leader_sell' };
}
