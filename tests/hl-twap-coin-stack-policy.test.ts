import { describe, expect, it } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import {
  bookDriverCloseAtMs,
  bookDriverSignal,
  coinSideStackSlots,
  driverOpenInGroup,
  evaluateCoinStackEntry,
  hourlyImpactForSignal,
} from '../src/hyperliquid/twap/live/coin-stack-policy.js';
import type { HlTwapLiveOpen } from '../src/hyperliquid/twap/live/types.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';
import { computeTwapSchedule } from '../src/hyperliquid/twap/twap-schedule.js';

const stackCfg = {
  coinMaxLegs: 2,
  coinMaxGrossUsd: 12_000,
  notionalUsd: 800,
  leverage: 7,
};

function sig(
  hash: string,
  side: 'buy' | 'sell',
  impact: number,
  minutes = 30,
): NormalizedTwapSignal {
  return {
    hash,
    twapId: null,
    user: `0x${hash.slice(2, 10)}`,
    side,
    coin: 'ENA',
    displaySymbol: 'ENA',
    isSpot: false,
    size: 1,
    minutes,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 500_000,
    midPx: 0.09,
    dayNtlVlmUsd: 1e9,
    volumeSharePct: impact,
    startedAtMs: Date.now(),
    block: 1,
    ended: null,
  };
}

function open(hash: string, impact: number, grossUsd: number, marginUsd = 800): HlTwapLiveOpen {
  return {
    hash,
    coin: 'ENA',
    displaySymbol: 'ENA',
    side: 'buy',
    entryTs: 1,
    entryAnchorPx: 0.09,
    avgEntryPx: 0.09,
    initialNotionalUsd: grossUsd,
    currentNotionalUsd: grossUsd,
    marginUsd,
    entryLeverage: 7,
    impactPct: impact,
    whaleUser: '0x1',
    minutes: 30,
    liveOpenAtMs: 1,
    liveCloseAtMs: 2,
    twapStartMs: 1,
    tpLevelsTaken: 0,
    dcaLevelsTaken: 0,
    whaleNotionalUsd: 500_000,
    whaleSize: 5,
  };
}

describe('evaluateCoinStackEntry', () => {
  it('allows first and second leg under caps', () => {
    const state = createTwapWatchState();
    const opens = new Map<string, HlTwapLiveOpen>();
    const pending = new Map();
    const next = sig('0xb', 'buy', 6);
    state.activeByHash.set('0xb', next);
    const d = evaluateCoinStackEntry(next, 'buy', opens, pending, state, stackCfg);
    expect(d.allow).toBe(true);
  });

  it('blocks third weaker signal when two legs open', () => {
    const state = createTwapWatchState();
    const opens = new Map<string, HlTwapLiveOpen>([
      ['0xa', open('0xa', 8, 2800)],
      ['0xb', open('0xb', 6, 2800)],
    ]);
    state.activeByHash.set('0xa', sig('0xa', 'buy', 8));
    state.activeByHash.set('0xb', sig('0xb', 'buy', 6));
    const weak = sig('0xc', 'buy', 2);
    state.activeByHash.set('0xc', weak);
    const d = evaluateCoinStackEntry(weak, 'buy', opens, new Map(), state, stackCfg);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('coin_stack_full_weaker_signal');
  });

  it('blocks third signal even when steeper (no triple-stack; re-anchor only)', () => {
    const state = createTwapWatchState();
    const opens = new Map<string, HlTwapLiveOpen>([
      ['0xa', open('0xa', 8, 2800)],
      ['0xb', open('0xb', 4, 2800)],
    ]);
    state.activeByHash.set('0xa', sig('0xa', 'buy', 8));
    state.activeByHash.set('0xb', sig('0xb', 'buy', 4));
    const steep = sig('0xc', 'buy', 10, 15);
    state.activeByHash.set('0xc', steep);
    const d = evaluateCoinStackEntry(steep, 'buy', opens, new Map(), state, stackCfg);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('coin_stack_full');
  });

  it('blocks gross cap when second leg would exceed max book gross', () => {
    const state = createTwapWatchState();
    const opens = new Map<string, HlTwapLiveOpen>([['0xa', open('0xa', 8, 7500)]]);
    state.activeByHash.set('0xa', sig('0xa', 'buy', 8));
    const weak = sig('0xb', 'buy', 2);
    state.activeByHash.set('0xb', weak);
    const d = evaluateCoinStackEntry(weak, 'buy', opens, new Map(), state, stackCfg);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('coin_stack_gross_cap');
  });
});

describe('driverOpenInGroup', () => {
  it('picks leg with highest hourly impact', () => {
    const state = createTwapWatchState();
    const legs = [open('0xa', 4, 3500), open('0xb', 10, 3500)];
    state.activeByHash.set('0xa', sig('0xa', 'buy', 4, 60));
    state.activeByHash.set('0xb', sig('0xb', 'buy', 10, 15));
    const driver = driverOpenInGroup(legs, state);
    expect(driver.hash).toBe('0xb');
    expect(hourlyImpactForSignal(state.activeByHash.get('0xb')!)).toBeGreaterThan(
      hourlyImpactForSignal(state.activeByHash.get('0xa')!),
    );
  });
});

describe('bookDriverCloseAtMs', () => {
  it('re-anchors book timer to best active TWAP including non-journal 3rd signal', () => {
    const state = createTwapWatchState();
    const legs = [open('0xa', 8, 3500), open('0xb', 4, 3500)];
    state.activeByHash.set('0xa', sig('0xa', 'buy', 8, 60));
    state.activeByHash.set('0xb', sig('0xb', 'buy', 4, 60));
    const steep = sig('0xc', 'buy', 12, 15);
    state.activeByHash.set('0xc', steep);

    const driver = bookDriverSignal('ENA', 'buy', legs, state);
    expect(driver?.hash).toBe('0xc');

    const closeAt = bookDriverCloseAtMs('ENA', 'buy', legs, state);
    expect(closeAt).toBe(computeTwapSchedule(steep).paperCloseAtMs);
  });
});

describe('coinSideStackSlots', () => {
  it('counts pending schedules toward leg cap', () => {
    const opens = new Map([['0xa', open('0xa', 8, 3500)]]);
    const pending = new Map([
      [
        '0xb',
        {
          kind: 'schedule' as const,
          ts: 1,
          hash: '0xb',
          openAtMs: 2,
          closeAtMs: 3,
          twapStartMs: 1,
          coin: 'ENA',
          displaySymbol: 'ENA',
          side: 'buy' as const,
          whaleUser: '0x2',
          minutes: 30,
          impactPct: 5,
          whaleNotionalUsd: 1,
          whaleSize: 1,
        },
      ],
    ]);
    const slots = coinSideStackSlots('ENA', 'buy', opens, pending);
    expect(slots).toHaveLength(2);
  });
});
