import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetShyftDefiMcapCacheForTests,
  parseShyftDefiPools,
  resolveShyftDefiMcap,
} from '../src/papertrader/stream/shyft-defi-mcap.js';

afterEach(() => {
  __resetShyftDefiMcapCacheForTests();
  vi.restoreAllMocks();
});

function fakeRes(ok: boolean, body: unknown): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: async () => body };
}

describe('parseShyftDefiPools', () => {
  it('reads mcap/liq from a {result:{pools:[...]}} envelope', () => {
    const json = {
      success: true,
      result: { pools: [{ marketCap: 125000, liquidity: 42000, dex: 'pumpFunAmm' }] },
    };
    expect(parseShyftDefiPools(json)).toEqual({ mcapUsd: 125000, liqUsd: 42000 });
  });

  it('picks the best positive reading across multiple pools and field aliases', () => {
    const json = {
      result: [
        { market_cap_usd: '90000', liquidity_usd: '10000' },
        { fdv: 130000, tvl: 55000 },
      ],
    };
    expect(parseShyftDefiPools(json)).toEqual({ mcapUsd: 130000, liqUsd: 55000 });
  });

  it('returns null when nothing positive can be read', () => {
    expect(parseShyftDefiPools({ result: { pools: [{ foo: 'bar', marketCap: 0 }] } })).toBeNull();
    expect(parseShyftDefiPools(null)).toBeNull();
    expect(parseShyftDefiPools({})).toBeNull();
  });
});

describe('resolveShyftDefiMcap — fallback + TTL cache', () => {
  it('returns null (fallback) when no API key is available', async () => {
    const fetchImpl = vi.fn();
    const r = await resolveShyftDefiMcap('Mint1', {
      ttlMs: 10_000,
      apiKey: '',
      fetchImpl: fetchImpl as never,
    });
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches and parses on success', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeRes(true, { result: { pools: [{ marketCap: 200000, liquidity: 30000 }] } }),
    );
    const r = await resolveShyftDefiMcap('Mint2', {
      ttlMs: 10_000,
      apiKey: 'k',
      fetchImpl: fetchImpl as never,
      nowMs: 1_000,
    });
    expect(r).toEqual({ mcapUsd: 200000, liqUsd: 30000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves a cached value within TTL (single network call)', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeRes(true, { result: { pools: [{ marketCap: 200000 }] } }),
    );
    const opts = { ttlMs: 10_000, apiKey: 'k', fetchImpl: fetchImpl as never };
    const a = await resolveShyftDefiMcap('Mint3', { ...opts, nowMs: 1_000 });
    const b = await resolveShyftDefiMcap('Mint3', { ...opts, nowMs: 5_000 });
    expect(a).toEqual({ mcapUsd: 200000, liqUsd: null });
    expect(b).toEqual({ mcapUsd: 200000, liqUsd: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeRes(true, { result: { pools: [{ marketCap: 200000 }] } }),
    );
    const opts = { ttlMs: 10_000, apiKey: 'k', fetchImpl: fetchImpl as never };
    await resolveShyftDefiMcap('Mint4', { ...opts, nowMs: 1_000 });
    await resolveShyftDefiMcap('Mint4', { ...opts, nowMs: 20_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to null on a non-200 response (and caches the miss)', async () => {
    const fetchImpl = vi.fn(async () => fakeRes(false, {}));
    const opts = { ttlMs: 10_000, apiKey: 'k', fetchImpl: fetchImpl as never };
    const a = await resolveShyftDefiMcap('Mint5', { ...opts, nowMs: 1_000 });
    const b = await resolveShyftDefiMcap('Mint5', { ...opts, nowMs: 2_000 });
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to null when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const r = await resolveShyftDefiMcap('Mint6', {
      ttlMs: 10_000,
      apiKey: 'k',
      fetchImpl: fetchImpl as never,
      nowMs: 1_000,
    });
    expect(r).toBeNull();
  });
});
