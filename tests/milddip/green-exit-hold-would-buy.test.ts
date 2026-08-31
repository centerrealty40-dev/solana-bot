import { describe, expect, it } from 'vitest';
import {
  evaluateGreenLane,
  type GreenLaneGates,
  type GreenLaneInput,
} from '../../src/milddip/green-lane.js';
import {
  greenLaneGatesFrom,
  shouldHoldGreenExitWouldBuy,
} from '../../src/milddip/green-would-buy.js';
import { OPEN_MARK_METRICS_MAX_AGE_MS } from '../../src/milddip/open-mark-metrics.js';
import type { MildDipConfig } from '../../src/milddip/config.js';

const gates: GreenLaneGates = {
  enabled: true,
  minTurnover5mLiq: 0.4,
  minVolume5mUsd: 8_000,
  minVolume1hUsd: 0,
  minPc5mPct: 0,
  maxPc5mPct: 0,
  maxRallyIntoPeakPct: 0,
  maxBounceFromTroughPct: 0,
  minDumpFromPeakPct: 10,
  tapeMinuteGatesEnabled: true,
  minTapeRet1mPct: -5,
  maxTapePrior5mPct: 3,
  requirePc1h: false,
  minPc1hPct: 0,
  minBuys5m: 0,
  maxBuyShare5m: 0,
  minLiquidityUsd: 10_000,
  minPairAgeHours: 0,
  maxRet1mPct: 0,
  maxTapeRet1mPct: 2,
};

const input: GreenLaneInput = {
  pc5mPct: null,
  pc1hPct: null,
  volume5mUsd: 10_000,
  volume1hUsd: null,
  liquidityUsd: 20_000,
  buys5m: null,
  sells5m: null,
  pairAgeHours: 0,
  dumpExtentFromPeakPct: -12,
  rallyIntoPeakPct: null,
  bounceFromTroughPct: null,
  tapeRet1mPct: 1,
  tapePrior5mPct: 2,
};

const args = {
  reason: 'green_trail',
  enabled: true,
  maxTotalMs: 120_000,
  deferredMsSoFar: 0,
  metricsAgeMs: 1_000,
  greenGates: gates,
  input,
};

describe('green exit hold would-buy', () => {
  it('rejects disabled and non-holdable reasons', () => {
    expect(shouldHoldGreenExitWouldBuy({ ...args, enabled: false })).toEqual({
      hold: false,
      reasons: ['disabled'],
    });
    expect(shouldHoldGreenExitWouldBuy({ ...args, reason: 'green_stop' })).toEqual({
      hold: false,
      reasons: ['reason_not_holdable'],
    });
    expect(shouldHoldGreenExitWouldBuy({ ...args, reason: 'hard_time_stop' })).toEqual({
      hold: false,
      reasons: ['reason_not_holdable'],
    });
  });

  it('rejects exhausted budgets and unusable metrics', () => {
    expect(shouldHoldGreenExitWouldBuy({ ...args, deferredMsSoFar: 120_000 })).toEqual({
      hold: false,
      reasons: ['hold_budget_spent'],
    });
    expect(shouldHoldGreenExitWouldBuy({
      ...args,
      metricsAgeMs: OPEN_MARK_METRICS_MAX_AGE_MS + 1,
    }).reasons[0]).toMatch(/^metrics_stale_/);
    expect(shouldHoldGreenExitWouldBuy({ ...args, metricsAgeMs: null })).toEqual({
      hold: false,
      reasons: ['no_metrics'],
    });
  });

  it('holds green trail and green no-move when green would buy', () => {
    expect(shouldHoldGreenExitWouldBuy(args).hold).toBe(true);
    expect(shouldHoldGreenExitWouldBuy({ ...args, reason: 'green_no_move' }).hold).toBe(true);
    const tapeFail = shouldHoldGreenExitWouldBuy({
      ...args,
      input: { ...input, tapeRet1mPct: 3 },
    });
    expect(tapeFail.hold).toBe(false);
    expect(tapeFail.reasons.some((r) => r.startsWith('tapeRet1m_max'))).toBe(true);
  });

  it('keeps runner-relaxed gates identical between entry and exit', () => {
    const green = {
      minLiquidityUsd: 20_000,
      runnerMinLiquidityUsd: 8_000,
      minPairAgeHours: 1,
      runnerMinPairAgeHours: 0,
      maxBounceFromTroughPct: 25,
      runnerMaxBounceFromTroughPct: 0,
      maxTapeRet1mPct: 2,
      runnerMaxTapeRet1mPct: 0,
      maxTapePrior5mPct: 3,
      runnerMaxTapePrior5mPct: 0,
    } as MildDipConfig['green'];
    expect(greenLaneGatesFrom(green, false)).toMatchObject({
      minLiquidityUsd: 20_000,
      minPairAgeHours: 1,
      maxBounceFromTroughPct: 25,
      maxTapeRet1mPct: 2,
      maxTapePrior5mPct: 3,
    });
    expect(greenLaneGatesFrom(green, true)).toMatchObject({
      minLiquidityUsd: 8_000,
      minPairAgeHours: 0,
      maxBounceFromTroughPct: 0,
      maxTapeRet1mPct: Number.POSITIVE_INFINITY,
      maxTapePrior5mPct: Number.POSITIVE_INFINITY,
    });
    expect(evaluateGreenLane(input, gates).pass).toBe(true);
  });
});
