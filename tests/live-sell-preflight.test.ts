import { describe, expect, it } from 'vitest';

/** Mirror of phase4 LIVE_SELL_MIN_PRICE_USD guard (NEST RCA: 6e-6 ghost quote). */
const LIVE_SELL_MIN_PRICE_USD = 1e-5;

function liveSellPriceUsdSane(priceUsdPerToken: number): boolean {
  return Number.isFinite(priceUsdPerToken) && priceUsdPerToken >= LIVE_SELL_MIN_PRICE_USD;
}

describe('live sell preflight price guard', () => {
  it('rejects ghost hot-tick prices below floor', () => {
    expect(liveSellPriceUsdSane(0.0055)).toBe(true);
    expect(liveSellPriceUsdSane(6.11e-6)).toBe(false);
    expect(liveSellPriceUsdSane(0)).toBe(false);
  });
});
