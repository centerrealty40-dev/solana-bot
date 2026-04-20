import { describe, it, expect } from 'vitest';
import {
  extractEarlyBuyers,
  aggregatePumpHits,
  filterSnipers,
  collapsePumpFleets,
  type EarlyBuyerHit,
  type PumpAlphaWallet,
} from '../src/scoring/pump-alpha.js';
import type { SwapEvent } from '../src/collectors/helius-discovery.js';

function ev(
  wallet: string,
  baseMint: string,
  side: 'buy' | 'sell',
  amountUsd: number,
  ts: number,
): SwapEvent {
  return { wallet, baseMint, side, amountUsd, ts, signature: `${wallet.slice(0, 4)}-${ts}` };
}

describe('extractEarlyBuyers', () => {
  it('returns first N buyers chronologically, deduped per wallet', () => {
    const events: SwapEvent[] = [
      ev('alice', 'mintA', 'buy', 100, 1_000),
      ev('bob', 'mintA', 'buy', 200, 1_005),
      ev('alice', 'mintA', 'buy', 50, 1_010), // alice's second buy — should be ignored
      ev('carol', 'mintA', 'sell', 100, 1_015), // sell — should be ignored
      ev('dave', 'mintA', 'buy', 500, 1_020),
    ];
    const hits = extractEarlyBuyers(events, { topN: 10, lookbackSec: 0 });
    expect(hits.map((h) => h.wallet)).toEqual(['alice', 'bob', 'dave']);
    expect(hits[0]!.rank).toBe(1);
    expect(hits[2]!.rank).toBe(3);
  });

  it('respects lookbackSec window', () => {
    const now = 10_000;
    const events: SwapEvent[] = [
      ev('old', 'mintA', 'buy', 100, 1_000), // outside window
      ev('alice', 'mintA', 'buy', 100, 9_500), // inside
      ev('bob', 'mintA', 'buy', 100, 9_900), // inside
    ];
    const hits = extractEarlyBuyers(events, { topN: 10, lookbackSec: 1_000, nowSec: now });
    expect(hits.map((h) => h.wallet)).toEqual(['alice', 'bob']);
  });

  it('caps at topN', () => {
    const events: SwapEvent[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(ev(`w${i}`, 'mintA', 'buy', 10, 1000 + i));
    }
    const hits = extractEarlyBuyers(events, { topN: 5, lookbackSec: 0 });
    expect(hits).toHaveLength(5);
  });
});

describe('aggregatePumpHits', () => {
  it('keeps wallets with hits in 2+ tokens', () => {
    const t1: EarlyBuyerHit[] = [
      { wallet: 'alpha', mint: 'tokA', rank: 1, ts: 1, amountUsd: 1000 },
      { wallet: 'lucky', mint: 'tokA', rank: 5, ts: 2, amountUsd: 200 },
    ];
    const t2: EarlyBuyerHit[] = [
      { wallet: 'alpha', mint: 'tokB', rank: 3, ts: 3, amountUsd: 800 },
      { wallet: 'unrelated', mint: 'tokB', rank: 1, ts: 4, amountUsd: 100 },
    ];
    const t3: EarlyBuyerHit[] = [
      { wallet: 'alpha', mint: 'tokC', rank: 2, ts: 5, amountUsd: 500 },
    ];
    const out = aggregatePumpHits([t1, t2, t3], { minHits: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]!.wallet).toBe('alpha');
    expect(out[0]!.hitCount).toBe(3);
  });

  it('sorts by composite score descending', () => {
    const t1: EarlyBuyerHit[] = [
      { wallet: 'A', mint: 'x', rank: 1, ts: 1, amountUsd: 100 },
      { wallet: 'B', mint: 'x', rank: 2, ts: 2, amountUsd: 100 },
    ];
    const t2: EarlyBuyerHit[] = [
      { wallet: 'A', mint: 'y', rank: 1, ts: 3, amountUsd: 100 },
      { wallet: 'B', mint: 'y', rank: 50, ts: 4, amountUsd: 100 },
    ];
    const out = aggregatePumpHits([t1, t2], { minHits: 2 });
    // Both have 2 hits; A has better avg rank
    expect(out[0]!.wallet).toBe('A');
  });
});

describe('filterSnipers', () => {
  it('drops wallets with tiny avg USD per buy', () => {
    const w: PumpAlphaWallet = {
      wallet: 'sniper',
      hitCount: 3,
      hits: [
        { wallet: 'sniper', mint: 'a', rank: 1, ts: 1000, amountUsd: 5 },
        { wallet: 'sniper', mint: 'b', rank: 1, ts: 5000, amountUsd: 5 },
        { wallet: 'sniper', mint: 'c', rank: 1, ts: 9000, amountUsd: 5 },
      ],
      rankScore: 3,
      totalBuyUsd: 15,
      avgRank: 1,
      score: 100,
    };
    const out = filterSnipers([w], { minAvgUsd: 50, minSpreadSec: 60 });
    expect(out).toHaveLength(0);
  });

  it('drops wallets with sub-minute spread (multi-token sniper batch)', () => {
    const w: PumpAlphaWallet = {
      wallet: 'batch',
      hitCount: 3,
      hits: [
        { wallet: 'batch', mint: 'a', rank: 1, ts: 1000, amountUsd: 1000 },
        { wallet: 'batch', mint: 'b', rank: 1, ts: 1010, amountUsd: 1000 },
        { wallet: 'batch', mint: 'c', rank: 1, ts: 1020, amountUsd: 1000 },
      ],
      rankScore: 3,
      totalBuyUsd: 3000,
      avgRank: 1,
      score: 100,
    };
    const out = filterSnipers([w], { minAvgUsd: 50, minSpreadSec: 60 });
    expect(out).toHaveLength(0);
  });

  it('keeps real alpha (decent USD, spread over time)', () => {
    const w: PumpAlphaWallet = {
      wallet: 'real',
      hitCount: 2,
      hits: [
        { wallet: 'real', mint: 'a', rank: 5, ts: 1000, amountUsd: 500 },
        { wallet: 'real', mint: 'b', rank: 10, ts: 100_000, amountUsd: 800 },
      ],
      rankScore: 0.3,
      totalBuyUsd: 1300,
      avgRank: 7.5,
      score: 50,
    };
    const out = filterSnipers([w]);
    expect(out).toHaveLength(1);
  });
});

describe('collapsePumpFleets', () => {
  it('collapses wallets that hit the exact same pumps with similar profiles', () => {
    const mk = (wallet: string, score: number): PumpAlphaWallet => ({
      wallet,
      hitCount: 2,
      hits: [
        { wallet, mint: 'mintA', rank: 1, ts: 1000, amountUsd: 100 },
        { wallet, mint: 'mintB', rank: 2, ts: 5000, amountUsd: 100 },
      ],
      rankScore: 1.5,
      totalBuyUsd: 200,
      avgRank: 1.5,
      score,
    });
    const wallets = [mk('clone1', 50), mk('clone2', 60), mk('clone3', 55)];
    const out = collapsePumpFleets(wallets);
    expect(out).toHaveLength(1);
    expect(out[0]!.wallet).toBe('clone2'); // highest score wins
  });

  it('keeps wallets with distinct hit sets', () => {
    const wA: PumpAlphaWallet = {
      wallet: 'A',
      hitCount: 2,
      hits: [
        { wallet: 'A', mint: 'x', rank: 1, ts: 1000, amountUsd: 100 },
        { wallet: 'A', mint: 'y', rank: 2, ts: 5000, amountUsd: 100 },
      ],
      rankScore: 1.5,
      totalBuyUsd: 200,
      avgRank: 1.5,
      score: 50,
    };
    const wB: PumpAlphaWallet = {
      wallet: 'B',
      hitCount: 2,
      hits: [
        { wallet: 'B', mint: 'p', rank: 1, ts: 1000, amountUsd: 100 },
        { wallet: 'B', mint: 'q', rank: 2, ts: 5000, amountUsd: 100 },
      ],
      rankScore: 1.5,
      totalBuyUsd: 200,
      avgRank: 1.5,
      score: 50,
    };
    const out = collapsePumpFleets([wA, wB]);
    expect(out).toHaveLength(2);
  });
});
