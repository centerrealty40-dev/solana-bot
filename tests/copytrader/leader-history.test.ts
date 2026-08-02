import { describe, expect, it } from 'vitest';
import {
  applyLeaderSwapToHistory,
  gcLeaderHistory,
  leaderMintStats,
} from '../../src/copytrader/leader-history.js';
import { emptyCopyTraderState } from '../../src/copytrader/state.js';

const MINT = 'Mint1111111111111111111111111111111111111111';
const DUST = 10_000n;

function buy(state: ReturnType<typeof emptyCopyTraderState>, usd: number, balanceAfter: bigint, ts = 1_000) {
  return applyLeaderSwapToHistory(state, {
    mint: MINT,
    side: 'buy',
    amountUsd: usd,
    leaderBalanceAfterRaw: balanceAfter,
    dustRaw: DUST,
    nowMs: ts,
  });
}

function sell(state: ReturnType<typeof emptyCopyTraderState>, usd: number, balanceAfter: bigint, ts = 2_000) {
  return applyLeaderSwapToHistory(state, {
    mint: MINT,
    side: 'sell',
    amountUsd: usd,
    leaderBalanceAfterRaw: balanceAfter,
    dustRaw: DUST,
    nowMs: ts,
  });
}

describe('leader mint history', () => {
  it('has no stats before a session closes', () => {
    const state = emptyCopyTraderState();
    buy(state, 300, 1_000_000n);
    expect(leaderMintStats(state, MINT)).toBeNull();
  });

  it('scores a round trip only when the leader goes flat', () => {
    const state = emptyCopyTraderState();
    buy(state, 100, 1_000_000n);
    expect(sell(state, 60, 400_000n)).toBeNull();
    expect(sell(state, 80, 0n)).toBeCloseTo(40, 6);

    const stats = leaderMintStats(state, MINT);
    expect(stats).toMatchObject({ sessions: 1, winRatePct: 100 });
    expect(stats?.avgPct).toBeCloseTo(40, 6);
  });

  it('treats a dust remainder as flat', () => {
    const state = emptyCopyTraderState();
    buy(state, 100, 1_000_000n);
    expect(sell(state, 90, DUST)).toBeCloseTo(-10, 6);
    expect(leaderMintStats(state, MINT)?.winRatePct).toBe(0);
  });

  it('averages across sessions and starts a fresh one after close', () => {
    const state = emptyCopyTraderState();
    buy(state, 100, 1_000_000n);
    sell(state, 120, 0n);
    buy(state, 100, 1_000_000n);
    sell(state, 80, 0n);

    const stats = leaderMintStats(state, MINT);
    expect(stats?.sessions).toBe(2);
    expect(stats?.avgPct).toBeCloseTo(0, 6);
    expect(stats?.winRatePct).toBe(50);
  });

  it('skips sessions where we never saw the cost basis', () => {
    const state = emptyCopyTraderState();
    expect(sell(state, 500, 0n)).toBeNull();
    expect(leaderMintStats(state, MINT)).toBeNull();
  });

  it('winsorizes a moonshot so one print cannot dominate the average', () => {
    const state = emptyCopyTraderState();
    buy(state, 100, 1_000_000n);
    expect(sell(state, 100_000, 0n)).toBe(300);
  });

  it('gc drops idle mints but keeps ones the leader still holds', () => {
    const state = emptyCopyTraderState();
    buy(state, 100, 1_000_000n);
    sell(state, 120, 0n, 1_000);
    state.leaderHistory.OpenMint = { sessions: 0, wins: 0, sumPct: 0, openCostUsd: 50 };

    const dropped = gcLeaderHistory(state, 3_600_000, 10_000_000);
    expect(dropped).toBe(1);
    expect(state.leaderHistory[MINT]).toBeUndefined();
    expect(state.leaderHistory.OpenMint).toBeDefined();
  });
});
