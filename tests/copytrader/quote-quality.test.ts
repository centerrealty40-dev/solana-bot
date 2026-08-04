import { describe, expect, it } from 'vitest';
import { isQuoteOutRegressed, parseTokenRaw } from '../../src/copytrader/quote-quality.js';

describe('isQuoteOutRegressed', () => {
  it('rejects Am8i-style −3% token regression at 1.5% cap', () => {
    const best = 658_964_514_528n;
    const bad = 638_687_903_443n;
    expect(
      isQuoteOutRegressed({ outRaw: bad, bestOutRaw: best, maxRegressionPct: 1.5 }),
    ).toBe(true);
  });

  it('allows small noise under the cap', () => {
    const best = 1_000_000n;
    const ok = 990_000n; // −1%
    expect(
      isQuoteOutRegressed({ outRaw: ok, bestOutRaw: best, maxRegressionPct: 1.5 }),
    ).toBe(false);
  });

  it('no-ops when cap is 0', () => {
    expect(
      isQuoteOutRegressed({ outRaw: 1n, bestOutRaw: 100n, maxRegressionPct: 0 }),
    ).toBe(false);
  });
});

describe('parseTokenRaw', () => {
  it('parses string amounts', () => {
    expect(parseTokenRaw('123')).toBe(123n);
    expect(parseTokenRaw('0')).toBeNull();
  });
});
