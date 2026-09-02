import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDexScreenerPairDetails } from '../../src/papertrader/pricing/dexscreener-quote-cache.js';

vi.mock('../../src/papertrader/pricing/dexscreener-quote-cache.js', () => ({
  fetchDexScreenerPairDetails: vi.fn(),
}));

import {
  __resetOpenMarkRefreshForTests,
  openMarkRefreshInFlightCount,
  requestOpenMarkRefresh,
} from '../../src/milddip/open-mark-refresh.js';
import {
  __resetOpenMarkMetricsForTests,
  isOpenMarkLiquidityDead,
  noteOpenMarkLiquidityDead,
  noteOpenMarkMetrics,
  readOpenMarkMetrics,
} from '../../src/milddip/open-mark-metrics.js';

describe('requestOpenMarkRefresh', () => {
  const fetchMock = vi.mocked(fetchDexScreenerPairDetails);

  beforeEach(() => {
    __resetOpenMarkRefreshForTests();
    __resetOpenMarkMetricsForTests();
    fetchMock.mockResolvedValue(null);
  });

  it('resets a dead-liquidity series when live liquidity returns', () => {
    const mint = 'A'.repeat(32) + 'pump';
    noteOpenMarkLiquidityDead(mint, 1_000);
    noteOpenMarkLiquidityDead(mint, 2_000);
    expect(readOpenMarkMetrics(mint, 2_000)?.liquidityDeadFirstTsMs).toBe(1_000);
    noteOpenMarkMetrics(mint, { tsMs: 3_000, liquidityUsd: 10_000 });
    expect(readOpenMarkMetrics(mint, 3_000)?.liquidityDeadFirstTsMs).toBeNull();
  });

  it('requires the configured duration before marking liquidity dead', () => {
    const mint = 'B'.repeat(32) + 'pump';
    noteOpenMarkLiquidityDead(mint, 1_000);
    noteOpenMarkLiquidityDead(mint, 2_000);
    const metrics = readOpenMarkMetrics(mint, 2_000);
    expect(isOpenMarkLiquidityDead(metrics, 2_001)).toBe(false);
    expect(isOpenMarkLiquidityDead(metrics, 1_000)).toBe(true);
  });

  it('does not treat missing Dex details as dead liquidity', async () => {
    const mint = 'C'.repeat(32) + 'pump';
    fetchMock.mockResolvedValue(null);
    requestOpenMarkRefresh({
      mint,
      nowMs: 1_000,
      minGapMs: 1,
      maxInFlight: 1,
      allowedDexIds: ['pumpswap'],
      cacheTtlMs: 15_000,
      liquidityDeadMaxUsd: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    requestOpenMarkRefresh({
      mint,
      nowMs: 10_000,
      minGapMs: 1,
      maxInFlight: 1,
      allowedDexIds: ['pumpswap'],
      cacheTtlMs: 15_000,
      liquidityDeadMaxUsd: 1_000,
    });
    await Promise.resolve();
    expect(isOpenMarkLiquidityDead(readOpenMarkMetrics(mint, Date.now()), 0)).toBe(false);
  });

  it('does not treat null liquidity as dead liquidity', async () => {
    const mint = 'D'.repeat(32) + 'pump';
    fetchMock.mockResolvedValue({
      priceUsd: 1,
      liquidityUsd: null,
      priceChangeM5Pct: null,
      volume5mUsd: null,
    });
    requestOpenMarkRefresh({
      mint,
      nowMs: 1_000,
      minGapMs: 1,
      maxInFlight: 1,
      allowedDexIds: ['pumpswap'],
      cacheTtlMs: 15_000,
      liquidityDeadMaxUsd: 1_000,
    });
    await Promise.resolve();
    expect(isOpenMarkLiquidityDead(readOpenMarkMetrics(mint, Date.now()), 0)).toBe(false);
  });

  it('records numeric liquidity at or below the dead threshold', async () => {
    const mint = 'E'.repeat(32) + 'pump';
    fetchMock.mockResolvedValue({
      priceUsd: 1,
      liquidityUsd: 100,
      priceChangeM5Pct: null,
      volume5mUsd: null,
    });
    requestOpenMarkRefresh({
      mint,
      nowMs: 1_000,
      minGapMs: 1,
      maxInFlight: 1,
      allowedDexIds: ['pumpswap'],
      cacheTtlMs: 15_000,
      liquidityDeadMaxUsd: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const metrics = readOpenMarkMetrics(mint, Date.now());
    expect(metrics?.liquidityDeadFirstTsMs).not.toBeNull();
  });

  it('records healthy details and resets a prior dead state', async () => {
    const mint = 'F'.repeat(32) + 'pump';
    noteOpenMarkLiquidityDead(mint, 1_000);
    fetchMock.mockResolvedValue({
      priceUsd: 1,
      liquidityUsd: 10_000,
      priceChangeM5Pct: null,
      volume5mUsd: null,
    });
    requestOpenMarkRefresh({
      mint,
      nowMs: 2_000,
      minGapMs: 1,
      maxInFlight: 1,
      allowedDexIds: ['pumpswap'],
      cacheTtlMs: 15_000,
      liquidityDeadMaxUsd: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const metrics = readOpenMarkMetrics(mint, Date.now());
    expect(metrics?.liquidityUsd).toBe(10_000);
    expect(metrics?.liquidityDeadFirstTsMs).toBeNull();
  });

  it('respects per-mint gap and max in-flight', () => {
    const now = 1_000_000;
    const base = {
      nowMs: now,
      minGapMs: 8_000,
      maxInFlight: 2,
      allowedDexIds: ['pumpswap'],
      cacheTtlMs: 15_000,
    };
    // We cannot easily mock undici here; just assert gating before fetch settles.
    expect(
      requestOpenMarkRefresh({ ...base, mint: 'A'.repeat(32) + 'pump' }),
    ).toBe(true);
    expect(
      requestOpenMarkRefresh({ ...base, mint: 'A'.repeat(32) + 'pump' }),
    ).toBe(false); // same mint gap / in-flight
    expect(
      requestOpenMarkRefresh({ ...base, mint: 'B'.repeat(32) + 'pump' }),
    ).toBe(true);
    expect(
      requestOpenMarkRefresh({ ...base, mint: 'C'.repeat(32) + 'pump' }),
    ).toBe(false); // maxInFlight=2
    expect(openMarkRefreshInFlightCount()).toBeLessThanOrEqual(2);
  });
});
