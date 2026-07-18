import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJupiterSwapQuoteGetJson } from '../src/core/jupiter-http.js';

describe('fetchJupiterSwapQuoteGetJson', () => {
  const envBackup = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.JUPITER_QUOTE_429_MAX_RETRIES = '1';
    process.env.JUPITER_QUOTE_429_INITIAL_BACKOFF_MS = '1';
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
});
