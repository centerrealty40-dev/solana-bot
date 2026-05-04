import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  liveBuildUnsignedSwapTx,
  liveFetchBuyQuote,
  liveJupiterSwapPostBody,
  liveQuoteExceedsMaxAge,
  liveQuoteSnapshotFromResponse,
  resolveLiveJupiterQuoteUrl,
  resolveLiveJupiterSwapUrl,
} from '../src/live/jupiter.js';

function baseCfg(over: Partial<LiveOscarConfig> = {}): LiveOscarConfig {
  return {
    strategyEnabled: false,
    executionMode: 'dry_run',
    profile: 'oscar',
    liveTradesPath: '/tmp/x.jsonl',
    strategyId: 'live-oscar',
    heartbeatIntervalMs: 60_000,
    liveJupiterQuoteTimeoutMs: 5000,
    liveJupiterSwapTimeoutMs: 8000,
    liveDefaultSlippageBps: 400,
    liveSimEnabled: true,
    liveSimTimeoutMs: 12_000,
    liveSimCreditsPerCall: 30,
    liveSimReplaceRecentBlockhash: true,
    liveSimSigVerify: false,
    liveJupiterSwapPriorityLevel: 'medium',
    ...over,
  } as LiveOscarConfig;
}

describe('live Jupiter Phase 2', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveLiveJupiterQuoteUrl uses default', () => {
    expect(resolveLiveJupiterQuoteUrl(baseCfg())).toContain('lite-api.jup.ag');
    expect(resolveLiveJupiterSwapUrl(baseCfg())).toContain('/swap/v1/swap');
  });

  it('resolveLiveJupiterQuoteUrl respects override', () => {
    expect(resolveLiveJupiterQuoteUrl(baseCfg({ liveJupiterQuoteUrl: 'https://example.com/q' }))).toBe(
      'https://example.com/q',
    );
  });

  it('liveQuoteSnapshotFromResponse builds §5 shape', () => {
    const q = {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      inAmount: '1500000',
      outAmount: '999000000000',
      priceImpactPct: '0.01',
      routePlan: [{}, {}],
    };
    const s = liveQuoteSnapshotFromResponse(q, {
      slippageBps: 400,
      quoteAgeMs: 42,
      swapBuildOk: true,
      swapTxBase64Len: 120,
    });
    expect(s.provider).toBe('jupiter');
    expect(s.routeHops).toBe(2);
    expect(s.slippageBps).toBe(400);
    expect(s.quoteAgeMs).toBe(42);
    expect(s.swapBuildOk).toBe(true);
    expect(s.swapTxBase64Len).toBe(120);
    expect(s.quoteInAmount).toBe('1500000');
    expect(s.quoteOutAmount).toBe('999000000000');
  });

  it('liveQuoteExceedsMaxAge is off when max unset', () => {
    expect(liveQuoteExceedsMaxAge({ quoteAgeMs: 999_999 }, undefined)).toBe(false);
    expect(liveQuoteExceedsMaxAge({ quoteAgeMs: 999_999 }, 0)).toBe(false);
  });

  it('liveQuoteExceedsMaxAge rejects stale or bad ages', () => {
    expect(liveQuoteExceedsMaxAge({ quoteAgeMs: 99 }, 100)).toBe(false);
    expect(liveQuoteExceedsMaxAge({ quoteAgeMs: 100 }, 100)).toBe(false);
    expect(liveQuoteExceedsMaxAge({ quoteAgeMs: 100 }, 99)).toBe(true);
    expect(liveQuoteExceedsMaxAge({ quoteAgeMs: 101 }, 100)).toBe(true);
    expect(liveQuoteExceedsMaxAge({}, 500)).toBe(true);
    expect(liveQuoteExceedsMaxAge({ quoteAgeMs: '40' }, 50)).toBe(true);
  });

  it('liveFetchBuyQuote parses GET quote', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'OutMint',
          priceImpactPct: '0.02',
          routePlan: [{}],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const r = await liveFetchBuyQuote({
      cfg: baseCfg(),
      outputMint: 'OutMint',
      sizeUsd: 10,
      solUsd: 200,
    });
    expect(r).not.toBeNull();
    expect(r!.quoteResponse.outputMint).toBe('OutMint');
    expect(r!.quoteSnapshot.provider).toBe('jupiter');
    expect(r!.quoteSnapshot.routeHops).toBe(1);
  });

  it('liveBuildUnsignedSwapTx parses swap tx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ swapTransaction: 'QUJD' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const r = await liveBuildUnsignedSwapTx({
      cfg: baseCfg(),
      quoteResponse: { routePlan: [] },
      userPublicKey: '11111111111111111111111111111111',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.b64).toBe('QUJD');
  });

  it('liveJupiterSwapPostBody adds prioritizationFeeLamports when max lamports set', () => {
    const body = liveJupiterSwapPostBody({
      cfg: baseCfg({ liveJupiterPriorityMaxLamports: 100_000, liveJupiterSwapPriorityLevel: 'medium' }),
      quoteResponse: { routePlan: [] },
      userPublicKey: '11111111111111111111111111111111',
    });
    expect(body.prioritizationFeeLamports).toEqual({
      priorityLevelWithMaxLamports: { priorityLevel: 'medium', maxLamports: 100_000 },
    });
  });

  it('liveBuildUnsignedSwapTx POST includes Jupiter priority cap', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ swapTransaction: 'QUJD' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await liveBuildUnsignedSwapTx({
      cfg: baseCfg({ liveJupiterPriorityMaxLamports: 100_000 }),
      quoteResponse: { routePlan: [] },
      userPublicKey: '11111111111111111111111111111111',
    });

    const posted = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(posted.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports).toBe(100_000);
  });
});
