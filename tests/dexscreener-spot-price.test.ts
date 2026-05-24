import { describe, expect, it } from 'vitest';

import { pickBestDexScreenerPair } from '../src/scripts/dexscreener-spot-price.js';

describe('dexscreener-spot-price', () => {
  it('pickBestDexScreenerPair prefers highest Solana liquidity', () => {
    const lowPair = '1111111111111111111111111111111111111111111111';
    const highPair = '2222222222222222222222222222222222222222222222';
    const row = pickBestDexScreenerPair([
      { chainId: 'ethereum', priceUsd: 1, pairAddress: highPair, liquidity: { usd: 999_999 } },
      { chainId: 'solana', priceUsd: 0.5, pairAddress: lowPair, liquidity: { usd: 10_000 } },
      { chainId: 'solana', priceUsd: 0.55, pairAddress: highPair, liquidity: { usd: 50_000 }, marketCap: 2_000_000 },
    ]);
    expect(row?.pairAddress).toBe(highPair);
    expect(row?.priceUsd).toBe(0.55);
    expect(row?.liquidityUsd).toBe(50_000);
    expect(row?.marketCapUsd).toBe(2_000_000);
  });

  it('pickBestDexScreenerPair returns null when no valid Solana pair', () => {
    expect(pickBestDexScreenerPair([{ chainId: 'bsc', priceUsd: 1, pairAddress: 'x' }])).toBeNull();
    expect(pickBestDexScreenerPair([])).toBeNull();
  });
});
