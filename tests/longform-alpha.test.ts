import { describe, it, expect } from 'vitest';
import type { SwapEvent } from '../src/collectors/helius-discovery.js';
import {
  extractLongformEarlyBuyers,
  aggregateLongformHits,
  collapseLongformFleets,
  formatLongformNote,
  type LongformHit,
} from '../src/scoring/longform-alpha.js';

function ev(
  wallet: string,
  baseMint: string,
  side: 'buy' | 'sell',
  ts: number,
  solValue = 1,
  amountUsd = 0,
): SwapEvent {
  return {
    wallet,
    baseMint,
    side,
    ts,
    solValue,
    amountUsd,
    signature: `sig-${wallet.slice(0, 4)}-${ts}`,
  };
}

const MINT = 'TOKEN_A';
const LAUNCH_MS = 1_700_000_000_000;
const LAUNCH_TS = LAUNCH_MS / 1000;

describe('extractLongformEarlyBuyers', () => {
  it('skips first N buyers (sniper zone)', () => {
    // 10 buyers within early window, all eligible by SOL amount
    const events: SwapEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(ev(`W${i}`, MINT, 'buy', LAUNCH_TS + i * 60, 1));
    }
    const hits = extractLongformEarlyBuyers(events, {
      pairCreatedAt: LAUNCH_MS,
      skipFirst: 3,
      topN: 100,
      minSolPerBuy: 0.1,
    });
    expect(hits.length).toBe(7);
    expect(hits[0]!.wallet).toBe('W3');
    expect(hits[0]!.rank).toBe(4);
  });

  it('drops dust buys below minSolPerBuy', () => {
    const events: SwapEvent[] = [
      ev('W0', MINT, 'buy', LAUNCH_TS + 10, 0.05),
      ev('W1', MINT, 'buy', LAUNCH_TS + 20, 0.5),
      ev('W2', MINT, 'buy', LAUNCH_TS + 30, 0.01),
      ev('W3', MINT, 'buy', LAUNCH_TS + 40, 1.0),
    ];
    const hits = extractLongformEarlyBuyers(events, {
      pairCreatedAt: LAUNCH_MS,
      skipFirst: 0,
      topN: 100,
      minSolPerBuy: 0.3,
    });
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.wallet)).toEqual(['W1', 'W3']);
  });

  it('only keeps swaps within early window from launch', () => {
    const dayInSec = 86400;
    const events: SwapEvent[] = [
      ev('W0', MINT, 'buy', LAUNCH_TS + 1 * dayInSec, 1),
      ev('W1', MINT, 'buy', LAUNCH_TS + 5 * dayInSec, 1),
      ev('W2', MINT, 'buy', LAUNCH_TS + 9 * dayInSec, 1), // outside 7-day window
    ];
    const hits = extractLongformEarlyBuyers(events, {
      pairCreatedAt: LAUNCH_MS,
      earlyWindowDays: 7,
      skipFirst: 0,
      topN: 100,
      minSolPerBuy: 0.1,
    });
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.wallet)).toEqual(['W0', 'W1']);
  });

  it('dedups by wallet, keeping first buy', () => {
    const events: SwapEvent[] = [
      ev('W0', MINT, 'buy', LAUNCH_TS + 100, 1),
      ev('W0', MINT, 'buy', LAUNCH_TS + 200, 2),
      ev('W1', MINT, 'buy', LAUNCH_TS + 150, 1),
    ];
    const hits = extractLongformEarlyBuyers(events, {
      pairCreatedAt: LAUNCH_MS,
      skipFirst: 0,
      topN: 100,
      minSolPerBuy: 0.1,
    });
    expect(hits.length).toBe(2);
    expect(hits[0]!.wallet).toBe('W0');
    expect(hits[0]!.solValue).toBe(1); // first buy, not the 2-SOL second one
    expect(hits[1]!.wallet).toBe('W1');
  });

  it('ignores sells', () => {
    const events: SwapEvent[] = [
      ev('W0', MINT, 'buy', LAUNCH_TS + 10, 1),
      ev('W0', MINT, 'sell', LAUNCH_TS + 20, 5),
      ev('W1', MINT, 'sell', LAUNCH_TS + 15, 1),
    ];
    const hits = extractLongformEarlyBuyers(events, {
      pairCreatedAt: LAUNCH_MS,
      skipFirst: 0,
      topN: 100,
      minSolPerBuy: 0.1,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]!.wallet).toBe('W0');
  });
});

describe('aggregateLongformHits', () => {
  it('requires minHits across DISTINCT mints', () => {
    const tokenAHits: LongformHit[] = [
      { wallet: 'W0', mint: 'A', rank: 31, ts: 1000, solValue: 1, amountUsd: 0 },
      { wallet: 'W1', mint: 'A', rank: 32, ts: 1100, solValue: 1, amountUsd: 0 },
    ];
    const tokenBHits: LongformHit[] = [
      { wallet: 'W0', mint: 'B', rank: 50, ts: 2000, solValue: 2, amountUsd: 0 },
    ];
    const out = aggregateLongformHits([tokenAHits, tokenBHits], { minHits: 2 });
    expect(out.length).toBe(1);
    expect(out[0]!.wallet).toBe('W0');
    expect(out[0]!.hitCount).toBe(2);
  });

  it('scores higher for more hits / earlier ranks / more SOL', () => {
    const winnerHits: LongformHit[] = [
      { wallet: 'W0', mint: 'A', rank: 31, ts: 1000, solValue: 5, amountUsd: 0 },
    ];
    const loserHits: LongformHit[] = [
      { wallet: 'W0', mint: 'B', rank: 32, ts: 1000, solValue: 5, amountUsd: 0 },
    ];

    const goodTokenC: LongformHit[] = [
      { wallet: 'W1', mint: 'A', rank: 400, ts: 1000, solValue: 0.5, amountUsd: 0 },
    ];
    const goodTokenD: LongformHit[] = [
      { wallet: 'W1', mint: 'B', rank: 450, ts: 1100, solValue: 0.5, amountUsd: 0 },
    ];

    const out = aggregateLongformHits([winnerHits, loserHits, goodTokenC, goodTokenD], {
      minHits: 2,
    });
    // Both wallets have 2 hits, but W0 has lower avg rank + much more SOL = higher score
    const w0 = out.find((w) => w.wallet === 'W0')!;
    const w1 = out.find((w) => w.wallet === 'W1')!;
    expect(w0.score).toBeGreaterThan(w1.score);
  });
});

describe('collapseLongformFleets', () => {
  it('collapses wallets with identical hit-set fingerprints', () => {
    const make = (wallet: string, score: number) => ({
      wallet,
      hitCount: 2,
      hits: [
        { wallet, mint: 'A', rank: 31, ts: 1000, solValue: 1, amountUsd: 0 },
        { wallet, mint: 'B', rank: 32, ts: 1100, solValue: 1, amountUsd: 0 },
      ],
      totalSolSpent: 2,
      avgRank: 31.5,
      score,
    });
    const out = collapseLongformFleets([make('W0', 50), make('W1', 60), make('W2', 55)]);
    // All three have same fingerprint (same mints + similar rank + similar SOL)
    // Only the highest-score representative survives.
    expect(out.length).toBe(1);
    expect(out[0]!.wallet).toBe('W1');
  });
});

describe('formatLongformNote', () => {
  it('produces a compact note with hits preview', () => {
    const w = {
      wallet: 'WtestWallet',
      hitCount: 2,
      hits: [
        { wallet: 'WtestWallet', mint: 'A', rank: 32, ts: 1000, solValue: 1.5, amountUsd: 0 },
        { wallet: 'WtestWallet', mint: 'B', rank: 41, ts: 2000, solValue: 2.0, amountUsd: 0 },
      ],
      totalSolSpent: 3.5,
      avgRank: 36.5,
      score: 78.2,
    };
    const winners = [
      { mint: 'A', symbol: 'PEPE', liquidityUsd: 0, volume24hUsd: 0, fdvUsd: 0, ageDays: 0, pairCreatedAt: 0 },
      { mint: 'B', symbol: 'WIF', liquidityUsd: 0, volume24hUsd: 0, fdvUsd: 0, ageDays: 0, pairCreatedAt: 0 },
    ];
    const note = formatLongformNote(w, winners);
    expect(note).toContain('winners=2');
    expect(note).toContain('PEPE#32');
    expect(note).toContain('WIF#41');
    expect(note).toContain('solIn=3.50');
  });
});
