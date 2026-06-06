import { describe, expect, it } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import { canScheduleLiveEntry } from '../src/hyperliquid/twap/live/coin-exposure.js';
import type { HlTwapLiveOpen } from '../src/hyperliquid/twap/live/types.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

function sig(hash: string, side: 'buy' | 'sell', impact: number): NormalizedTwapSignal {
  return {
    hash,
    twapId: null,
    user: `0x${hash}`,
    side,
    coin: 'BTC',
    displaySymbol: 'BTC',
    isSpot: false,
    size: 1,
    minutes: 10,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 500_000,
    midPx: 100_000,
    dayNtlVlmUsd: 1e9,
    volumeSharePct: impact,
    startedAtMs: Date.now(),
    block: 1,
    ended: null,
  };
}

function open(hash: string, side: 'buy' | 'sell'): HlTwapLiveOpen {
  return {
    hash,
    coin: 'BTC',
    displaySymbol: 'BTC',
    side,
    entryTs: 1,
    entryAnchorPx: 100_000,
    avgEntryPx: 100_000,
    initialNotionalUsd: 100,
    currentNotionalUsd: 100,
    marginUsd: 100,
    entryLeverage: 1,
    impactPct: 5,
    whaleUser: '0x1',
    minutes: 10,
    liveOpenAtMs: 1,
    liveCloseAtMs: 2,
    twapStartMs: 1,
    tpLevelsTaken: 0,
    dcaLevelsTaken: 0,
    whaleNotionalUsd: 500_000,
    whaleSize: 5,
  };
}

describe('canScheduleLiveEntry', () => {
  it('allows second long on same coin when impact qualifies', () => {
    const state = createTwapWatchState();
    const opens = new Map<string, HlTwapLiveOpen>();
    opens.set('0xa', open('0xa', 'buy'));
    state.activeByHash.set('0xa', sig('0xa', 'buy', 5));
    const next = sig('0xb', 'buy', 4);
    state.activeByHash.set('0xb', next);
    const d = canScheduleLiveEntry(next, state, opens, 3);
    expect(d.allow).toBe(true);
  });

  it('blocks opposite side while long open', () => {
    const state = createTwapWatchState();
    const opens = new Map([['0xa', open('0xa', 'buy')]]);
    state.activeByHash.set('0xa', sig('0xa', 'buy', 5));
    const sell = sig('0xb', 'sell', 5);
    state.activeByHash.set('0xb', sell);
    const d = canScheduleLiveEntry(sell, state, opens, 3);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('coin_has_opposite_side');
  });
});
