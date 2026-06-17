import { describe, it, expect, beforeEach } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';
import { waveBPostTp1ScratchEligible } from '../src/papertrader/executor/exit-policy-wave-b.js';
import {
  armWaveBPostTp1ScratchReentry,
  configureWaveBPostTp1ScratchReentry,
  consumeWaveBPostTp1ScratchReentry,
  resetWaveBPostTp1ScratchReentryForTests,
  waveBPostTp1ScratchFullExitDue,
  waveBPostTp1ScratchReentryBypassGate,
  waveBPostTp1ScratchReentryDue,
  waveBPostTp1ScratchReentryPending,
  waveBPostTp1ScratchSignalDropPct,
} from '../src/papertrader/executor/wave-b-post-tp1-scratch-reentry.js';

function cfg(overrides: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    strategyId: 'live-oscar',
    liveOscarWaveBPostTp1ScratchReentryEnabled: true,
    liveOscarWaveBPostTp1ScratchDropPct: 15,
    liveOscarWaveBPostTp1ScratchReentryDropPct: 30,
    liveOscarWaveBPostTp1ScratchReentryUsd: 1500,
    liveStagedEntrySignalTtlMs: 0,
    ...overrides,
  } as unknown as PaperTraderConfig;
}

function waveBOt(partial: Partial<OpenTrade> = {}): OpenTrade {
  return {
    liveExitPolicyId: 'wave_b_v1',
    partialSells: [{ reason: 'TP_LADDER' } as OpenTrade['partialSells'][0]],
    liveStagedEntry: {
      signalTs: 1_700_000_000_000,
      signalPriceUsd: 1,
      firstDropPct: 5,
      firstLegUsd: 1000,
      secondDropPct: 10,
      secondLegUsd: 500,
      killDropPct: 50,
      entrySplitV2: true,
      entrySplitLegUsd: 1000,
      entrySplitTargetDropPct: 10,
    },
    ...partial,
  } as OpenTrade;
}

describe('wave-b-post-tp1-scratch-reentry', () => {
  beforeEach(() => {
    resetWaveBPostTp1ScratchReentryForTests();
    configureWaveBPostTp1ScratchReentry(cfg());
  });

  it('waveBPostTp1ScratchEligible requires wave B, TP1, not yet scratched', () => {
    expect(waveBPostTp1ScratchEligible(waveBOt())).toBe(true);
    expect(waveBPostTp1ScratchEligible(waveBOt({ liveExitPolicyId: 'legacy_grid' }))).toBe(false);
    expect(waveBPostTp1ScratchEligible(waveBOt({ partialSells: [] }))).toBe(false);
    expect(waveBPostTp1ScratchEligible(waveBOt({ liveWavePostTp1ScratchTaken: true }))).toBe(false);
  });

  it('signal drop math uses signal anchor not avg entry', () => {
    expect(waveBPostTp1ScratchSignalDropPct(1, 0.84)).toBeCloseTo(-16, 5);
    expect(waveBPostTp1ScratchFullExitDue(cfg(), waveBOt(), 0.84)).toBe(true);
    expect(waveBPostTp1ScratchFullExitDue(cfg(), waveBOt(), 0.86)).toBe(false);
  });

  it('reentry fires at configured deeper signal drop', () => {
    const pending = {
      mint: 'mintA',
      symbol: 'AAA',
      lane: 'post_migration' as const,
      dex: 'raydium' as const,
      signalTs: 1,
      signalPriceUsd: 1,
      scratchTs: 2,
      scratchDropPct: 15,
      reentryDropPct: 30,
      reentryUsd: 1500,
    };
    expect(waveBPostTp1ScratchReentryDue(pending, 0.7)).toBe(true);
    expect(waveBPostTp1ScratchReentryDue(pending, 0.75)).toBe(false);
  });

  it('arm/consume pending and bypass post-exit gate while armed', () => {
    armWaveBPostTp1ScratchReentry({
      mint: 'mintA',
      symbol: 'AAA',
      lane: 'post_migration',
      dex: 'raydium',
      signalTs: 1,
      signalPriceUsd: 1,
      scratchTs: 2,
      scratchDropPct: 15,
      reentryDropPct: 30,
      reentryUsd: 1500,
    });
    expect(waveBPostTp1ScratchReentryPending('mintA')?.reentryUsd).toBe(1500);
    expect(waveBPostTp1ScratchReentryBypassGate('mintA')).toBe(true);
    consumeWaveBPostTp1ScratchReentry('mintA');
    expect(waveBPostTp1ScratchReentryPending('mintA')).toBeNull();
    expect(waveBPostTp1ScratchReentryBypassGate('mintA')).toBe(false);
  });

  it('scratch takes precedence over derisk when scratch feature enabled', () => {
    const c = cfg({
      liveOscarWaveBPostTp1DeriskEnabled: true,
      liveOscarWaveBPostTp1ScratchReentryEnabled: true,
    });
    const ot = waveBOt({ avgEntry: 1 });
    expect(waveBPostTp1ScratchFullExitDue(c, ot, 0.84)).toBe(true);
  });
});
