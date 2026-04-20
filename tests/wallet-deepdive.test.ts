import { describe, it, expect } from 'vitest';
import type { SwapEvent } from '../src/collectors/helius-discovery.js';
import {
  scoreWallet,
  shouldKeep,
  formatDeepDiveNote,
} from '../src/scoring/wallet-deepdive.js';

function ev(
  wallet: string,
  baseMint: string,
  side: 'buy' | 'sell',
  ts: number,
  amountUsd = 0,
): SwapEvent {
  return {
    wallet,
    baseMint,
    side,
    ts,
    amountUsd,
    solValue: 0,
    signature: `sig-${ts}-${baseMint.slice(0, 4)}`,
  };
}

const WALLET = 'WtestWalletAddress11111111111111111111111111';

describe('scoreWallet', () => {
  it('classifies buy-only wallet as buy_only and gives negative score', () => {
    // 8 buys across 6 mints, no sells, spread over 10 days
    const day = 86400;
    const events: SwapEvent[] = [
      ev(WALLET, 'A', 'buy', 1_000_000),
      ev(WALLET, 'B', 'buy', 1_000_000 + 1 * day),
      ev(WALLET, 'C', 'buy', 1_000_000 + 2 * day),
      ev(WALLET, 'D', 'buy', 1_000_000 + 3 * day),
      ev(WALLET, 'E', 'buy', 1_000_000 + 5 * day),
      ev(WALLET, 'F', 'buy', 1_000_000 + 7 * day),
      ev(WALLET, 'G', 'buy', 1_000_000 + 9 * day),
      ev(WALLET, 'H', 'buy', 1_000_000 + 10 * day),
    ];
    const m = scoreWallet(WALLET, events);
    expect(m.klass).toBe('buy_only');
    expect(m.sellRatio).toBe(0);
    expect(m.score).toBeLessThan(0);
    expect(shouldKeep(m)).toBe(false);
  });

  it('classifies real_trader: high roundtrip, many days, many mints', () => {
    const day = 86400;
    const base = 2_000_000;
    const events: SwapEvent[] = [];
    // 12 mints, each fully roundtripped (buy + sell), spread across 30 days
    for (let i = 0; i < 12; i++) {
      const t = base + i * 2 * day;
      events.push(ev(WALLET, `M${i}`, 'buy', t, 100));
      events.push(ev(WALLET, `M${i}`, 'sell', t + day, 150));
    }
    const m = scoreWallet(WALLET, events);
    expect(m.klass).toBe('real_trader');
    expect(m.roundtripRatio).toBe(1);
    expect(m.distinctMints).toBe(12);
    expect(m.daysActive).toBeGreaterThan(20);
    expect(m.score).toBeGreaterThan(50);
    expect(shouldKeep(m)).toBe(true);
  });

  it('classifies sniper_bot: many mints, ultra-short holds, sells fast', () => {
    const events: SwapEvent[] = [];
    const base = 3_000_000;
    // 60 mints, each held ~10 sec, both buy & sell, spread over 5 days
    for (let i = 0; i < 60; i++) {
      const t = base + i * 7200;
      events.push(ev(WALLET, `S${i}`, 'buy', t));
      events.push(ev(WALLET, `S${i}`, 'sell', t + 10));
    }
    const m = scoreWallet(WALLET, events);
    expect(m.klass).toBe('sniper_bot');
    expect(m.medianHoldSec).toBeLessThan(30);
    expect(m.distinctMints).toBe(60);
    expect(m.score).toBeLessThan(0);
    expect(shouldKeep(m)).toBe(false);
  });

  it('classifies throwaway: too few swaps', () => {
    const events: SwapEvent[] = [
      ev(WALLET, 'X', 'buy', 1_000_000),
      ev(WALLET, 'X', 'sell', 1_000_010),
    ];
    const m = scoreWallet(WALLET, events);
    expect(m.klass).toBe('throwaway');
    expect(shouldKeep(m)).toBe(false);
  });

  it('classifies specialist: few mints, sells, week+ active', () => {
    const day = 86400;
    const base = 4_000_000;
    const events: SwapEvent[] = [
      ev(WALLET, 'TOKEN1', 'buy', base),
      ev(WALLET, 'TOKEN1', 'sell', base + 2 * day),
      ev(WALLET, 'TOKEN2', 'buy', base + 3 * day),
      ev(WALLET, 'TOKEN2', 'sell', base + 5 * day),
      ev(WALLET, 'TOKEN1', 'buy', base + 6 * day),
      ev(WALLET, 'TOKEN1', 'sell', base + 9 * day),
    ];
    const m = scoreWallet(WALLET, events);
    expect(m.klass).toBe('specialist');
    expect(m.distinctMints).toBeLessThanOrEqual(5);
    expect(m.sellRatio).toBeGreaterThan(0.2);
  });

  it('handles empty event list gracefully', () => {
    const m = scoreWallet(WALLET, []);
    expect(m.totalSwaps).toBe(0);
    expect(m.klass).toBe('throwaway');
    expect(m.score).toBeLessThan(0);
  });

  it('computes PnL only when both legs are priced', () => {
    const events: SwapEvent[] = [
      ev(WALLET, 'A', 'buy', 1_000_000, 100), // both priced
      ev(WALLET, 'A', 'sell', 1_000_100, 150),
      ev(WALLET, 'B', 'buy', 1_000_000, 0), // unpriced -> excluded from PnL
      ev(WALLET, 'B', 'sell', 1_000_100, 100),
    ];
    const m = scoreWallet(WALLET, events);
    expect(m.pricedClosedPositions).toBe(1);
    expect(m.sumPnlUsd).toBe(50);
    expect(m.winRate).toBe(1);
  });

  it('detects partial roundtrip (only some positions closed)', () => {
    const day = 86400;
    const base = 5_000_000;
    const events: SwapEvent[] = [
      ev(WALLET, 'A', 'buy', base),
      ev(WALLET, 'A', 'sell', base + 1 * day),
      ev(WALLET, 'B', 'buy', base + 2 * day), // never sold
      ev(WALLET, 'C', 'buy', base + 3 * day),
      ev(WALLET, 'C', 'sell', base + 4 * day),
      ev(WALLET, 'D', 'buy', base + 5 * day), // never sold
    ];
    const m = scoreWallet(WALLET, events);
    expect(m.distinctMints).toBe(4);
    expect(m.closedPositions).toBe(2);
    expect(m.roundtripRatio).toBe(0.5);
  });
});

describe('formatDeepDiveNote', () => {
  it('produces a compact note string', () => {
    const day = 86400;
    const base = 6_000_000;
    const events: SwapEvent[] = [];
    for (let i = 0; i < 12; i++) {
      const t = base + i * 2 * day;
      events.push(ev(WALLET, `M${i}`, 'buy', t, 100));
      events.push(ev(WALLET, `M${i}`, 'sell', t + day, 150));
    }
    const m = scoreWallet(WALLET, events);
    const note = formatDeepDiveNote(m);
    expect(note).toContain('class=real_trader');
    expect(note).toContain('mints=12');
    expect(note).toContain('roundtrip=100%');
    expect(note).toContain('win=100%');
  });
});
