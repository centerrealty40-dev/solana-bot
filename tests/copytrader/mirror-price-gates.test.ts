import { describe, expect, it } from 'vitest';
import {
  addPriceAboveLeaderCap,
  evaluateCopyAdd,
  partialSellPriceBelowLeaderFloor,
} from '../../src/copytrader/mirror-price-gates.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';

const baseCfg = {
  minLeaderBuyUsd: 50,
  addMaxPremiumPct: 5,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
} as CopyTraderConfig;

describe('addPriceAboveLeaderCap', () => {
  it('blocks add when price is +5% above leader', () => {
    expect(addPriceAboveLeaderCap(1, 1.051, 5)).toBe(true);
    expect(addPriceAboveLeaderCap(1, 1.049, 5)).toBe(false);
  });
});

describe('partialSellPriceBelowLeaderFloor', () => {
  it('blocks partial sell when price is -5% below leader', () => {
    expect(partialSellPriceBelowLeaderFloor(1, 0.949, 5)).toBe(true);
    expect(partialSellPriceBelowLeaderFloor(1, 0.951, 5)).toBe(false);
  });
});

describe('evaluateCopyAdd', () => {
  it('rejects add when price ran above cap', () => {
    const r = evaluateCopyAdd(baseCfg, {
      mint: 'm',
      leaderPriceUsd: 0.001,
      leaderBuyUsd: 600,
      currentPriceUsd: 0.00106,
      dex: {
        symbol: 'T',
        name: 'T',
        priceUsd: 0.00106,
        marketCap: 1_000_000,
        liquidityUsd: 50_000,
        volume24h: 1,
        volume1h: 1,
        pairCreatedAtMs: Date.now(),
        dexId: 'pump',
      },
      nowMs: Date.now(),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('add_price_too_high'))).toBe(true);
  });
});