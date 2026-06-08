import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import { canScheduleLiveEntry, resolveLiveEntryAuditPlan } from '../src/hyperliquid/twap/live/coin-exposure.js';
import {
  hlTwapBtcAlignedBlockReason,
  hlTwapBtcAlignedGateEnabled,
  hlTwapBtcAlignedThreshPct,
} from '../src/hyperliquid/twap/twap-btc-gate.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

vi.mock('../src/papertrader/pricing.js', () => ({
  getBtcContext: vi.fn(),
}));

import { getBtcContext } from '../src/papertrader/pricing.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sig(side: 'buy' | 'sell'): NormalizedTwapSignal {
  return {
    hash: '0xabc',
    twapId: null,
    user: '0xgood00000000000000000000000000000001',
    side,
    coin: 'BTC',
    displaySymbol: 'BTC',
    isSpot: false,
    size: 1,
    minutes: 30,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 500_000,
    midPx: 100_000,
    dayNtlVlmUsd: 1e9,
    volumeSharePct: 5,
    startedAtMs: Date.now(),
    block: 1,
    ended: null,
  };
}

describe('hl-twap btc aligned gate', () => {
  beforeEach(() => {
    process.env.HL_TWAP_BTC_ALIGNED_GATE = '1';
    delete process.env.HL_TWAP_BTC_ALIGNED_THRESH_PCT;
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: 1.5,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
  });

  afterEach(() => {
    delete process.env.HL_TWAP_BTC_ALIGNED_GATE;
    delete process.env.HL_TWAP_BTC_ALIGNED_THRESH_PCT;
    vi.resetAllMocks();
  });

  it('defaults threshold to 1%', () => {
    expect(hlTwapBtcAlignedThreshPct()).toBe(1);
  });

  it('allows long on weak BTC down when thresh=1 (default)', () => {
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: -0.5,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
    expect(hlTwapBtcAlignedBlockReason('buy')).toBeNull();
    expect(hlTwapBtcAlignedBlockReason('sell')).toBeNull();
  });

  it('blocks long on strong BTC down (default thresh)', () => {
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: -1.2,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
    expect(hlTwapBtcAlignedBlockReason('buy')).toBe('btc_aligned_gate_long');
    expect(hlTwapBtcAlignedBlockReason('sell')).toBeNull();
  });

  it('blocks short on strong BTC up (default thresh)', () => {
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: 1.2,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
    expect(hlTwapBtcAlignedBlockReason('sell')).toBe('btc_aligned_gate_short');
    expect(hlTwapBtcAlignedBlockReason('buy')).toBeNull();
  });

  it('legacy thresh=0 blocks any sign mismatch', () => {
    process.env.HL_TWAP_BTC_ALIGNED_THRESH_PCT = '0';
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: -0.5,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
    expect(hlTwapBtcAlignedBlockReason('buy')).toBe('btc_aligned_gate_long');
  });

  it('canScheduleLiveEntry rejects long on strong BTC down', () => {
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: -1.5,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
    const state = createTwapWatchState();
    const buy = sig('buy');
    state.activeByHash.set(buy.hash, buy);
    const d = canScheduleLiveEntry(buy, state, new Map(), 2);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('btc_aligned_gate_long');
  });

  it('resolveLiveEntryAuditPlan matches schedule gate', () => {
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: -1.5,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-twap-audit-'));
    const journal = path.join(dir, 'live.jsonl');
    const state = createTwapWatchState();
    const buy = sig('buy');
    state.activeByHash.set(buy.hash, buy);
    const plan = resolveLiveEntryAuditPlan(buy, state, journal, 2);
    expect(plan.allow).toBe(false);
    expect(plan.reason).toBe('btc_aligned_gate_long');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is disabled by default env', () => {
    delete process.env.HL_TWAP_BTC_ALIGNED_GATE;
    expect(hlTwapBtcAlignedGateEnabled()).toBe(false);
    expect(hlTwapBtcAlignedBlockReason('buy')).toBeNull();
  });
});
