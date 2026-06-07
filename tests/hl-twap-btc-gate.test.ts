import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import { canScheduleLiveEntry } from '../src/hyperliquid/twap/live/coin-exposure.js';
import {
  hlTwapBtcAlignedBlockReason,
  hlTwapBtcAlignedGateEnabled,
} from '../src/hyperliquid/twap/twap-btc-gate.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

vi.mock('../src/papertrader/pricing.js', () => ({
  getBtcContext: vi.fn(),
}));

import { getBtcContext } from '../src/papertrader/pricing.js';

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
    vi.resetAllMocks();
  });

  it('blocks long when BTC 1h is down', () => {
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: -0.5,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
    expect(hlTwapBtcAlignedBlockReason('buy')).toBe('btc_aligned_gate_long');
    expect(hlTwapBtcAlignedBlockReason('sell')).toBeNull();
  });

  it('blocks short when BTC 1h is up', () => {
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: 0.8,
      ret4h_pct: null,
      ret24h_pct: null,
      ret72h_pct: null,
      retPeak72hDrawdown_pct: null,
      updated_ts: Date.now(),
    });
    expect(hlTwapBtcAlignedBlockReason('sell')).toBe('btc_aligned_gate_short');
    expect(hlTwapBtcAlignedBlockReason('buy')).toBeNull();
  });

  it('canScheduleLiveEntry rejects long on BTC down', () => {
    vi.mocked(getBtcContext).mockReturnValue({
      ret1h_pct: -1,
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

  it('is disabled by default env', () => {
    delete process.env.HL_TWAP_BTC_ALIGNED_GATE;
    expect(hlTwapBtcAlignedGateEnabled()).toBe(false);
    expect(hlTwapBtcAlignedBlockReason('buy')).toBeNull();
  });
});
