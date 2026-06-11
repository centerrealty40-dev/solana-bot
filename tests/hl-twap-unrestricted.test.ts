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
import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import { canScheduleLiveEntry } from '../src/hyperliquid/twap/live/coin-exposure.js';
import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';
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

  it('canScheduleLiveEntry enforces coin stack cap in unrestricted mode', () => {
    const liveCfg = loadHlTwapLiveConfig();
    const state = createTwapWatchState();
    const opens = new Map([
      [
        '0xa',
        {
          hash: '0xa',
          coin: 'BTC',
          displaySymbol: 'BTC',
          side: 'buy' as const,
          entryTs: 1,
          entryAnchorPx: 100,
          avgEntryPx: 100,
          initialNotionalUsd: 5600,
          currentNotionalUsd: 5600,
          marginUsd: 800,
          entryLeverage: 7,
          impactPct: 8,
          whaleUser: '0x1',
          minutes: 30,
          liveOpenAtMs: 1,
          liveCloseAtMs: 2,
          twapStartMs: 1,
          tpLevelsTaken: 0,
          dcaLevelsTaken: 0,
          whaleNotionalUsd: 100_000,
          whaleSize: 1000,
        },
      ],
      [
        '0xb',
        {
          hash: '0xb',
          coin: 'BTC',
          displaySymbol: 'BTC',
          side: 'buy' as const,
          entryTs: 1,
          entryAnchorPx: 100,
          avgEntryPx: 100,
          initialNotionalUsd: 5600,
          currentNotionalUsd: 5600,
          marginUsd: 800,
          entryLeverage: 7,
          impactPct: 4,
          whaleUser: '0x2',
          minutes: 30,
          liveOpenAtMs: 1,
          liveCloseAtMs: 2,
          twapStartMs: 1,
          tpLevelsTaken: 0,
          dcaLevelsTaken: 0,
          whaleNotionalUsd: 100_000,
          whaleSize: 1000,
        },
      ],
    ]);
    state.activeByHash.set('0xa', { ...sig(30), hash: '0xa', volumeSharePct: 8 });
    state.activeByHash.set('0xb', { ...sig(30), hash: '0xb', volumeSharePct: 4 });
    const steep = { ...sig(15), hash: '0xc', volumeSharePct: 12, minutes: 15 };
    state.activeByHash.set('0xc', steep);
    const decision = canScheduleLiveEntry(steep, state, opens, 2, undefined, liveCfg);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('coin_stack_reanchor');
    expect(decision.reanchor?.targetHash).toBe('0xb');
  });

  it('canScheduleLiveEntry still blocks opposite side in unrestricted mode', () => {
    const opens = new Map([
      [
        '0xa',
        {
          hash: '0xa',
          coin: 'BTC',
          displaySymbol: 'BTC',
          side: 'buy' as const,
          entryTs: 1,
          entryAnchorPx: 100,
          avgEntryPx: 100,
          initialNotionalUsd: 5000,
          currentNotionalUsd: 5000,
          marginUsd: 1000,
          entryLeverage: 5,
          impactPct: 5,
          whaleUser: '0x1',
          minutes: 30,
          liveOpenAtMs: 1,
          liveCloseAtMs: 2,
          twapStartMs: 1,
          tpLevelsTaken: 0,
          dcaLevelsTaken: 0,
          whaleNotionalUsd: 100_000,
          whaleSize: 1000,
        },
      ],
    ]);
    const sell = { ...sig(30), hash: '0xb', side: 'sell' as const };
    const decision = canScheduleLiveEntry(sell, { activeByHash: new Map() }, opens, 2);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('coin_has_opposite_side');
  });
});
