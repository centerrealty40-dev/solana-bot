import { describe, expect, it } from 'vitest';
import {
  evaluateMildDipEntry,
  evaluateMildDipPeakGiveback,
  evaluateMildDipPreBuy,
  isMfeBankEnabled,
  type MildDipEntryGates,
  type MildDipExitGates,
} from '../../src/milddip/gates.js';

const baseGates: MildDipEntryGates = {
  minDipPct: -20,
  maxDipPct: 0,
  minVolume5mUsd: 8_000,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 300_000_000,
  minPairAgeHours: 0.25,
  maxPairAgeHours: 72,
  allowedDexIds: ['pumpswap', 'pumpfun'],
};

const oscarExit: MildDipExitGates = {
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

describe('evaluateMildDipEntry', () => {
  it('passes a typical mild-dip candidate', () => {
    const v = evaluateMildDipEntry(
      {
        priceChange5mPct: -9.7,
        volume5mUsd: 25_000,
        liquidityUsd: 40_000,
        marketCapUsd: 200_000,
        pairAgeHours: 2,
        dexId: 'pumpswap',
        buys5m: 10,
        sells5m: 5,
        volume1hUsd: 100_000,
        priceChange1hPct: -5,
      },
      baseGates,
    );
    expect(v.pass).toBe(true);
  });
});

describe('evaluateMildDipPreBuy', () => {
  it('blocks chase', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.1,
      freshPc5mPct: -10,
      entryGates: baseGates,
      maxChasePct: 5,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_chase'))).toBe(true);
  });
});

describe('Oscar mfeBank exit', () => {
  it('enables mfe bank by default', () => {
    expect(isMfeBankEnabled(oscarExit)).toBe(true);
  });

  it('banks 40% at +8% MFE', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 108,
      peakPriceUsd: 108,
      armed: false,
      gates: oscarExit,
      heldMs: 60_000,
      mfeBankStage: 0,
    });
    expect(v.armed).toBe(true);
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_1');
    expect(v.fraction).toBeCloseTo(0.4, 5);
  });

  it('sleeve dumps remainder after bank on -12% giveback', () => {
    const peak = 109;
    const mark = peak * (1 - 0.12); // exact −12% from peak
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: mark,
      peakPriceUsd: peak,
      armed: true,
      gates: oscarExit,
      heldMs: 120_000,
      mfeBankStage: 1,
      scaleOutDone: true,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('mfe_bank_sleeve');
    expect(v.fraction).toBe(1);
  });

  it('time_red after 15m unarmed with pnl ≤ -5%', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 94,
      peakPriceUsd: 100,
      armed: false,
      gates: oscarExit,
      heldMs: 900_000,
      mfeBankStage: 0,
      postEntryTroughPriceUsd: 94,
      postEntryTroughAtMs: Date.now() - 900_000,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('never_arm_time_red');
  });
});
