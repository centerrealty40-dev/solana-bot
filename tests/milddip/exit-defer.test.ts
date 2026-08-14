import { describe, expect, it } from 'vitest';
import {
  evaluateWouldBuyForExitDefer,
  resolveExitDeferPc5m,
  shouldDeferSoftExit,
} from '../../src/milddip/exit-defer.js';
import type { MildDipEntryGates } from '../../src/milddip/gates.js';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';

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

const pathOff = {
  mint: 'GCa9TZ111111111111111111111111111111111111',
  nowMs: 1_700_000_000_000,
  markPriceUsd: 0.001,
  streamPc5mPct: null as number | null,
  dexId: 'pumpswap' as string | null,
  entryDipSource: 'dex' as string | null,
  turnDumpGateEnabled: false,
  turnDumpAlpha: -5,
  turnDumpBeta: 6,
  turnDumpShallowSlackPct: 10,
  turnDumpDeepSlackPct: 12,
  turnDumpShallowBranchEnabled: false,
  turnDumpShallowAlpha: -8,
  turnDumpShallowBeta: 4,
  turnDumpShallowBandPct: 8,
  turnDumpKnifeBranchEnabled: false,
  turnDumpKnifeMinDumpPct: 30,
  turnDumpKnifeMinTurn: 0.3,
  entryRequireStabilize: false,
  knifeStabilizeMinBouncePct: 2,
  knifeStabilizeQuietMs: 30_000,
  knifeStabilizeBandPct: 3,
  stabLookbackMs: 300_000,
};

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
  path: pathOff,
};

describe('resolveExitDeferPc5m', () => {
  it('prefers deeper stream drawdown over flat Dex pc5m', () => {
    expect(resolveExitDeferPc5m(0.05, -4.5)).toBe(-4.5);
  });

  it('keeps Dex when stream is shallower', () => {
    expect(resolveExitDeferPc5m(-8, -5)).toBe(-8);
  });
});

describe('evaluateWouldBuyForExitDefer', () => {
  it('passes dex allow-list when dexId is present', () => {
    const gatesWithDex: MildDipEntryGates = {
      ...entryGates,
      allowedDexIds: ['pumpswap'],
    };
    const v = evaluateWouldBuyForExitDefer({
      entryGates: gatesWithDex,
      metrics: base.metrics,
      carried: base.carried,
      priceRatioSinceEntry: base.priceRatioSinceEntry,
      heldMs: base.heldMs,
      path: { ...pathOff, dexId: 'pumpswap' },
    });
    expect(v.pass).toBe(true);
  });

  it('fails dex allow-list when dexId is missing', () => {
    const gatesWithDex: MildDipEntryGates = {
      ...entryGates,
      allowedDexIds: ['pumpswap'],
    };
    const v = evaluateWouldBuyForExitDefer({
      entryGates: gatesWithDex,
      metrics: base.metrics,
      carried: base.carried,
      priceRatioSinceEntry: base.priceRatioSinceEntry,
      heldMs: base.heldMs,
      path: { ...pathOff, dexId: null },
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.join(' ')).toContain('dex=null_not_allowed');
  });
});

describe('shouldDeferSoftExit', () => {
  it('holds a soft exit the entry gate would still buy', () => {
    const v = shouldDeferSoftExit(base);
    expect(v.defer).toBe(true);
  });

  it('holds when stream dip qualifies but Dex pc5m is flat (A13oRB-style)', () => {
    const v = shouldDeferSoftExit({
      ...base,
      reason: 'peak_giveback',
      metrics: { ...base.metrics, pc5mPct: 0.05 },
      path: { ...pathOff, streamPc5mPct: -4.5 },
    });
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
      path: { ...pathOff, streamPc5mPct: 12 },
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
    // The window matches the one the never-arm exits already fire on, so a
    // reading good enough to sell on is good enough to keep on (1.11.877).
    const fresh = shouldDeferSoftExit({
      ...base,
      reason: 'never_arm_time_red',
      metrics: { ...base.metrics, ageMs: 120_000 },
    });
    expect(fresh.defer).toBe(true);

    const v = shouldDeferSoftExit({
      ...base,
      metrics: { ...base.metrics, ageMs: 180_000 },
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

  it('defers on dip band despite stale low vol/turn (FXoZh2 held-bag)', () => {
    const liveGates: MildDipEntryGates = {
      ...entryGates,
      minVolume5mUsd: 150,
      minTurnover5mLiq: 0.06,
      allowedDexIds: ['pumpswap'],
    };
    const v = shouldDeferSoftExit({
      ...base,
      entryGates: liveGates,
      reason: 'never_arm_stale',
      metrics: {
        pc5mPct: -4.34,
        volume5mUsd: 92,
        liquidityUsd: 30_000,
        ageMs: 2_000,
      },
      path: { ...pathOff, dexId: 'pumpswap' },
    });
    expect(v.defer).toBe(true);
  });

  it('does not require entry stabilize for an open bag', () => {
    const mint = 'Stab1111111111111111111111111111111111111';
    const nowMs = 1_700_000_100_000;
    mildDipPriceRing.note(mint, 0.001, { tsMs: nowMs - 60_000, source: 'stream' });
    mildDipPriceRing.note(mint, 0.0009, { tsMs: nowMs - 30_000, source: 'stream' });
    mildDipPriceRing.note(mint, 0.000927, { tsMs: nowMs, source: 'stream' });

    const v = shouldDeferSoftExit({
      ...base,
      path: {
        ...pathOff,
        mint,
        nowMs,
        markPriceUsd: 0.000927,
        entryRequireStabilize: true,
        knifeStabilizeMinBouncePct: 5,
        knifeStabilizeQuietMs: 30_000,
        knifeStabilizeBandPct: 2,
        stabLookbackMs: 300_000,
      },
    });
    expect(v.defer).toBe(true);
  });
});
