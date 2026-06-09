import { describe, expect, it } from 'vitest';
import {
  effectiveLeaderBalanceRaw,
  leaderBalanceIsDust,
  resolveOurSellFraction,
} from '../../src/copytrader/leader-dust.js';

describe('leader dust', () => {
  const dust = 10_000n;

  it('treats tiny on-chain balance as dust', () => {
    expect(leaderBalanceIsDust(1n, dust)).toBe(true);
    expect(effectiveLeaderBalanceRaw(1n, dust)).toBe(0n);
    expect(effectiveLeaderBalanceRaw(0n, dust)).toBe(0n);
    expect(effectiveLeaderBalanceRaw(50_000n, dust)).toBe(50_000n);
  });

  it('forces full our sell when leader post-balance is dust', () => {
    expect(
      resolveOurSellFraction({
        leaderSellFraction: 0.5,
        postLeaderBalanceRaw: 1n,
        dustRaw: dust,
      }),
    ).toBe(1);
    expect(
      resolveOurSellFraction({
        leaderSellFraction: 0.5,
        postLeaderBalanceRaw: 50_000n,
        dustRaw: dust,
      }),
    ).toBe(0.5);
  });
});
