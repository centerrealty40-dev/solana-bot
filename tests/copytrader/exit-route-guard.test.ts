import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveProbeSellRoute } from '../../src/live/jupiter.js';
import {
  clearExitRouteMissing,
  exitRouteGuardResetForTests,
  isExitRouteMissingCached,
  markExitRouteMissing,
} from '../../src/copytrader/exit-route-guard.js';

describe('exit-route-guard', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.JUPITER_QUOTE_429_MAX_RETRIES = '0';
    process.env.JUPITER_GLOBAL_RATE_LIMIT = '0';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    exitRouteGuardResetForTests();
    vi.restoreAllMocks();
  });

  it('caches a missing route until the TTL expires', () => {
    markExitRouteMissing('mint', 1_000);
    expect(isExitRouteMissingCached('mint', 1_001, 600_000)).toBe(true);
    expect(isExitRouteMissingCached('mint', 601_000, 600_000)).toBe(false);
  });

  it('clears a cached missing route', () => {
    markExitRouteMissing('mint', 1_000);
    clearExitRouteMissing('mint');
    expect(isExitRouteMissingCached('mint', 1_001, 600_000)).toBe(false);
  });

  it('resets all cached missing routes', () => {
    markExitRouteMissing('mint-a', 1_000);
    markExitRouteMissing('mint-b', 1_000);
    exitRouteGuardResetForTests();
    expect(isExitRouteMissingCached('mint-a', 1_001, 600_000)).toBe(false);
    expect(isExitRouteMissingCached('mint-b', 1_001, 600_000)).toBe(false);
  });

  it('maps sell-route probe responses and leaves unknown responses uncached', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected fetch');
    });
    const cfg = {
      liveJupiterQuoteUrl: 'https://example.invalid/quote',
      liveJupiterQuoteTimeoutMs: 5000,
      liveDefaultSlippageBps: 400,
    } as Parameters<typeof liveProbeSellRoute>[0]['cfg'];

    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ outAmount: '1' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errorCode: 'no_routes_found' }), { status: 400 }),
      )
      .mockResolvedValueOnce(new Response('busy', { status: 429 }));

    expect(
      await liveProbeSellRoute({
        cfg,
        inputMint: 'mint',
        tokenAmountRaw: '100',
        outputMintOverride: 'USDC',
      }),
    ).toBe('routable');
    expect(
      await liveProbeSellRoute({
        cfg,
        inputMint: 'mint',
        tokenAmountRaw: '100',
        outputMintOverride: 'USDC',
      }),
    ).toBe('no_route');
    expect(
      await liveProbeSellRoute({
        cfg,
        inputMint: 'mint',
        tokenAmountRaw: '100',
        outputMintOverride: 'USDC',
      }),
    ).toBe('unknown');
    expect(isExitRouteMissingCached('mint', Date.now(), 600_000)).toBe(false);
  });
});
