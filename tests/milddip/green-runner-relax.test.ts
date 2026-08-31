import { describe, expect, it } from 'vitest';
import {
  evaluateGreenLane,
  type GreenLaneGates,
  type GreenLaneInput,
} from '../../src/milddip/green-lane.js';
import { effectiveRunnerTapeCap } from '../../src/milddip/fast-path.js';

const snapshot: GreenLaneInput = {
  pc5mPct: 72.01,
  pc1hPct: 59.32,
  dumpExtentFromPeakPct: -45.08,
  rallyIntoPeakPct: 0,
  bounceFromTroughPct: 324.33,
  tapeRet1mPct: null,
  tapePrior5mPct: null,
  volume5mUsd: 10_000,
  volume1hUsd: 60_000,
  liquidityUsd: 20_634.91,
  buys5m: 50,
  sells5m: 50,
  pairAgeHours: 0.36,
};

const sharedGates: GreenLaneGates = {
  enabled: true,
  minTurnover5mLiq: 0.03,
  minVolume5mUsd: 150,
  minVolume1hUsd: 0,
  minPc5mPct: 14,
  maxPc5mPct: 100,
  maxRallyIntoPeakPct: 0,
  maxBounceFromTroughPct: 25,
  minDumpFromPeakPct: 0,
  tapeMinuteGatesEnabled: false,
  minTapeRet1mPct: 5,
  maxTapePrior5mPct: 10,
  requirePc1h: true,
  minPc1hPct: 20,
  minBuys5m: 0,
  maxBuyShare5m: 0.65,
  minLiquidityUsd: 20_000,
  minPairAgeHours: 1,
  maxRet1mPct: 0,
  maxTapeRet1mPct: 1000,
};

describe('GREEN runner relaxation', () => {
  it('selects runner tape caps without changing normal caps', () => {
    expect(effectiveRunnerTapeCap(false, 0, 2)).toBe(2);
    expect(effectiveRunnerTapeCap(true, 0, 2)).toBe(Number.POSITIVE_INFINITY);
    expect(effectiveRunnerTapeCap(true, 40, 2)).toBe(40);
  });

  it('passes a fresh leader-active runner only with relaxed age, liquidity, and bounce floors', () => {
    const current = evaluateGreenLane(snapshot, sharedGates);
    expect(current.pass).toBe(false);
    expect(current.reasons.some((reason) => reason.startsWith('green_pair_age_floor'))).toBe(true);
    expect(current.reasons).toContain('green_bounce_from_trough=324.33');

    const relaxed = evaluateGreenLane(snapshot, {
      ...sharedGates,
      minPairAgeHours: 0,
      minLiquidityUsd: 8_000,
      maxBounceFromTroughPct: 0,
    });
    expect(relaxed.pass).toBe(true);
  });

  it('relaxes tape caps for the fresh leader runner without relaxing the dump gate', () => {
    const runnerSnapshot: GreenLaneInput = {
      ...snapshot,
      pairAgeHours: null,
      liquidityUsd: 21_384.69,
      bounceFromTroughPct: 102.21,
      tapeRet1mPct: 24.28,
      tapePrior5mPct: 12.63,
      dumpExtentFromPeakPct: -12.5,
    };
    const runnerGates: GreenLaneGates = {
      ...sharedGates,
      minDumpFromPeakPct: 10,
      tapeMinuteGatesEnabled: true,
      minTapeRet1mPct: -100,
      minPairAgeHours: 0,
      minLiquidityUsd: 8_000,
      maxBounceFromTroughPct: 0,
      maxTapeRet1mPct: Number.POSITIVE_INFINITY,
      maxTapePrior5mPct: Number.POSITIVE_INFINITY,
    };
    expect(evaluateGreenLane(runnerSnapshot, runnerGates).pass).toBe(true);

    const normal = evaluateGreenLane(runnerSnapshot, {
      ...runnerGates,
      minPairAgeHours: 1,
      minLiquidityUsd: 20_000,
      maxBounceFromTroughPct: 25,
      maxTapeRet1mPct: 2,
      maxTapePrior5mPct: 10,
    });
    expect(normal.pass).toBe(false);
    expect(normal.reasons.some((reason) => reason.includes('green_pair_age_floor'))).toBe(true);
    expect(normal.reasons.some((reason) => reason.includes('green_bounce_from_trough'))).toBe(
      true,
    );
    expect(normal.reasons.some((reason) => reason.includes('tapeRet1m_max'))).toBe(true);
    expect(normal.reasons.some((reason) => reason.includes('tapePrior5m'))).toBe(true);

    const shallow = evaluateGreenLane(
      { ...runnerSnapshot, dumpExtentFromPeakPct: -2 },
      runnerGates,
    );
    expect(shallow.pass).toBe(false);
    expect(shallow.reasons.some((reason) => reason.includes('green_dump_shallow'))).toBe(true);
  });
});
