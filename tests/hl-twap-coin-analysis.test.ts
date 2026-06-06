import { describe, expect, it } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import {
  aggregateCoinImpacts,
  computeCoinEntryPlan,
  crossingImpactDecision,
  shouldCloseForImpactLoss,
} from '../src/hyperliquid/twap/coin-twap-analysis.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

function sig(
  hash: string,
  side: 'buy' | 'sell',
  impact: number,
  minutes: number,
  startedAtMs = 1_000_000,
): NormalizedTwapSignal {
  return {
    hash,
    twapId: null,
    user: `0x${hash}`,
    side,
    coin: 'REZ',
    displaySymbol: 'REZ',
    isSpot: false,
    size: 1000,
    minutes,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 1000,
    midPx: 1,
    dayNtlVlmUsd: 1e6,
    volumeSharePct: impact,
    startedAtMs,
    block: 1,
    ended: null,
  };
}

describe('coin-twap-analysis', () => {
  it('crossingImpactDecision: dominant side >= min, diff > min (opposite may be 0)', () => {
    expect(crossingImpactDecision(0, 40, 3)).toEqual({
      allow: true,
      dominant: 'sell',
      diffPct: 40,
    });
    expect(crossingImpactDecision(40, 37, 3).allow).toBe(false);
    expect(crossingImpactDecision(40, 36, 3)).toEqual({
      allow: true,
      dominant: 'buy',
      diffPct: 4,
    });
  });

  it('aggregates all active TWAPs on coin', () => {
    const { buyPct, sellPct } = aggregateCoinImpacts([
      sig('a', 'buy', 5, 60),
      sig('b', 'buy', 2, 60),
      sig('c', 'sell', 10, 60),
    ]);
    expect(buyPct).toBe(7);
    expect(sellPct).toBe(10);
  });

  it('defers entry until opposing TWAP ends', () => {
    const state = createTwapWatchState();
    const buy = sig('buy1', 'buy', 38, 120, 1_000_000);
    state.activeByHash.set(buy.hash, buy);
    const sell = sig('sell1', 'sell', 40, 510, 1_000_000);
    const plan = computeCoinEntryPlan(sell, state, 3);
    expect(plan.allow).toBe(true);
    expect(plan.reason).toBe('deferred_opposite_end');
    expect(plan.waitForOppositeEndsMs).not.toBeNull();
    expect(plan.openAtMs).toBeGreaterThan(1_000_000 + 30_000);
  });

  it('shouldCloseForImpactLoss when opposite TWAP removes edge', () => {
    const state = createTwapWatchState();
    state.activeByHash.set('s1', sig('s1', 'sell', 40, 500));
    state.activeByHash.set('b1', sig('b1', 'buy', 38, 500));
    expect(shouldCloseForImpactLoss('sell', state, 'REZ', 3)).toBe(true);
    state.activeByHash.delete('b1');
    expect(shouldCloseForImpactLoss('sell', state, 'REZ', 3)).toBe(false);
  });
});
