import { describe, expect, it } from 'vitest';
import {
  __resetBirdeyeMarketCacheForTests,
  parseBirdeyeMarketData,
  parseBirdeyeTradeData5m,
  classifyBirdeyeError,
} from '../src/papertrader/pricing/birdeye-market.js';
import {
  __resetDexScreenerMarketCacheForTests,
  pickDiscoveryMarketQuote,
  parseDexScreenerPair,
} from '../src/papertrader/pricing/discovery-market-quote.js';

const NOW = 1_700_000_000_000;

describe('parseBirdeyeMarketData', () => {
  it('reads price mcap liq from v3 market-data envelope', () => {
    const r = parseBirdeyeMarketData({
      success: true,
      data: {
        address: 'Mint111',
        price: 0.00123,
        market_cap: 500_000,
        liquidity: 80_000,
        fdv: 600_000,
      },
    });
    expect(r?.priceUsd).toBe(0.00123);
    expect(r?.marketCapUsd).toBe(500_000);
    expect(r?.liquidityUsd).toBe(80_000);
  });
});

describe('parseBirdeyeTradeData5m', () => {
  it('reads volume_5m_usd', () => {
    expect(parseBirdeyeTradeData5m({ success: true, data: { volume_5m_usd: 12_345 } })).toBe(12_345);
  });
});

describe('classifyBirdeyeError', () => {
  it('detects quota messages', () => {
    expect(classifyBirdeyeError(200, 'Compute units limit exceeded')).toBe('quota');
  });
  it('detects rate limit', () => {
    expect(classifyBirdeyeError(429, 'Too many requests')).toBe('rate_limit');
  });
});

describe('pickDiscoveryMarketQuote — fallback chain', () => {
  const pgRow = {
    price_usd: 0.001,
    market_cap_usd: 400_000,
    liquidity_usd: 50_000,
    volume_5m: 1_000,
    ts: new Date(NOW - 20 * 60_000),
  };

  it('returns PG when disabled path (no birdeye/dex)', () => {
    const r = pickDiscoveryMarketQuote({
      pgRow,
      nowMs: NOW,
      maxStaleMs: 15_000,
      coverageGapMinMs: 5 * 60_000,
    });
    expect(r.source).toBe('pg_snapshot');
    expect(r.priceUsd).toBe(0.001);
    expect(r.pgSnapshotAgeMs).toBe(20 * 60_000);
  });

  it('prefers fresh Birdeye over PG', () => {
    const r = pickDiscoveryMarketQuote({
      pgRow,
      birdeye: {
        priceUsd: 0.0011,
        marketCapUsd: 440_000,
        liquidityUsd: 55_000,
        volume5mUsd: 2_000,
        fetchedAtMs: NOW - 2_000,
      },
      nowMs: NOW,
      maxStaleMs: 15_000,
      coverageGapMinMs: 5 * 60_000,
    });
    expect(r.source).toBe('birdeye');
    expect(r.priceUsd).toBe(0.0011);
    expect(r.volume5mUsd).toBe(2_000);
  });

  it('falls back to DexScreener when Birdeye stale', () => {
    const r = pickDiscoveryMarketQuote({
      pgRow,
      birdeye: {
        priceUsd: 0.002,
        marketCapUsd: null,
        liquidityUsd: null,
        volume5mUsd: null,
        fetchedAtMs: NOW - 60_000,
      },
      dexscreener: {
        priceUsd: 0.00105,
        marketCapUsd: 420_000,
        liquidityUsd: null,
        volume5mUsd: null,
        fetchedAtMs: NOW - 1_000,
      },
      nowMs: NOW,
      maxStaleMs: 15_000,
      coverageGapMinMs: 5 * 60_000,
    });
    expect(r.source).toBe('dexscreener');
    expect(r.priceUsd).toBe(0.00105);
  });

  it('flags coverage gap when PG stale and REST miss', () => {
    const r = pickDiscoveryMarketQuote({
      pgRow,
      birdeye: {
        priceUsd: null,
        marketCapUsd: null,
        liquidityUsd: null,
        volume5mUsd: null,
        fetchedAtMs: NOW - 1_000,
        tierInsufficient: true,
        errorKind: 'quota',
      },
      nowMs: NOW,
      maxStaleMs: 15_000,
      coverageGapMinMs: 5 * 60_000,
    });
    expect(r.coverageGap).toBe(true);
    expect(r.birdeyeTierInsufficient).toBe(true);
  });
});

describe('parseDexScreenerPair', () => {
  it('maps pair fields including volume m5', () => {
    const r = parseDexScreenerPair({
      priceUsd: '0.5',
      marketCap: 1_000_000,
      liquidity: { usd: 200_000 },
      volume: { m5: 15_000 },
    });
    expect(r.priceUsd).toBe(0.5);
    expect(r.marketCapUsd).toBe(1_000_000);
    expect(r.volume5mUsd).toBe(15_000);
  });
});

describe('cache resets', () => {
  it('does not throw', () => {
    __resetBirdeyeMarketCacheForTests();
    __resetDexScreenerMarketCacheForTests();
    expect(true).toBe(true);
  });
});
