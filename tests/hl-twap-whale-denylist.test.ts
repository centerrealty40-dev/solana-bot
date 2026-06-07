import { describe, expect, it } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import { computeCoinEntryPlan } from '../src/hyperliquid/twap/coin-twap-analysis.js';
import { canScheduleLiveEntry } from '../src/hyperliquid/twap/live/coin-exposure.js';
import {
  HL_TWAP_DEFAULT_DENIED_WHALES,
  isDeniedWhale,
  resetDeniedWhaleCache,
} from '../src/hyperliquid/twap/whale-denylist.js';
import { resetFadeWhaleCache } from '../src/hyperliquid/twap/fade-whales.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

function sig(user: string, impact = 10, minutes = 30): NormalizedTwapSignal {
  return {
    hash: `0x${user.slice(2, 10)}`,
    twapId: null,
    user,
    side: 'buy',
    coin: 'FARTCOIN',
    displaySymbol: 'FARTCOIN',
    isSpot: false,
    size: 1e6,
    minutes,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 500_000,
    midPx: 0.1,
    dayNtlVlmUsd: 16e6,
    volumeSharePct: impact,
    startedAtMs: Date.now(),
    block: 1,
    ended: null,
  };
}

describe('whale-denylist', () => {
  it('includes prod cluster whale by default', () => {
    expect(isDeniedWhale(HL_TWAP_DEFAULT_DENIED_WHALES[0])).toBe(true);
    expect(isDeniedWhale(HL_TWAP_DEFAULT_DENIED_WHALES[0].toUpperCase())).toBe(true);
  });

  it('blocks entry plan for denied whale even with high hourly impact', () => {
    const state = createTwapWatchState();
    const whale = HL_TWAP_DEFAULT_DENIED_WHALES[0]!;
    const plan = computeCoinEntryPlan(sig(whale, 10, 30), state, 2);
    expect(plan.allow).toBe(false);
    expect(plan.reason).toBe('whale_denylisted');
  });

  it('allows other whales with sufficient hourly impact', () => {
    const state = createTwapWatchState();
    const plan = computeCoinEntryPlan(sig('0xgood00000000000000000000000000000001', 10, 30), state, 2);
    expect(plan.allow).toBe(true);
  });

  it('canScheduleLiveEntry rejects denied whale', () => {
    const state = createTwapWatchState();
    const whale = HL_TWAP_DEFAULT_DENIED_WHALES[0]!;
    const d = canScheduleLiveEntry(sig(whale), state, new Map(), 2);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('whale_denylisted');
  });

  it('fade whale overrides built-in denylist for entry plan', () => {
    process.env.HL_TWAP_FADE_WHALES = HL_TWAP_DEFAULT_DENIED_WHALES[0]!;
    resetFadeWhaleCache();
    resetDeniedWhaleCache();
    const state = createTwapWatchState();
    const whale = HL_TWAP_DEFAULT_DENIED_WHALES[0]!;
    const plan = computeCoinEntryPlan(sig(whale, 10, 30), state, 2);
    expect(plan.allow).toBe(true);
    delete process.env.HL_TWAP_FADE_WHALES;
    resetFadeWhaleCache();
    resetDeniedWhaleCache();
  });

  it('merges HL_TWAP_WHALE_DENYLIST env', () => {
    process.env.HL_TWAP_WHALE_DENYLIST = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    resetDeniedWhaleCache();
    expect(isDeniedWhale('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(true);
    delete process.env.HL_TWAP_WHALE_DENYLIST;
    resetDeniedWhaleCache();
  });
});
