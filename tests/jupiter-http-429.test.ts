import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetJupiter429MonitorForTests } from '../src/core/jupiter-429-monitor.js';
import { notifyJupiterQuoteRateLimitExhausted } from '../src/core/telegram/jupiter-alerts.js';
import {
  fetchJupiterSwapQuoteGetJson,
  fetchJupiterSwapQuoteGetResult,
} from '../src/core/jupiter-http.js';

vi.mock('../src/core/telegram/jupiter-alerts.js', () => ({
  notifyJupiter429RateLimitBurst: vi.fn().mockResolvedValue(undefined),
  notifyJupiterQuoteRateLimitExhausted: vi.fn().mockResolvedValue(undefined),
}));

describe('fetchJupiterSwapQuoteGetJson', () => {
  const envBackup = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.JUPITER_QUOTE_429_MAX_RETRIES = '1';
    process.env.JUPITER_QUOTE_429_INITIAL_BACKOFF_MS = '1';
    process.env.JUPITER_GLOBAL_RATE_LIMIT = '0';
    resetJupiter429MonitorForTests();
    vi.mocked(notifyJupiterQuoteRateLimitExhausted).mockClear();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  it('retries once on HTTP 429 then returns quote JSON', async () => {
    let n = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n += 1;
      if (n < 2) {
        return {
          status: 429,
          ok: false,
          headers: { get: () => null as string | null },
          text: async () => '',
        } as Response;
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => null as string | null },
        json: async () => ({ inAmount: '1000000', outAmount: '500' }),
      } as Response;
    });

    const j = await fetchJupiterSwapQuoteGetJson({
      url: 'https://example.invalid/quote',
      timeoutMs: 5000,
    });
    expect(j).toMatchObject({ inAmount: '1000000', outAmount: '500' });
    expect(n).toBe(2);
  });

  it('with JUPITER_QUOTE_429_MAX_RETRIES=0 does not retry on 429', async () => {
    process.env.JUPITER_QUOTE_429_MAX_RETRIES = '0';
    let n = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n += 1;
      return {
        status: 429,
        ok: false,
        headers: { get: () => null as string | null },
        text: async () => '',
      } as Response;
    });

    const j = await fetchJupiterSwapQuoteGetJson({
      url: 'https://example.invalid/quote',
      timeoutMs: 5000,
    });
    expect(j).toBeNull();
    expect(n).toBe(1);
  });

  it('returns a distinct gate-skipped result for a busy background lane', async () => {
    const gateDir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp('/tmp/jup-http-gate-'),
    );
    process.env.JUPITER_GLOBAL_RATE_LIMIT = '1';
    process.env.JUPITER_GLOBAL_MAX_RPS = '1';
    process.env.JUPITER_GLOBAL_BACKGROUND_MAX_RPS = '1';
    process.env.JUPITER_BACKGROUND_MAX_WAIT_MS = '0';
    process.env.JUPITER_GLOBAL_GATE_PATH = `${gateDir}/gate.json`;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ outAmount: '1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const first = await fetchJupiterSwapQuoteGetResult({
      url: 'https://example.invalid/quote',
      timeoutMs: 5000,
      priority: 'background',
    });
    const second = await fetchJupiterSwapQuoteGetResult({
      url: 'https://example.invalid/quote',
      timeoutMs: 5000,
      priority: 'background',
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, gateSkipped: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not alert on exhausted background 429, but alerts execution exhaustion', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      status: 429,
      ok: false,
      headers: { get: () => null as string | null },
      text: async () => '',
    }) as Response);

    const background = await fetchJupiterSwapQuoteGetResult({
      url: 'https://example.invalid/quote',
      timeoutMs: 5000,
      priority: 'background',
    });
    expect(background).toMatchObject({ ok: false, status: 429 });
    expect(notifyJupiterQuoteRateLimitExhausted).not.toHaveBeenCalled();

    resetJupiter429MonitorForTests();
    process.env.JUPITER_QUOTE_429_MAX_RETRIES = '0';
    const execution = await fetchJupiterSwapQuoteGetResult({
      url: 'https://example.invalid/quote',
      timeoutMs: 5000,
      priority: 'execution',
    });
    expect(execution).toMatchObject({ ok: false, status: 429 });
    expect(notifyJupiterQuoteRateLimitExhausted).toHaveBeenCalledTimes(1);
  });
});
