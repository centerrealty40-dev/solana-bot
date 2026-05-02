import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  liveBuildUnsignedSwapTx,
  liveFetchBuyQuote,
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
});
