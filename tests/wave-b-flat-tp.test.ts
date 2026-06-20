import { describe, it, expect } from 'vitest';
import {
  stampLiveOscarExitPolicyOnOpen,
  waveBTpGridProfileFor,
  waveBDefensiveTrailActive,
  WAVE_B_FLAT_TP_HALF8_RUNNER,
  WAVE_B_FLAT_TP_FLAT15,
  WAVE_B_V1_TP_GRID,
  WAVE_B_V1_TP_GRID_NO_AVG,
  WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC,
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
    liveOscarWaveBFlatTpEnabled: false,
    liveOscarWaveBFlatTpMode: 'half8_runner',
    liveOscarWaveBTimeStopHours: 12,
    ...overrides,
  } as unknown as PaperTraderConfig;
}

function baseOt(): OpenTrade {
  return {
    liveExitProfileMode: 'B',
    liveExitPolicyId: 'wave_b_v1',
    ladderUsedLevels: new Set<number>(),
    ladderUsedIndices: new Set<number>(),
    tpGridOverrides: undefined,
    legs: [{ reason: 'open' } as OpenTrade['legs'][number]],
  } as unknown as OpenTrade;
}

describe('wave-b flat-take', () => {
  it('OFF (no stamp): profile is the escalating ladder (byte-identical)', () => {
    const ot = baseOt();
    expect(waveBTpGridProfileFor(ot)).toBe(WAVE_B_V1_TP_GRID_NO_AVG);
    ot.legs.push({ reason: 'staged_avg' } as OpenTrade['legs'][number]);
    expect(waveBTpGridProfileFor(ot)).toBe(WAVE_B_V1_TP_GRID);
  });

  it('stamped half8_runner: profile is +8% / sell 50%', () => {
    const ot = baseOt();
    ot.liveWaveFlatTpMode = 'half8_runner';
    expect(waveBTpGridProfileFor(ot)).toBe(WAVE_B_FLAT_TP_HALF8_RUNNER);
    expect(WAVE_B_FLAT_TP_HALF8_RUNNER.gridStepPnl).toBe(0.08);
    expect([...WAVE_B_FLAT_TP_HALF8_RUNNER.gridSellFractionByStep]).toEqual([0.5]);
  });

  it('stamped half8_runner overrides averaging-aware selection', () => {
    const ot = baseOt();
    ot.legs.push({ reason: 'staged_avg' } as OpenTrade['legs'][number]);
    ot.liveWaveFlatTpMode = 'half8_runner';
    expect(waveBTpGridProfileFor(ot)).toBe(WAVE_B_FLAT_TP_HALF8_RUNNER);
  });

  it('stamped flat: profile is +15% / sell 100%', () => {
    const ot = baseOt();
    ot.liveWaveFlatTpMode = 'flat';
    expect(waveBTpGridProfileFor(ot)).toBe(WAVE_B_FLAT_TP_FLAT15);
    expect(WAVE_B_FLAT_TP_FLAT15.gridStepPnl).toBe(0.15);
    expect([...WAVE_B_FLAT_TP_FLAT15.gridSellFractionByStep]).toEqual([1]);
  });

  it('tpGridEffective for half8_runner: step 8%, every rung sells 50% (clamped)', () => {
    const ot = baseOt();
    ot.liveWaveFlatTpMode = 'half8_runner';
    const g = tpGridEffective(ot, cfg());
    expect(g.stepPnl).toBe(0.08);
    expect(g.sellFractionForStep(1)).toBe(0.5);
    expect(g.sellFractionForStep(2)).toBe(0.5);
    expect(g.sellFractionForStep(9)).toBe(0.5);
  });

  it('tpGridEffective for flat: step 15%, first rung sells 100%', () => {
    const ot = baseOt();
    ot.liveWaveFlatTpMode = 'flat';
    const g = tpGridEffective(ot, cfg());
    expect(g.stepPnl).toBe(0.15);
    expect(g.sellFractionForStep(1)).toBe(1);
  });

  it('defensive trail suppressed for flat, active for half8_runner at peak >= +7.5%', () => {
    const peak = WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC + 0.02;

    const flat = baseOt();
    flat.liveWaveFlatTpMode = 'flat';
    flat.liveWavePeakPnlFrac = peak;
    expect(waveBDefensiveTrailActive(flat, 0.15)).toBe(false);

    const runner = baseOt();
    runner.liveWaveFlatTpMode = 'half8_runner';
    runner.liveWavePeakPnlFrac = peak;
    expect(waveBDefensiveTrailActive(runner, 0.08)).toBe(true);
  });

  it('stamp: flag OFF leaves mode unset (escalating); flag ON stamps the configured mode', () => {
    const off = baseOt();
    off.liveExitPolicyId = undefined;
    stampLiveOscarExitPolicyOnOpen(off, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    expect(off.liveExitPolicyId).toBe('wave_b_v1');
    expect(off.liveWaveFlatTpMode).toBeUndefined();

    const onRunner = baseOt();
    onRunner.liveExitPolicyId = undefined;
    stampLiveOscarExitPolicyOnOpen(
      onRunner,
      cfg({ liveOscarExitPolicyWaveBEnabled: true, liveOscarWaveBFlatTpEnabled: true, liveOscarWaveBFlatTpMode: 'half8_runner' }),
    );
    expect(onRunner.liveWaveFlatTpMode).toBe('half8_runner');

    const onFlat = baseOt();
    onFlat.liveExitPolicyId = undefined;
    stampLiveOscarExitPolicyOnOpen(
      onFlat,
      cfg({ liveOscarExitPolicyWaveBEnabled: true, liveOscarWaveBFlatTpEnabled: true, liveOscarWaveBFlatTpMode: 'flat' }),
    );
    expect(onFlat.liveWaveFlatTpMode).toBe('flat');
  });
});
