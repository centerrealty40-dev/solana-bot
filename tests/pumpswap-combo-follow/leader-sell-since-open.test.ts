import { describe, expect, it } from 'vitest';
import { leaderSellSinceOpen, type FollowState } from '../../src/pumpswap-combo-follow/state.js';

function stateWithSell(mint: string, ts: number): FollowState {
  return {
    positions: [],
    realizedPnlUsd: 0,
    halted: false,
    lossCooldownUntilByMint: {},
    seenSignatures: {},
    leaderLedger: {},
    pendingBuys: [],
    lastLeaderSellByMint: {
      [mint]: { ts, signature: 'sig', priceUsd: 1 },
    },
    updatedAt: Date.now(),
  };
}

describe('leaderSellSinceOpen', () => {
  it('ignores leader sell before position opened', () => {
    const mint = 'Mint111';
    const openedAt = 1_000_000;
    const st = stateWithSell(mint, openedAt - 60_000);
    expect(leaderSellSinceOpen(st, mint, openedAt)).toBeUndefined();
  });

  it('returns leader sell after position opened', () => {
    const mint = 'Mint222';
    const openedAt = 1_000_000;
    const st = stateWithSell(mint, openedAt + 5_000);
    const ref = leaderSellSinceOpen(st, mint, openedAt);
    expect(ref?.ts).toBe(openedAt + 5_000);
  });

  it('includes sell at exact open time', () => {
    const mint = 'Mint333';
    const openedAt = 1_000_000;
    const st = stateWithSell(mint, openedAt);
    expect(leaderSellSinceOpen(st, mint, openedAt)?.ts).toBe(openedAt);
  });
});
