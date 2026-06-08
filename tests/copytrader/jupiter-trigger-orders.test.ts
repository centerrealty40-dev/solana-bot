import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaderHasActiveJupiterSellOrders } from '../../src/copytrader/jupiter-trigger-orders.js';

const WALLET = 'LeaderWallet1111111111111111111111111111';
const MINT = 'MintGO111111111111111111111111111111111111';

describe('leaderHasActiveJupiterSellOrders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects active sell order with remaining input amount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          orders: [
            {
              inputMint: MINT,
              rawRemainingMakingAmount: '4656506638142',
              outputMint: 'So11111111111111111111111111111111111111112',
            },
          ],
          totalPages: 1,
          page: 1,
        }),
      })),
    );

    const r = await leaderHasActiveJupiterSellOrders(WALLET, MINT);
    expect(r.active).toBe(true);
    expect(r.orderCount).toBe(1);
    expect(r.totalRemainingRaw).toBe('4656506638142');
    expect(r.source).toBe('pro');
  });

  it('returns inactive when orders list is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ orders: [], totalPages: 0, page: 1, totalItems: 0 }),
      })),
    );

    const r = await leaderHasActiveJupiterSellOrders(WALLET, MINT);
    expect(r.active).toBe(false);
    expect(r.orderCount).toBe(0);
  });
});
