import { describe, expect, it } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import {
  aggregateCoinHourlyImpacts,
  aggregateCoinImpacts,
  computeCoinEntryPlan,
  crossingImpactDecision,
  shouldCloseForImpactLoss,
  twapHourlyImpactPct,
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
  it('twapHourlyImpactPct: spread daily share over duration', () => {
    expect(twapHourlyImpactPct(sig('a', 'buy', 3, 60))).toBe(3);
    expect(twapHourlyImpactPct(sig('b', 'buy', 3, 24 * 60))).toBeCloseTo(0.125);
  });

  it('crossingImpactDecision: lone side >= min %/h passes without delta', () => {
    expect(crossingImpactDecision(3, 0, 3)).toEqual({
      allow: true,
      dominant: 'buy',
      diffPct: 3,
    });
    expect(crossingImpactDecision(2.9, 0, 3).allow).toBe(false);
  });

  it('crossingImpactDecision: with opposing TWAP, dominant >= min and diff > min', () => {
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

  it('aggregates hourly impact across active TWAPs', () => {
    const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts([
      sig('a', 'buy', 6, 60),
      sig('b', 'buy', 3, 60),
      sig('c', 'sell', 10, 60),
    ]);
    expect(buyPctPerHour).toBe(9);
    expect(sellPctPerHour).toBe(10);
  });

  it('aggregates daily share (legacy display)', () => {
    const { buyPct, sellPct } = aggregateCoinImpacts([
      sig('a', 'buy', 5, 60),
      sig('b', 'buy', 2, 60),
      sig('c', 'sell', 10, 60),
    ]);
    expect(buyPct).toBe(7);
    expect(sellPct).toBe(10);
  });

  it('short TWAP enters when it dominates by %/h even if long buy still active', () => {
    const state = createTwapWatchState();
    const buy = sig('buy1', 'buy', 38, 120, 1_000_000);
    state.activeByHash.set(buy.hash, buy);
    const sell = sig('sell1', 'sell', 40, 30, 1_000_000);
    const plan = computeCoinEntryPlan(sell, state, 3);
    expect(plan.allow).toBe(true);
    expect(plan.reason).toBe('ok');
    expect(plan.dominant).toBe('sell');
    expect(plan.waitForOppositeEndsMs).toBeNull();
  });

  it('allows lone long TWAP when hourly impact >= min regardless of duration', () => {
    const state = createTwapWatchState();
    const weekMin = 7 * 24 * 60;
    const lone = sig('buy1', 'buy', 3 * (weekMin / 60), weekMin, 1_000_000);
    state.activeByHash.set(lone.hash, lone);
    const plan = computeCoinEntryPlan(lone, state, 3);
    expect(plan.allow).toBe(true);
    expect(plan.reason).toBe('ok');
    expect(plan.buyPctPerHour).toBeCloseTo(3);
  });

  it('blocks lone long TWAP when hourly impact below min', () => {
    const state = createTwapWatchState();
    const lone = sig('buy1', 'buy', 5, 150, 1_000_000);
    state.activeByHash.set(lone.hash, lone);
    const plan = computeCoinEntryPlan(lone, state, 3);
    expect(plan.allow).toBe(false);
    expect(plan.reason).toBe('hourly_impact_no_edge');
    expect(plan.buyPctPerHour).toBeCloseTo(2);
  });

  it('allows stacked long buy TWAPs when combined hourly impact >= min', () => {
    const state = createTwapWatchState();
    const buy1 = sig('buy1', 'buy', 4, 150, 1_000_000);
    const buy2 = sig('buy2', 'buy', 4, 150, 1_000_000);
    state.activeByHash.set(buy1.hash, buy1);
    state.activeByHash.set(buy2.hash, buy2);
    const plan = computeCoinEntryPlan(buy2, state, 3);
    expect(plan.allow).toBe(true);
    expect(plan.reason).toBe('ok');
    expect(plan.buyPctPerHour).toBeCloseTo(3.2);
  });

  it('buy enters immediately when long impact outweighs active sell TWAP', () => {
    const state = createTwapWatchState();
    state.activeByHash.set('s1', sig('s1', 'sell', 10, 60, 1_000_000));
    const buy = sig('b1', 'buy', 20, 30, 1_000_000);
    const plan = computeCoinEntryPlan(buy, state, 3);
    expect(plan.allow).toBe(true);
    expect(plan.reason).toBe('ok');
    expect(plan.dominant).toBe('buy');
    expect(plan.waitForOppositeEndsMs).toBeNull();
  });

  it('defers buy entry until sell TWAP ends when sell dominates hourly impact', () => {
    const state = createTwapWatchState();
    const sellStart = 1_000_000;
    const sell = sig('s1', 'sell', 50, 60, sellStart);
    state.activeByHash.set(sell.hash, sell);
    const buy = sig('b1', 'buy', 10, 60, sellStart);
    const plan = computeCoinEntryPlan(buy, state, 3);
    expect(plan.allow).toBe(true);
    expect(plan.reason).toBe('deferred_opposite_end');
    expect(plan.waitForOppositeEndsMs).not.toBeNull();
  });

  it('shouldCloseForImpactLoss when opposite TWAP removes hourly edge', () => {
    const state = createTwapWatchState();
    state.activeByHash.set('s1', sig('s1', 'sell', 40, 500));
    state.activeByHash.set('b1', sig('b1', 'buy', 38, 500));
    expect(shouldCloseForImpactLoss('sell', state, 'REZ', 3)).toBe(true);
    state.activeByHash.delete('b1');
    expect(shouldCloseForImpactLoss('sell', state, 'REZ', 3)).toBe(false);
  });
});
