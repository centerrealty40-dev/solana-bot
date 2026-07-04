import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBirdeyeMarketCacheForTests,
  isBirdeyeBatchEndpointUnavailable,
  resolveBirdeyeMarketQuoteBatch,
} from '../src/papertrader/pricing/birdeye-market.js';

describe('resolveBirdeyeMarketQuoteBatch', () => {
  afterEach(() => {
    __resetBirdeyeMarketCacheForTests();
    delete process.env.BIRDEYE_API_KEY;
  });

  it('falls back to per-mint when batch disabled (Lite default)', async () => {
    process.env.BIRDEYE_API_KEY = 'lite-key';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/multiple')) {
        throw new Error('batch should not be called');
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            data: { price: 0.01, market_cap: 100_000, liquidity: 50_000 },
          }),
      };
    });

    const res = await resolveBirdeyeMarketQuoteBatch(['MintA', 'MintB'], {
      ttlMs: 12_000,
      batchEnabled: false,
      fetchImpl: fetchImpl as never,
    });

    expect(res.batchUnavailable).toBe(false);
    expect(res.quotes.size).toBe(2);
    expect(fetchImpl.mock.calls.every((c) => !String(c[0]).includes('/multiple'))).toBe(true);
  });

  it('marks batch unavailable on 403 and still resolves per-mint', async () => {
    process.env.BIRDEYE_API_KEY = 'lite-key';
    let perMintCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/multiple')) {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ message: 'Feature not available on Lite tier' }),
        };
      }
      perMintCalls += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ success: true, data: { price: 0.02, market_cap: 200_000 } }),
      };
    });

    const res = await resolveBirdeyeMarketQuoteBatch(['MintC', 'MintD'], {
      ttlMs: 12_000,
      batchEnabled: true,
      fetchImpl: fetchImpl as never,
    });

    expect(res.batchUnavailable).toBe(true);
    expect(perMintCalls).toBeGreaterThanOrEqual(2);
    expect(res.quotes.get('MintC')?.priceUsd).toBe(0.02);
  });
});

describe('isBirdeyeBatchEndpointUnavailable', () => {
  it('detects Lite tier 403', () => {
    expect(isBirdeyeBatchEndpointUnavailable(403, 'upgrade to business')).toBe(true);
  });
});
