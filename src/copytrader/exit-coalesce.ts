import { absRawAmount, isFullCloseFraction } from './proportional.js';

export type CoalescedSell = {
  fraction: number;
  coalesced: boolean;
  reason?: 'leader_full_exit' | 'leader_flat_after_sell';
};

/** Leader holds nothing after this sell (full exit or ledger caught up). */
export function leaderFlatAfterSell(preLeaderRaw: bigint, sellRaw: bigint): boolean {
  const sold = absRawAmount(sellRaw);
  if (sold <= 0n) return false;
  if (preLeaderRaw <= 0n) return true;
  return sold >= preLeaderRaw;
}

/** Collapse ladder partials into one wallet sweep when leader is exiting completely. */
export function coalescedMirrorSellFraction(
  sellFrac: number,
  preLeaderRaw: bigint,
  sellRaw: bigint,
): CoalescedSell {
  if (isFullCloseFraction(sellFrac)) {
    return { fraction: 1, coalesced: true, reason: 'leader_full_exit' };
  }
  if (leaderFlatAfterSell(preLeaderRaw, sellRaw)) {
    return { fraction: 1, coalesced: true, reason: 'leader_flat_after_sell' };
  }
  return { fraction: sellFrac, coalesced: false };
}

export function leaderLedgerIsZero(tokenRaw: string | undefined): boolean {
  if (!tokenRaw) return true;
  try {
    return BigInt(tokenRaw) <= 0n;
  } catch {
    return true;
  }
}
