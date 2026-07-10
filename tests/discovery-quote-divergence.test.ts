import { describe, expect, it } from 'vitest';
import {
  quotePgDivergencePct,
  isDiscoveryQuoteDivergent,
} from '../src/papertrader/pricing/discovery-market-quote.js';

describe('quotePgDivergencePct', () => {
  it('computes absolute percent divergence vs PG baseline', () => {
    expect(quotePgDivergencePct(0.1686, 0.2123)).toBeCloseTo(20.58, 1);
    expect(quotePgDivergencePct(0.21, 0.21)).toBe(0);
    expect(quotePgDivergencePct(0.231, 0.21)).toBeCloseTo(10, 5);
  });

  it('returns Infinity when either price is unusable', () => {
    expect(quotePgDivergencePct(null, 0.21)).toBe(Infinity);
    expect(quotePgDivergencePct(0.21, 0)).toBe(Infinity);
    expect(quotePgDivergencePct(-1, 0.21)).toBe(Infinity);
  });
});

describe('isDiscoveryQuoteDivergent', () => {
  it('flags the ANSEM incident: dexscreener 0.1686 vs PG 0.2123 at 12% max', () => {
    expect(
      isDiscoveryQuoteDivergent({ source: 'dexscreener', priceUsd: 0.1686 }, 0.2123, 12),
    ).toBe(true);
  });

  it('does not flag small divergence within threshold', () => {
    expect(
      isDiscoveryQuoteDivergent({ source: 'dexscreener', priceUsd: 0.205 }, 0.21, 12),
    ).toBe(false);
  });

  it('never flags a PG-sourced quote (nothing to reject)', () => {
    expect(
      isDiscoveryQuoteDivergent({ source: 'pg_snapshot', priceUsd: 0.1 }, 0.2123, 12),
    ).toBe(false);
  });

  it('does not flag when prices are unusable (guard cannot judge)', () => {
    expect(isDiscoveryQuoteDivergent({ source: 'dexscreener', priceUsd: null }, 0.21, 12)).toBe(false);
    expect(isDiscoveryQuoteDivergent({ source: 'dexscreener', priceUsd: 0.18 }, null, 12)).toBe(false);
  });

  it('is disabled when maxDivergencePct is non-positive', () => {
    expect(
      isDiscoveryQuoteDivergent({ source: 'dexscreener', priceUsd: 0.1 }, 0.2123, 0),
    ).toBe(false);
  });
});
