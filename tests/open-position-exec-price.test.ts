import { describe, expect, it } from 'vitest';
import {
  _resetOpenPositionExecPriceCacheForTests,
  sellUsdPerTokenFromQuote,
  setOpenPositionExecSellUsd,
  getOpenPositionExecSellUsd,
  isOpenPositionExecSellFresh,
} from '../src/live/open-position-exec-price.js';

describe('open-position-exec-price', () => {
  it('computes sell usd per token from quote proceeds', () => {
    const px = sellUsdPerTokenFromQuote({
      wsolOutLamports: 50_000_000n,
      tokenAmountRaw: 1_000_000n,
      solUsd: 150,
      decimals: 6,
    });
    expect(px).toBeCloseTo(7.5, 4);
  });

  it('stores and reads fresh executable sell snapshot', () => {
    _resetOpenPositionExecPriceCacheForTests();
    const mint = 'Mint1111111111111111111111111111111111';
    const updatedAtMs = Date.now() - 100;
    setOpenPositionExecSellUsd(mint, {
      mint,
      sellUsdPerToken: 0.0034,
      quoteAgeMs: 40,
      updatedAtMs,
      probeTokenRaw: '1000000',
      wsolOutLamports: '50000000',
    });
    expect(getOpenPositionExecSellUsd(mint)).toBe(0.0034);
    expect(isOpenPositionExecSellFresh(mint, 5000)).toBe(true);
    expect(isOpenPositionExecSellFresh(mint, 50)).toBe(false);
  });
});
