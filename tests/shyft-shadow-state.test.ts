import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetShyftShadowStateForTests,
  getShyftShadowStreamPrice,
  getShyftShadowWatchedMints,
  isShyftShadowEnabled,
  onShyftShadowMintsChanged,
  recordShyftShadowStreamPrice,
  setShyftShadowEnabled,
  setShyftShadowMaxAgeMs,
  setShyftShadowWatchedMints,
} from '../src/papertrader/stream/shadow-state.js';

afterEach(() => __resetShyftShadowStateForTests());

describe('shyft shadow state', () => {
  it('returns null when disabled', () => {
    recordShyftShadowStreamPrice('M', { priceUsd: 1, streamTsMs: 1000, slot: 1 });
    expect(isShyftShadowEnabled()).toBe(false);
    expect(getShyftShadowStreamPrice('M', 1000)).toBeNull();
  });

  it('returns the last price within max age, null when stale', () => {
    setShyftShadowEnabled(true);
    setShyftShadowMaxAgeMs(5_000);
    recordShyftShadowStreamPrice('M', { priceUsd: 2.5, streamTsMs: 1000, slot: 7 });
    expect(getShyftShadowStreamPrice('M', 4_000)?.priceUsd).toBe(2.5);
    expect(getShyftShadowStreamPrice('M', 1000 + 5_001)).toBeNull();
    expect(getShyftShadowStreamPrice('UNSEEN', 1000)).toBeNull();
  });

  it('fires the change callback only on real set changes and drops unwatched prices', () => {
    let calls = 0;
    let last: string[] = [];
    onShyftShadowMintsChanged((m) => {
      calls += 1;
      last = m;
    });
    setShyftShadowEnabled(true);
    recordShyftShadowStreamPrice('A', { priceUsd: 1, streamTsMs: 1000, slot: 1 });
    recordShyftShadowStreamPrice('B', { priceUsd: 1, streamTsMs: 1000, slot: 1 });

    setShyftShadowWatchedMints(['A', 'B']);
    expect(calls).toBe(1);
    expect(new Set(last)).toEqual(new Set(['A', 'B']));

    // same set (order differs) → no callback
    setShyftShadowWatchedMints(['B', 'A']);
    expect(calls).toBe(1);

    // drop B → callback fires, B's cached price evicted
    setShyftShadowWatchedMints(['A']);
    expect(calls).toBe(2);
    expect(getShyftShadowWatchedMints()).toEqual(['A']);
    expect(getShyftShadowStreamPrice('B', 1000)).toBeNull();
    expect(getShyftShadowStreamPrice('A', 1000)?.priceUsd).toBe(1);
  });
});
