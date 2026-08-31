import { describe, expect, it } from 'vitest';
import { evaluateGreenLane, type GreenLaneGates, type GreenLaneInput } from '../../src/milddip/green-lane.js';

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
});
