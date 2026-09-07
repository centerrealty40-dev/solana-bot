import { describe, expect, it, vi } from 'vitest';
import {
  mirrorBuyOnlyHoldingReadDecision,
} from '../../src/milddip/entry-attempt.js';
import { fetchWalletMintHoldingOrNull } from '../../src/copytrader/rpc.js';

describe('buy-only own holding decimals', () => {
  it('sums token accounts and takes the first valid decimals value', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          value: [
            {
              account: {
                data: {
                  parsed: {
                    info: {
                      tokenAmount: { amount: '12', decimals: -1 },
                    },
                  },
                },
              },
            },
            {
              account: {
                data: {
                  parsed: {
                    info: {
                      tokenAmount: { amount: '34', decimals: 9 },
                    },
                  },
                },
              },
            },
            {
              account: {
                data: {
                  parsed: {
                    info: {
                      tokenAmount: { amount: '56', decimals: 6 },
                    },
                  },
                },
              },
            },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWalletMintHoldingOrNull('https://rpc.example', 'wallet', 'mint'),
    ).resolves.toEqual({ raw: 102n, decimals: 9 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://rpc.example',
      expect.objectContaining({
        body: expect.stringContaining('getTokenAccountsByOwner'),
      }),
    );
    vi.unstubAllGlobals();
  });

  it('fails closed when a positive raw holding has unknown decimals', () => {
    expect(
      mirrorBuyOnlyHoldingReadDecision({
        holding: { raw: 13_609_234_815n, decimals: null },
        ringDecimals: null,
        priceUsd: 1,
        maxUsd: 100,
      }),
    ).toBe('own_holding_decimals_unknown');
  });

  it('fails closed when the holding RPC read is unavailable', () => {
    expect(
      mirrorBuyOnlyHoldingReadDecision({
        holding: null,
        ringDecimals: null,
        priceUsd: 1,
        maxUsd: 100,
      }),
    ).toBe('own_holding_unverified');
  });

  it('allows a zero balance even when decimals are unknown', () => {
    expect(
      mirrorBuyOnlyHoldingReadDecision({
        holding: { raw: 0n, decimals: null },
        ringDecimals: null,
        priceUsd: 1,
        maxUsd: 100,
      }),
    ).toBe('allow');
  });

  it('preserves the known-decimals $100 threshold and ring precedence', () => {
    expect(
      mirrorBuyOnlyHoldingReadDecision({
        holding: { raw: 100_000_000n, decimals: 9 },
        ringDecimals: 6,
        priceUsd: 1,
        maxUsd: 100,
      }),
    ).toBe('skip_own_holding');
    expect(
      mirrorBuyOnlyHoldingReadDecision({
        holding: { raw: 100_000_000n, decimals: 9 },
        ringDecimals: null,
        priceUsd: 1,
        maxUsd: 100,
      }),
    ).toBe('allow');
  });
});
