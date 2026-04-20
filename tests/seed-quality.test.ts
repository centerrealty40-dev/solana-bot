import { describe, it, expect } from 'vitest';
import {
  aggregateSwapEvents,
  filterWallets,
  scoreWallet,
  rankWallets,
} from '../src/scoring/seed-quality.js';
import type { SwapEvent } from '../src/collectors/helius-discovery.js';

function ev(
  wallet: string,
  baseMint: string,
  side: 'buy' | 'sell',
  amountUsd: number,
  ts: number,
): SwapEvent {
  return {
    wallet,
    baseMint,
    side,
    amountUsd,
    solValue: 0,
    ts,
    signature: `${wallet.slice(0, 4)}-${ts}`,
  };
}

describe('seed-quality.aggregateSwapEvents', () => {
  it('sums tokens, swaps, volumes and net flow per wallet', () => {
    const events: SwapEvent[] = [
      ev('alice', 'mintA', 'buy', 100, 1_000),
      ev('alice', 'mintA', 'sell', 80, 1_200),
      ev('alice', 'mintB', 'buy', 200, 1_500),
      ev('bob', 'mintA', 'buy', 50, 1_100),
    ];
    const agg = aggregateSwapEvents(events);
    const a = agg.get('alice')!;
    expect(a.tokenCount).toBe(2);
    expect(a.swapCount).toBe(3);
    expect(a.buyCount).toBe(2);
    expect(a.sellCount).toBe(1);
    expect(a.volumeUsd).toBe(380);
    expect(a.netFlowUsd).toBe(220); // 300 buy - 80 sell
    expect(a.medianGapSec).toBeGreaterThan(0);
    // alice has 200 in mintB and 180 in mintA -> top conc 200/380
    expect(a.topTokenConcentration).toBeCloseTo(200 / 380, 5);
  });

  it('handles single-event wallet (medianGapSec=NaN)', () => {
    const agg = aggregateSwapEvents([ev('solo', 'mintA', 'buy', 10, 100)]);
    expect(Number.isNaN(agg.get('solo')!.medianGapSec)).toBe(true);
  });
});

describe('seed-quality.filterWallets', () => {
  it('drops wallets with too few tokens or too small volume', () => {
    const events: SwapEvent[] = [
      // single-token wallet with too-fast trades and unbalanced - dropped by specialist tier
      ev('one_token_fast', 'mintA', 'buy', 100_000, 1),
      ev('one_token_fast', 'mintA', 'sell', 99_000, 2),
      ev('dust', 'mintA', 'buy', 1, 1),
      ev('dust', 'mintB', 'buy', 1, 100),
      ev('dust', 'mintC', 'buy', 1, 200),
      ev('dust', 'mintD', 'buy', 1, 300),
      ev('good', 'mintA', 'buy', 5_000, 1),
      ev('good', 'mintB', 'buy', 4_000, 60),
      ev('good', 'mintC', 'buy', 3_000, 120),
      ev('good', 'mintD', 'sell', 2_000, 200),
    ];
    const agg = aggregateSwapEvents(events);
    const kept = filterWallets(agg.values()).map((w) => w.wallet);
    expect(kept).toContain('good');
    expect(kept).not.toContain('one_token_fast'); // < 10 swaps, gap=1s
    expect(kept).not.toContain('dust'); // $4 volume
  });

  it('keeps single-token specialists when they are heavy and balanced', () => {
    // 12 swaps in one token, 6/6 balanced, $24k volume, gaps ~60s -> specialist
    const evs: SwapEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evs.push(ev('specialist', 'mintA', i % 2 ? 'sell' : 'buy', 2_000, i * 60));
    }
    const agg = aggregateSwapEvents(evs);
    const kept = filterWallets(agg.values()).map((w) => w.wallet);
    expect(kept).toContain('specialist');
  });

  it('rejects single-token aper (only buys, dumps later)', () => {
    const evs: SwapEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evs.push(ev('aper', 'mintA', 'buy', 2_000, i * 60)); // pure buy, no balance
    }
    const agg = aggregateSwapEvents(evs);
    const kept = filterWallets(agg.values()).map((w) => w.wallet);
    expect(kept).not.toContain('aper');
  });

  it('respects allowSpecialists=false', () => {
    const evs: SwapEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evs.push(ev('specialist', 'mintA', i % 2 ? 'sell' : 'buy', 2_000, i * 60));
    }
    const agg = aggregateSwapEvents(evs);
    const kept = filterWallets(agg.values(), { allowSpecialists: false }).map((w) => w.wallet);
    expect(kept).not.toContain('specialist');
  });

  it('drops MEV bots with sub-second median gap', () => {
    const evs: SwapEvent[] = [];
    for (let i = 0; i < 20; i++) {
      evs.push(ev('mev', `mint${i % 5}`, i % 2 ? 'sell' : 'buy', 1_000, i)); // 1s apart
    }
    const agg = aggregateSwapEvents(evs);
    const kept = filterWallets(agg.values(), { minMedianGapSec: 5 });
    expect(kept.find((w) => w.wallet === 'mev')).toBeUndefined();
  });

  it('drops wallets with >70% concentration in one token', () => {
    const evs: SwapEvent[] = [
      ev('whale', 'mintA', 'buy', 100_000, 1),
      ev('whale', 'mintA', 'sell', 80_000, 60),
      ev('whale', 'mintB', 'buy', 5_000, 120),
      ev('whale', 'mintC', 'buy', 5_000, 200),
    ];
    const agg = aggregateSwapEvents(evs);
    const kept = filterWallets(agg.values());
    expect(kept.find((w) => w.wallet === 'whale')).toBeUndefined();
  });
});

describe('seed-quality.scoreWallet', () => {
  it('rewards breadth and balanced buy/sell ratio', () => {
    const balanced = scoreWallet({
      wallet: 'a',
      tokenCount: 10,
      swapCount: 20,
      buyCount: 10,
      sellCount: 10,
      volumeUsd: 50_000,
      netFlowUsd: 0,
      medianGapSec: 120,
      topTokenConcentration: 0.2,
    });
    const onlySell = scoreWallet({
      wallet: 'b',
      tokenCount: 10,
      swapCount: 20,
      buyCount: 0,
      sellCount: 20,
      volumeUsd: 50_000,
      netFlowUsd: -50_000,
      medianGapSec: 120,
      topTokenConcentration: 0.2,
    });
    expect(balanced).toBeGreaterThan(onlySell);
  });

  it('rewards diversification', () => {
    const diverse = scoreWallet({
      wallet: 'a',
      tokenCount: 5,
      swapCount: 10,
      buyCount: 5,
      sellCount: 5,
      volumeUsd: 10_000,
      netFlowUsd: 0,
      medianGapSec: 60,
      topTokenConcentration: 0.2,
    });
    const concentrated = scoreWallet({
      wallet: 'b',
      tokenCount: 5,
      swapCount: 10,
      buyCount: 5,
      sellCount: 5,
      volumeUsd: 10_000,
      netFlowUsd: 0,
      medianGapSec: 60,
      topTokenConcentration: 0.65,
    });
    expect(diverse).toBeGreaterThan(concentrated);
  });
});

describe('seed-quality.rankWallets end-to-end', () => {
  it('returns wallets sorted by score desc and only those passing filters', () => {
    const events: SwapEvent[] = [];
    // wallet H: high quality - 5 tokens, 10 trades, balanced, $20k vol
    for (let i = 0; i < 5; i++) {
      events.push(ev('high', `m${i}`, 'buy', 2_000, i * 60));
      events.push(ev('high', `m${i}`, 'sell', 2_000, i * 60 + 30));
    }
    // wallet L: only one token
    events.push(ev('low', 'm0', 'buy', 100_000, 1));
    events.push(ev('low', 'm0', 'sell', 100_000, 2));
    const ranked = rankWallets(events);
    expect(ranked[0]?.wallet).toBe('high');
    expect(ranked.find((w) => w.wallet === 'low')).toBeUndefined();
  });
});
