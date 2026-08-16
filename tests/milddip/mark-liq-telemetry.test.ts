import { describe, expect, it } from 'vitest';
import { computeMarkLiquidityTelemetry } from '../../src/milddip/open-mark-metrics.js';

describe('mild-dip mark liquidity telemetry', () => {
  it('computes liquidity and price-adjusted depth ratios', () => {
    const result = computeMarkLiquidityTelemetry({
      liquidityUsd: 80,
      entryLiquidityUsd: 100,
      priceUsd: 0.8,
      entryPriceUsd: 1,
    });
    expect(result.liqRatio).toBeCloseTo(0.8, 10);
    expect(result.depthDrainRatio).toBeCloseTo(1, 10);
  });

  it('returns null ratios when metrics or entry liquidity are unavailable', () => {
    for (const args of [
      { liquidityUsd: null, entryLiquidityUsd: 100, priceUsd: 1, entryPriceUsd: 1 },
      { liquidityUsd: 80, entryLiquidityUsd: 0, priceUsd: 1, entryPriceUsd: 1 },
      { liquidityUsd: 80, entryLiquidityUsd: -1, priceUsd: 1, entryPriceUsd: 1 },
    ]) {
      expect(computeMarkLiquidityTelemetry(args)).toEqual({
        liqRatio: null,
        depthDrainRatio: null,
      });
    }
  });

  it('keeps liqRatio when only an entry or current price is unavailable', () => {
    expect(
      computeMarkLiquidityTelemetry({
        liquidityUsd: 80,
        entryLiquidityUsd: 100,
        priceUsd: null,
        entryPriceUsd: 1,
      }),
    ).toEqual({ liqRatio: 0.8, depthDrainRatio: null });
    expect(
      computeMarkLiquidityTelemetry({
        liquidityUsd: 80,
        entryLiquidityUsd: 100,
        priceUsd: 1,
        entryPriceUsd: null,
      }),
    ).toEqual({ liqRatio: 0.8, depthDrainRatio: null });
  });

  it('rejects impossible price divisions for depthDrainRatio', () => {
    expect(
      computeMarkLiquidityTelemetry({
        liquidityUsd: 80,
        entryLiquidityUsd: 100,
        priceUsd: 0,
        entryPriceUsd: 1,
      }),
    ).toEqual({ liqRatio: 0.8, depthDrainRatio: null });
  });
});
