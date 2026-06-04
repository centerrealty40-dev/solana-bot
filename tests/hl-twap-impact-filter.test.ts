import { describe, expect, it } from 'vitest';

import {
  createTwapWatchState,
  crossingImpactDecision,
  detectTwapChanges,
  passesTwapFilters,
} from '../src/hyperliquid/twap/detect.js';
import type { HypurrscanTwapRow, NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

const row: HypurrscanTwapRow = {
  time: 1,
  user: '0xabc',
  block: 1,
  hash: '0ximpact',
  error: null,
  action: {
    type: 'twapOrder',
    twap: { a: 159, b: true, s: '100', r: false, m: 5, t: false },
  },
};

function norm(impactPct: number, side: 'buy' | 'sell' = 'buy'): NormalizedTwapSignal {
  return {
    hash: row.hash,
    twapId: null,
    user: row.user,
    side,
    coin: 'HYPE',
    displaySymbol: 'HYPE',
    isSpot: false,
    size: 5000,
    minutes: 5,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 500_000,
    midPx: 65,
    dayNtlVlmUsd: 2e9,
    volumeSharePct: impactPct,
    startedAtMs: 1,
    block: 1,
    ended: null,
  };
}

describe('hl-twap impact filter', () => {
  it('blocks when impact below 1%', () => {
    const state = createTwapWatchState();
    const r = detectTwapChanges([row], () => norm(0.5), state, { minVolumeSharePct: 1 });
    expect(r.newSignals).toHaveLength(0);
  });

  it('passes at 1% impact for buy and sell', () => {
    const state = createTwapWatchState();
    const rBuy = detectTwapChanges([row], () => norm(1.2), state, { minVolumeSharePct: 1 });
    expect(rBuy.newSignals).toHaveLength(1);

    const state2 = createTwapWatchState();
    const sellRow = { ...row, hash: '0xsell' };
    const rSell = detectTwapChanges([sellRow], () => norm(1.2, 'sell'), state2, { minVolumeSharePct: 1 });
    expect(rSell.newSignals).toHaveLength(1);
  });

  it('rejects weaker crossing leg when net impact ≤ 1%', () => {
    const state = createTwapWatchState();
    const buy = norm(3);
    state.activeByHash.set(buy.hash, buy);
    const sell = { ...norm(2, 'sell'), hash: '0xsell' };
    expect(passesTwapFilters(sell, { minVolumeSharePct: 1 }, state)).toBe(false);
    expect(crossingImpactDecision(3, 2, 1).allow).toBe(false);
  });

  it('allows dominant sell when crossing diff > 1%', () => {
    const state = createTwapWatchState();
    const buy = norm(2);
    state.activeByHash.set(buy.hash, buy);
    const sell = { ...norm(4.41, 'sell'), hash: '0xsell' };
    expect(passesTwapFilters(sell, { minVolumeSharePct: 1 }, state)).toBe(true);
  });
});
