import { describe, expect, it } from 'vitest';
import {
  evaluateStagedEntryAdd,
  evaluateStagedProfitExit,
  resolveStagedEntryFirstClip,
  stagedEntryAverageCostPx,
} from '../../src/milddip/staged-entry.js';

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

  const base = {
    enabled: true,
    addDone: false,
    attempts: 0,
    nowMs: 100_000,
    firstFillPx: 100,
    triggerPct: 8,
    maxChasePct: 4,
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

  it('caps the one-shot add at $40', () => {
    const add = evaluateStagedEntryAdd({
      ...base,
      markPx: 108,
      intendedUsd: 30,
      alreadyFilledUsd: 5,
    });
    expect(add.addUsd).toBe(40);
  });

  it('disabled staged entry reproduces the no-add behavior', () => {
    expect(evaluateStagedEntryAdd({ ...base, enabled: false, markPx: 200 })).toMatchObject({
      shouldAdd: false,
      addUsd: 0,
      reason: 'disabled',
    });
  });

  it('vetoes profit sleeve and TP exits below weighted average cost', () => {
    const args = { exitPx: 101, avgCostPx: 100, minOverAvgPct: 1 };
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
        avgCostPx: 100,
        minOverAvgPct: 1,
      }).allow,
    ).toBe(true);
    expect(
      evaluateStagedProfitExit({
        reason: 'hard_stop',
        exitPx: 50,
        avgCostPx: 100,
        minOverAvgPct: 1,
      }).allow,
    ).toBe(true);
    expect(stagedEntryAverageCostPx({ entryPriceUsd: 100 })).toBe(100);
  });
});
