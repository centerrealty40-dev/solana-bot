import { describe, expect, it } from 'vitest';
import { evaluateAwakeningPreBuy } from '../../src/volgreen/entry-gates.js';
import { evaluateMildDipPeakGiveback, type MildDipExitGates } from '../../src/milddip/gates.js';

describe('evaluateAwakeningPreBuy', () => {
  it('passes when price available, pc5m ok, no chase', () => {
    const v = evaluateAwakeningPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.02,
      freshPc5mPct: 5,
      maxChasePct: 5,
      minFreshPc5mPct: 0,
    });
    expect(v.pass).toBe(true);
  });

  it('blocks short red ring', () => {
    const v = evaluateAwakeningPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.01,
      freshPc5mPct: 5.28,
      maxChasePct: 5,
      minFreshPc5mPct: 0,
      shortRingPc: -3.5,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_short_red'))).toBe(true);
  });
});

describe('vol-green uses Oscar mfeBank exit', () => {
  const gates: MildDipExitGates = {
    armPct: 5,
    partialGivebackPct: 3,
    scaleOutFraction: 0.5,
    givebackPct: 8,
    mfeBankEnabled: true,
    mfeBank1Pct: 8,
    mfeBank1Fraction: 0.4,
    mfeBank2Pct: 15,
    mfeBank2Fraction: 0.4,
    mfeBankSleeveGivebackPct: 12,
    neverArmPatienceMs: 0,
    neverArmMaxHoldMs: 0,
    hardMaxHoldMs: 0,
    neverArmDeadMinMs: 0,
    neverArmDeadPnlPct: 10,
    neverArmStaleMinMs: 0,
    neverArmStaleMaxMfePct: 2,
    neverArmStalePnlPct: 5,
    neverArmVolFadeMinMs: 0,
    neverArmVolFadeRatio: 0.25,
    neverArmVolFadeFloorUsd: 300,
    neverArmVolFadeSampleMs: 300_000,
    neverArmVolFadeWeakWindows: 3,
    cliffDumpPnlPct: 50,
    neverArmBounceMinDumpPct: 8,
    neverArmBouncePct: 8,
    neverArmBounceMinTroughAgeMs: 60_000,
    neverArmBounceRequireRedPct: 3,
    neverArmFreefallPnlPct: 0,
    neverArmFreefallMinMs: 0,
    neverArmTimeRedMinMs: 900_000,
    neverArmTimeRedPnlPct: 5,
  };

  it('arms and banks like Oscar', () => {
    const armed = evaluateMildDipPeakGiveback({
      entryPriceUsd: 1,
      markPriceUsd: 1.1,
      peakPriceUsd: 1.1,
      armed: false,
      gates,
      heldMs: 60_000,
      mfeBankStage: 0,
    });
    expect(armed.armed).toBe(true);
    expect(armed.shouldExit).toBe(true);
    expect(armed.reason).toBe('mfe_bank_1');
  });
});
