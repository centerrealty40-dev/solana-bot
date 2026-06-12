import { describe, expect, it } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import { computeCoinEntryPlan } from '../src/hyperliquid/twap/coin-twap-analysis.js';
import { canScheduleLiveEntry } from '../src/hyperliquid/twap/live/coin-exposure.js';
import {
  HL_TWAP_DEFAULT_BLOCKLIST_WHALES,
  isBlocklistedWhale,
  resetBlocklistedWhaleCache,
} from '../src/hyperliquid/twap/whale-blocklist.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

const BLOCKED_WHALE = HL_TWAP_DEFAULT_BLOCKLIST_WHALES[0]!;
const OTHER_WHALE = '0x622fc18a3f1a616a331b96e4c17f1b457feb5c6f';

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

describe('whale-blocklist', () => {
  it('includes 0xb676 from live PNL analysis', () => {
    expect(isBlocklistedWhale(BLOCKED_WHALE)).toBe(true);
    expect(isBlocklistedWhale(OTHER_WHALE)).toBe(false);
  });

  it('blocks entry plan with whale_blocklist reason', () => {
    const state = createTwapWatchState();
    const plan = computeCoinEntryPlan(sig(BLOCKED_WHALE, 10, 30), state, 2);
    expect(plan.allow).toBe(false);
    expect(plan.reason).toBe('whale_blocklist');
  });

  it('allows profitable 🔴100% whale 0x622f', () => {
    const state = createTwapWatchState();
    const plan = computeCoinEntryPlan(sig(OTHER_WHALE, 10, 30), state, 2);
    expect(plan.allow).toBe(true);
  });

  it('canScheduleLiveEntry rejects blocklisted whale', () => {
    const state = createTwapWatchState();
    const d = canScheduleLiveEntry(sig(BLOCKED_WHALE), state, new Map(), 2);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('whale_blocklist');
  });

  it('merges HL_TWAP_WHALE_BLOCKLIST env', () => {
    process.env.HL_TWAP_WHALE_BLOCKLIST = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    resetBlocklistedWhaleCache();
    expect(isBlocklistedWhale('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(true);
    delete process.env.HL_TWAP_WHALE_BLOCKLIST;
    resetBlocklistedWhaleCache();
  });
});
