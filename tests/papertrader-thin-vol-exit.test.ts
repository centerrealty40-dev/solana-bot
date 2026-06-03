import { describe, it, expect } from 'vitest';
import {
  variantAHybridThinVolFlushReady,
  variantAHybridThinVolStep,
  VARIANT_A_V2_POLICY_ID,
} from '../src/papertrader/executor/exit-policy-variant-a.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    strategyId: 'live-oscar',
    liveOscarThinVolExitEnabled: true,
    ...overrides,
  } as unknown as PaperTraderConfig;
}

function hybridOt(): OpenTrade {
  return {
    liveExitPolicyId: VARIANT_A_V2_POLICY_ID,
    liveThinVolEntryVol5mUsd: 40_000,
    liveWavePeakPnlFrac: 0.1,
    remainingFraction: 0.9,
    partialSells: [{ reason: 'TP_LADDER' } as OpenTrade['partialSells'][0]],
    avgEntry: 1,
    totalInvestedUsd: 750,
    legs: [],
  } as unknown as OpenTrade;
}

describe('variantAHybridThinVolFlush', () => {
  it('requires two consecutive thin ticks and PnL gates', () => {
    const ot = hybridOt();
    expect(variantAHybridThinVolStep(ot, 10_000)).toBe(true);
    expect(variantAHybridThinVolFlushReady(ot, cfg(), 0.03, 10_000)).toBe(false);
    expect(variantAHybridThinVolFlushReady(ot, cfg(), 0.03, 10_000)).toBe(true);
  });

  it('does not fire without first TP', () => {
    const ot = hybridOt();
    ot.partialSells = [];
    ot.liveThinVolStreak = 0;
    expect(variantAHybridThinVolFlushReady(ot, cfg(), 0.05, 5_000)).toBe(false);
  });

  it('disabled when env off', () => {
    const ot = hybridOt();
    expect(variantAHybridThinVolFlushReady(ot, cfg({ liveOscarThinVolExitEnabled: false }), 0.05, 5_000)).toBe(
      false,
    );
  });
});
