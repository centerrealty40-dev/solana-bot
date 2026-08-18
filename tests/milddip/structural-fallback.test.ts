import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  fetchMildDipStructuralFallback,
  resetStructuralFallbackStateForTests,
  type StructuralFallbackSnapshot,
} from '../../src/milddip/structural-fallback.js';
import {
  getStructuralCache,
  loadStructural,
  noteStructuralCache,
  resetFastPathStateForTests,
} from '../../src/milddip/fast-path.js';
import type { MildDipConfig } from '../../src/milddip/config.js';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';

const mint = 'FallbackMintxxxxxxxxxxxxxxxxxxxxxxxxxxxx1';
const otherMint = 'FallbackMintxxxxxxxxxxxxxxxxxxxxxxxxxxxx2';
const nowMs = Date.parse('2026-08-20T12:00:00.000Z');

function cfg(overrides: Partial<MildDipConfig> = {}): MildDipConfig {
  return {
    structuralFallbackEnabled: true,
    structuralFallbackMaxPerMin: 20,
    structuralFallbackMintGapMs: 30_000,
    structuralFallbackCacheTtlMs: 15_000,
    structuralFallbackTimeoutMs: 2_500,
    entry: { allowedDexIds: ['raydium', 'pumpswap'] },
    fastPathStructuralCacheMs: 8_000,
    fastPathStructuralStaleMs: 30_000,
    ...overrides,
  } as MildDipConfig;
}

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
  } as Response;
}

function pool(
  poolMint: string,
  dexId: string,
  reserve: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attributes: {
      base_token_price_usd: '1.25',
      reserve_in_usd: reserve,
      pool_created_at: '2026-08-20T10:00:00.000Z',
      volume_usd: { m5: '4481.22', h1: '73122.4' },
      transactions: { m5: { buys: '16', sells: '9' } },
      price_change_percentage: { m5: '-4.5', h1: '12.25' },
      ...overrides,
    },
    relationships: {
      base_token: { data: { id: `solana_${poolMint}` } },
      dex: { data: { id: dexId } },
    },
  };
}

describe('GeckoTerminal structural fallback', () => {
  beforeEach(() => {
    resetStructuralFallbackStateForTests();
    resetFastPathStateForTests();
  });

  it('selects the matching base-token pool with the largest reserve', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [
          pool(otherMint, 'raydium', '999999'),
          pool(mint, 'raydium', '10000', { base_token_price_usd: '2' }),
          pool(mint, 'pumpswap', '20000'),
          pool(mint, 'meteora', '50000'),
        ],
      }),
    );
    const snapshot = await fetchMildDipStructuralFallback(mint, cfg(), nowMs, { fetchImpl });
    expect(snapshot).toMatchObject({
      priceUsd: 1.25,
      liquidityUsd: 20_000,
      dexId: 'pumpswap',
      marketCapUsd: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null when no base-token pool survives dex filtering', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ data: [pool(otherMint, 'raydium', '10000'), pool(mint, 'meteora', '50000')] }),
    );
    await expect(
      fetchMildDipStructuralFallback(mint, cfg(), nowMs, { fetchImpl }),
    ).resolves.toBeNull();
  });

  it('maps string fields and pool age without inventing market cap', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ data: [pool(mint, 'raydium', '37305.98')] }),
    );
    const snapshot = await fetchMildDipStructuralFallback(mint, cfg(), nowMs, { fetchImpl });
    expect(snapshot).toEqual<StructuralFallbackSnapshot>({
      priceUsd: 1.25,
      volume5mUsd: 4481.22,
      liquidityUsd: 37305.98,
      buys5m: 16,
      sells5m: 9,
      volume1hUsd: 73122.4,
      priceChange5mPct: -4.5,
      priceChange1hPct: 12.25,
      pairAgeHours: 2,
      dexId: 'raydium',
      marketCapUsd: null,
    });
  });

  it.each([
    ['429', async () => response({}, false, 429)],
    ['500', async () => response({}, false, 500)],
    ['invalid JSON', async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) as Response],
    [
      'timeout',
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
        }),
    ],
  ])('soft-fails on %s', async (_name, implementation) => {
    const fetchImpl = vi.fn(implementation);
    const result = await fetchMildDipStructuralFallback(
      mint,
      cfg({ structuralFallbackTimeoutMs: 1 }),
      nowMs,
      { fetchImpl },
    );
    expect(result).toBeNull();
  });

  it('soft-fails on zero price and turns invalid numeric fields into null', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [
          pool(mint, 'raydium', '10000', {
            base_token_price_usd: '0',
            volume_usd: { m5: '-1', h1: 'not-a-number' },
            transactions: { m5: { buys: '-2', sells: 'NaN' } },
            price_change_percentage: { m5: '-4', h1: 'bad' },
          }),
        ],
      }),
    );
    await expect(
      fetchMildDipStructuralFallback(mint, cfg(), nowMs, { fetchImpl }),
    ).resolves.toBeNull();
  });

  it('enforces the per-mint interval and token bucket without extra network calls', async () => {
    const fetchImpl = vi.fn(async () => response({ data: [pool(mint, 'raydium', '10000')] }));
    const limited = cfg({
      structuralFallbackMaxPerMin: 1,
      structuralFallbackCacheTtlMs: 0,
    });
    await fetchMildDipStructuralFallback(mint, limited, nowMs, { fetchImpl });
    await fetchMildDipStructuralFallback(mint, limited, nowMs + 1_000, { fetchImpl });
    await fetchMildDipStructuralFallback(otherMint, limited, nowMs + 1_000, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('loads fallback only after stale cache and keeps it out of the price ring', async () => {
    const fallback: StructuralFallbackSnapshot = {
      priceUsd: 2,
      volume5mUsd: 3000,
      liquidityUsd: 20_000,
      buys5m: 12,
      sells5m: 8,
      volume1hUsd: 30_000,
      priceChange5mPct: -5,
      priceChange1hPct: -2,
      pairAgeHours: 3,
      dexId: 'raydium',
      marketCapUsd: null,
    };
    const fetchDex = vi.fn(async () => null);
    const fetchFallback = vi.fn(async () => fallback);
    const loaded = await loadStructural(mint, cfg(), nowMs, true, {
      fetchDex,
      fetchFallback,
    });
    expect(loaded?.source).toBe('gecko');
    expect(fetchFallback).toHaveBeenCalledTimes(1);
    expect(getStructuralCache(mint, nowMs, 8_000)?.source).toBe('gecko');
    expect(mildDipPriceRing.lastPrice(mint, nowMs)).toBeNull();

    const cached = await loadStructural(mint, cfg(), nowMs + 1_000, true, {
      fetchDex,
      fetchFallback,
    });
    expect(cached?.source).toBe('gecko');
    expect(fetchFallback).toHaveBeenCalledTimes(1);
  });

  it('does not call fallback for fresh or stale cache, or when disallowed', async () => {
    const metrics = {
      priceChange5mPct: -5,
      priceChange1hPct: -2,
      volume5mUsd: 3000,
      liquidityUsd: 20_000,
      marketCapUsd: null,
      pairAgeHours: 3,
      dexId: 'raydium',
      buys5m: 12,
      sells5m: 8,
      volume1hUsd: 30_000,
    };
    noteStructuralCache(mint, 2, metrics, nowMs - 1_000, 'dex');
    const fetchDex = vi.fn(async () => null);
    const fetchFallback = vi.fn(async () => null);
    await loadStructural(mint, cfg(), nowMs, true, { fetchDex, fetchFallback });
    expect(fetchFallback).not.toHaveBeenCalled();

    resetFastPathStateForTests();
    const dexDetails = {
      priceUsd: 2,
      priceChangeM5Pct: -5,
      priceChangeH1Pct: -2,
      volume5mUsd: 3000,
      volume1hUsd: 30_000,
      liquidityUsd: 20_000,
      marketCapUsd: 100_000,
      pairCreatedAtMs: nowMs - 3 * 3_600_000,
      dexId: 'raydium',
      buys5m: 12,
      sells5m: 8,
    } as Awaited<ReturnType<NonNullable<Parameters<typeof loadStructural>[4]>['fetchDex']>>;
    const dexResult = await loadStructural(mint, cfg(), nowMs, true, {
      fetchDex: vi.fn(async () => dexDetails),
      fetchFallback,
    });
    expect(dexResult?.source).toBe('dex');
    expect(fetchFallback).not.toHaveBeenCalled();

    resetFastPathStateForTests();
    noteStructuralCache(mint, 2, metrics, nowMs - 20_000, 'dex');
    await loadStructural(mint, cfg(), nowMs, true, { fetchDex, fetchFallback });
    expect(fetchFallback).not.toHaveBeenCalled();

    resetFastPathStateForTests();
    await loadStructural(mint, cfg(), nowMs, false, { fetchDex, fetchFallback });
    expect(fetchFallback).not.toHaveBeenCalled();
  });
});
