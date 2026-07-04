import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBirdeyeCollectorCacheForTests,
  enrichCollectorRowsWithBirdeye,
} from '../scripts-tmp/birdeye-collector-enrich.mjs';

describe('enrichCollectorRowsWithBirdeye', () => {
  afterEach(() => {
    __resetBirdeyeCollectorCacheForTests();
    delete process.env.BIRDEYE_API_KEY;
    delete process.env.BIRDEYE_COLLECTOR_ENABLED;
    vi.restoreAllMocks();
  });

  it('returns rows unchanged when collector disabled', async () => {
    const rows = [{ base_mint: 'Mint1', price_usd: 1 }];
    const res = await enrichCollectorRowsWithBirdeye({
      rows,
      bucketTs: new Date(),
      sourceTag: 'pumpswap',
      fetchImpl: fetch,
      fetchJsonWithRetry: vi.fn(),
      normalizeDexPair: () => null,
      dedupByPairAddress: (r: unknown[]) => r,
    });
    expect(res.rows).toBe(rows);
    expect(res.stats).toBeNull();
  });

  it('overlays birdeye price on existing open-mint row', async () => {
    process.env.BIRDEYE_API_KEY = 'k';
    process.env.BIRDEYE_COLLECTOR_ENABLED = '1';
    vi.spyOn(
      await import('../scripts-tmp/paper2-open-snapshot-enrich.mjs'),
      'loadPaper2OpenMintsSync',
    ).mockReturnValue(['MintOpen1111111111111111111111111111111111']);
    vi.spyOn(
      await import('../scripts-tmp/paper2-open-snapshot-enrich.mjs'),
      'loadLiveOscarOpenMintsSync',
    ).mockReturnValue([]);
    vi.spyOn(
      await import('../scripts-tmp/paper2-open-snapshot-enrich.mjs'),
      'loadLiveOscarWhitelistMintsSync',
    ).mockReturnValue([]);
    vi.spyOn(
      await import('../scripts-tmp/paper2-open-snapshot-enrich.mjs'),
      'loadDiscoveryCollectorPinMintsSync',
    ).mockReturnValue([]);

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          data: { price: 0.99, market_cap: 900_000, liquidity: 40_000 },
        }),
    }));

    const rows = [
      {
        base_mint: 'MintOpen1111111111111111111111111111111111',
        pair_address: 'pair1',
        price_usd: 0.5,
        market_cap_usd: 100_000,
      },
    ];

    const res = await enrichCollectorRowsWithBirdeye({
      rows,
      bucketTs: new Date(),
      sourceTag: 'pumpswap',
      fetchImpl,
      fetchJsonWithRetry: vi.fn(),
      normalizeDexPair: () => null,
      dedupByPairAddress: (r: unknown[]) => r,
    });

    expect(res.stats?.overlayUpdated).toBe(1);
    expect(res.stats?.changed).toBe(true);
    expect(res.rows[0].price_usd).toBe(0.99);
    expect(res.rows[0].market_cap_usd).toBe(900_000);
  });
});
