import { describe, expect, it } from 'vitest';

import { createTwapWatchState, passesTwapFilters } from '../src/hyperliquid/twap/detect.js';
import {
  absorbHypurrscanDuplicate,
  createWsIntegrateState,
  resolveLocalTwapHash,
  tryAcceptWsTwap,
  twapMatchKey,
} from '../src/hyperliquid/twap/hl-ws-integrate.js';
import { normalizeHlWsTwap, wsLocalTwapHash } from '../src/hyperliquid/twap/hl-ws-normalize.js';
import type { HlWsTwapOpenEvent } from '../src/hyperliquid/twap/hl-ws-types.js';
import type { HyperliquidMarketCache } from '../src/hyperliquid/twap/hyperliquid-meta.js';

const cache: HyperliquidMarketCache = {
  perpNames: ['ETH', 'GRASS'],
  spotByAssetId: new Map(),
  mids: new Map([['ETH', 3000], ['GRASS', 0.35]]),
  perpCtxByIndex: new Map([
    [0, { midPx: '3000', dayNtlVlm: '100000000' }],
    [1, { midPx: '0.35', dayNtlVlm: '5000000' }],
  ]),
  loadedAtMs: Date.now(),
};

function wsEv(over: Partial<HlWsTwapOpenEvent> = {}): HlWsTwapOpenEvent {
  return {
    source: 'hl_ws',
    channel: 'userTwapHistory',
    user: '0xwhale',
    twapId: 7,
    syntheticId: '0xwhale:twap:7',
    status: 'activated',
    coin: 'ETH',
    side: 'buy',
    size: 10,
    minutes: 60,
    reduceOnly: false,
    randomize: false,
    startedAtMs: 1_700_000_000_000,
    receivedAtMs: 1_700_000_000_800,
    isSnapshot: false,
    ...over,
  };
}

describe('hl-ws-normalize', () => {
  it('builds NormalizedTwapSignal with ws hash', () => {
    const sig = normalizeHlWsTwap(wsEv(), cache);
    expect(sig?.hash).toBe(wsLocalTwapHash('0xwhale:twap:7'));
    expect(sig?.displaySymbol).toBe('ETH');
    expect(sig?.notionalUsd).toBeCloseTo(30_000, 0);
  });
});

describe('hl-ws-integrate', () => {
  const opts = { minVolumeSharePct: 0, buyOnly: false };

  it('tryAcceptWsTwap registers ws hash', () => {
    const state = createTwapWatchState();
    const ws = createWsIntegrateState();
    const sig = tryAcceptWsTwap(wsEv(), cache, state, ws, opts);
    expect(sig?.hash.startsWith('ws:')).toBe(true);
    expect(state.seenOpenHashes.has(sig!.hash)).toBe(true);
    expect(ws.wsByMatchKey.get(twapMatchKey('0xwhale', 'ETH', 1_700_000_000_000))).toBe(sig!.hash);
  });

  it('absorbHypurrscanDuplicate links hypurr hash to ws hash', () => {
    const state = createTwapWatchState();
    const ws = createWsIntegrateState();
    const wsSig = tryAcceptWsTwap(wsEv(), cache, state, ws, opts)!;
    state.openedNotifiedHashes.add(wsSig.hash);

    const hypurrSig = {
      ...wsSig,
      hash: '0xrealtxhash',
      block: 123,
    };
    expect(absorbHypurrscanDuplicate(hypurrSig, state, ws)).toBe(true);
    expect(resolveLocalTwapHash('0xrealtxhash', ws)).toBe(wsSig.hash);
    expect(state.openedNotifiedHashes.has('0xrealtxhash')).toBe(true);
  });

  it('passesTwapFilters still applies on ws path', () => {
    const state = createTwapWatchState();
    const ws = createWsIntegrateState();
    const tiny = normalizeHlWsTwap(wsEv({ size: 0.001 }), cache)!;
    expect(passesTwapFilters(tiny, { minVolumeSharePct: 99, buyOnly: false }, state)).toBe(false);
    const none = tryAcceptWsTwap(
      { ...wsEv(), size: 0.001 },
      cache,
      state,
      ws,
      { minVolumeSharePct: 99, buyOnly: false },
    );
    expect(none).toBeNull();
  });
});
