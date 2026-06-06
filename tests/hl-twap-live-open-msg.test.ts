import { describe, expect, it } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import { buildLiveTradeOpenMessage } from '../src/hyperliquid/twap/live/telegram-notify.js';
import type { HlTwapLiveOpen } from '../src/hyperliquid/twap/live/types.js';
import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';

describe('live trade open telegram', () => {
  it('includes whale TWAP size and no other TWAPs', () => {
    const pos: HlTwapLiveOpen = {
      hash: '0x77e6',
      coin: 'REZ',
      displaySymbol: 'REZ',
      side: 'sell',
      entryTs: Date.now(),
      entryAnchorPx: 0.003389,
      avgEntryPx: 0.003389,
      initialNotionalUsd: 500,
      currentNotionalUsd: 500,
      marginUsd: 100,
      entryLeverage: 5,
      impactPct: 40.64,
      whaleUser: '0xc90ed59fe09222ae3f7965434a7a42b0d5160a3d',
      minutes: 510,
      liveOpenAtMs: 1,
      liveCloseAtMs: 2,
      twapStartMs: 1_780_692_382_840,
      tpLevelsTaken: 0,
      dcaLevelsTaken: 0,
      whaleNotionalUsd: 33_431,
      whaleSize: 9_923_000,
    };
    const state = createTwapWatchState();
    state.activeByHash.set(pos.hash, {
      hash: pos.hash,
      twapId: null,
      user: pos.whaleUser,
      side: 'sell',
      coin: 'REZ',
      displaySymbol: 'REZ',
      isSpot: false,
      size: pos.whaleSize!,
      minutes: 510,
      randomize: true,
      reduceOnly: false,
      notionalUsd: 33_431,
      midPx: 0.003367,
      dayNtlVlmUsd: 82_270,
      volumeSharePct: 40.64,
      startedAtMs: pos.twapStartMs,
      block: 1,
      ended: null,
    });
    const msg = buildLiveTradeOpenMessage(pos, loadHlTwapLiveConfig(), state);
    expect(msg).toContain('REZ SHORT');
    expect(msg).toContain('вместе с китом');
    expect(msg).toContain('sell TWAP');
    expect(msg).toContain('$500');
    expect(msg).toContain('маржа $100');
    expect(msg).toContain('5x');
    expect(msg).toContain('1020 циклов');
    expect(msg).toContain('$33.43K');
    expect(msg).toContain('Другие TWAP на монете: нет');
    expect(msg).toContain('40.64%');
  });
});
