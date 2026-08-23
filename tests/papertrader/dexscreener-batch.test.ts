import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  DEXSCREENER_BATCH_MAX,
  __resetDexQuoteCacheForTests,
  fetchDexScreenerPairDetails,
  fetchDexScreenerPairCreatedAtMany,
  nextDexScreenerCooldownAt,
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
    delete process.env.DEXSCREENER_GLOBAL_GATE_PATH;
    delete process.env.DEXSCREENER_429_BACKOFF_BASE_MS;
    delete process.env.DEXSCREENER_429_BACKOFF_MAX_MS;
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
    process.env.DEXSCREENER_GLOBAL_GATE_PATH = path.join(dir, 'gate.json');
    process.env.DEX_QUOTE_CACHE_ENABLED = '1';
    const target = mint(77);
    const failed = await prefetchDexScreenerPairDetailsManyWithMetadata([target], {
      fetchImpl: (async () => ({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'retry-after' ? '1' : null) },
      })) as never,
      nowMs: Date.now(),
      bypassGate: true,
    });
    expect(failed.errorMints).toEqual([target]);
    expect(failed.rateLimited429).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'gate.json'), 'utf8')).total429).toBe(1);
    fs.writeFileSync(
      path.join(dir, 'gate.json'),
      JSON.stringify({
        nextAllowedMs: Date.now(),
        cooldownUntilMs: Date.now() - 1,
        consecutive429: 1,
        total429: 1,
        last429AtMs: Date.now(),
      }),
    );
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
    delete process.env.DEXSCREENER_GLOBAL_GATE_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses Retry-After seconds and HTTP dates, then falls back exponentially', () => {
    const nowMs = Date.parse('2025-01-01T00:00:00.000Z');
    const seconds = nextDexScreenerCooldownAt({
      nowMs,
      retryAfter: '2',
      consecutive429: 0,
    });
    expect(seconds.consecutive429).toBe(1);
    expect(seconds.cooldownMs).toBe(2_000);

    const date = nextDexScreenerCooldownAt({
      nowMs,
      retryAfter: 'Wed, 01 Jan 2025 00:00:04 GMT',
      consecutive429: 1,
    });
    expect(date.consecutive429).toBe(2);
    expect(date.cooldownMs).toBe(4_000);

    const invalid = nextDexScreenerCooldownAt({
      nowMs,
      retryAfter: 'garbage',
      consecutive429: 1,
    });
    const missing = nextDexScreenerCooldownAt({
      nowMs,
      retryAfter: undefined,
      consecutive429: 2,
    });
    expect(invalid.cooldownMs).toBe(10_000);
    expect(missing.cooldownMs).toBe(20_000);
  });

  it('clamps configured 429 backoff base and ceiling', () => {
    process.env.DEXSCREENER_429_BACKOFF_BASE_MS = '500';
    process.env.DEXSCREENER_429_BACKOFF_MAX_MS = '1500';
    expect(
      nextDexScreenerCooldownAt({ nowMs: 1_000, retryAfter: 'garbage', consecutive429: 0 }).cooldownMs,
    ).toBe(1_000);
    expect(
      nextDexScreenerCooldownAt({ nowMs: 1_000, retryAfter: 'garbage', consecutive429: 1 }).cooldownMs,
    ).toBe(1_500);
    delete process.env.DEXSCREENER_429_BACKOFF_BASE_MS;
    delete process.env.DEXSCREENER_429_BACKOFF_MAX_MS;
  });

  it('resets the 429 streak and cooldown after an ok response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-gate-reset-'));
    process.env.DEXSCREENER_GLOBAL_GATE_PATH = path.join(dir, 'gate.json');
    const target = mint(80);
    const responses = [
      {
        ok: false,
        status: 429,
        headers: { get: () => null },
      },
      {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ pairs: [pairFor(target)] }),
      },
    ];
    const fetchImpl = (async () => responses.shift()!) as never;
    await prefetchDexScreenerPairDetailsManyWithMetadata([target], {
      fetchImpl,
      nowMs: Date.now(),
      bypassGate: true,
    });
    fs.writeFileSync(
      path.join(dir, 'gate.json'),
      JSON.stringify({
        nextAllowedMs: Date.now(),
        cooldownUntilMs: Date.now() - 1,
        consecutive429: 1,
        total429: 1,
        last429AtMs: Date.now(),
      }),
    );
    __resetDexQuoteCacheForTests();
    await prefetchDexScreenerPairDetailsManyWithMetadata([target], {
      fetchImpl,
      nowMs: Date.now() + 1_000,
      bypassGate: true,
    });
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'gate.json'), 'utf8'));
    expect(state.consecutive429).toBe(0);
    expect(state.cooldownUntilMs).toBe(0);
    expect(state.total429).toBe(1);
    delete process.env.DEXSCREENER_GLOBAL_GATE_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('waits for a cooldown persisted by another process before requesting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-gate-wait-'));
    const gatePath = path.join(dir, 'gate.json');
    const nowMs = Date.now();
    fs.writeFileSync(
      gatePath,
      JSON.stringify({
        nextAllowedMs: nowMs,
        cooldownUntilMs: nowMs + 1_000,
        consecutive429: 1,
        total429: 1,
        last429AtMs: nowMs,
      }),
    );
    process.env.DEXSCREENER_GLOBAL_GATE_PATH = gatePath;
    process.env.DEXSCREENER_GLOBAL_RATE_LIMIT = '1';
    process.env.DEXSCREENER_GLOBAL_MAX_RPM = '120';
    const startedAt = Date.now();
    await prefetchDexScreenerPairDetailsManyWithMetadata([mint(81)], {
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ pairs: [] }),
      })) as never,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    delete process.env.DEXSCREENER_GLOBAL_GATE_PATH;
    delete process.env.DEXSCREENER_GLOBAL_RATE_LIMIT;
    delete process.env.DEXSCREENER_GLOBAL_MAX_RPM;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed for bypass requests during cooldown without negative caching', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-gate-bypass-'));
    const gatePath = path.join(dir, 'gate.json');
    const cachePath = path.join(dir, 'cache.json');
    const nowMs = Date.now();
    fs.writeFileSync(
      gatePath,
      JSON.stringify({
        nextAllowedMs: nowMs,
        cooldownUntilMs: nowMs + 5_000,
        consecutive429: 2,
        total429: 2,
        last429AtMs: nowMs,
      }),
    );
    process.env.DEXSCREENER_GLOBAL_GATE_PATH = gatePath;
    process.env.DEX_QUOTE_CACHE_PATH = cachePath;
    process.env.DEX_QUOTE_CACHE_ENABLED = '1';
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ pairs: [] }) };
    }) as never;

    await expect(
      fetchDexScreenerPairDetails(mint(82), {
        fetchImpl,
        nowMs,
        bypassGate: true,
      }),
    ).resolves.toBeNull();
    const result = await prefetchDexScreenerPairDetailsManyWithMetadata([mint(83)], {
      fetchImpl,
      nowMs,
      bypassGate: true,
    });
    expect(result.requests).toBe(0);
    expect(result.cooldownSkipped).toBe(1);
    expect(result.errorMints).toEqual([mint(83)]);
    expect(calls).toBe(0);
    expect(fs.existsSync(cachePath)).toBe(false);

    __resetDexQuoteCacheForTests();
    fs.writeFileSync(
      gatePath,
      JSON.stringify({
        nextAllowedMs: nowMs,
        cooldownUntilMs: nowMs - 1,
        consecutive429: 2,
        total429: 2,
        last429AtMs: nowMs,
      }),
    );
    const recovered = await prefetchDexScreenerPairDetailsManyWithMetadata([mint(83)], {
      fetchImpl: (async (url: string) => {
        calls += 1;
        const target = String(url).split('/tokens/')[1]!.split(',')[0]!;
        return { ok: true, json: async () => ({ pairs: [pairFor(target)] }) };
      }) as never,
      nowMs,
      bypassGate: true,
    });
    expect(recovered.requests).toBe(1);
    expect(recovered.resolvedMints).toEqual([mint(83)]);
    expect(calls).toBe(1);
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

    expect(calls).toHaveLength(9);
    expect(result.uncoveredMints).toHaveLength(20);
    expect(result.retriedMints).toHaveLength(8);
    expect(result.missedMints).toHaveLength(12);
    expect(result.detailsByMint.size).toBe(18);
    expect(result.resolvedMints).toHaveLength(18);
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
