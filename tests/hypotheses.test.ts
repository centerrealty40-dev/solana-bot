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
    const ctx: MarketCtx = { now: new Date(), recentSwaps: [], priceSamples: [], scores, recentSignals: new Map() };
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
    const ctx: MarketCtx = { now: t, recentSwaps: [earlier], priceSamples: [], scores, recentSignals: new Map() };
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
    const ctx: MarketCtx = { now: t, recentSwaps: [earlier], priceSamples: [], scores, recentSignals: new Map() };
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

describe('H7 confluence gate', () => {
  function ctxWithSignals(entries: Array<[string, 'buy' | 'sell', string]>): MarketCtx {
    const m = new Map();
    let i = 1n;
    for (const [hyp, side, reason] of entries) {
      m.set(hyp, {
        hypothesisId: hyp,
        side,
        count: 1,
        lastTs: new Date(Date.now() - 5_000),
        lastSignalId: i++,
        lastReason: reason,
      });
    }
    return { now: new Date(), recentSwaps: [], priceSamples: [], scores: new Map(), recentSignals: m };
  }

  it('does not fire on a single tier-A signal', async () => {
    const { H7ConfluenceGate } = await import('../src/hypotheses/h7-confluence-gate.js');
    const h = new H7ConfluenceGate();
    const swap = mkSwap({ wallet: 'X', side: 'buy', amountUsd: 500, baseMint: 'M1' });
    const ctx = ctxWithSignals([['h2', 'buy', 'cluster of 3']]);
    expect(h.onSwap(swap, ctx)).toBeNull();
  });

  it('fires when 2 tier-A hypotheses converge', async () => {
    const { H7ConfluenceGate } = await import('../src/hypotheses/h7-confluence-gate.js');
    const h = new H7ConfluenceGate();
    const swap = mkSwap({ wallet: 'X', side: 'buy', amountUsd: 500, baseMint: 'M2' });
    const ctx = ctxWithSignals([
      ['h2', 'buy', 'cluster'],
      ['h3', 'buy', 'dev re-buying'],
    ]);
    const sigs = h.onSwap(swap, ctx);
    expect(sigs).not.toBeNull();
    expect(sigs![0]!.side).toBe('buy');
    expect(sigs![0]!.sizeUsd).toBe(150);
  });

  it('vetoes entry when H5 sell signal present', async () => {
    const { H7ConfluenceGate } = await import('../src/hypotheses/h7-confluence-gate.js');
    const h = new H7ConfluenceGate();
    const swap = mkSwap({ wallet: 'X', side: 'buy', amountUsd: 500, baseMint: 'M3' });
    const ctx = ctxWithSignals([
      ['h2', 'buy', 'cluster'],
      ['h3', 'buy', 'dev re-buying'],
      ['h5', 'sell', 'losers piling in'],
    ]);
    expect(h.onSwap(swap, ctx)).toBeNull();
  });

  it('does not re-fire on the same mint within throttle window', async () => {
    const { H7ConfluenceGate } = await import('../src/hypotheses/h7-confluence-gate.js');
    const h = new H7ConfluenceGate();
    const swap = mkSwap({ wallet: 'X', side: 'buy', amountUsd: 500, baseMint: 'M4' });
    const ctx = ctxWithSignals([
      ['h2', 'buy', 'cluster'],
      ['h4', 'buy', 'pre-listing accumulation'],
    ]);
    const first = h.onSwap(swap, ctx);
    expect(first).not.toBeNull();
    // Second call within cooldown returns null even if new ctx still has triggers
    const second = h.onSwap(swap, ctx);
    expect(second).toBeNull();
  });
});

function emptyCtx(): MarketCtx {
  return { now: new Date(), recentSwaps: [], priceSamples: [], scores: new Map(), recentSignals: new Map() };
}
