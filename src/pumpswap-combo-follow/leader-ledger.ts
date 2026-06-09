import type { FollowState } from './state.js';

function absRaw(raw: bigint): bigint {
  return raw < 0n ? -raw : raw;
}

export function leaderPreBalanceRaw(state: FollowState, mint: string): bigint {
  const row = state.leaderLedger[mint];
  if (!row?.tokenRaw) return 0n;
  try {
    return BigInt(row.tokenRaw);
  } catch {
    return 0n;
  }
}

export function applyLeaderSwapToLedger(
  state: FollowState,
  mint: string,
  side: 'buy' | 'sell',
  baseAmountRaw: bigint,
): void {
  let bal = leaderPreBalanceRaw(state, mint);
  const amt = absRaw(baseAmountRaw);
  if (side === 'buy') {
    bal += amt;
  } else {
    bal = bal > amt ? bal - amt : 0n;
  }
  state.leaderLedger[mint] = { tokenRaw: bal.toString() };
}

export function bootstrapLeaderPreSellBalance(postBalanceRaw: bigint, soldRaw: bigint): bigint {
  return postBalanceRaw + absRaw(soldRaw);
}
