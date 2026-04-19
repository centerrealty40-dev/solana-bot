import { describe, expect, it } from 'vitest';
import { H1ConfirmationGate } from '../src/hypotheses/h1-confirmation-gate.js';
import { H6SnipeThenHold } from '../src/hypotheses/h6-snipe-then-hold.js';
import type { MarketCtx, NormalizedSwap, WalletScore } from '../src/core/types.js';

function emptyScore(wallet: string, overrides: Partial<WalletScore> = {}): WalletScore {
  return {
    wallet,
    earlyEntryScore: 0,
    realizedPnl30d: 0,
    holdingAvgMinutes: 0,
    sellInTranchesRatio: 0,
    fundingOriginAgeDays: 100,
    clusterId: null,
    consistencyScore: 0,
    updatedAt: new Date(),
    ...overrides,
  };
}

function mkSwap(overrides: Partial<NormalizedSwap> & {
  wallet: string;
  blockTime: Date;
  side: 'buy' | 'sell';
  amountUsd: number;
}): NormalizedSwap {
  return {
    signature: 'sig' + Math.random(),
    slot: 1,
    baseMint: 'MINT',
    quoteMint: 'USDC',
    baseAmountRaw: 1_000_000n,
    quoteAmountRaw: BigInt(Math.round(overrides.amountUsd * 1_000_000)),
    priceUsd: 1,
    dex: 'raydium',
    source: 'helius_webhook',
    ...overrides,
  } as NormalizedSwap;
}

describe('H1 confirmation gate', () => {
  it('does not fire on a single buy from watchlist', () => {
    const h = new H1ConfirmationGate();
    (h as unknown as { watchlist: Set<string> }).watchlist = new Set(['A', 'B']);
    const swap = mkSwap({ wallet: 'A', blockTime: new Date(), side: 'buy', amountUsd: 500 });
    const scores = new Map<string, WalletScore>([
      ['A', emptyScore('A', { realizedPnl30d: 100_000 })],
    ]);
    const ctx: MarketCtx = { now: new Date(), recentSwaps: [], priceSamples: [], scores };
    expect(h.onSwap(swap, ctx)).toBeNull();
  });

  it('fires when 2 watchlist wallets buy and one has big PnL', () => {
    const h = new H1ConfirmationGate();
    (h as unknown as { watchlist: Set<string> }).watchlist = new Set(['A', 'B']);
    const t = new Date('2026-01-01T00:00:00Z');
    const earlier = mkSwap({ wallet: 'B', blockTime: new Date(t.getTime() - 60_000), side: 'buy', amountUsd: 200 });
    const swap = mkSwap({ wallet: 'A', blockTime: t, side: 'buy', amountUsd: 500 });
    const scores = new Map<string, WalletScore>([
      ['A', emptyScore('A', { realizedPnl30d: 100_000 })],
      ['B', emptyScore('B')],
    ]);
    const ctx: MarketCtx = { now: t, recentSwaps: [earlier], priceSamples: [], scores };
    const sigs = h.onSwap(swap, ctx);
    expect(sigs).not.toBeNull();
    expect(sigs!.length).toBe(1);
    expect(sigs![0]!.side).toBe('buy');
  });

  it('does not fire when neither wallet has big PnL', () => {
    const h = new H1ConfirmationGate();
    (h as unknown as { watchlist: Set<string> }).watchlist = new Set(['A', 'B']);
    const t = new Date();
    const earlier = mkSwap({ wallet: 'B', blockTime: new Date(t.getTime() - 60_000), side: 'buy', amountUsd: 200 });
    const swap = mkSwap({ wallet: 'A', blockTime: t, side: 'buy', amountUsd: 500 });
    const scores = new Map<string, WalletScore>([
      ['A', emptyScore('A')],
      ['B', emptyScore('B')],
    ]);
    const ctx: MarketCtx = { now: t, recentSwaps: [earlier], priceSamples: [], scores };
    expect(h.onSwap(swap, ctx)).toBeNull();
  });
});

describe('H6 snipe-then-hold state machine', () => {
  it('does not trigger on first buy', () => {
    const h = new H6SnipeThenHold();
    const swap = mkSwap({ wallet: 'X', blockTime: new Date(), side: 'buy', amountUsd: 100 });
    expect(h.onSwap(swap, emptyCtx())).toBeNull();
  });
});

function emptyCtx(): MarketCtx {
  return { now: new Date(), recentSwaps: [], priceSamples: [], scores: new Map() };
}
