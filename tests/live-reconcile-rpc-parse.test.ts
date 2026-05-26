import { describe, expect, it } from 'vitest';
import { parseTokenBalancesFromGetTokenAccountsByOwnerResult } from '../src/live/reconcile-live.js';

describe('getTokenAccountsByOwner RPC result shape', () => {
  const mint = 'CGEDT9QZDvvH5GmVkWJH2BXiMJqMJySC9ihWyr7Spump';
  const entry = {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: { amount: '95546597', decimals: 6 },
          },
        },
      },
    },
  };

  it('parses wrapped { context, value } (QuickNode / standard Solana RPC)', () => {
    const m = parseTokenBalancesFromGetTokenAccountsByOwnerResult({
      context: { slot: 1 },
      value: [entry],
    });
    expect(m.get(mint)).toBe(95546597n);
  });

  it('parses bare array', () => {
    const m = parseTokenBalancesFromGetTokenAccountsByOwnerResult([entry]);
    expect(m.get(mint)).toBe(95546597n);
  });

  it('returns empty map when value is not an array', () => {
    const m = parseTokenBalancesFromGetTokenAccountsByOwnerResult({
      context: { slot: 1 },
      value: null as unknown as unknown[],
    });
    expect(m.size).toBe(0);
  });
});
