/** 1.11.231 — unit tests для extractQuotePriceImpactPct + isQuotePriceImpactTooHigh. */
import { describe, it, expect } from 'vitest';
import {
  extractQuotePriceImpactPct,
  isQuotePriceImpactTooHigh,
} from '../src/live/jupiter.js';

describe('extractQuotePriceImpactPct', () => {
  it('handles missing field → null', () => {
    expect(extractQuotePriceImpactPct({})).toBeNull();
    expect(extractQuotePriceImpactPct(null)).toBeNull();
  });

  it('parses string format like "0.0123"', () => {
    expect(extractQuotePriceImpactPct({ priceImpactPct: '0.0123' })).toBeCloseTo(0.0123);
  });

  it('parses numeric format', () => {
    expect(extractQuotePriceImpactPct({ priceImpactPct: 0.05 })).toBe(0.05);
  });

  it('returns null on negative / NaN', () => {
    expect(extractQuotePriceImpactPct({ priceImpactPct: -0.01 })).toBeNull();
    expect(extractQuotePriceImpactPct({ priceImpactPct: 'abc' })).toBeNull();
  });
});

describe('isQuotePriceImpactTooHigh', () => {
  it('returns blocked=false when limitPct <= 0 (off)', () => {
    const r = isQuotePriceImpactTooHigh({ priceImpactPct: '0.5' }, 0);
    expect(r.blocked).toBe(false);
    expect(r.pct).toBe(0.5);
  });

  it('blocks when impact > limit', () => {
    /** raw=0.02 = 2% > limit 1% → blocked. */
    const r = isQuotePriceImpactTooHigh({ priceImpactPct: '0.02' }, 1);
    expect(r.blocked).toBe(true);
    expect(r.pct).toBe(2);
  });

  it('allows when impact <= limit', () => {
    /** raw=0.005 = 0.5% < limit 1% → allowed. */
    const r = isQuotePriceImpactTooHigh({ priceImpactPct: '0.005' }, 1);
    expect(r.blocked).toBe(false);
    expect(r.pct).toBe(0.5);
  });

  it('exact equality is not blocked (>)', () => {
    const r = isQuotePriceImpactTooHigh({ priceImpactPct: '0.01' }, 1);
    expect(r.blocked).toBe(false);
    expect(r.pct).toBe(1);
  });

  it('null priceImpact + active limit → not blocked (defensive)', () => {
    const r = isQuotePriceImpactTooHigh({}, 1);
    expect(r.blocked).toBe(false);
    expect(r.pct).toBeNull();
  });
});
