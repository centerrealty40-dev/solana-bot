import { describe, expect, it } from 'vitest';
import {
  evaluateGreenLane,
  type GreenLaneGates,
  type GreenLaneInput,
} from '../../src/milddip/green-lane.js';
import { effectiveRunnerTapeCap } from '../../src/milddip/fast-path.js';
import { resolveGreenEntryRiskFloors } from '../../src/milddip/entry-attempt.js';
import { evaluateMildDipEntryRisk } from '../../src/milddip/gates.js';

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

const freshRunnerPair = {
  pairAgeHours: 0.01,
  volume5mUsd: 12_000,
  liquidityUsd: 17_900,
  buys5m: 60,
  sells5m: 40,
};

const greenFloorArgs = {
  minPairAgeHours: 1,
  minLiquidityUsd: 20_000,
  entryMaxVol5mToLiq: 0,
  runnerMinPairAgeHours: 0,
  runnerMinLiquidityUsd: 8_000,
  runnerEntryMaxVol5mToLiq: 0,
  fallbackMaxVol5mToLiq: 2,
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

  it('runner relaxation propagates to the entry-risk floors', () => {
    const floors = resolveGreenEntryRiskFloors({ ...greenFloorArgs, runnerRelax: true });
    expect(floors).toEqual({
      minPairAgeHours: 0,
      minLiquidityUsd: 8_000,
      maxVol5mToLiq: 0,
    });

    const verdict = evaluateMildDipEntryRisk({
      ...freshRunnerPair,
      minPairAgeHours: floors.minPairAgeHours,
      minLiquidityUsd: floors.minLiquidityUsd,
      maxVol5mToLiq: floors.maxVol5mToLiq,
    });
    expect(verdict.pass).toBe(true);
    expect(
      verdict.reasons.some(
        (reason) =>
          reason.includes('pair_too_young') ||
          reason.includes('liq_too_thin') ||
          reason.includes('vol_liq_churn_too_high'),
      ),
    ).toBe(false);
  });

  it('keeps the standard green entry-risk floors without relaxation', () => {
    const floors = resolveGreenEntryRiskFloors({ ...greenFloorArgs, runnerRelax: false });
    expect(floors).toEqual({
      minPairAgeHours: 1,
      minLiquidityUsd: 20_000,
      maxVol5mToLiq: 2,
    });

    const verdict = evaluateMildDipEntryRisk({
      ...freshRunnerPair,
      minPairAgeHours: floors.minPairAgeHours,
      minLiquidityUsd: floors.minLiquidityUsd,
      maxVol5mToLiq: floors.maxVol5mToLiq,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some((reason) => reason.includes('pair_too_young'))).toBe(true);
    expect(verdict.reasons.some((reason) => reason.includes('liq_too_thin'))).toBe(true);
  });

  it('respects a configured runner liquidity floor while relaxed', () => {
    const floors = resolveGreenEntryRiskFloors({
      ...greenFloorArgs,
      runnerRelax: true,
      runnerMinLiquidityUsd: 50_000,
    });
    expect(floors.minLiquidityUsd).toBe(50_000);

    const verdict = evaluateMildDipEntryRisk({
      ...freshRunnerPair,
      minPairAgeHours: floors.minPairAgeHours,
      minLiquidityUsd: floors.minLiquidityUsd,
      maxVol5mToLiq: floors.maxVol5mToLiq,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some((reason) => reason.includes('liq_too_thin'))).toBe(true);
  });

  it('falls back to the shared churn cap when the green cap is unset', () => {
    expect(
      resolveGreenEntryRiskFloors({
        ...greenFloorArgs,
        runnerRelax: false,
        entryMaxVol5mToLiq: 0,
        fallbackMaxVol5mToLiq: 3,
      }).maxVol5mToLiq,
    ).toBe(3);
    expect(
      resolveGreenEntryRiskFloors({
        ...greenFloorArgs,
        runnerRelax: false,
        entryMaxVol5mToLiq: 5,
        fallbackMaxVol5mToLiq: 3,
      }).maxVol5mToLiq,
    ).toBe(5);
  });
});
