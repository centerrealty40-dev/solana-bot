import { describe, expect, it } from 'vitest';
import { assessRugRisk, type RugRiskGates } from '../../src/milddip/rug-risk.js';

/** Live thresholds: the two slices that actually lose money. */
const GATES: RugRiskGates = { knifeDumpPct: -45, knifeTurn: 3, blockDumpPct: 0 };

describe('assessRugRisk', () => {
  it('knife-sizes the reported 8UT4zB rug on dump depth (pc5m -45.3)', () => {
    const r = assessRugRisk({
      pc5mPct: -45.3,
      volume5mUsd: 16_534.98,
      liquidityUsd: 13_140.26,
      gates: GATES,
    });
    expect(r.tier).toBe('knife');
    expect(r.reasons).toEqual(['deep_dump=-45.3%']);
    expect(r.turn).toBeCloseTo(1.258, 3);
  });

  it('knife-sizes 7spXic on turnover alone (pc5m -22.5, turn 7.29)', () => {
    const r = assessRugRisk({
      pc5mPct: -22.53,
      volume5mUsd: 103_063.25,
      liquidityUsd: 14_131.29,
      gates: GATES,
    });
    expect(r.tier).toBe('knife');
    expect(r.reasons).toEqual(['hot_turn=7.29']);
  });

  it('leaves a -35% dump at full size — that slice is not the losing one', () => {
    const r = assessRugRisk({
      pc5mPct: -35,
      volume5mUsd: 5_000,
      liquidityUsd: 20_000,
      gates: GATES,
    });
    expect(r.tier).toBe('normal');
  });

  it('leaves turnover 1.5-3 at full size for the same reason', () => {
    const r = assessRugRisk({
      pc5mPct: -20,
      volume5mUsd: 40_000,
      liquidityUsd: 20_000,
      gates: GATES,
    });
    expect(r.tier).toBe('normal');
    expect(r.turn).toBe(2);
  });

  it('leaves an ordinary dip alone', () => {
    const r = assessRugRisk({
      pc5mPct: -12.4,
      volume5mUsd: 5_569,
      liquidityUsd: 19_535,
      gates: GATES,
    });
    expect(r.tier).toBe('normal');
    expect(r.reasons).toEqual([]);
  });

  it('does not refuse deep dumps while the block leg is off (default)', () => {
    const r = assessRugRisk({
      pc5mPct: -99.94,
      volume5mUsd: 5_000,
      liquidityUsd: 10_000,
      gates: GATES,
    });
    expect(r.tier).toBe('knife');
  });

  it('refuses only when a block threshold is set explicitly', () => {
    const r = assessRugRisk({
      pc5mPct: -99.94,
      volume5mUsd: 5_000,
      liquidityUsd: 10_000,
      gates: { ...GATES, blockDumpPct: -85 },
    });
    expect(r.tier).toBe('blocked');
    expect(r.reasons).toEqual(['dump_spent=-99.9%']);
  });

  it('reports both reasons when a name is deep and hot', () => {
    const r = assessRugRisk({
      pc5mPct: -60,
      volume5mUsd: 60_000,
      liquidityUsd: 10_000,
      gates: GATES,
    });
    expect(r.reasons).toEqual(['deep_dump=-60.0%', 'hot_turn=6.00']);
  });

  it('stays normal when liquidity is unknown and the dip is shallow', () => {
    const r = assessRugRisk({
      pc5mPct: -8,
      volume5mUsd: 50_000,
      liquidityUsd: null,
      gates: GATES,
    });
    expect(r.tier).toBe('normal');
    expect(r.turn).toBeNull();
  });

  it('treats a missing pc5m as unknown rather than deep', () => {
    const r = assessRugRisk({
      pc5mPct: null,
      volume5mUsd: 100,
      liquidityUsd: 10_000,
      gates: GATES,
    });
    expect(r.tier).toBe('normal');
  });
});
