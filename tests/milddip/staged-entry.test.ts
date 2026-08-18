import { describe, expect, it } from 'vitest';
import {
  evaluateStagedEntryAdd,
  evaluateStagedProfitExit,
  resolveStagedEntryFirstClip,
  stagedEntryAverageCostPx,
} from '../../src/milddip/staged-entry.js';
import { resolveMildDipWantedSizeUsd } from '../../src/milddip/gates.js';

describe('mild-dip staged entry', () => {
  it('caps a new $18 curve clip at $5 and remembers the intended size', () => {
    expect(
      resolveStagedEntryFirstClip({
        enabled: true,
        isNewBag: true,
        isProbe: false,
        isGreen: false,
        sizeUsd: 18,
        firstUsd: 5,
      }),
    ).toEqual({ sizeUsd: 5, intendedUsd: 18, active: true });
  });

  it('does not stage disabled, probe, existing, or green entries', () => {
    for (const patch of [
      { enabled: false },
      { isProbe: true },
      { isNewBag: false },
      { isGreen: true },
    ]) {
      expect(
        resolveStagedEntryFirstClip({
          enabled: true,
          isNewBag: true,
          isProbe: false,
          isGreen: false,
          sizeUsd: 18,
          firstUsd: 5,
          ...patch,
        }).sizeUsd,
      ).toBe(18);
    }
  });

  it('keeps the first-touch curve cap when staged entry is disabled', () => {
    const wanted = resolveMildDipWantedSizeUsd({
      basePositionUsd: 3,
      liqPowerLaw: { coef: 0.001888, exp: 0.866, minUsd: 5, maxUsd: 30 },
      thick: {
        positionUsd: 20,
        minMarketCapUsd: 100_000,
        minLiquidityUsd: 50_000,
        minPairAgeHours: 6,
      },
      metrics: {
        liquidityUsd: 21_008.46,
        marketCapUsd: 30_000,
        pairAgeHours: 2,
      },
    });
    const firstTouchUsd = Math.min(10, wanted.sizeUsd);
    const clip = resolveStagedEntryFirstClip({
      enabled: false,
      isNewBag: true,
      isProbe: false,
      isGreen: false,
      sizeUsd: Math.max(5, firstTouchUsd),
      firstUsd: 5,
    });
    expect(wanted.sizeUsd).toBeCloseTo(10.45, 1);
    expect(firstTouchUsd).toBe(10);
    expect(clip).toEqual({ sizeUsd: 10, intendedUsd: null, active: false });
  });

  const base = {
    enabled: true,
    addDone: false,
    attempts: 0,
    nowMs: 100_000,
    firstFillPx: 100,
    anchorMode: 'fill' as const,
    troughPx: null,
    troughAtMs: null,
    triggerPct: 8,
    maxChasePct: 4,
    troughTriggerPct: 8,
    troughBandPct: 4,
    minTroughAgeMs: 60_000,
    intendedUsd: 18,
    alreadyFilledUsd: 5,
    addMult: 2,
    addMaxUsd: 40,
    liquidityUsd: 20_000,
    minLiquidityUsd: 15_000,
    liquidityDrainActive: false,
    rugRiskActive: false,
  };

  it('waits below +8%, then adds 2x intended less the first clip at the trigger', () => {
    expect(evaluateStagedEntryAdd({ ...base, markPx: 107 }).shouldAdd).toBe(false);
    const add = evaluateStagedEntryAdd({ ...base, markPx: 108 });
    expect(add.shouldAdd).toBe(true);
    expect(add.addUsd).toBe(31);
  });

  it('skips above the chase band without consuming attempts, then adds on pullback', () => {
    const above = evaluateStagedEntryAdd({ ...base, markPx: 113 });
    expect(above).toMatchObject({ shouldAdd: false, reason: 'above_chase_band' });
    expect(base.attempts).toBe(0);
    expect(evaluateStagedEntryAdd({ ...base, markPx: 111.5 }).shouldAdd).toBe(true);
  });

  it('supports fill anchoring as a configuration-only rollback', () => {
    expect(
      evaluateStagedEntryAdd({
        ...base,
        anchorMode: 'fill',
        troughPx: 50,
        troughAtMs: 1,
        markPx: 107,
      }),
    ).toMatchObject({ shouldAdd: false, reason: 'below_trigger', triggerPx: 108 });
    expect(
      evaluateStagedEntryAdd({
        ...base,
        anchorMode: 'fill',
        troughPx: 50,
        troughAtMs: 1,
        markPx: 108,
      }),
    ).toMatchObject({ shouldAdd: true, anchorPx: 100, anchorAtMs: null });
  });

  it('caps the one-shot add at $40', () => {
    const add = evaluateStagedEntryAdd({
      ...base,
      markPx: 108,
      intendedUsd: 30,
      alreadyFilledUsd: 5,
    });
    expect(add.addUsd).toBe(40);
  });

  it('returns target_filled without an add when the add cap is zero', () => {
    expect(
      evaluateStagedEntryAdd({
        ...base,
        markPx: 108,
        addMaxUsd: 0,
      }),
    ).toMatchObject({ shouldAdd: false, addUsd: 0, reason: 'target_filled' });
  });

  it('disabled staged entry reproduces the no-add behavior', () => {
    expect(evaluateStagedEntryAdd({ ...base, enabled: false, markPx: 200 })).toMatchObject({
      shouldAdd: false,
      addUsd: 0,
      reason: 'disabled',
    });
  });

  const troughBase = {
    ...base,
    anchorMode: 'trough' as const,
    troughPx: 100,
    troughAtMs: 1,
    nowMs: 120_000,
    maxChasePct: 10,
  };

  it('uses the trough trigger and rejects marks below the trough corridor', () => {
    expect(
      evaluateStagedEntryAdd({ ...troughBase, markPx: 107.99 }),
    ).toMatchObject({ shouldAdd: false, reason: 'below_trough_trigger', triggerPx: 108 });
  });

  it('adds inside the trough corridor after the trough has stabilized', () => {
    const verdict = evaluateStagedEntryAdd({
      ...troughBase,
      markPx: 110,
      troughAtMs: 1,
    });
    expect(verdict).toMatchObject({
      shouldAdd: true,
      triggerPx: 108,
      anchorPx: 100,
      anchorAtMs: 1,
    });
    expect(verdict.bounceOffAnchorPct).toBeCloseTo(10);
    expect(verdict.markVsFirstFillPct).toBeCloseTo(10);
  });

  it('rejects marks above the trough corridor', () => {
    expect(
      evaluateStagedEntryAdd({ ...troughBase, markPx: 112.01 }),
    ).toMatchObject({ shouldAdd: false, reason: 'above_trough_band' });
  });

  it('requires the trough to be at least the configured age', () => {
    expect(
      evaluateStagedEntryAdd({ ...troughBase, markPx: 110, troughAtMs: 70_001 }),
    ).toMatchObject({ shouldAdd: false, reason: 'trough_too_fresh' });
  });

  it('rejects trough mode without a usable trough', () => {
    expect(
      evaluateStagedEntryAdd({
        ...troughBase,
        troughPx: null,
        troughAtMs: null,
        markPx: 110,
      }),
    ).toMatchObject({ shouldAdd: false, reason: 'missing_trough' });
  });

  it('keeps the first-fill chase ceiling active in trough mode', () => {
    expect(
      evaluateStagedEntryAdd({ ...troughBase, maxChasePct: 2, markPx: 111 }),
    ).toMatchObject({ shouldAdd: false, reason: 'above_chase_band' });
  });

  it('vetoes profit sleeve and TP exits below weighted average cost', () => {
    const args = {
      exitPx: 101,
      entryPriceUsd: 100,
      stagedAddDone: true,
      avgCostPx: 100,
      minOverAvgPct: 1,
    };
    expect(evaluateStagedProfitExit({ ...args, reason: 'mfe_bank_sleeve' }).allow).toBe(true);
    expect(evaluateStagedProfitExit({ ...args, reason: 'tp_grid' }).allow).toBe(true);
    expect(evaluateStagedProfitExit({ ...args, reason: 'mfe_bank_sleeve', exitPx: 100.9 }).allow).toBe(false);
    expect(evaluateStagedProfitExit({ ...args, reason: 'tp_grid', exitPx: 100.9 }).allow).toBe(false);
  });

  it('leaves protective exits unchanged and no-add average cost equals entry', () => {
    expect(
      evaluateStagedProfitExit({
        reason: 'peak_giveback',
        exitPx: 50,
        entryPriceUsd: 100,
        stagedAddDone: true,
        avgCostPx: 100,
        minOverAvgPct: 1,
      }).allow,
    ).toBe(true);
    expect(
      evaluateStagedProfitExit({
        reason: 'hard_stop',
        exitPx: 50,
        entryPriceUsd: 100,
        stagedAddDone: true,
        avgCostPx: 100,
        minOverAvgPct: 1,
      }).allow,
    ).toBe(true);
    expect(stagedEntryAverageCostPx({ entryPriceUsd: 100 })).toBe(100);
  });

  it('keeps an underwater sleeve protective and only vetoes between entry and average cost', () => {
    const args = {
      reason: 'mfe_bank_sleeve',
      entryPriceUsd: 100,
      stagedAddDone: true,
      avgCostPx: 110,
      minOverAvgPct: 1,
    };
    expect(evaluateStagedProfitExit({ ...args, exitPx: 90 }).allow).toBe(true);
    expect(evaluateStagedProfitExit({ ...args, exitPx: 105 }).allow).toBe(false);
    expect(evaluateStagedProfitExit({ ...args, exitPx: 111.1 }).allow).toBe(true);
  });

  it('never vetoes a bag without a staged add', () => {
    expect(
      evaluateStagedProfitExit({
        reason: 'mfe_bank_sleeve',
        exitPx: 100.5,
        entryPriceUsd: 100,
        stagedAddDone: false,
        avgCostPx: 110,
        minOverAvgPct: 1,
      }).allow,
    ).toBe(true);
  });

  it('expires a staged-profit veto at the configured cap', () => {
    const result = evaluateStagedProfitExit({
      reason: 'mfe_bank_sleeve',
      exitPx: 105,
      entryPriceUsd: 100,
      stagedAddDone: true,
      avgCostPx: 110,
      minOverAvgPct: 1,
      vetoSinceMs: 1_000,
      nowMs: 1_800_000,
      vetoMaxMs: 1_799_000,
    });
    expect(result).toEqual({
      allow: true,
      thresholdPx: 111.1,
      reason: 'veto_expired',
    });
  });
});
