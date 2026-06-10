import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { computeCoinEntryPlan } from '../src/hyperliquid/twap/coin-twap-analysis.js';
import {
  isMicroTwapMinutes,
  microTwapExitSliceCount,
  shouldUseMicroExecution,
  twapDurationGate,
  twapEntrySliceCount,
  twapExitSliceCount,
} from '../src/hyperliquid/twap/twap-duration.js';
import { canScheduleLiveEntry } from '../src/hyperliquid/twap/live/coin-exposure.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

describe('hl-twap unrestricted', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.HL_TWAP_UNRESTRICTED = '1';
    process.env.HL_TWAP_MICRO_MAX_MINUTES = '15';
    process.env.HL_TWAP_MIN_IMPACT_PCT_HOUR = '2';
    delete process.env.HL_TWAP_ULTRA_SHORT_EXIT_SLICES;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  const sig = (minutes: number): NormalizedTwapSignal => ({
    hash: `0x${minutes.toString(16).padStart(64, '0')}`,
    twapId: null,
    user: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    side: 'buy',
    coin: 'BTC',
    displaySymbol: 'BTC',
    isSpot: false,
    size: 1000,
    minutes,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 100_000,
    midPx: 100,
    dayNtlVlmUsd: 1_000_000,
    volumeSharePct: 10,
    startedAtMs: Date.now(),
    block: 1,
    ended: null,
  });

  it('allows any duration including 5m, 15m, and 1440m', () => {
    expect(twapDurationGate(5).allow).toBe(true);
    expect(twapDurationGate(15).allow).toBe(true);
    expect(twapDurationGate(15).reason).toBe('ok_micro');
    expect(twapDurationGate(1440).allow).toBe(true);
    expect(twapDurationGate(1440).reason).toBe('ok');
  });

  it('gradual exit slices by duration: ≤5m→2, 6–15m→2, >15m→3; entry always 1 slice', () => {
    expect(isMicroTwapMinutes(15)).toBe(true);
    expect(shouldUseMicroExecution(15)).toBe(true);
    expect(twapExitSliceCount(5)).toBe(2);
    expect(twapExitSliceCount(15)).toBe(2);
    expect(twapExitSliceCount(16)).toBe(3);
    expect(twapExitSliceCount(60)).toBe(3);
    expect(twapEntrySliceCount(60)).toBe(1);
    expect(microTwapExitSliceCount(5)).toBe(2);
  });

  it('ultra-short can use 1 slice via HL_TWAP_ULTRA_SHORT_EXIT_SLICES=1', () => {
    process.env.HL_TWAP_ULTRA_SHORT_EXIT_SLICES = '1';
    expect(twapExitSliceCount(5)).toBe(1);
    expect(twapExitSliceCount(3)).toBe(1);
  });

  it('computeCoinEntryPlan requires hourly impact ≥ min (only gate in unrestricted)', () => {
    const plan = computeCoinEntryPlan(sig(5), { activeByHash: new Map() }, 2);
    expect(plan.allow).toBe(true);
    expect(plan.reason).toBe('ok_micro');

    const weak = { ...sig(60), volumeSharePct: 0.5 };
    const blocked = computeCoinEntryPlan(weak, { activeByHash: new Map() }, 2);
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toBe('hourly_impact_no_edge');
  });

  it('canScheduleLiveEntry skips whale/btc/momentum blocks', () => {
    process.env.HL_TWAP_WHALE_DENYLIST = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    process.env.HL_TWAP_BTC_ALIGNED_GATE = '1';
    process.env.HL_TWAP_COIN_MOMENTUM_GATE = '1';
    const decision = canScheduleLiveEntry(sig(3), { activeByHash: new Map() }, new Map(), 2);
    expect(decision.allow).toBe(true);
  });
});
