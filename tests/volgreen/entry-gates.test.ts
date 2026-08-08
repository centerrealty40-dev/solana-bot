import { describe, expect, it } from 'vitest';
import { evaluateAwakeningPreBuy } from '../../src/volgreen/entry-gates.js';
import { evaluateMildDipPeakGiveback } from '../../src/milddip/gates.js';

describe('evaluateAwakeningPreBuy', () => {
  it('passes when price still green and within chase', () => {
    const v = evaluateAwakeningPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.02,
      freshPc5mPct: 3,
      maxChasePct: 4,
      minFreshPc5mPct: 0,
    });
    expect(v.pass).toBe(true);
  });

  it('rejects red fresh candle', () => {
    const v = evaluateAwakeningPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 0.99,
      freshPc5mPct: -1,
      maxChasePct: 4,
      minFreshPc5mPct: 0,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_pc5m'))).toBe(true);
  });

  it('rejects chase above max', () => {
    const v = evaluateAwakeningPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.1,
      freshPc5mPct: 8,
      maxChasePct: 4,
      minFreshPc5mPct: 0,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_chase'))).toBe(true);
  });

  it('rejects short-ring red even when Dex pc5m still green (goon trap)', () => {
    const v = evaluateAwakeningPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 0.99,
      freshPc5mPct: 5.28,
      maxChasePct: 5,
      minFreshPc5mPct: 0,
      shortRingPc: -3.5,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_short_red'))).toBe(true);
  });
});

describe('vol-green exit parity with mild-dip W9.1', () => {
  const gates = {
    armPct: 8,
    givebackPct: 6,
    partialSellFraction: 0,
    neverArmPartialSellFraction: 0,
    secondGivebackPct: 0,
    minMfeBeforeTrailPct: 0,
    neverArmPatienceMs: 0,
    neverArmMaxHoldMs: 5_400_000,
    maxHoldMs: 0,
    neverArmDeadMinMs: 900_000,
    neverArmDeadPnlPct: 15,
    neverArmVolFadeMinMs: 600_000,
    neverArmVolFadeRatio: 0.35,
    neverArmVolFadeFloorUsd: 500,
    neverArmStaleMinMs: 0,
    neverArmStaleMaxMfePct: 0,
  };

  it('arms and exits on giveback like mild-dip', () => {
    const armed = evaluateMildDipPeakGiveback({
      entryPriceUsd: 1,
      markPriceUsd: 1.1,
      peakPriceUsd: 1.1,
      armed: false,
      gates,
      heldMs: 60_000,
    });
    expect(armed.armed).toBe(true);
    expect(armed.shouldExit).toBe(false);

    const giveback = evaluateMildDipPeakGiveback({
      entryPriceUsd: 1,
      markPriceUsd: 1.1 * (1 - 0.061),
      peakPriceUsd: 1.1,
      armed: true,
      gates,
      heldMs: 120_000,
    });
    expect(giveback.shouldExit).toBe(true);
    expect(giveback.reason).toBe('peak_giveback');
  });
});
