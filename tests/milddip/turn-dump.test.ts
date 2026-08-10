import { describe, expect, it } from 'vitest';
import {
  evaluateTurnDumpGate,
  predictDumpDepthPct,
  turnDumpKnifeOrOk,
  turnover5mLiq,
} from '../../src/milddip/turn-dump.js';

const mainArgs = {
  enabled: true,
  alpha: -5.08,
  beta: 6.86,
  shallowSlackPct: 8,
  deepSlackPct: 12,
} as const;

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
      ...mainArgs,
      pc5m: -5,
      volume5mUsd: 3_000,
      liquidityUsd: 100_000,
    });
    expect(v.pass).toBe(true);
    expect(v.branch).toBe('main');
    expect(v.turn).toBeCloseTo(0.03);
  });

  it('rejects shallow dump on hot turn (wait_dip-class miss)', () => {
    // turn=1.0 → pred ~27; dump=12 is too shallow (resid ~-15)
    const v = evaluateTurnDumpGate({
      ...mainArgs,
      pc5m: -12,
      volume5mUsd: 100_000,
      liquidityUsd: 100_000,
    });
    expect(v.pass).toBe(false);
    expect(v.branch).toBeNull();
    expect(v.reasons.some((r) => r.includes('turn_dump_main_shallow'))).toBe(true);
  });

  it('rejects extreme deep dump vs pred when deep slack on', () => {
    // turn=0.05 → pred ~6.7; dump=30 too deep
    const v = evaluateTurnDumpGate({
      ...mainArgs,
      pc5m: -30,
      volume5mUsd: 5_000,
      liquidityUsd: 100_000,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('turn_dump_main_deep'))).toBe(true);
  });

  it('disabled gate always passes', () => {
    const v = evaluateTurnDumpGate({
      ...mainArgs,
      enabled: false,
      pc5m: -1,
      volume5mUsd: 1,
      liquidityUsd: 1,
    });
    expect(v.pass).toBe(true);
  });

  it('live 8zkg tpg7 miss: slack 8 rejects, slack 10 (slip) passes', () => {
    // turn≈0.378 → pred≈20.01; dump=11.69 → resid≈−8.32
    const vol = 26_171.66;
    const liq = 69_302.9;
    const args = {
      enabled: true,
      pc5m: -11.69,
      volume5mUsd: vol,
      liquidityUsd: liq,
      alpha: -5.08,
      beta: 6.86,
      deepSlackPct: 12,
    } as const;
    expect(evaluateTurnDumpGate({ ...args, shallowSlackPct: 8 }).pass).toBe(false);
    const slip = evaluateTurnDumpGate({ ...args, shallowSlackPct: 10 });
    expect(slip.pass).toBe(true);
    expect(slip.branch).toBe('main');
  });

  it('1.11.777 shallow branch: 72Jp-class scrape passes SHALLOW after MAIN reject', () => {
    // turn≈0.271 → MAIN floor≈7.81, dump=3.74 → MAIN reject; SHALLOW ±8 pass
    const vol = 27_130;
    const liq = 100_000;
    const base = {
      enabled: true,
      pc5m: -3.74,
      volume5mUsd: vol,
      liquidityUsd: liq,
      alpha: -5.08,
      beta: 6.86,
      shallowSlackPct: 10,
      deepSlackPct: 12,
    } as const;
    const mainOnly = evaluateTurnDumpGate({ ...base, shallowBranchEnabled: false });
    expect(mainOnly.pass).toBe(false);
    expect(mainOnly.reasons.some((r) => r.includes('turn_dump_main_shallow'))).toBe(true);

    const dual = evaluateTurnDumpGate({
      ...base,
      shallowBranchEnabled: true,
      shallowAlpha: -8.83,
      shallowBeta: 4.23,
      shallowBandPct: 8,
    });
    expect(dual.pass).toBe(true);
    expect(dual.branch).toBe('shallow');
    expect(dual.reasons.some((r) => r.includes('branch=shallow'))).toBe(true);
  });

  it('prefers MAIN when both branches would pass', () => {
    // low-turn mid dump sits in both bands
    const v = evaluateTurnDumpGate({
      enabled: true,
      pc5m: -5,
      volume5mUsd: 3_000,
      liquidityUsd: 100_000,
      alpha: -5.08,
      beta: 6.86,
      shallowSlackPct: 10,
      deepSlackPct: 12,
      shallowBranchEnabled: true,
      shallowAlpha: -8.83,
      shallowBeta: 4.23,
      shallowBandPct: 8,
    });
    expect(v.pass).toBe(true);
    expect(v.branch).toBe('main');
  });

  it('1.11.793 knife OR: dump≥30 & turn≥0.3 after MAIN|SHALLOW fail', () => {
    // turn=0.5 → MAIN pred~26.6 ceil~38.6 — dump=40 is MAIN deep-reject;
    // SHALLOW ±8 also fails; knife should pass.
    const base = {
      enabled: true,
      pc5m: -40,
      volume5mUsd: 50_000,
      liquidityUsd: 100_000,
      alpha: -5.08,
      beta: 6.86,
      shallowSlackPct: 10,
      deepSlackPct: 12,
      shallowBranchEnabled: true,
      shallowAlpha: -8.83,
      shallowBeta: 4.23,
      shallowBandPct: 8,
    } as const;
    expect(evaluateTurnDumpGate({ ...base, knifeBranchEnabled: false }).pass).toBe(false);

    const cold = evaluateTurnDumpGate({
      ...base,
      volume5mUsd: 10_000, // turn=0.1
      knifeBranchEnabled: true,
      knifeMinDumpPct: 30,
      knifeMinTurn: 0.3,
    });
    expect(cold.pass).toBe(false);
    expect(cold.reasons.some((r) => r.includes('turn_dump_knife_cold'))).toBe(true);

    const hit = evaluateTurnDumpGate({
      ...base,
      knifeBranchEnabled: true,
      knifeMinDumpPct: 30,
      knifeMinTurn: 0.3,
    });
    expect(hit.pass).toBe(true);
    expect(hit.branch).toBe('knife');
    expect(hit.dump).toBeCloseTo(40);
    expect(hit.turn).toBeCloseTo(0.5);
  });

  it('1.11.799 knife OR fires on hot dump even when TD branch=main (EeqYr8)', () => {
    // turn≈1.05, dump≈35 → regression classifies MAIN, not knife.
    const td = evaluateTurnDumpGate({
      enabled: true,
      pc5m: -34.91,
      volume5mUsd: 22_136,
      liquidityUsd: 21_090,
      alpha: -5.08,
      beta: 6.86,
      shallowSlackPct: 10,
      deepSlackPct: 12,
      shallowBranchEnabled: true,
      shallowAlpha: -8.83,
      shallowBeta: 4.23,
      shallowBandPct: 8,
      knifeBranchEnabled: true,
      knifeMinDumpPct: 30,
      knifeMinTurn: 0.3,
    });
    expect(td.pass).toBe(true);
    expect(td.branch).toBe('main');
    // Old bug: branch==='knife' alone → deep_knife_defer. Instant OR must still pass.
    expect(
      turnDumpKnifeOrOk({
        enabled: true,
        knifeBranchEnabled: true,
        pc5m: -34.91,
        volume5mUsd: 22_136,
        liquidityUsd: 21_090,
        minDumpPct: 30,
        minTurn: 0.3,
      }).ok,
    ).toBe(true);
    expect(
      turnDumpKnifeOrOk({
        enabled: true,
        knifeBranchEnabled: true,
        pc5m: -34.91,
        volume5mUsd: 5_000,
        liquidityUsd: 21_090,
        minDumpPct: 30,
        minTurn: 0.3,
      }).ok,
    ).toBe(false);
  });
});
