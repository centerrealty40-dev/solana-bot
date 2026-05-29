import type { CopyTraderState, LeaderMintLedger } from './state.js';
import { absRawAmount } from './proportional.js';

export function getLeaderLedger(state: CopyTraderState, mint: string): LeaderMintLedger {
  const existing = state.leaderLedger[mint];
  if (existing) return existing;
  const fresh: LeaderMintLedger = { tokenRaw: '0' };
  state.leaderLedger[mint] = fresh;
  return fresh;
}

export function leaderPreBalanceRaw(state: CopyTraderState, mint: string): bigint {
  const row = state.leaderLedger[mint];
  if (!row?.tokenRaw) return 0n;
  try {
    return BigInt(row.tokenRaw);
  } catch {
    return 0n;
  }
}

export function applyLeaderSwapToLedger(
  state: CopyTraderState,
  mint: string,
  side: 'buy' | 'sell',
  baseAmountRaw: bigint,
): void {
  const ledger = getLeaderLedger(state, mint);
  let bal = leaderPreBalanceRaw(state, mint);
  const amt = absRawAmount(baseAmountRaw);
  if (side === 'buy') {
    bal += amt;
  } else {
    bal = bal > amt ? bal - amt : 0n;
  }
  ledger.tokenRaw = bal.toString();
}

/** Reconstruct pre-sell balance when we joined mid-position. */
export function bootstrapLeaderPreSellBalance(postBalanceRaw: bigint, soldRaw: bigint): bigint {
  return postBalanceRaw + absRawAmount(soldRaw);
}
