import { describe, expect, it } from 'vitest';
import { randomSellDelayMs, resolveSellDelayMs } from '../../src/copytrader/sell-delay.js';

describe('resolveSellDelayMs', () => {
  const delayed = {
    sellDelayMinMs: 15_000,
    sellDelayMaxMs: 15_000,
    sellDelaySkipMaxDropPct: 5,
  };

  it('skips delay when drop ≤ threshold', () => {
    const r = resolveSellDelayMs(delayed, {
      entryPriceUsd: 1,
      currentPriceUsd: 0.96, // -4%
    });
    expect(r.delayMs).toBe(0);
    expect(r.skipped).toBe(true);
    expect(r.dropPct).toBeCloseTo(4, 5);
  });

  it('applies delay when drop > threshold', () => {
    const r = resolveSellDelayMs(delayed, {
      entryPriceUsd: 1,
      currentPriceUsd: 0.94, // -6%
    });
    expect(r.delayMs).toBe(15_000);
    expect(r.skipped).toBe(false);
    expect(r.dropPct).toBeCloseTo(6, 5);
  });

  it('treats exactly −5% as skip (inclusive)', () => {
    const r = resolveSellDelayMs(delayed, {
      entryPriceUsd: 1,
      currentPriceUsd: 0.95,
    });
    expect(r.delayMs).toBe(0);
    expect(r.skipped).toBe(true);
  });

  it('falls back to leader sell price when no entry', () => {
    const r = resolveSellDelayMs(delayed, {
      entryPriceUsd: 0,
      leaderSellPriceUsd: 2,
      currentPriceUsd: 1.8, // -10% vs leader sell
    });
    expect(r.delayMs).toBe(15_000);
    expect(r.skipped).toBe(false);
  });

  it('sells immediately when skip on but prices missing', () => {
    const r = resolveSellDelayMs(delayed, {
      entryPriceUsd: 1,
      currentPriceUsd: null,
    });
    expect(r.delayMs).toBe(0);
    expect(r.skipped).toBe(true);
    expect(r.dropPct).toBeNull();
  });

  it('legacy: skip off always uses base delay', () => {
    const r = resolveSellDelayMs(
      { ...delayed, sellDelaySkipMaxDropPct: 0 },
      { entryPriceUsd: 1, currentPriceUsd: 0.99 },
    );
    expect(r.delayMs).toBe(15_000);
    expect(r.skipped).toBe(false);
  });
});

describe('randomSellDelayMs', () => {
  it('returns min when span is 0', () => {
    expect(randomSellDelayMs({ sellDelayMinMs: 30_000, sellDelayMaxMs: 30_000 })).toBe(30_000);
  });
});
