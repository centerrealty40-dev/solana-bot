import { describe, expect, it } from 'vitest';
import {
  evaluateTurnDumpGate,
  predictDumpDepthPct,
  turnover5mLiq,
} from '../../src/milddip/turn-dump.js';

describe('turn-dump gate (8zkg formula)', () => {
  it('predicts deeper dump at higher turnover', () => {
    const shallow = predictDumpDepthPct(0.03, -5.08, 6.86);
    const mid = predictDumpDepthPct(0.1, -5.08, 6.86);
    const deep = predictDumpDepthPct(0.5, -5.08, 6.86);
    expect(shallow).toBeLessThan(mid);
    expect(mid).toBeLessThan(deep);
    expect(shallow).toBeGreaterThan(3);
    expect(shallow).toBeLessThan(6);
  });

  it('computes turnover = vol5m / liq', () => {
    expect(turnover5mLiq(20_000, 100_000)).toBeCloseTo(0.2);
    expect(turnover5mLiq(null, 100_000)).toBeNull();
  });

  it('passes when dump near pred (low turn, shallow dump)', () => {
    // turn=0.03 → pred ~4.3; dump=5 (pc5m=-5)
    const v = evaluateTurnDumpGate({
      enabled: true,
      pc5m: -5,
      volume5mUsd: 3_000,
      liquidityUsd: 100_000,
      alpha: -5.08,
      beta: 6.86,
      shallowSlackPct: 8,
      deepSlackPct: 12,
    });
    expect(v.pass).toBe(true);
    expect(v.turn).toBeCloseTo(0.03);
  });

  it('rejects shallow dump on hot turn (wait_dip-class miss)', () => {
    // turn=1.0 → pred ~27; dump=12 is too shallow (resid ~-15)
    const v = evaluateTurnDumpGate({
      enabled: true,
      pc5m: -12,
      volume5mUsd: 100_000,
      liquidityUsd: 100_000,
      alpha: -5.08,
      beta: 6.86,
      shallowSlackPct: 8,
      deepSlackPct: 12,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('turn_dump_shallow'))).toBe(true);
  });

  it('rejects extreme deep dump vs pred when deep slack on', () => {
    // turn=0.05 → pred ~6.7; dump=30 too deep
    const v = evaluateTurnDumpGate({
      enabled: true,
      pc5m: -30,
      volume5mUsd: 5_000,
      liquidityUsd: 100_000,
      alpha: -5.08,
      beta: 6.86,
      shallowSlackPct: 8,
      deepSlackPct: 12,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('turn_dump_deep'))).toBe(true);
  });

  it('disabled gate always passes', () => {
    const v = evaluateTurnDumpGate({
      enabled: false,
      pc5m: -1,
      volume5mUsd: 1,
      liquidityUsd: 1,
      alpha: -5.08,
      beta: 6.86,
      shallowSlackPct: 8,
      deepSlackPct: 12,
    });
    expect(v.pass).toBe(true);
  });
});
