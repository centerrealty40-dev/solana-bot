import { describe, it, expect } from 'vitest';
import { filterSmartMoneyCandidates } from '../src/collectors/birdeye.js';

const validWallet = (n: number) =>
  ('1' + 'A'.repeat(43)).slice(0, 43) + String.fromCharCode(50 + (n % 9));

describe('filterSmartMoneyCandidates', () => {
  it('drops wallets seen in only one token (no breadth)', () => {
    const out = filterSmartMoneyCandidates([
      { wallet: validWallet(1), tokensCount: 1, totalVolumeUsd: 50_000, totalTrades: 10, sampleTokens: ['x'] },
      { wallet: validWallet(2), tokensCount: 3, totalVolumeUsd: 50_000, totalTrades: 10, sampleTokens: ['x'] },
    ]);
    expect(out.map((t) => t.wallet)).toEqual([validWallet(2)]);
  });

  it('drops wallets with absurd trade counts (MEV / arb bots)', () => {
    const out = filterSmartMoneyCandidates([
      { wallet: validWallet(1), tokensCount: 5, totalVolumeUsd: 100_000, totalTrades: 9999, sampleTokens: [] },
      { wallet: validWallet(2), tokensCount: 5, totalVolumeUsd: 100_000, totalTrades: 25, sampleTokens: [] },
    ]);
    expect(out.map((t) => t.wallet)).toEqual([validWallet(2)]);
  });

  it('drops wallets with absurd volume (CEX hot wallets)', () => {
    const out = filterSmartMoneyCandidates([
      { wallet: validWallet(1), tokensCount: 5, totalVolumeUsd: 50_000_000, totalTrades: 30, sampleTokens: [] },
      { wallet: validWallet(2), tokensCount: 5, totalVolumeUsd: 200_000, totalTrades: 30, sampleTokens: [] },
    ]);
    expect(out.map((t) => t.wallet)).toEqual([validWallet(2)]);
  });

  it('drops wallets with too few trades (one-shot luck)', () => {
    const out = filterSmartMoneyCandidates([
      { wallet: validWallet(1), tokensCount: 2, totalVolumeUsd: 100_000, totalTrades: 2, sampleTokens: [] },
      { wallet: validWallet(2), tokensCount: 2, totalVolumeUsd: 100_000, totalTrades: 8, sampleTokens: [] },
    ]);
    expect(out.map((t) => t.wallet)).toEqual([validWallet(2)]);
  });

  it('rejects wallets with malformed addresses', () => {
    const out = filterSmartMoneyCandidates([
      { wallet: 'not-a-base58-address!@#', tokensCount: 5, totalVolumeUsd: 100_000, totalTrades: 30, sampleTokens: [] },
      { wallet: validWallet(2), tokensCount: 5, totalVolumeUsd: 100_000, totalTrades: 30, sampleTokens: [] },
    ]);
    expect(out.map((t) => t.wallet)).toEqual([validWallet(2)]);
  });

  it('ranks by tokensCount × sqrt(volume); breadth dominates over single-whale-bias', () => {
    // scores: W1=2*√1e6≈2000, W2=8*√1e5≈2530, W3=4*√5e5≈2828
    // so W3 wins (breadth 4 beats whale-W1's vol; whale-bias damped by sqrt)
    // and W2 (high breadth, modest volume) still ranks above the lone whale W1
    const out = filterSmartMoneyCandidates([
      { wallet: validWallet(1), tokensCount: 2, totalVolumeUsd: 1_000_000, totalTrades: 30, sampleTokens: [] },
      { wallet: validWallet(2), tokensCount: 8, totalVolumeUsd: 100_000, totalTrades: 30, sampleTokens: [] },
      { wallet: validWallet(3), tokensCount: 4, totalVolumeUsd: 500_000, totalTrades: 30, sampleTokens: [] },
    ]);
    expect(out[0]!.wallet).toBe(validWallet(3));
    expect(out[out.length - 1]!.wallet).toBe(validWallet(1));
  });
});
