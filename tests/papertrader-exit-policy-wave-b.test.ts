import { describe, it, expect } from 'vitest';
import {
  ensureLiveOscarExitPolicyPinned,
  isWaveBExitPolicy,
  migrateLegacyOpenToWaveB,
  resolveLiveOscarExitPolicyForTick,
  stampLiveOscarExitPolicyOnOpen,
  waveBOnNewHigh,
  clampLiveTrackerMtmForExit,
  waveBNextTrailLevelToFire,
  waveBRecoverPhantomPeakIfNeeded,
  WAVE_B_V1_TP_GRID,
  WAVE_B_V1_TP_GRID_NO_AVG,
  hasAveragingLeg,
  refreshWaveBGridOverrides,
  waveBSellFractionForStep,
  waveBTpGridProfileFor,
  LEGACY_LIVE_OSCAR_TP_GRID,
  WAVE_B_MTM_MAX_TICK_JUMP_FRAC,
  WAVE_B_TRAIL_FLUSH_REMAIN_USD,
  waveBRemainderValueNetUsd,
  waveBTrailSellFractionForRemainder,
  waveBAdjustSellFractionForRemainder,
  waveBDefensiveTrailActive,
  waveBBreakevenExitEligible,
  waveBFirstTwoTpRungsTaken,
  waveBBreakevenInsuranceEligible,
  waveBPostTp1ScratchEligible,
  waveBMaybeResetTpImpulse,
  waveBUpdatePreArmImpulseCycle,
  waveBAbsoluteKillEligible,
  waveBPreArmKillEligible,
  WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC,
  WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC,
} from '../src/papertrader/executor/exit-policy-wave-b.js';
import { tpGridEffective } from '../src/papertrader/executor/tp-grid-effective.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    strategyId: 'live-oscar',
    liveExitModeAbEnabled: true,
    tpGridStepPnl: 0.025,
    tpGridSellFractionByStep: [0, 0.1, 0.2],
    liveOscarExitPolicyWaveBEnabled: false,
    ...overrides,
  } as unknown as PaperTraderConfig;
}

function baseOt(): OpenTrade {
  return {
    liveExitProfileMode: 'B',
    ladderUsedLevels: new Set([0.05, 0.075]),
    ladderUsedIndices: new Set([1, 2]),
    tpGridOverrides: undefined,
    legs: [{ reason: 'open' } as OpenTrade['legs'][number]],
  } as unknown as OpenTrade;
}

function baseOtWithAveraging(): OpenTrade {
  const ot = baseOt();
  ot.legs.push({ reason: 'staged_avg' } as OpenTrade['legs'][number]);
  return ot;
}

describe('exit-policy-wave-b', () => {
  it('pins legacy grid on restore without policy id', () => {
    const ot = baseOt();
    ensureLiveOscarExitPolicyPinned(ot);
    expect(ot.liveExitPolicyId).toBe('legacy_grid');
    expect(ot.tpGridOverrides?.gridStepPnl).toBe(LEGACY_LIVE_OSCAR_TP_GRID.gridStepPnl);
    expect(ot.tpGridOverrides?.gridSellFractionByStep).toEqual([
      0.1, 0.3, 0.5, 0.7, 0.7,
    ]);
  });

  it('stamps wave_b on open when flag enabled (no-avg profile by default)', () => {
    const ot = baseOt();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    expect(isWaveBExitPolicy(ot)).toBe(true);
    expect(ot.tpGridOverrides?.gridStepPnl).toBe(WAVE_B_V1_TP_GRID_NO_AVG.gridStepPnl);
    expect(ot.tpGridOverrides?.gridSellFractionByStep).toEqual([
      ...WAVE_B_V1_TP_GRID_NO_AVG.gridSellFractionByStep,
    ]);
  });

  it('stamps averaging-branch profile when open already has staged_avg leg', () => {
    const ot = baseOtWithAveraging();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    expect(ot.tpGridOverrides?.gridSellFractionByStep).toEqual([
      ...WAVE_B_V1_TP_GRID.gridSellFractionByStep,
    ]);
  });

  it('waveBOnNewHigh resets trail only — TP ladder marks stay until impulse reset', () => {
    const ot = baseOt();
    ot.liveExitPolicyId = 'wave_b_v1';
    ot.liveWaveTrailLevelsTaken = [0.1];
    waveBOnNewHigh(ot, 0.15, 0.025);
    expect(ot.ladderUsedLevels.has(0.05)).toBe(true);
    expect(ot.ladderUsedLevels.has(0.075)).toBe(true);
    expect(ot.liveWaveTrailLevelsTaken).toEqual([]);
    expect(ot.liveWavePeakPnlFrac).toBeCloseTo(0.15);
  });

  it('tpGridEffective respects pinned legacy overrides in mode B', () => {
    const ot = baseOt();
    ensureLiveOscarExitPolicyPinned(ot);
    const eff = tpGridEffective(ot, cfg({ tpGridStepPnl: 0.025, tpGridSellFractionByStep: [0, 0.1, 0.2] }));
    expect(eff.stepPnl).toBe(0.05);
    expect(eff.sellFractionForStep(2)).toBeCloseTo(0.3);
  });

  it('migrates legacy open to wave_b — no-avg profile when no averaging legs', () => {
    const ot = baseOt();
    ot.liveExitPolicyId = 'legacy_grid';
    ot.tpGridOverrides = { gridStepPnl: 0.05, gridSellFractionByStep: [0.1, 0.3, 0.5, 0.7, 0.7] };
    ot.partialSells = [{ reason: 'TP_LADDER' } as OpenTrade['partialSells'][0]];
    ot.remainingFraction = 0.5;
    ot.peakPnlPct = 12;
    expect(resolveLiveOscarExitPolicyForTick(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }), 0.12)).toBe(
      true,
    );
    expect(isWaveBExitPolicy(ot)).toBe(true);
    expect(ot.tpGridOverrides?.gridStepPnl).toBe(0.025);
    expect(ot.tpGridOverrides?.gridSellFractionByStep).toEqual([
      ...WAVE_B_V1_TP_GRID_NO_AVG.gridSellFractionByStep,
    ]);
    expect(migrateLegacyOpenToWaveB(ot)).toBe(false);
  });

  it('migrates legacy open to wave_b — averaging profile when ≥1 dca/staged_avg leg', () => {
    const ot = baseOtWithAveraging();
    ot.liveExitPolicyId = 'legacy_grid';
    ot.tpGridOverrides = { gridStepPnl: 0.05, gridSellFractionByStep: [0.1, 0.3, 0.5, 0.7, 0.7] };
    ot.partialSells = [{ reason: 'TP_LADDER' } as OpenTrade['partialSells'][0]];
    ot.remainingFraction = 0.5;
    ot.peakPnlPct = 12;
    expect(resolveLiveOscarExitPolicyForTick(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }), 0.12)).toBe(
      true,
    );
    expect(ot.tpGridOverrides?.gridSellFractionByStep).toEqual([
      ...WAVE_B_V1_TP_GRID.gridSellFractionByStep,
    ]);
  });

  it('clampLiveTrackerMtmForExit limits single-tick upside spike', () => {
    const ot = {
      lastObservedPriceUsd: 0.114,
      avgEntry: 0.114,
    } as OpenTrade;
    const clamped = clampLiveTrackerMtmForExit(ot, 0.2026);
    expect(clamped).toBeCloseTo(0.114 * (1 + WAVE_B_MTM_MAX_TICK_JUMP_FRAC), 6);
  });

  it('waveBRecoverPhantomPeakIfNeeded disarms armed trail when PnL below arm and no trail sells yet', () => {
    const ot = {
      liveExitPolicyId: 'wave_b_v1',
      trailingArmed: true,
      liveWaveTrailAnchorPnlFrac: 0.13,
      liveWavePeakPnlFrac: 0.13,
      liveWaveTrailLevelsTaken: [0.105],
      partialSells: [],
    } as unknown as OpenTrade;
    expect(waveBRecoverPhantomPeakIfNeeded(ot, -0.02)).toBe(true);
    expect(ot.trailingArmed).toBe(false);
    expect(ot.liveWaveTrailLevelsTaken).toEqual([]);
  });

  it('waveBSellFractionForStep escalates 5% per rung', () => {
    expect(waveBSellFractionForStep(0)).toBe(0);
    expect(waveBSellFractionForStep(1)).toBe(0.05);
    expect(waveBSellFractionForStep(2)).toBe(0.1);
    expect(waveBSellFractionForStep(3)).toBeCloseTo(0.15);
    expect(waveBSellFractionForStep(20)).toBe(1);
    expect(waveBSellFractionForStep(25)).toBe(1);
  });

  it('waveBTrailSellFractionForRemainder flushes full remainder at or below $100', () => {
    const c = cfg();
    expect(waveBTrailSellFractionForRemainder(99.99, c)).toBe(1);
    expect(waveBTrailSellFractionForRemainder(100, c)).toBe(1);
    expect(waveBTrailSellFractionForRemainder(250, c)).toBeCloseTo(0.2);
    expect(WAVE_B_TRAIL_FLUSH_REMAIN_USD).toBe(100);
  });

  it('waveBAdjustSellFractionForRemainder flushes TP and trail below $100', () => {
    const c = cfg();
    expect(waveBAdjustSellFractionForRemainder(80, 0.05, c)).toBe(1);
    expect(waveBAdjustSellFractionForRemainder(80, 0.2, c)).toBe(1);
    expect(waveBAdjustSellFractionForRemainder(150, 0.05, c)).toBeCloseTo(0.05);
    expect(waveBAdjustSellFractionForRemainder(150, 0.2, c)).toBeCloseTo(0.2);
    expect(waveBAdjustSellFractionForRemainder(99, 0, c)).toBe(0);
    /** Buttcoin-style tail: ~$111 × 10% would leave <$100 — sell 100% now. */
    expect(waveBAdjustSellFractionForRemainder(111, 0.1, c)).toBe(1);
    expect(waveBAdjustSellFractionForRemainder(123, 0.1, c)).toBeCloseTo(0.1);
  });

  it('waveBRemainderValueNetUsd scales with remainingFraction and price', () => {
    const ot = {
      totalInvestedUsd: 1000,
      remainingFraction: 0.08,
      avgEntry: 1,
    } as OpenTrade;
    expect(waveBRemainderValueNetUsd(ot, 1.2)).toBeCloseTo(96, 1);
    expect(waveBTrailSellFractionForRemainder(waveBRemainderValueNetUsd(ot, 1.2), cfg())).toBe(1);
  });

  it('waveBNextTrailLevelToFire legacy floor at +7.5% when not defensive', () => {
    expect(waveBNextTrailLevelToFire(0.76, 0.025, -0.02, [], false)).toBe(null);
    expect(waveBNextTrailLevelToFire(0.76, 0.025, 0.73, [], false)).toBeCloseTo(0.735, 6);
    expect(waveBNextTrailLevelToFire(0.76, 0.025, 0.7, [0.735], false)).toBeCloseTo(0.71, 6);
  });

  it('waveBNextTrailLevelToFire defensive mode allows trail below +7.5%', () => {
    expect(waveBNextTrailLevelToFire(0.11, 0.025, 0.03, [], true)).toBeCloseTo(0.085, 6);
    expect(waveBNextTrailLevelToFire(0.11, 0.025, -0.01, [0.085], true)).toBeCloseTo(0.06, 6);
  });

  it('waveBDefensiveTrailActive at +7.5% ladder mark', () => {
    const otBelow = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set([0.05]),
      ladderUsedIndices: new Set([1]),
    } as unknown as OpenTrade;
    expect(waveBDefensiveTrailActive(otBelow, 0.025)).toBe(false);
    const otAtGate = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set([0.075]),
      ladderUsedIndices: new Set([2]),
    } as unknown as OpenTrade;
    expect(waveBDefensiveTrailActive(otAtGate, 0.025)).toBe(true);
    const otAbove = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set<number>(),
      ladderUsedIndices: new Set([3]),
    } as unknown as OpenTrade;
    expect(waveBDefensiveTrailActive(otAbove, 0.025)).toBe(true);
  });

  it('waveBBreakevenExitEligible only after +7.5% gate (touch or executed TP)', () => {
    const otLow = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set([0.05]),
      ladderUsedIndices: new Set([0, 1]),
    } as unknown as OpenTrade;
    expect(waveBBreakevenExitEligible(otLow, 0.025)).toBe(false);
    const otPreArm = {
      liveExitPolicyId: 'wave_b_v1',
      liveWavePreArmReached: true,
      ladderUsedIndices: new Set([0, 1]),
    } as unknown as OpenTrade;
    expect(waveBBreakevenExitEligible(otPreArm, 0.025)).toBe(true);
    const otTp75 = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set([0.075]),
      ladderUsedIndices: new Set([2]),
      liveWaveMaxExecutedTpFrac: 0.075,
    } as unknown as OpenTrade;
    expect(waveBBreakevenExitEligible(otTp75, 0.025)).toBe(true);
  });

  it('waveBUpdatePreArmImpulseCycle keeps marks at 0% for insurance, clears on rally', () => {
    const ot = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set([0.025, 0.05]),
      ladderUsedIndices: new Set([0, 1]),
      liveWaveBreakevenInsuranceTaken: true,
    } as unknown as OpenTrade;
    waveBUpdatePreArmImpulseCycle(ot, 0, 0.025);
    expect(ot.liveWaveImpulseBelowFirstRung).toBe(true);
    expect(ot.ladderUsedLevels.size).toBe(2);
    expect(ot.liveWaveBreakevenInsuranceTaken).toBe(true);
    waveBUpdatePreArmImpulseCycle(ot, 0.03, 0.025);
    expect(ot.liveWaveImpulseBelowFirstRung).toBe(false);
    expect(ot.liveWaveBreakevenInsuranceTaken).toBe(false);
    expect(ot.ladderUsedLevels.size).toBe(0);
  });

  it('waveBUpdatePreArmImpulseCycle clears marks on red dip below 0%', () => {
    const ot = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set([0.025, 0.05]),
      ladderUsedIndices: new Set([0, 1]),
    } as unknown as OpenTrade;
    expect(waveBUpdatePreArmImpulseCycle(ot, -0.07, 0.025)).toBe(true);
    expect(ot.ladderUsedLevels.size).toBe(0);
    expect(ot.liveWaveImpulseBelowFirstRung).toBe(true);
  });

  it('waveBMaybeResetTpImpulse partial clear at +2.5% after +7.5% gate', () => {
    const ot = {
      liveExitPolicyId: 'wave_b_v1',
      liveWavePreArmReached: true,
      ladderUsedLevels: new Set([0.025, 0.05, 0.075, 0.1]),
      ladderUsedIndices: new Set([0, 1, 2, 3]),
      liveWaveMaxExecutedTpFrac: 0.075,
    } as unknown as OpenTrade;
    expect(waveBMaybeResetTpImpulse(ot, 0.025, 0.025)).toBe(true);
    expect(ot.ladderUsedLevels.has(0.025)).toBe(true);
    expect(ot.ladderUsedLevels.has(0.05)).toBe(false);
    expect(ot.ladderUsedLevels.has(0.075)).toBe(false);
    expect(ot.ladderUsedLevels.has(0.1)).toBe(false);
  });

  it('waveBBreakevenExitEligible stays true after impulse reset clears ladder marks', () => {
    const ot = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set<number>(),
      ladderUsedIndices: new Set<number>(),
      liveWaveMaxExecutedTpFrac: 0.075,
    } as unknown as OpenTrade;
    expect(waveBBreakevenExitEligible(ot, 0.025)).toBe(true);
  });

  it('waveBFirstTwoTpRungsTaken requires +2.5% and +5% rungs', () => {
    const step = 0.025;
    const otOne = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedIndices: new Set([0]),
      ladderUsedLevels: new Set<number>(),
    } as unknown as OpenTrade;
    expect(waveBFirstTwoTpRungsTaken(otOne, step)).toBe(false);

    const otTwo = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedIndices: new Set([0, 1]),
      ladderUsedLevels: new Set<number>(),
    } as unknown as OpenTrade;
    expect(waveBFirstTwoTpRungsTaken(otTwo, step)).toBe(true);

    const otLevels = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedIndices: new Set<number>(),
      ladderUsedLevels: new Set([0.025, 0.05]),
    } as unknown as OpenTrade;
    expect(waveBFirstTwoTpRungsTaken(otLevels, step)).toBe(true);
  });

  it('waveBBreakevenInsuranceEligible after first two TPs and before +7.5% gate', () => {
    const step = 0.025;
    const eligible = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedIndices: new Set([0, 1]),
      ladderUsedLevels: new Set([0.025, 0.05]),
      liveWaveMaxExecutedTpFrac: 0.05,
    } as unknown as OpenTrade;
    expect(waveBBreakevenInsuranceEligible(eligible, step)).toBe(true);

    const alreadyTaken = { ...eligible, liveWaveBreakevenInsuranceTaken: true } as OpenTrade;
    expect(waveBBreakevenInsuranceEligible(alreadyTaken, step)).toBe(false);

    const pastFullExitGate = {
      ...eligible,
      liveWaveMaxExecutedTpFrac: 0.075,
    } as unknown as OpenTrade;
    expect(waveBBreakevenInsuranceEligible(pastFullExitGate, step)).toBe(false);

    const onlyFirst = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedIndices: new Set([0]),
      ladderUsedLevels: new Set([0.025]),
      liveWaveMaxExecutedTpFrac: 0.025,
    } as unknown as OpenTrade;
    expect(waveBBreakevenInsuranceEligible(onlyFirst, step)).toBe(false);
  });

  it('wave B no-avg profile: escalating sell per +2.5% rung', () => {
    const ot = baseOt();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    expect(hasAveragingLeg(ot)).toBe(false);
    const eff = tpGridEffective(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    expect(eff.stepPnl).toBe(0.025);
    expect(eff.sellFractionForStep(1)).toBeCloseTo(0.05);
    expect(eff.sellFractionForStep(2)).toBeCloseTo(0.1);
    expect(eff.sellFractionForStep(3)).toBeCloseTo(0.15);
    expect(eff.sellFractionForStep(4)).toBeCloseTo(0.2);
  });

  it('wave B averaging profile: escalating sell per +2.5% rung', () => {
    const ot = baseOtWithAveraging();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    expect(hasAveragingLeg(ot)).toBe(true);
    const eff = tpGridEffective(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    let remain = 1;
    for (let k = 1; k <= 6; k++) {
      remain *= 1 - eff.sellFractionForStep(k);
    }
    expect(eff.stepPnl).toBe(0.025);
    expect(eff.sellFractionForStep(1)).toBeCloseTo(0.05);
    expect(eff.sellFractionForStep(3)).toBeCloseTo(0.15);
    expect(eff.sellFractionForStep(6)).toBeCloseTo(0.3);
    expect(remain).toBeCloseTo(0.302, 2);
  });

  it('tpGridEffective flips wave B fork at runtime when staged_avg appended (no restamp needed)', () => {
    const ot = baseOt();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    const c = cfg({ liveOscarExitPolicyWaveBEnabled: true });
    expect(tpGridEffective(ot, c).stepPnl).toBe(0.025);
    expect(tpGridEffective(ot, c).sellFractionForStep(1)).toBeCloseTo(0.05);
    ot.legs.push({ reason: 'staged_avg' } as OpenTrade['legs'][number]);
    expect(tpGridEffective(ot, c).stepPnl).toBe(0.025);
    expect(tpGridEffective(ot, c).sellFractionForStep(1)).toBeCloseTo(0.05);
    expect(tpGridEffective(ot, c).sellFractionForStep(3)).toBeCloseTo(0.15);
  });

  it('refreshWaveBGridOverrides updates stamped overrides after averaging leg', () => {
    const ot = baseOt();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    expect(ot.tpGridOverrides?.gridSellFractionByStep).toEqual([
      ...WAVE_B_V1_TP_GRID_NO_AVG.gridSellFractionByStep,
    ]);
    ot.legs.push({ reason: 'staged_avg' } as OpenTrade['legs'][number]);
    refreshWaveBGridOverrides(ot);
    expect(ot.tpGridOverrides?.gridSellFractionByStep).toEqual([
      ...WAVE_B_V1_TP_GRID.gridSellFractionByStep,
    ]);
  });

  it('hasAveragingLeg ignores entry split / scale-in legs', () => {
    const ot = baseOt();
    ot.legs.push({ reason: 'entry_split' } as OpenTrade['legs'][number]);
    ot.legs.push({ reason: 'scale_in' } as OpenTrade['legs'][number]);
    expect(hasAveragingLeg(ot)).toBe(false);
    expect(waveBTpGridProfileFor(ot).gridSellFractionByStep).toEqual([
      ...WAVE_B_V1_TP_GRID_NO_AVG.gridSellFractionByStep,
    ]);
    ot.legs.push({ reason: 'dca' } as OpenTrade['legs'][number]);
    expect(hasAveragingLeg(ot)).toBe(true);
  });

  it('defensive arm and pre-arm kill-off threshold is +7.5%', () => {
    expect(WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC).toBe(0.075);
    expect(WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC).toBe(0.075);
  });

  it('waveBAbsoluteKillEligible fires at −9% even after +7.5% pre-arm', () => {
    const ot = {
      liveExitPolicyId: 'wave_b_v1',
      avgEntryMarket: 1,
      legs: [{ price: 1, marketPrice: 1, sizeUsd: 500, reason: 'open' }],
      liveWavePreArmReached: true,
    } as unknown as OpenTrade;
    expect(waveBPreArmKillEligible(ot, -0.09, 0.9)).toBe(false);
    expect(waveBAbsoluteKillEligible(ot, -0.09, 0.9, -0.1)).toBe(true);
  });

  it('waveBClearAllTpLadderMarks re-arms +2.5%/+5% after pullback below first rung', () => {
    const ot = {
      liveExitPolicyId: 'wave_b_v1',
      ladderUsedLevels: new Set([0.025, 0.05]),
      ladderUsedIndices: new Set([0, 1]),
      liveWaveMaxExecutedTpFrac: 0.05,
      liveWaveBreakevenInsuranceTaken: true,
      liveWavePeakPnlFrac: 0.05,
      liveWaveTrailAnchorPnlFrac: 0.05,
      trailingArmed: false,
    } as unknown as OpenTrade;
    expect(waveBMaybeResetTpImpulse(ot, -0.05, 0.025)).toBe(true);
    expect(ot.ladderUsedLevels.size).toBe(0);
    expect(ot.ladderUsedIndices.size).toBe(0);
    expect(ot.liveWaveBreakevenInsuranceTaken).toBe(false);
    expect(ot.liveWaveMaxExecutedTpFrac).toBeCloseTo(0.05);
  });

  it('waveBPostTp1ScratchEligible after first TP partial on wave B', () => {
    const ot = {
      liveExitPolicyId: 'wave_b_v1',
      partialSells: [{ reason: 'TP_LADDER' }],
    } as unknown as OpenTrade;
    expect(waveBPostTp1ScratchEligible(ot)).toBe(true);
    expect(waveBPostTp1ScratchEligible({ ...ot, liveWavePostTp1ScratchTaken: true } as OpenTrade)).toBe(
      false,
    );
  });
});
