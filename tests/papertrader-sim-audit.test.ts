import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { runOpenSimAudit } from '../src/papertrader/pricing/sim-audit.js';
import { qnCall } from '../src/core/rpc/qn-client.js';

vi.mock('../src/core/rpc/qn-client.js', () => ({
  qnCall: vi.fn(),
}));

const mintFoo = 'FoooooofakeMint11111111111111111111111111111';

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    strategyId: 'pt-test',
    simAuditEnabled: true,
    simSamplePct: 100,
    simMaxWallMs: 8000,
    simBuildTimeoutMs: 5000,
    simUseJupiterBuild: true,
    simCredsPerCall: 30,
    simStrictBudget: true,
    positionUsd: 100,
    entryFirstLegFraction: 1,
    priceVerifyMaxSlipBps: 400,
    ...over,
  } as PaperTraderConfig;
}

function mockJupiterChain() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.includes('/swap/v1/quote')) {
      return new Response(
        JSON.stringify({ outAmount: '1000000000000', priceImpactPct: '0.01', routePlan: [{}] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/swap/v1/swap')) {
      return new Response(JSON.stringify({ swapTransaction: 'AA==' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.mocked(qnCall).mockReset();
});

describe('runOpenSimAudit (W7.8)', () => {
  it('returns null when audit disabled (omit jsonl field)', async () => {
    const r = await runOpenSimAudit({
      cfg: baseCfg({ simAuditEnabled: false }),
      mint: mintFoo,
      entryTs: 1,
      solUsd: 200,
    });
    expect(r).toBeNull();
    expect(qnCall).not.toHaveBeenCalled();
  });

  it('returns null when sample pct is 0', async () => {
    const r = await runOpenSimAudit({
      cfg: baseCfg({ simSamplePct: 0 }),
      mint: mintFoo,
      entryTs: 1,
      solUsd: 200,
    });
    expect(r).toBeNull();
  });

  it('stamps ok when Jupiter + simulate succeed', async () => {
    mockJupiterChain();
    vi.mocked(qnCall).mockResolvedValue({
      ok: true,
      value: { context: { slot: 1 }, value: { err: null, unitsConsumed: 42_000 } },
    });
    const r = await runOpenSimAudit({
      cfg: baseCfg(),
      mint: mintFoo,
      entryTs: 1,
      solUsd: 200,
    });
    expect(r?.kind).toBe('ok');
    if (r?.kind === 'ok') {
      expect(r.buildKind).toBe('jupiter');
      expect(r.unitsConsumed).toBe(42_000);
      expect(r.err).toBeNull();
      expect(r.qnCredits).toBe(30);
    }
    expect(vi.mocked(qnCall).mock.calls[0]?.[0]).toBe('simulateTransaction');
    expect(vi.mocked(qnCall).mock.calls[0]?.[2]).toMatchObject({ feature: 'sim', creditsPerCall: 30 });
  });

  it('stamps err when simulate returns on-chain error', async () => {
    mockJupiterChain();
    vi.mocked(qnCall).mockResolvedValue({
      ok: true,
      value: { value: { err: 'InstructionError', unitsConsumed: 12_000, logs: ['foo'] } },
    });
    const r = await runOpenSimAudit({
      cfg: baseCfg(),
      mint: mintFoo,
      entryTs: 1,
      solUsd: 200,
    });
    expect(r?.kind).toBe('err');
    if (r?.kind === 'err') {
      expect(r.err?.message).toContain('InstructionError');
      expect(r.buildKind).toBe('jupiter');
    }
  });

  it('maps qnCall budget to skipped qn_budget', async () => {
    mockJupiterChain();
    vi.mocked(qnCall).mockResolvedValue({ ok: false, reason: 'budget' });
    const r = await runOpenSimAudit({
      cfg: baseCfg(),
      mint: mintFoo,
      entryTs: 1,
      solUsd: 200,
    });
    expect(r?.kind).toBe('skipped');
    if (r?.kind === 'skipped') expect(r.reason).toBe('qn_budget');
  });

  it('maps qnCall rpc_error to skipped qn_rpc_error', async () => {
    mockJupiterChain();
    vi.mocked(qnCall).mockResolvedValue({ ok: false, reason: 'rpc_error', message: 'boom' });
    const r = await runOpenSimAudit({
      cfg: baseCfg(),
      mint: mintFoo,
      entryTs: 1,
      solUsd: 200,
    });
    expect(r?.kind).toBe('skipped');
    if (r?.kind === 'skipped') expect(r.reason).toBe('qn_rpc_error');
  });
});
