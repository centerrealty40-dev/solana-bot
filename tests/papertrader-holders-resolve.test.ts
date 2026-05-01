import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

vi.mock('../src/core/rpc/qn-client.js', () => ({
  qnCall: vi.fn(),
  qnBatchCall: vi.fn(),
}));

vi.mock('../src/core/db/client.js', () => ({
  db: { execute: vi.fn(async () => undefined) },
}));

import { qnCall, qnBatchCall } from '../src/core/rpc/qn-client.js';
import {
  resolveHolderCount,
  parseOwnerAmountSlice,
  getHoldersResolveStats,
  _resetHoldersResolverForTests,
} from '../src/papertrader/holders/holders-resolve.js';

const mockBatch = vi.mocked(qnBatchCall);
const mockCall = vi.mocked(qnCall);

const cfgBase = {
  holdersLiveEnabled: true,
  holdersUseQnAddon: false,
  holdersTtlMs: 90_000,
  holdersNegTtlMs: 15_000,
  holdersMaxPerTick: 10,
  holdersTimeoutMs: 4000,
  holdersIncludeToken2022: true,
  holdersExcludeOwners: [] as string[],
  holdersOnFail: 'db_fallback' as const,
  holdersDbWriteback: false,
  holdersGpaCreditsPerCall: 100,
};

function makeAccountSlice(ownerB58: string, amount: bigint): string {
  const ownerBuf = new PublicKey(ownerB58).toBuffer();
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  return Buffer.concat([ownerBuf, amountBuf]).toString('base64');
}

function gpaItem(b64: string, pubkey = 'PubkEyAddrXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'): {
  pubkey: string;
  account: { data: [string, string] };
} {
  return { pubkey, account: { data: [b64, 'base64'] } };
}

beforeEach(() => {
  mockBatch.mockReset();
  mockCall.mockReset();
  _resetHoldersResolverForTests();
});
afterEach(() => {
  mockBatch.mockReset();
  mockCall.mockReset();
  _resetHoldersResolverForTests();
});

describe('parseOwnerAmountSlice', () => {
  it('decodes owner and detects non-zero amount', () => {
    const b64 = makeAccountSlice('11111111111111111111111111111111', 42n);
    const out = parseOwnerAmountSlice(b64);
    expect(out).not.toBeNull();
    expect(out!.hasBalance).toBe(true);
  });

  it('detects zero amount', () => {
    const b64 = makeAccountSlice('11111111111111111111111111111111', 0n);
    const out = parseOwnerAmountSlice(b64);
    expect(out).not.toBeNull();
    expect(out!.hasBalance).toBe(false);
  });

  it('returns null on too-short payload', () => {
    expect(parseOwnerAmountSlice(Buffer.from([1, 2, 3]).toString('base64'))).toBeNull();
  });
});

describe('resolveHolderCount via GPA', () => {
  it('counts unique owners with non-zero balance, dedup across Token + Token-2022', async () => {
    const owner1 = '11111111111111111111111111111112';
    const owner2 = '11111111111111111111111111111113';
    const owner3 = '11111111111111111111111111111114';
    mockBatch.mockResolvedValue({
      ok: true,
      value: [
        [
          gpaItem(makeAccountSlice(owner1, 100n)),
          gpaItem(makeAccountSlice(owner2, 50n)),
          gpaItem(makeAccountSlice(owner1, 0n)),
        ],
        [gpaItem(makeAccountSlice(owner3, 1n)), gpaItem(makeAccountSlice(owner2, 999n))],
      ],
    });
    const r = await resolveHolderCount(cfgBase as never, 'mintTest');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(3);
      expect(r.source).toBe('qn_gpa');
      expect(r.fromCache).toBe(false);
    }
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });

  it('honors EXCLUDE_OWNERS', async () => {
    const ownerVault = '11111111111111111111111111111115';
    const ownerHuman = '11111111111111111111111111111116';
    mockBatch.mockResolvedValue({
      ok: true,
      value: [
        [gpaItem(makeAccountSlice(ownerVault, 9999n)), gpaItem(makeAccountSlice(ownerHuman, 1n))],
        [],
      ],
    });
    const cfg = { ...cfgBase, holdersExcludeOwners: [ownerVault] };
    const r = await resolveHolderCount(cfg as never, 'mintExcl');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.count).toBe(1);
  });

  it('positive cache hit returns immediately on second call', async () => {
    const owner1 = '11111111111111111111111111111117';
    mockBatch.mockResolvedValue({
      ok: true,
      value: [[gpaItem(makeAccountSlice(owner1, 1n))], []],
    });
    const a = await resolveHolderCount(cfgBase as never, 'mintCache');
    const b = await resolveHolderCount(cfgBase as never, 'mintCache');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.source).toBe('qn_gpa');
      expect(b.source).toBe('cache_pos');
      expect(b.fromCache).toBe(true);
    }
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });

  it('singleflight: concurrent calls for same mint coalesce into one RPC', async () => {
    const owner1 = '11111111111111111111111111111118';
    let resolveBatch: (v: unknown) => void = () => {};
    const pending = new Promise((res) => {
      resolveBatch = res;
    });
    mockBatch.mockImplementation(() => pending as never);
    const p1 = resolveHolderCount(cfgBase as never, 'mintSF');
    const p2 = resolveHolderCount(cfgBase as never, 'mintSF');
    resolveBatch({
      ok: true,
      value: [[gpaItem(makeAccountSlice(owner1, 1n))], []],
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });

  it('falls through with negative cache on QN budget error', async () => {
    mockBatch.mockResolvedValue({ ok: false, reason: 'budget' });
    const r = await resolveHolderCount(cfgBase as never, 'mintBudget');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('budget');
    const r2 = await resolveHolderCount(cfgBase as never, 'mintBudget');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.fromCache).toBe(true);
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });
});

describe('resolveHolderCount with addon enabled', () => {
  it('addon ok short-circuits GPA', async () => {
    mockCall.mockResolvedValue({ ok: true, value: { total: 4321 } });
    const cfg = { ...cfgBase, holdersUseQnAddon: true };
    const r = await resolveHolderCount(cfg as never, 'mintAddon');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(4321);
      expect(r.source).toBe('qn_addon');
    }
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('addon unsupported triggers GPA fallback', async () => {
    mockCall.mockResolvedValue({
      ok: false,
      reason: 'rpc_error',
      message: 'Method not enabled on this endpoint',
    });
    const owner1 = '11111111111111111111111111111119';
    mockBatch.mockResolvedValue({
      ok: true,
      value: [[gpaItem(makeAccountSlice(owner1, 1n))], []],
    });
    const cfg = { ...cfgBase, holdersUseQnAddon: true };
    const r = await resolveHolderCount(cfg as never, 'mintAddonFb');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe('qn_gpa');
      expect(r.count).toBe(1);
    }
  });
});

describe('stats counters', () => {
  it('increments ok / fromGpa on success', async () => {
    const owner1 = '1111111111111111111111111111111A';
    mockBatch.mockResolvedValue({
      ok: true,
      value: [[gpaItem(makeAccountSlice(owner1, 1n))], []],
    });
    await resolveHolderCount(cfgBase as never, 'mintStats1');
    const s = getHoldersResolveStats();
    expect(s.ok).toBe(1);
    expect(s.fromGpa).toBe(1);
  });

  it('increments fromCache on cached hit', async () => {
    const owner1 = '1111111111111111111111111111111B';
    mockBatch.mockResolvedValue({
      ok: true,
      value: [[gpaItem(makeAccountSlice(owner1, 1n))], []],
    });
    await resolveHolderCount(cfgBase as never, 'mintStats2');
    await resolveHolderCount(cfgBase as never, 'mintStats2');
    const s = getHoldersResolveStats();
    expect(s.ok).toBe(2);
    expect(s.fromCache).toBe(1);
    expect(s.fromGpa).toBe(1);
  });
});
