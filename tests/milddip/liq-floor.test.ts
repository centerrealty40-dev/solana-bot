import { describe, expect, it } from 'vitest';
import { evaluateMildDipEntryRisk } from '../../src/milddip/gates.js';

const base = {
  pairAgeHours: 4,
  volume5mUsd: 1_000,
  liquidityUsd: 4_000,
  minPairAgeHours: 0,
  maxVol5mToLiq: 0,
  minLiquidityUsd: 4_000,
};

describe('1.11.970 entry liquidity floor', () => {
  it('rejects liquidity below the threshold and accepts the threshold', () => {
    expect(
      evaluateMildDipEntryRisk({
        ...base,
        liquidityUsd: 3_999.99,
      }),
    ).toEqual({
      pass: false,
      reasons: ['liq_too_thin=3999.99<4000'],
    });
    expect(evaluateMildDipEntryRisk(base).pass).toBe(true);
    expect(
      evaluateMildDipEntryRisk({
        ...base,
        liquidityUsd: 4_001,
      }).pass,
    ).toBe(true);
  });

  it('does not block when liquidity is missing or the floor is disabled', () => {
    for (const liquidityUsd of [null, undefined, 0]) {
      expect(
        evaluateMildDipEntryRisk({
          ...base,
          liquidityUsd,
        }).pass,
      ).toBe(true);
    }
    expect(
      evaluateMildDipEntryRisk({
        ...base,
        liquidityUsd: 1,
        minLiquidityUsd: 0,
      }).pass,
    ).toBe(true);
  });
});
