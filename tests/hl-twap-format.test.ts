import { describe, expect, it } from 'vitest';

import {
  buildTwapStartMessage,
  formatDurationRu,
  formatUsdCompact,
  mexcFuturesUrl,
} from '../src/hyperliquid/twap/format-telegram.js';
import type { UserTwapRating } from '../src/hyperliquid/twap/user-rating.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

function sampleSig(overrides: Partial<NormalizedTwapSignal> = {}): NormalizedTwapSignal {
  return {
    hash: '0xabc',
    twapId: null,
    user: '0x0422d8308870ba079decd8cc27f1268296196873',
    side: 'buy',
    coin: 'HYPE',
    displaySymbol: 'HYPE',
    isSpot: false,
    size: 5000,
    minutes: 5,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 325_310,
    midPx: 65.06,
    dayNtlVlmUsd: 2e9,
    volumeSharePct: 0.016,
    startedAtMs: 1_780_570_548_907,
    block: 1,
    ended: null,
    ...overrides,
  };
}

describe('hl-twap format', () => {
  it('formats duration like TWAPx', () => {
    expect(formatDurationRu(5)).toContain('минут');
    expect(formatDurationRu(60)).toContain('час');
    expect(formatDurationRu(210)).toContain('3.5');
  });

  it('formats USD compact', () => {
    expect(formatUsdCompact(325_310)).toBe('$325.31K');
    expect(formatUsdCompact(2e9)).toBe('$2.00B');
  });

  it('builds start message with mexc link', () => {
    const html = buildTwapStartMessage(sampleSig(), {
      mexcUrl: mexcFuturesUrl('HYPE'),
    });
    expect(html).toContain('покупка');
    expect(html).toContain('HYPE');
    expect(html).toContain('mexc.com');
    expect(html).toContain('0x0422d8308870ba079decd8cc27f1268296196873');
  });

  it('includes user rating line', () => {
    const rating: UserTwapRating = {
      endedTotal: 10,
      cancelCount: 2,
      finishedCount: 8,
      cancelPct: 20,
    };
    const html = buildTwapStartMessage(sampleSig(), { userRating: rating });
    expect(html).toContain('Рейтинг');
    expect(html).toContain('20%');
  });
});
