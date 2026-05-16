import { describe, it, expect } from 'vitest';
import {
  ensureLiveOscarExitPolicyPinned,
  isWaveBExitPolicy,
  stampLiveOscarExitPolicyOnOpen,
  waveBOnNewHigh,
  WAVE_B_V1_TP_GRID,
  LEGACY_LIVE_OSCAR_TP_GRID,
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

  it('wave B uniform profile cumulative at +20%', () => {
    const ot = baseOt();
    stampLiveOscarExitPolicyOnOpen(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    const eff = tpGridEffective(ot, cfg({ liveOscarExitPolicyWaveBEnabled: true }));
    let remain = 1;
    for (let k = 1; k <= 8; k++) {
      remain *= 1 - eff.sellFractionForStep(k);
    }
    expect(remain).toBeCloseTo(0.2359, 3);
  });
});
