import { describe, expect, it } from 'vitest';

import { buildMajorsUniverse } from '../src/hyperliquid/oscar-majors/universe.js';
import type { HyperliquidMarketCache } from '../src/hyperliquid/twap/hyperliquid-meta.js';

function mockCache(coins: Array<{ coin: string; dayVlm: number; mid: number }>): HyperliquidMarketCache {
  const perpNames = coins.map((c) => c.coin);
  const perpCtxByIndex = new Map<number, { dayNtlVlm: string }>();
  const mids = new Map<string, number>();
  coins.forEach((c, i) => {
    perpCtxByIndex.set(i, { dayNtlVlm: String(c.dayVlm) });
    mids.set(c.coin, c.mid);
  });
  return {
    perpNames,
    perpCtxByIndex,
    mids,
    loadedAtMs: Date.now(),
  } as HyperliquidMarketCache;
}

describe('hl-oscar-majors universe', () => {
  it('returns only BTC and ETH from whitelist', () => {
    const cache = mockCache([
      { coin: 'BTC', dayVlm: 5_000_000_000, mid: 95000 },
      { coin: 'ETH', dayVlm: 2_000_000_000, mid: 3500 },
      { coin: 'SOL', dayVlm: 500_000_000, mid: 150 },
    ]);
    const universe = buildMajorsUniverse(cache, {
      minDayVolumeUsd: 1_000_000,
      whitelist: ['BTC', 'ETH'],
    });
    expect(universe.map((c) => c.coin)).toEqual(['BTC', 'ETH']);
  });

  it('filters by min day volume', () => {
    const cache = mockCache([
      { coin: 'BTC', dayVlm: 500_000, mid: 95000 },
      { coin: 'ETH', dayVlm: 2_000_000_000, mid: 3500 },
    ]);
    const universe = buildMajorsUniverse(cache, {
      minDayVolumeUsd: 1_000_000,
      whitelist: ['BTC', 'ETH'],
    });
    expect(universe.map((c) => c.coin)).toEqual(['ETH']);
  });
});
