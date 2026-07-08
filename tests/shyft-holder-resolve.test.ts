import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetShyftHolderCacheForTests,
  parseShyftHolderTotal,
  resolveShyftHolderCount,
} from '../src/papertrader/holders/shyft-holder-resolve.js';

afterEach(() => {
  __resetShyftHolderCacheForTests();
  vi.restoreAllMocks();
});

describe('parseShyftHolderTotal', () => {
  it('reads total from a {result:{total:N}} envelope', () => {
    expect(parseShyftHolderTotal({ success: true, result: { total: 4521 } })).toBe(4521);
  });

  it('reads holder_count alias', () => {
    expect(parseShyftHolderTotal({ data: { holder_count: '3100' } })).toBe(3100);
  });

  it('returns null when no positive total can be read', () => {
    expect(parseShyftHolderTotal({ result: { owners: [] } })).toBeNull();
    expect(parseShyftHolderTotal(null)).toBeNull();
  });
});

describe('resolveShyftHolderCount', () => {
  it('returns no_key when API key is missing', async () => {
    const fetchImpl = vi.fn();
    const r = await resolveShyftHolderCount('Mint1', {
      ttlMs: 10_000,
      apiKey: '',
      fetchImpl: fetchImpl as never,
    });
    expect(r).toEqual({ ok: false, reason: 'no_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns count on HTTP 200 with total field', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { total: 5000 } }),
    }));
    const r = await resolveShyftHolderCount('Mint2', {
      ttlMs: 10_000,
      apiKey: 'test-key',
      fetchImpl: fetchImpl as never,
    });
    expect(r).toEqual({ ok: true, count: 5000, fromCache: false });
  });

  it('uses TTL cache on second call', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { total: 4200 } }),
    }));
    const opts = { ttlMs: 60_000, apiKey: 'k', fetchImpl: fetchImpl as never, nowMs: 1_000 };
    await resolveShyftHolderCount('Mint3', opts);
    const r2 = await resolveShyftHolderCount('Mint3', { ...opts, nowMs: 2_000 });
    expect(r2).toEqual({ ok: true, count: 4200, fromCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
