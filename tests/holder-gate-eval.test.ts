import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/rpc/qn-client.js', () => ({
  qnCall: vi.fn(),
  qnBatchCall: vi.fn(),
}));

vi.mock('../src/papertrader/holders/shyft-holder-resolve.js', () => ({
  resolveShyftHolderCount: vi.fn(),
}));

import { qnBatchCall } from '../src/core/rpc/qn-client.js';
import { evaluateHolderGate } from '../src/papertrader/holders/holder-gate-eval.js';
import { resolveShyftHolderCount } from '../src/papertrader/holders/shyft-holder-resolve.js';
import { _resetHoldersResolverForTests } from '../src/papertrader/holders/holders-resolve.js';

const mockBatch = vi.mocked(qnBatchCall);
const mockShyft = vi.mocked(resolveShyftHolderCount);

const cfgBase = {
  holdersLiveEnabled: true,
  holdersUseQnAddon: false,
  holdersTtlMs: 90_000,
  holdersNegTtlMs: 15_000,
  holdersMaxPerTick: 8,
  holdersTimeoutMs: 4000,
  holdersIncludeToken2022: true,
  holdersExcludeOwners: [] as string[],
  holdersOnFail: 'block' as const,
  holdersDbWriteback: false,
  holdersGpaCreditsPerCall: 100,
  globalMinHolderCount: 3000,
  shyftHoldersEnabled: true,
  shyftHoldersTtlMs: 90_000,
  shyftHoldersTimeoutMs: 4000,
};

afterEach(() => {
  mockBatch.mockReset();
  mockShyft.mockReset();
  _resetHoldersResolverForTests();
});

describe('evaluateHolderGate', () => {
  it('blocks with telegram flag when QN and Shyft both fail', async () => {
    mockBatch.mockResolvedValueOnce({ ok: false, reason: 'timeout', message: 't/o' });
    mockShyft.mockResolvedValueOnce({ ok: false, reason: 'http' });

    const r = await evaluateHolderGate({
      cfg: cfgBase as never,
      mint: 'MintA',
      dbHolders: 0,
      cheapPass: true,
      liveHoldersForObservability: true,
      liveHoldersForGate: true,
      liveHoldersThisTick: 0,
    });

    expect(r.holderReasons).toEqual(['holders_unknown:timeout+shyft_http']);
    expect(r.holdersMeta?.holders_unknown_after_cheap_pass).toBe(true);
    expect(r.holdersMeta?.holders_live).toBeNull();
  });

  it('uses Shyft fallback when QN fails', async () => {
    mockBatch.mockResolvedValueOnce({ ok: false, reason: 'rpc_error', message: 'err' });
    mockShyft.mockResolvedValueOnce({ ok: true, count: 4500, fromCache: false });

    const r = await evaluateHolderGate({
      cfg: cfgBase as never,
      mint: 'MintB',
      dbHolders: 100,
      cheapPass: true,
      liveHoldersForObservability: true,
      liveHoldersForGate: true,
      liveHoldersThisTick: 0,
    });

    expect(r.holderReasons).toEqual([]);
    expect(r.holdersMeta?.holders_source).toBe('shyft');
    expect(r.holdersMeta?.holders_live).toBe(4500);
  });

  it('blocks when holder count below minimum', async () => {
    mockBatch.mockResolvedValueOnce({
      ok: true,
      value: [],
    });
    // GPA empty owners → count 0
    const r = await evaluateHolderGate({
      cfg: cfgBase as never,
      mint: 'MintC',
      dbHolders: 5000,
      cheapPass: true,
      liveHoldersForObservability: true,
      liveHoldersForGate: true,
      liveHoldersThisTick: 0,
    });

    expect(r.holderReasons).toContain('holders<3000');
  });

  it('uses Shyft when per-tick QN budget is exhausted', async () => {
    mockShyft.mockResolvedValueOnce({ ok: true, count: 8000, fromCache: false });

    const r = await evaluateHolderGate({
      cfg: cfgBase as never,
      mint: 'MintD',
      dbHolders: 0,
      cheapPass: true,
      liveHoldersForObservability: true,
      liveHoldersForGate: true,
      liveHoldersThisTick: 8,
    });

    expect(mockBatch).not.toHaveBeenCalled();
    expect(r.holdersMeta?.holders_source).toBe('shyft');
    expect(r.holderReasons).toEqual([]);
  });
});
