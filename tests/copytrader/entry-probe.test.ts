import { describe, expect, it } from 'vitest';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import {
  entryMinDeployUsd,
  isEntryFullyDeployed,
} from '../../src/copytrader/entry-deploy.js';
import {
  entryDipSizeUsd,
  entryProbeSizeUsd,
  leaderDipTargetPx,
  usesDipOnlyEntry,
  usesSplitEntryProbe,
} from '../../src/copytrader/entry-probe.js';
import { evaluateCopyAdd, evaluateCopyEntryDip } from '../../src/copytrader/evaluate.js';

const baseCfg = {
  positionUsd: 800,
  entryProbeFraction: 0.25,
  entryDipDiscountPct: 5,
  entryMinDeployFraction: 0.99,
  addPriceMaxPremiumPct: 0,
  minLeaderBuyUsd: 50,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minPairAgeHours: 0,
} as CopyTraderConfig;

describe('entry-probe sizing', () => {
  it('splits 25/75 by default', () => {
    expect(usesSplitEntryProbe(baseCfg)).toBe(true);
    expect(entryProbeSizeUsd(baseCfg)).toBe(200);
    expect(entryDipSizeUsd(baseCfg)).toBe(600);
  });

  it('leader dip target at -5%', () => {
    expect(leaderDipTargetPx(0.001, 5)).toBeCloseTo(0.00095, 8);
  });

  it('dip-only when probe fraction is 0', () => {
    const cfg = { ...baseCfg, entryProbeFraction: 0 } as CopyTraderConfig;
    expect(usesDipOnlyEntry(cfg)).toBe(true);
    expect(entryDipSizeUsd(cfg)).toBe(800);
  });

  it('full deploy requires 99% of positionUsd on split entry', () => {
    expect(entryMinDeployUsd(baseCfg)).toBe(792);
    expect(isEntryFullyDeployed(baseCfg, 200)).toBe(false);
    expect(isEntryFullyDeployed(baseCfg, 792)).toBe(true);
    expect(isEntryFullyDeployed(baseCfg, 800)).toBe(true);
  });
});

describe('evaluateCopyEntryDip', () => {
  const dex = {
    symbol: 'TEST',
    name: 'Test',
    priceUsd: 0.00094,
    marketCap: 500_000,
    liquidityUsd: 40_000,
    volume24h: 100_000,
    volume1h: 5_000,
    pairCreatedAtMs: Date.now() - 48 * 3600_000,
    dexId: 'raydium',
  };

  it('passes at -5% from leader', () => {
    const r = evaluateCopyEntryDip(
      { ...baseCfg, entryDipDiscountPct: 5 } as CopyTraderConfig,
      {
        mint: 'Mint1111111111111111111111111111111111111',
        leaderPriceUsd: 0.001,
        leaderBuyUsd: 400,
        currentPriceUsd: 0.00095,
        dex,
        nowMs: Date.now(),
      },
    );
    expect(r.pass).toBe(true);
  });

  it('rejects above dip threshold', () => {
    const r = evaluateCopyEntryDip(
      { ...baseCfg, entryDipDiscountPct: 5 } as CopyTraderConfig,
      {
        mint: 'Mint1111111111111111111111111111111111111',
        leaderPriceUsd: 0.001,
        leaderBuyUsd: 400,
        currentPriceUsd: 0.00098,
        dex,
        nowMs: Date.now(),
      },
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('price_not_low_enough'))).toBe(true);
  });
});

describe('evaluateCopyAdd', () => {
  const dex = {
    symbol: 'TEST',
    name: 'Test',
    priceUsd: 0.0009,
    marketCap: 500_000,
    liquidityUsd: 40_000,
    volume24h: 100_000,
    volume1h: 5_000,
    pairCreatedAtMs: Date.now() - 48 * 3600_000,
    dexId: 'raydium',
  };

  it('passes at leader add price', () => {
    const r = evaluateCopyAdd(
      { ...baseCfg, addPriceMaxPremiumPct: 0 } as CopyTraderConfig,
      {
        mint: 'Mint1111111111111111111111111111111111111',
        leaderPriceUsd: 0.001,
        leaderBuyUsd: 200,
        currentPriceUsd: 0.001,
        dex,
        nowMs: Date.now(),
      },
    );
    expect(r.pass).toBe(true);
  });

  it('rejects above leader add price when premium is 0', () => {
    const r = evaluateCopyAdd(
      { ...baseCfg, addPriceMaxPremiumPct: 0 } as CopyTraderConfig,
      {
        mint: 'Mint1111111111111111111111111111111111111',
        leaderPriceUsd: 0.001,
        leaderBuyUsd: 200,
        currentPriceUsd: 0.00101,
        dex,
        nowMs: Date.now(),
      },
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('add_price_too_high'))).toBe(true);
  });
});
