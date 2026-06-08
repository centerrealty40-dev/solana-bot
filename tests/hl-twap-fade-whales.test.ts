import { afterEach, describe, expect, it, vi } from 'vitest';

import { hlTwapEntrySide, isFadeWhale, resetFadeWhaleCache } from '../src/hyperliquid/twap/fade-whales.js';
import { isDeniedWhale, resetDeniedWhaleCache } from '../src/hyperliquid/twap/whale-denylist.js';

const FADE_WHALE = '0x153c8444380512cabdc34f6cea09c322e14e319a';

describe('fade-whales', () => {
  afterEach(() => {
    delete process.env.HL_TWAP_FADE_WHALES;
    resetFadeWhaleCache();
    resetDeniedWhaleCache();
  });

  it('inverts side for fade whale', () => {
    process.env.HL_TWAP_FADE_WHALES = FADE_WHALE;
    resetFadeWhaleCache();
    expect(isFadeWhale(FADE_WHALE)).toBe(true);
    expect(hlTwapEntrySide(FADE_WHALE, 'buy')).toBe('sell');
    expect(hlTwapEntrySide(FADE_WHALE, 'sell')).toBe('buy');
  });

  it('fade whale is not denied when also on env denylist', () => {
    process.env.HL_TWAP_WHALE_DENYLIST = FADE_WHALE;
    process.env.HL_TWAP_FADE_WHALES = FADE_WHALE;
    resetFadeWhaleCache();
    resetDeniedWhaleCache();
    expect(isDeniedWhale(FADE_WHALE)).toBe(false);
    delete process.env.HL_TWAP_WHALE_DENYLIST;
  });
});
