import { describe, expect, it } from 'vitest';
import { planTreasuryRebalance } from '../../src/pumpswap-combo-follow/treasury.js';

describe('planTreasuryRebalance', () => {
  it('targets 20% USDC and plans SOL→USDC when underweight', () => {
    const plan = planTreasuryRebalance({
      solLamports: 900_000_000n, // 0.9 SOL tradable after reserve
      usdcMicro: 0n,
      solUsd: 100,
      targetUsdcPct: 20,
      minFreeSolLamports: 100_000_000n,
      minSwapUsd: 3,
      bandPct: 0.04,
    });
    expect(plan.liquidTotalUsd).toBeCloseTo(80, 1);
    expect(plan.action).toBe('buy_usdc');
    expect(plan.swapUsd).toBeGreaterThan(12);
  });

  it('skips tiny drift inside band', () => {
    const plan = planTreasuryRebalance({
      solLamports: 850_000_000n,
      usdcMicro: 15_000_000n, // $15 USDC on ~$95 liquid ≈ 16%
      solUsd: 100,
      targetUsdcPct: 20,
      minFreeSolLamports: 50_000_000n,
      minSwapUsd: 3,
      bandPct: 0.08,
    });
    expect(plan.action).toBe('none');
  });

  it('plans USDC→SOL when overweight USDC', () => {
    const plan = planTreasuryRebalance({
      solLamports: 200_000_000n,
      usdcMicro: 80_000_000n,
      solUsd: 100,
      targetUsdcPct: 20,
      minFreeSolLamports: 50_000_000n,
      minSwapUsd: 3,
      bandPct: 0.04,
    });
    expect(plan.action).toBe('sell_usdc');
    expect(plan.swapUsd).toBeGreaterThan(3);
  });
});
