import { describe, expect, it } from 'vitest';
import { evaluateOwnEntryShapeGate } from '../../src/milddip/gates.js';

describe('evaluateOwnEntryShapeGate', () => {
  it('passes when disabled', () => {
    const result = evaluateOwnEntryShapeGate({
      enabled: false,
      minTurnover5mLiq: 0.3,
      maxPc1hPct: 50,
      volume5mUsd: 20,
      liquidityUsd: 100,
      priceChange1hPct: 60,
    });
    expect(result).toEqual({
      pass: true,
      reasons: [],
      turnover5mLiq: 0.2,
      pc1hPct: 60,
    });
  });

  it('rejects turnover below the floor', () => {
    const result = evaluateOwnEntryShapeGate({
      enabled: true,
      minTurnover5mLiq: 0.3,
      maxPc1hPct: 50,
      volume5mUsd: 20,
      liquidityUsd: 100,
      priceChange1hPct: 40,
    });
    expect(result.pass).toBe(false);
    expect(result.reasons[0]).toContain('turnover_below_floor');
  });

  it('passes healthy turnover and hourly change', () => {
    expect(
      evaluateOwnEntryShapeGate({
        enabled: true,
        minTurnover5mLiq: 0.3,
        maxPc1hPct: 50,
        volume5mUsd: 35,
        liquidityUsd: 100,
        priceChange1hPct: 40,
      }).pass,
    ).toBe(true);
  });

  it('rejects hourly change above the cap', () => {
    const result = evaluateOwnEntryShapeGate({
      enabled: true,
      minTurnover5mLiq: 0.3,
      maxPc1hPct: 50,
      volume5mUsd: 35,
      liquidityUsd: 100,
      priceChange1hPct: 60,
    });
    expect(result.pass).toBe(false);
    expect(result.reasons).toContain('pc1h_above_cap');
  });

  it('fails open for unknown metrics', () => {
    expect(
      evaluateOwnEntryShapeGate({
        enabled: true,
        minTurnover5mLiq: 0.3,
        maxPc1hPct: 50,
        volume5mUsd: null,
        liquidityUsd: 0,
        priceChange1hPct: null,
      }),
    ).toEqual({
      pass: true,
      reasons: [],
      turnover5mLiq: null,
      pc1hPct: null,
    });
  });

  it('does nothing when both thresholds are zero', () => {
    expect(
      evaluateOwnEntryShapeGate({
        enabled: true,
        minTurnover5mLiq: 0,
        maxPc1hPct: 0,
        volume5mUsd: 0,
        liquidityUsd: 100,
        priceChange1hPct: 999,
      }).pass,
    ).toBe(true);
  });
});
