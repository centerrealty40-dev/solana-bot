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
  LEGACY_LIVE_OSCAR_TP_GRID,
  WAVE_B_MTM_MAX_TICK_JUMP_FRAC,
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
  } as unknown as OpenTrade;
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

  it('stamps wave_b on open when flag enabled', () => {
    const ot = baseOt();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    expect(isWaveBExitPolicy(ot)).toBe(true);
    expect(ot.tpGridOverrides?.gridStepPnl).toBe(WAVE_B_V1_TP_GRID.gridStepPnl);
  });

  it('waveBOnNewHigh clears ladder levels below new peak', () => {
    const ot = baseOt();
    ot.liveExitPolicyId = 'wave_b_v1';
    waveBOnNewHigh(ot, 0.15, 0.025);
    expect(ot.ladderUsedLevels.has(0.05)).toBe(false);
    expect(ot.ladderUsedLevels.has(0.075)).toBe(false);
    expect(ot.liveWaveTrailLevelsTaken).toEqual([]);
  });

  it('tpGridEffective respects pinned legacy overrides in mode B', () => {
    const ot = baseOt();
    ensureLiveOscarExitPolicyPinned(ot);
    const eff = tpGridEffective(ot, cfg({ tpGridStepPnl: 0.025, tpGridSellFractionByStep: [0, 0.1, 0.2] }));
    expect(eff.stepPnl).toBe(0.05);
    expect(eff.sellFractionForStep(2)).toBeCloseTo(0.3);
  });

  it('migrates legacy open to wave_b when flag enabled', () => {
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
    expect(ot.tpGridOverrides?.gridSellFractionByStep).toEqual([0, 0, 0.1, 0.25, 0.25, 0.25, 0.25, 0.25, 0.15]);
    expect(migrateLegacyOpenToWaveB(ot)).toBe(false);
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
      liveWaveTrailAnchorPnlFrac: 0.76,
      liveWavePeakPnlFrac: 0.76,
      liveWaveTrailLevelsTaken: [0.735],
      partialSells: [],
    } as unknown as OpenTrade;
    expect(waveBRecoverPhantomPeakIfNeeded(ot, -0.02)).toBe(true);
    expect(ot.trailingArmed).toBe(false);
    expect(ot.liveWaveTrailLevelsTaken).toEqual([]);
  });

  it('waveBNextTrailLevelToFire returns one level and skips underwater PnL', () => {
    expect(waveBNextTrailLevelToFire(0.76, 0.025, -0.02, [])).toBe(null);
    expect(waveBNextTrailLevelToFire(0.76, 0.025, 0.73, [])).toBeCloseTo(0.735, 6);
    expect(waveBNextTrailLevelToFire(0.76, 0.025, 0.7, [0.735])).toBeCloseTo(0.71, 6);
  });

  it('wave B uniform profile cumulative at +20%', () => {
    const ot = baseOt();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    const eff = tpGridEffective(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    let remain = 1;
    for (let k = 1; k <= 8; k++) {
      remain *= 1 - eff.sellFractionForStep(k);
    }
    expect(eff.sellFractionForStep(3)).toBeCloseTo(0.1);
    expect(eff.sellFractionForStep(4)).toBeCloseTo(0.25);
    expect(eff.sellFractionForStep(8)).toBeCloseTo(0.25);
    expect(remain).toBeCloseTo(0.2136, 3);
  });
});
