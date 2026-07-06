import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  __resetShyftVsDexThrottleForTests,
  buildShyftStreamHealthEvent,
  buildShyftVsDexQuoteEvent,
  buildShyftVsDexQuoteObservation,
  quotePctDelta,
  shouldEmitShyftVsDexQuote,
} from '../src/papertrader/stream/shyft-shadow-observe.js';
import { __resetDexScreenerMarketCacheForTests } from '../src/papertrader/pricing/discovery-market-quote.js';
import { __resetShyftDefiMcapCacheForTests } from '../src/papertrader/stream/shyft-defi-mcap.js';

describe('quotePctDelta', () => {
  it('returns signed % diff', () => {
    expect(quotePctDelta(110, 100)).toBe(10);
    expect(quotePctDelta(90, 100)).toBe(-10);
  });
  it('returns null for invalid inputs', () => {
    expect(quotePctDelta(null, 100)).toBeNull();
    expect(quotePctDelta(100, 0)).toBeNull();
  });
});

describe('buildShyftStreamHealthEvent', () => {
  it('builds health row with uptime and observation age', () => {
    const ev = buildShyftStreamHealthEvent(
      {
        status: 'connected',
        watchedMintCount: 3,
        reconnectCount: 2,
        lastObservationMs: 1_000_000,
        connectedSinceMs: 900_000,
        observationsTotal: 42,
        detail: 'grpc.fra.shyft.to mints=3',
      },
      1_030_000,
    );
    expect(ev.kind).toBe('live_shyft_stream_health');
    expect(ev.connectedUptimeMs).toBe(130_000);
    expect(ev.lastObservationAgeMs).toBe(30_000);
    expect(ev.reconnectCount).toBe(2);
  });
});

describe('buildShyftVsDexQuoteEvent', () => {
  it('computes stream vs dex and prod deltas', () => {
    const ev = buildShyftVsDexQuoteEvent(
      {
        mint: 'MintA',
        lane: 'prod',
        surface: 'entry',
        stream: { priceUsd: 1.1, streamTsMs: 1_000_000, slot: 123 },
        dexPriceUsd: 1.0,
        dexMcapUsd: 1_000_000,
        dexLiqUsd: 50_000,
        dexFetchedAtMs: 999_000,
        shyftDefiMcapUsd: 1_050_000,
        shyftDefiLiqUsd: 48_000,
        prodPriceUsd: 1.05,
        prodMcapUsd: 1_020_000,
        prodLiqUsd: 49_000,
      },
      1_001_000,
    );
    expect(ev.kind).toBe('live_shyft_vs_dex_quote');
    expect(ev.streamVsDexPricePct).toBe(10);
    expect(ev.prodVsDexPricePct).toBe(5);
    expect(ev.shyftDefiVsDexMcapPct).toBe(5);
    expect(ev.streamAgeMs).toBe(1_000);
  });
});

describe('shouldEmitShyftVsDexQuote throttle', () => {
  beforeEach(() => __resetShyftVsDexThrottleForTests());

  it('throttles repeated emits per mint+surface', () => {
    expect(shouldEmitShyftVsDexQuote('m1', 'entry', 10_000, 30_000)).toBe(true);
    expect(shouldEmitShyftVsDexQuote('m1', 'entry', 20_000, 30_000)).toBe(false);
    expect(shouldEmitShyftVsDexQuote('m1', 'mtm', 20_000, 30_000)).toBe(true);
    expect(shouldEmitShyftVsDexQuote('m1', 'entry', 50_000, 30_000)).toBe(true);
  });
});

describe('buildShyftVsDexQuoteObservation', () => {
  beforeEach(() => {
    __resetShyftVsDexThrottleForTests();
    __resetDexScreenerMarketCacheForTests();
    __resetShyftDefiMcapCacheForTests();
  });

  it('fetches dex + defi and returns comparison event', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('dexscreener')) {
        return {
          ok: true,
          json: async () => ({
            pairs: [
              {
                chainId: 'solana',
                baseToken: { address: 'MintX' },
                priceUsd: '2',
                marketCap: 2_000_000,
                liquidity: { usd: 80_000 },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ result: { pools: [{ marketCap: 2_100_000, liquidity: 75_000 }] } }),
      };
    });

    process.env.SHYFT_DEFI_API_KEY = 'test-key';
    const ev = await buildShyftVsDexQuoteObservation({
      mint: 'MintX',
      lane: 'prod',
      surface: 'entry',
      stream: { priceUsd: 2.2, streamTsMs: 1_000, slot: null },
      prodPriceUsd: 2.1,
      fetchImpl: fetchImpl as never,
      nowMs: 2_000,
    });

    expect(ev).not.toBeNull();
    expect(ev!.dexPriceUsd).toBe(2);
    expect(ev!.shyftDefiMcapUsd).toBe(2_100_000);
    expect(ev!.streamVsDexPricePct).toBe(10);
  });
});
