import { describe, expect, it } from 'vitest';
import { shouldDeferSoftExit } from '../../src/milddip/exit-defer.js';
import type { MildDipEntryGates } from '../../src/milddip/gates.js';

const entryGates: MildDipEntryGates = {
  minDipPct: -20,
  maxDipPct: 0,
  minVolume5mUsd: 500,
  maxVolume5mUsd: 40_000,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 5_000_000,
  minPairAgeHours: 6,
  maxPairAgeHours: 720,
  allowedDexIds: [],
};

const gates = { enabled: true, maxTotalMs: 600_000 };

/** GCa9TZ: sold on breakeven_stop, rebought 98s later 7.7% lower. */
const base = {
  reason: 'breakeven_stop' as const,
  gates,
  entryGates,
  metrics: {
    pc5mPct: -6,
    volume5mUsd: 4_000,
    liquidityUsd: 30_000,
    ageMs: 5_000,
  },
  carried: { marketCapUsd: 400_000, pairAgeHours: 40 },
  priceRatioSinceEntry: 0.9,
  heldMs: 600_000,
  deferredMsSoFar: 0,
};

describe('shouldDeferSoftExit', () => {
  it('holds a soft exit the entry gate would still buy', () => {
    const v = shouldDeferSoftExit(base);
    expect(v.defer).toBe(true);
  });

  it('sells when the entry gate no longer wants the name', () => {
    // Liquidity drained below the floor: the reason we would not re-enter.
    const v = shouldDeferSoftExit({
      ...base,
      metrics: { ...base.metrics, liquidityUsd: 4_000 },
    });
    expect(v.defer).toBe(false);
    expect(v.reasons.join(' ')).toContain('liq=');
  });

  it('sells once the price is no longer in the dip band', () => {
    const v = shouldDeferSoftExit({
      ...base,
      metrics: { ...base.metrics, pc5mPct: 12 },
    });
    expect(v.defer).toBe(false);
  });

  it('never defers a floor', () => {
    for (const reason of ['hard_stop', 'cliff_dump', 'never_arm_freefall'] as const) {
      expect(shouldDeferSoftExit({ ...base, reason }).defer).toBe(false);
    }
  });

  it('holds a time cut the entry gate would still buy (1.11.877)', () => {
    // PrkyDd: cut at -15.13% on never_arm_time_red with the tape still falling,
    // rebought 140s later 1.06% lower. Selling and re-entering at the same price
    // is strictly worse than holding, so the cut only paid the fee.
    for (const reason of [
      'never_arm_time_red',
      'never_arm_timeout',
      'max_hold_underwater',
    ] as const) {
      expect(shouldDeferSoftExit({ ...base, reason }).defer).toBe(true);
    }
  });

  it('a time cut still fires once the budget is spent', () => {
    const v = shouldDeferSoftExit({
      ...base,
      reason: 'never_arm_time_red',
      deferredMsSoFar: 600_000,
    });
    expect(v.defer).toBe(false);
    expect(v.reasons).toContain('defer_budget_spent');
  });

  it('a time cut still fires when the entry gate has gone', () => {
    const v = shouldDeferSoftExit({
      ...base,
      reason: 'never_arm_time_red',
      metrics: { ...base.metrics, liquidityUsd: 4_000 },
    });
    expect(v.defer).toBe(false);
  });

  it('never defers a profit exit', () => {
    for (const reason of ['tp_grid', 'mfe_bank_1', 'mfe_bank_2'] as const) {
      expect(shouldDeferSoftExit({ ...base, reason }).defer).toBe(false);
    }
  });

  it('stops deferring once the budget is spent', () => {
    const v = shouldDeferSoftExit({ ...base, deferredMsSoFar: 600_000 });
    expect(v.defer).toBe(false);
    expect(v.reasons).toContain('defer_budget_spent');
  });

  it('will not claim the gate passes on stale metrics', () => {
    const v = shouldDeferSoftExit({
      ...base,
      metrics: { ...base.metrics, ageMs: 120_000 },
    });
    expect(v.defer).toBe(false);
    expect(v.reasons.join(' ')).toContain('metrics_stale');
  });

  it('is off unless enabled', () => {
    const v = shouldDeferSoftExit({ ...base, gates: { ...gates, enabled: false } });
    expect(v.defer).toBe(false);
  });

  it('scales the carried market cap by the price move', () => {
    // Entry mcap 60k, price halved: 30k is under the 50k floor, so we would not
    // re-enter and the exit stands.
    const v = shouldDeferSoftExit({
      ...base,
      carried: { marketCapUsd: 60_000, pairAgeHours: 40 },
      priceRatioSinceEntry: 0.5,
    });
    expect(v.defer).toBe(false);
    expect(v.reasons.join(' ')).toContain('mcap=');
  });

  it('respects the pair-age ceiling as the hold grows', () => {
    const v = shouldDeferSoftExit({
      ...base,
      carried: { marketCapUsd: 400_000, pairAgeHours: 719.9 },
      heldMs: 3_600_000,
    });
    expect(v.defer).toBe(false);
    expect(v.reasons.join(' ')).toContain('age_h=');
  });
});
