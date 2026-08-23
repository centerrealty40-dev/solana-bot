import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  DEXSCREENER_BATCH_MAX,
  __resetDexQuoteCacheForTests,
  fetchDexScreenerPairCreatedAtMany,
  prefetchDexScreenerPairDetailsMany,
  prefetchDexScreenerPairDetailsManyWithMetadata,
} from '../../src/papertrader/pricing/dexscreener-quote-cache.js';

function mint(i: number): string {
  return `M${String(i).padStart(3, '0')}${'x'.repeat(38)}`;
}

function pairFor(address: string) {
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: `pair-${address.slice(0, 6)}`,
    priceUsd: '0.00001',
    baseToken: { address },
    quoteToken: { address: 'So11111111111111111111111111111111111111112' },
    liquidity: { usd: 20_000 },
    volume: { m5: 1_000, h1: 20_000 },
    marketCap: 50_000,
    priceChange: { m5: -12, h1: -20 },
    txns: { m5: { buys: 5, sells: 7 } },
    pairCreatedAt: Date.now() - 7_200_000,
  };
}

describe('1.11.820 DexScreener batch prefetch', () => {
  beforeEach(() => {
    __resetDexQuoteCacheForTests();
    // Without this the cases share `data/dexscreener-quote-cache.json` and the
    // second one sees the first one's writes as warm cache.
    process.env.DEX_QUOTE_CACHE_ENABLED = '0';
  });

  afterEach(() => {
    delete process.env.DEX_QUOTE_CACHE_PATH;
    process.env.DEX_QUOTE_CACHE_ENABLED = '0';
  });

  it('spends one request per 30 mints, not one per mint', async () => {
    const urls: string[] = [];
    const mints = Array.from({ length: 65 }, (_, i) => mint(i));
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      const addrs = String(url).split('/tokens/')[1]!.split(',').map(decodeURIComponent);
      return {
        ok: true,
        json: async () => ({ pairs: addrs.map(pairFor) }),
      };
    }) as never;

    const calls = await prefetchDexScreenerPairDetailsMany(mints, {
      fetchImpl,
      nowMs: Date.now(),
      bypassGate: true,
    });

    expect(DEXSCREENER_BATCH_MAX).toBe(30);
    expect(calls).toBe(3); // 30 + 30 + 5
    expect(urls).toHaveLength(3);
    expect(urls[0]!.split(',').length).toBe(30);
    expect(urls[2]!.split(',').length).toBe(5);
  });

  it('skips mints already warm in cache', async () => {
    const now = Date.now();
    const mints = [mint(1), mint(2)];
    const fetchImpl = (async (url: string) => {
      const addrs = String(url).split('/tokens/')[1]!.split(',').map(decodeURIComponent);
      return { ok: true, json: async () => ({ pairs: addrs.map(pairFor) }) };
    }) as never;

    expect(await prefetchDexScreenerPairDetailsMany(mints, { fetchImpl, nowMs: now, bypassGate: true })).toBe(1);
    // Second pass inside the TTL must not touch the network at all.
    expect(
      await prefetchDexScreenerPairDetailsMany(mints, {
        fetchImpl,
        nowMs: now + 1_000,
        cacheTtlMs: 30_000,
        bypassGate: true,
      }),
    ).toBe(0);
  });

  it('a failed chunk does not throw and leaves the rest usable', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as never;
    await expect(
      prefetchDexScreenerPairDetailsMany([mint(9)], {
        fetchImpl,
        nowMs: Date.now(),
        bypassGate: true,
      }),
    ).resolves.toBe(1);
  });

  it('does not cache a 429 as a negative quote', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-batch-error-'));
    process.env.DEX_QUOTE_CACHE_PATH = path.join(dir, 'cache.json');
    process.env.DEX_QUOTE_CACHE_ENABLED = '1';
    const target = mint(77);
    const failed = await prefetchDexScreenerPairDetailsManyWithMetadata([target], {
      fetchImpl: (async () => ({ ok: false, status: 429 })) as never,
      nowMs: Date.now(),
      bypassGate: true,
    });
    expect(failed.errorMints).toEqual([target]);
    __resetDexQuoteCacheForTests();
    const recovered = await prefetchDexScreenerPairDetailsManyWithMetadata([target], {
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ pairs: [pairFor(target)] }),
      })) as never,
      nowMs: Date.now() + 1_000,
      bypassGate: true,
    });
    expect(recovered.resolvedMints).toEqual([target]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retries a fresh negative cache entry instead of suppressing the mint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-negative-cache-'));
    process.env.DEX_QUOTE_CACHE_PATH = path.join(dir, 'cache.json');
    process.env.DEX_QUOTE_CACHE_ENABLED = '1';
    const now = Date.now();
    const target = mint(78);
    fs.writeFileSync(
      process.env.DEX_QUOTE_CACHE_PATH,
      JSON.stringify({
        entries: { [target]: { miss: true, fetchedAtMs: now } },
      }),
    );
    let calls = 0;
    const result = await prefetchDexScreenerPairDetailsManyWithMetadata([target], {
      fetchImpl: (async () => {
        calls += 1;
        return {
          ok: true,
          json: async () => ({ pairs: [pairFor(target)] }),
        };
      }) as never,
      nowMs: now + 1_000,
      bypassGate: true,
    });
    expect(calls).toBe(1);
    expect(result.resolvedMints).toEqual([target]);
    expect(result.detailsByMint.get(target)?.pairAddress).toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fills mints omitted by a truncated full-size batch with targeted requests', async () => {
    const mints = Array.from({ length: 30 }, (_, i) => mint(i));
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      const addresses = String(url)
        .split('/tokens/')[1]!
        .split(',')
        .map(decodeURIComponent);
      const pairs =
        addresses.length === 30
          ? addresses.slice(0, 10).flatMap((address) =>
              Array.from({ length: 3 }, () => pairFor(address)),
            )
          : [pairFor(addresses[0]!)];
      return { ok: true, json: async () => ({ pairs }) };
    }) as never;

    const result = await prefetchDexScreenerPairDetailsManyWithMetadata(mints, {
      fetchImpl,
      nowMs: Date.now(),
      bypassGate: true,
    });

    expect(calls).toHaveLength(21);
    expect(result.uncoveredMints).toHaveLength(20);
    expect(result.retriedMints).toHaveLength(20);
    expect(result.detailsByMint.size).toBe(30);
    expect(result.resolvedMints).toHaveLength(30);
  });

  it('returns fresh positive cache details without an HTTP request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-positive-cache-'));
    process.env.DEX_QUOTE_CACHE_PATH = path.join(dir, 'cache.json');
    process.env.DEX_QUOTE_CACHE_ENABLED = '1';
    const now = Date.now();
    const target = mint(79);
    const pair = pairFor(target);
    fs.writeFileSync(
      process.env.DEX_QUOTE_CACHE_PATH,
      JSON.stringify({
        entries: {
          [target]: {
            miss: false,
            priceUsd: Number(pair.priceUsd),
            marketCapUsd: pair.marketCap,
            liquidityUsd: pair.liquidity.usd,
            volume5mUsd: pair.volume.m5,
            volume1hUsd: pair.volume.h1,
            pairAddress: pair.pairAddress,
            baseMint: target,
            quoteMint: 'So11111111111111111111111111111111111111112',
            dexId: pair.dexId,
            fetchedAtMs: now,
          },
        },
      }),
    );
    const result = await prefetchDexScreenerPairDetailsManyWithMetadata([target], {
      fetchImpl: (async () => {
        throw new Error('HTTP must not be called');
      }) as never,
      nowMs: now + 1_000,
      bypassGate: true,
    });
    expect(result.requests).toBe(0);
    expect(result.detailsByMint.get(target)?.pairAddress).toBe(pair.pairAddress);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns pair creation times with the same 30-address chunking and pair pick', async () => {
    const urls: string[] = [];
    const mints = Array.from({ length: 31 }, (_, i) => mint(i));
    const now = Date.now();
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      const addrs = String(url).split('/tokens/')[1]!.split(',').map(decodeURIComponent);
      return {
        ok: true,
        json: async () => ({
          pairs: addrs.map((address) => ({
            chainId: 'solana',
            dexId: 'pumpswap',
            pairAddress: `pair-${address.slice(0, 6)}`,
            priceUsd: '0.00001',
            baseToken: { address },
            quoteToken: { address: 'So11111111111111111111111111111111111111112' },
            liquidity: { usd: 20_000 },
            pairCreatedAt: now - 7_200_000,
          })),
        }),
      };
    }) as never;

    const result = await fetchDexScreenerPairCreatedAtMany(mints, {
      fetchImpl,
      bypassGate: true,
    });

    expect(urls).toHaveLength(2);
    expect(urls[0]!.split(',')).toHaveLength(30);
    expect(result.size).toBe(31);
    expect(result.get(mints[0]!)).toBe(now - 7_200_000);
    expect(result.get(mints[30]!)).toBe(now - 7_200_000);
  });
});
