import { describe, expect, it } from 'vitest';
import {
  isFullCloseFraction,
  leaderAddFraction,
  leaderSellFraction,
  ourAddUsdFromLeaderAdd,
  reduceUsdAfterPartialSell,
  scaleTokenRaw,
} from '../../src/copytrader/proportional.js';

describe('leaderSellFraction', () => {
  it('computes partial sell ratio from pre-balance', () => {
    expect(leaderSellFraction(1_000_000n, 300_000n)).toBeCloseTo(0.3, 5);
    expect(leaderSellFraction(1_000_000n, 1_000_000n)).toBe(1);
  });

  it('caps at 1 when sold exceeds ledger', () => {
    expect(leaderSellFraction(100n, 500n)).toBe(1);
  });
});

describe('leaderAddFraction', () => {
  it('computes add as fraction of pre-buy holdings', () => {
    expect(leaderAddFraction(1_000_000n, 500_000n)).toBeCloseTo(0.5, 5);
  });

  it('returns 0 when no pre-balance (entry handled separately)', () => {
    expect(leaderAddFraction(0n, 500_000n)).toBe(0);
  });
});

describe('ourAddUsdFromLeaderAdd', () => {
  it('scales our stack by leader add fraction', () => {
    expect(
      ourAddUsdFromLeaderAdd({
        ourSizeUsd: 50,
        addFraction: 0.5,
        maxRoomUsd: 45,
        minAddUsd: 3,
      }),
    ).toBe(25);
  });

  it('respects max room cap', () => {
    expect(
      ourAddUsdFromLeaderAdd({
        ourSizeUsd: 80,
        addFraction: 0.5,
        maxRoomUsd: 10,
        minAddUsd: 3,
      }),
    ).toBe(10);
  });

  it('skips tiny adds below minimum', () => {
    expect(
      ourAddUsdFromLeaderAdd({
        ourSizeUsd: 50,
        addFraction: 0.01,
        maxRoomUsd: 45,
        minAddUsd: 3,
      }),
    ).toBe(0);
  });
});

describe('partial position math', () => {
  it('scales token raw for partial sell', () => {
    expect(scaleTokenRaw(1_000_000n, 0.25)).toBe(250_000n);
  });

  it('reduces USD notional after partial sell', () => {
    expect(reduceUsdAfterPartialSell(50, 0.3)).toBe(35);
  });

  it('detects full close', () => {
    expect(isFullCloseFraction(0.999)).toBe(true);
    expect(isFullCloseFraction(0.5)).toBe(false);
  });
});
