import { describe, expect, it } from 'vitest';
import { mirrorSellFractionFromLeader } from '../../src/milddip/leader-sell-fraction.js';

const base = {
  proportionalEnabled: true,
  minFraction: 0.05,
  fullFraction: 0.9,
};

describe('mirrorSellFractionFromLeader', () => {
  it('fails closed to a full sell when proportional mode is disabled', () => {
    expect(
      mirrorSellFractionFromLeader({
        ...base,
        proportionalEnabled: false,
        sellFraction: 0.2,
      }),
    ).toEqual({ fraction: 1, mode: 'full' });
  });

  it('fails closed to a full sell for unknown or non-finite fractions', () => {
    expect(mirrorSellFractionFromLeader({ ...base, sellFraction: null })).toEqual({
      fraction: 1,
      mode: 'full',
    });
    expect(
      mirrorSellFractionFromLeader({ ...base, sellFraction: Number.NaN }),
    ).toEqual({ fraction: 1, mode: 'full' });
  });

  it('skips fractions below the minimum', () => {
    expect(
      mirrorSellFractionFromLeader({ ...base, sellFraction: 0.049 }),
    ).toEqual({ fraction: 0, mode: 'skip' });
  });

  it('keeps the minimum boundary proportional', () => {
    expect(
      mirrorSellFractionFromLeader({ ...base, sellFraction: 0.05 }),
    ).toEqual({ fraction: 0.05, mode: 'proportional' });
  });

  it('keeps fractions below the full threshold proportional', () => {
    expect(
      mirrorSellFractionFromLeader({ ...base, sellFraction: 0.899 }),
    ).toEqual({ fraction: 0.899, mode: 'proportional' });
  });

  it('treats the full threshold boundary as a full sell', () => {
    expect(
      mirrorSellFractionFromLeader({ ...base, sellFraction: 0.9 }),
    ).toEqual({ fraction: 1, mode: 'full' });
  });
});
