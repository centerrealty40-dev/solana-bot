import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDexQuoteInProcessCacheForTests,
  fetchDexQuoteViaCache,
  getCachedDexQuote,
  putCachedDexQuotes,
  quoteCacheEnabled,
} from '../scripts-tmp/dexscreener-quote-cache.mjs';

describe('dexscreener-quote-cache', () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-quote-cache-'));
    cachePath = path.join(tmpDir, 'cache.json');
    process.env.DEX_QUOTE_CACHE_ENABLED = '1';
    process.env.DEX_QUOTE_CACHE_PATH = cachePath;
    process.env.DEX_QUOTE_CACHE_TTL_MS = '20000';
    process.env.DEXSCREENER_GLOBAL_RATE_LIMIT = '0';
    __resetDexQuoteInProcessCacheForTests();
  });

  afterEach(() => {
    delete process.env.DEX_QUOTE_CACHE_ENABLED;
    delete process.env.DEX_QUOTE_CACHE_PATH;
    delete process.env.DEX_QUOTE_CACHE_TTL_MS;
    delete process.env.DEXSCREENER_GLOBAL_RATE_LIMIT;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    __resetDexQuoteInProcessCacheForTests();
  });

  it('reads fresh entries from file cache', async () => {
    const nowMs = Date.now();
    await putCachedDexQuotes(
      {
        MintA: {
          miss: false,
          priceUsd: 0.01,
          marketCapUsd: 1_000_000,
          liquidityUsd: 50_000,
          volume5mUsd: 1000,
          volume1hUsd: 5000,
          fetchedAtMs: nowMs,
        },
      },
      nowMs,
    );
    const hit = getCachedDexQuote('MintA', nowMs);
    expect(hit.hit).toBe(true);
    expect(hit.entry?.priceUsd).toBe(0.01);
  });

  it('fetchDexQuoteViaCache uses cache on second call without HTTP', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: 'solana',
            baseToken: { address: 'MintB' },
            quoteToken: { address: 'So11111111111111111111111111111111111111112' },
            priceUsd: '0.002',
            marketCap: 800_000,
            liquidity: { usd: 40_000 },
            volume: { m5: 900 },
          },
        ],
      }),
    }));

    const snap1 = await fetchDexQuoteViaCache('MintB', { fetchImpl: fetchImpl as typeof fetch });
    expect(snap1?.priceUsd).toBe(0.002);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    __resetDexQuoteInProcessCacheForTests();
    const snap2 = await fetchDexQuoteViaCache('MintB', { fetchImpl: fetchImpl as typeof fetch });
    expect(snap2?.priceUsd).toBe(0.002);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('respects DEX_QUOTE_CACHE_ENABLED=0', () => {
    process.env.DEX_QUOTE_CACHE_ENABLED = '0';
    expect(quoteCacheEnabled()).toBe(false);
  });
});
