import { describe, expect, it } from 'vitest';
import { liveSellPriceUsdSane } from '../src/live/sell-price-sanity.js';

describe('live sell preflight price guard', () => {
  it('rejects ghost hot-tick prices below floor', () => {
    expect(liveSellPriceUsdSane(0.0055)).toBe(true);
    expect(liveSellPriceUsdSane(6.11e-6)).toBe(false);
    expect(liveSellPriceUsdSane(0)).toBe(false);
  });
});
