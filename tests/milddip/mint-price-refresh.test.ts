import { afterEach, describe, expect, it } from 'vitest';
import {
  priceUsdFromParsedSwapTx,
  resetMintPriceRefreshStatsForTests,
} from '../../src/milddip/mint-price-refresh.js';
import type { TxJsonParsed } from '../../src/parser/rpc-http.js';

afterEach(() => {
  resetMintPriceRefreshStatsForTests();
});

describe('priceUsdFromParsedSwapTx', () => {
  it('returns null for empty tx', () => {
    expect(priceUsdFromParsedSwapTx(null, 'EeB76LHyVZPMRvTpLcxJqqfSz4gg9f9XgsUmFybcpump', 150)).toBe(
      null,
    );
  });

  it('returns null when mint does not match swap base', () => {
    const mint = 'EeB76LHyVZPMRvTpLcxJqqfSz4gg9f9XgsUmFybcpump';
    const other = 'BJWHLm1111111111111111111111111111111111111';
    // Minimal failing shape — no allowlisted program → null
    const tx = {
      slot: 1,
      blockTime: 1_786_268_868,
      meta: { err: null, logMessages: [], preTokenBalances: [], postTokenBalances: [] },
      transaction: {
        signatures: ['5Zen3XwfYf7QAvfCTQebSAzisai1Y9uvxUqrdAEWtjpV52AmxdMZue2tHkaR38qKvUrqKCEJQ4sdsBEjrjjCT38c'],
        message: { accountKeys: [], instructions: [] },
      },
    } as unknown as TxJsonParsed;
    expect(priceUsdFromParsedSwapTx(tx, other, 150)).toBe(null);
    expect(priceUsdFromParsedSwapTx(tx, mint, 150)).toBe(null);
  });
});
