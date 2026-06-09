import { describe, expect, it } from 'vitest';
import { planTreasuryRebalance } from '../../src/pumpswap-combo-follow/treasury.js';

const base = {
  solUsd: 100,
  usdcMinPct: 15,
  usdcMaxPct: 30,
  rebalanceTargetPct: 20,
  minFreeSolLamports: 100_000_000n,
  minSwapUsd: 3,
};

describe('planTreasuryRebalance', () => {
  it('does nothing inside 15–30% corridor', () => {
    const plan = planTreasuryRebalance({
      ...base,
      solLamports: 720_000_000n,
      usdcMicro: 20_000_000n, // ~$20 / ~$92 ≈ 22%
    });
    expect(plan.action).toBe('none');
    expect(plan.swapUsd).toBe(0);
  });

  it('does nothing at 18% USDC (still inside corridor)', () => {
    const plan = planTreasuryRebalance({
      ...base,
      solLamports: 820_000_000n,
      usdcMicro: 18_000_000n,
    });
    expect(plan.action).toBe('none');
  });

  it('plans SOL→USDC only below 15%', () => {
    const plan = planTreasuryRebalance({
      ...base,
      solLamports: 900_000_000n,
      usdcMicro: 0n,
    });
    expect(plan.usdcPct).toBeLessThan(15);
    expect(plan.action).toBe('buy_usdc');
    expect(plan.swapUsd).toBeGreaterThan(12);
  });

  it('plans USDC→SOL only above 30%', () => {
    const plan = planTreasuryRebalance({
      ...base,
      solLamports: 200_000_000n,
      usdcMicro: 80_000_000n,
    });
    expect(plan.usdcPct).toBeGreaterThan(30);
    expect(plan.action).toBe('sell_usdc');
    expect(plan.swapUsd).toBeGreaterThan(3);
  });
});
