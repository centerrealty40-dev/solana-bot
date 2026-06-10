import type { LeaderSellRef } from './types.js';

export type LeaderFlushReason =
  | 'disabled'
  | 'no_sell'
  | 'not_due'
  | 'small_sell_skipped'
  | 'leader_flat'
  | 'large_sell';

export type LeaderFlushVerdict = {
  shouldFlush: boolean;
  reason: LeaderFlushReason;
  flushDueTs: number;
};

export function isLeaderFlatAfterSell(ref: LeaderSellRef): boolean {
  if (ref.leaderFlat) return true;
  if (ref.leaderPostBalanceRaw != null) {
    try {
      return BigInt(ref.leaderPostBalanceRaw) === 0n;
    } catch {
      return false;
    }
  }
  return false;
}

/** When minSellUsd=0, legacy: flush on any leader sell after largeSellDelayMs. */
export function evaluateLeaderPoolFlush(args: {
  nowMs: number;
  enabled: boolean;
  sellRef: LeaderSellRef | undefined;
  openedAt: number;
  minSellUsd: number;
  largeSellDelayMs: number;
  flatFlushDelayMs: number;
}): LeaderFlushVerdict {
  const { nowMs, enabled, sellRef, openedAt, minSellUsd, largeSellDelayMs, flatFlushDelayMs } =
    args;

  if (!enabled) {
    return { shouldFlush: false, reason: 'disabled', flushDueTs: 0 };
  }
  if (!sellRef || sellRef.ts < openedAt) {
    return { shouldFlush: false, reason: 'no_sell', flushDueTs: 0 };
  }

  if (isLeaderFlatAfterSell(sellRef)) {
    const flushDueTs = sellRef.ts + flatFlushDelayMs;
    return {
      shouldFlush: nowMs >= flushDueTs,
      reason: nowMs >= flushDueTs ? 'leader_flat' : 'not_due',
      flushDueTs,
    };
  }

  const sellUsd = sellRef.sellUsd ?? 0;
  if (minSellUsd > 0 && sellUsd > 0 && sellUsd < minSellUsd) {
    return { shouldFlush: false, reason: 'small_sell_skipped', flushDueTs: 0 };
  }

  const flushDueTs = sellRef.ts + largeSellDelayMs;
  return {
    shouldFlush: nowMs >= flushDueTs,
    reason: nowMs >= flushDueTs ? 'large_sell' : 'not_due',
    flushDueTs,
  };
}

export function leaderFlushExitReason(verdictReason: LeaderFlushReason): string {
  return verdictReason === 'leader_flat'
    ? 'flow8z_leader_flat_flush'
    : 'flow8z_leader_pool_flush';
}
