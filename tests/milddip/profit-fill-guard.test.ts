import { describe, expect, it } from 'vitest';
import { profitFillMinPriceUsd } from '../../src/milddip/profit-fill-guard.js';

describe('mild-dip profit fill quote guard', () => {
  it('blocks a profit quote beyond the configured slip', () => {
    const floor = profitFillMinPriceUsd({
      reason: 'tp_grid',
      gainPct: 15.2,
      decisionPriceUsd: 100,
      maxSlipPct: 4,
    });
    expect(floor).toBe(96);
    expect(95).toBeLessThan(floor!);
  });

  it('allows a profit quote within the configured slip', () => {
    const floor = profitFillMinPriceUsd({
      reason: 'mfe_bank_sleeve',
      gainPct: 25,
      decisionPriceUsd: 100,
      maxSlipPct: 4,
    });
    expect(97).toBeGreaterThanOrEqual(floor!);
  });

  it('does not guard loss exits', () => {
    expect(
      profitFillMinPriceUsd({
        reason: 'cliff_dump',
        gainPct: -40,
        decisionPriceUsd: 100,
        maxSlipPct: 4,
      }),
    ).toBeNull();
  });

  it('guards bounce-based loss fills at the configured decision-price slip', () => {
    const floor = profitFillMinPriceUsd({
      reason: 'never_arm_bounce',
      gainPct: -20.4,
      decisionPriceUsd: 100,
      maxSlipPct: 8,
      mode: 'loss',
    });
    expect(floor).toBe(92);
    expect(87).toBeLessThan(floor!);
    expect(93).toBeGreaterThanOrEqual(floor!);
  });

  it('does not guard terminal loss reasons or disabled loss protection', () => {
    expect(
      profitFillMinPriceUsd({
        reason: 'dust_close',
        gainPct: -60,
        decisionPriceUsd: 100,
        maxSlipPct: 8,
        mode: 'loss',
      }),
    ).toBeNull();
    expect(
      profitFillMinPriceUsd({
        reason: 'cliff_dump',
        gainPct: -60,
        decisionPriceUsd: 100,
        maxSlipPct: 0,
        mode: 'loss',
      }),
    ).toBeNull();
  });
});
