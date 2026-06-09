import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearCoinMomentumCache,
  computeCoinDd24hPct,
  hlTwapCoinMomentumBlockReason,
  hlTwapCoinMomentumGateEnabled,
  refreshCoinMomentumCache,
} from '../src/hyperliquid/twap/coin-momentum-gate.js';

describe('coin-momentum-gate', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.HL_TWAP_COIN_MOMENTUM_GATE = '1';
    process.env.HL_TWAP_COIN_MOMENTUM_DD24H_PCT = '5';
    clearCoinMomentumCache();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    clearCoinMomentumCache();
    vi.unstubAllGlobals();
  });

  it('computeCoinDd24hPct from 24h window', () => {
    const ts = 1_700_000_000_000;
    const candles = [];
    for (let i = 0; i < 24; i++) {
      const t = ts - (24 - i) * 3_600_000;
      const peak = i === 10 ? 110 : 100;
      candles.push({ t, T: t + 3_599_999, c: 94, h: peak });
    }
    const dd = computeCoinDd24hPct(candles, ts);
    expect(dd).not.toBeNull();
    expect(dd!).toBeLessThan(-5);
  });

  it('blocks long when cached dd24h below threshold', async () => {
    const ts = Date.now();
    const candles = [];
    for (let i = 0; i < 30; i++) {
      const t = ts - (30 - i) * 3_600_000;
      candles.push({ t, T: t + 3_599_999, c: '90', h: '100' });
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => candles,
      })),
    );
    await refreshCoinMomentumCache('GRASS', ts);
    expect(hlTwapCoinMomentumBlockReason('GRASS', 'buy')).toMatch(/^coin_dd24h_/);
    expect(hlTwapCoinMomentumBlockReason('GRASS', 'sell')).toBeNull();
  });

  it('disabled when env off', () => {
    process.env.HL_TWAP_COIN_MOMENTUM_GATE = '0';
    expect(hlTwapCoinMomentumGateEnabled()).toBe(false);
    expect(hlTwapCoinMomentumBlockReason('GRASS', 'buy')).toBeNull();
  });
});
