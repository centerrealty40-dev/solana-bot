import { describe, expect, it } from 'vitest';
import { normalizeHeliusSwap, type HeliusEnhancedTx } from '../src/collectors/normalizer.js';
import { QUOTE_MINTS } from '../src/core/constants.js';

describe('normalizeHeliusSwap', () => {
  it('returns empty when no swap event', () => {
    const tx: HeliusEnhancedTx = {
      signature: 's',
      slot: 1,
      timestamp: 1000,
    };
    expect(normalizeHeliusSwap(tx, {})).toEqual([]);
  });

  it('parses a SOL -> token buy', () => {
    const wallet = 'WALLET1';
    const tokenMint = 'TOK1';
    const tx: HeliusEnhancedTx = {
      signature: 'sig',
      slot: 1,
      timestamp: 1700000000,
      feePayer: wallet,
      source: 'JUPITER',
      events: {
        swap: {
          nativeInput: { account: wallet, amount: '1000000000' }, // 1 SOL
          tokenOutputs: [
            {
              userAccount: wallet,
              mint: tokenMint,
              tokenAmount: { tokenAmount: '500000000', decimals: 6 }, // 500 tokens
            },
          ],
        },
      },
    };
    const out = normalizeHeliusSwap(tx, { [QUOTE_MINTS.SOL]: 100 });
    expect(out.length).toBe(1);
    const s = out[0]!;
    expect(s.side).toBe('buy');
    expect(s.baseMint).toBe(tokenMint);
    expect(s.amountUsd).toBeCloseTo(100, 5);
    expect(s.dex).toBe('jupiter');
  });

  it('parses a token -> USDC sell', () => {
    const wallet = 'W';
    const tx: HeliusEnhancedTx = {
      signature: 'sig2',
      slot: 2,
      timestamp: 1700000000,
      feePayer: wallet,
      source: 'RAYDIUM',
      events: {
        swap: {
          tokenInputs: [
            { userAccount: wallet, mint: 'TOK', tokenAmount: { tokenAmount: '1000000', decimals: 6 } },
          ],
          tokenOutputs: [
            {
              userAccount: wallet,
              mint: QUOTE_MINTS.USDC,
              tokenAmount: { tokenAmount: '50000000', decimals: 6 },
            },
          ],
        },
      },
    };
    const out = normalizeHeliusSwap(tx, {});
    expect(out.length).toBe(1);
    expect(out[0]!.side).toBe('sell');
    expect(out[0]!.amountUsd).toBeCloseTo(50, 5);
    expect(out[0]!.dex).toBe('raydium');
  });
});
