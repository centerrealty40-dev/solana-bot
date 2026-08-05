import { describe, expect, it } from 'vitest';
import {
  evaluateMildDipEntry,
  evaluateMildDipExit,
  evaluateMildDipPreBuy,
  type MildDipEntryGates,
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

describe('evaluateMildDipEntry', () => {
  it('passes a typical mild-dip candidate', () => {
    const v = evaluateMildDipEntry(
      {
        priceChange5mPct: -9.7,
        volume5mUsd: 25_000,
        liquidityUsd: 40_000,
        marketCapUsd: 400_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
      },
      baseGates,
    );
    expect(v.pass).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('rejects chase (pc5m > 0)', () => {
    const v = evaluateMildDipEntry(
      {
        priceChange5mPct: 3,
        volume5mUsd: 25_000,
        liquidityUsd: 40_000,
        marketCapUsd: 400_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
      },
      baseGates,
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('pc5m'))).toBe(true);
  });

  it('rejects deep knife (pc5m ≤ −20)', () => {
    const v = evaluateMildDipEntry(
      {
        priceChange5mPct: -20,
        volume5mUsd: 25_000,
        liquidityUsd: 40_000,
        marketCapUsd: 400_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
      },
      baseGates,
    );
    expect(v.pass).toBe(false);
  });

  it('accepts boundary maxDipPct = 0', () => {
    const v = evaluateMildDipEntry(
      {
        priceChange5mPct: 0,
        volume5mUsd: 25_000,
        liquidityUsd: 40_000,
        marketCapUsd: 400_000,
        pairAgeHours: 6,
        dexId: 'pumpfun',
      },
      baseGates,
    );
    expect(v.pass).toBe(true);
  });
});

describe('evaluateMildDipPreBuy', () => {
  const band = { minDipPct: -20, maxDipPct: 0 };

  it('passes when still in dip and mark not chasing', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.02,
      freshPc5mPct: -8,
      entryGates: band,
      maxChasePct: 4,
    });
    expect(v.pass).toBe(true);
  });

  it('rejects green candle (pc5m > 0) after stale signal', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.01,
      freshPc5mPct: 2.5,
      entryGates: band,
      maxChasePct: 4,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_pc5m'))).toBe(true);
  });

  it('rejects bounce above maxChasePct even if pc5m still red', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.06,
      freshPc5mPct: -5,
      entryGates: band,
      maxChasePct: 4,
    });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('prebuy_chase'))).toBe(true);
  });

  it('allows chase check off when maxChasePct=0', () => {
    const v = evaluateMildDipPreBuy({
      signalPriceUsd: 1,
      freshPriceUsd: 1.2,
      freshPc5mPct: -3,
      entryGates: band,
      maxChasePct: 0,
    });
    expect(v.pass).toBe(true);
  });
});

const exitGates = {
  tpGainPct: 10,
  trailGivebackPct: 6,
  timeStopMs: 1_800_000,
  volFadeDropPct: 30,
  volFadeMinVolume5mUsd: 0,
  volFadeSampleWindow: 3,
  volFadeMinWeakSamples: 2,
  volFadeMinHoldMs: 60_000,
};

describe('evaluateMildDipExit', () => {
  it('takes profit at +10%', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.1,
      peakPriceUsd: 1.1,
      openedAtMs: 0,
      nowMs: 60_000,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('take_profit');
  });

  it('trails −6% from peak after arming above entry', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.1 * 0.94, // −6% from peak 1.1
      peakPriceUsd: 1.1,
      openedAtMs: 0,
      nowMs: 120_000,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('trail_giveback');
  });

  it('does not treat −6% from entry as trail before peak arms', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 0.94,
      peakPriceUsd: 1,
      openedAtMs: 0,
      nowMs: 120_000,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('exits on volume fade after min hold', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.02,
      peakPriceUsd: 1.03,
      openedAtMs: 0,
      nowMs: 90_000,
      gates: exitGates,
      volumeFaded: true,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('volume_fade');
  });

  it('ignores volume fade before min hold', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.02,
      peakPriceUsd: 1.03,
      openedAtMs: 0,
      nowMs: 30_000,
      gates: exitGates,
      volumeFaded: true,
    });
    expect(v.shouldExit).toBe(false);
  });

  it('time-stops after 30m', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.02,
      peakPriceUsd: 1.03,
      openedAtMs: 0,
      nowMs: 1_800_000,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('time_stop');
  });

  it('holds when neither TP nor trail nor fade nor time-stop', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.02,
      peakPriceUsd: 1.03,
      openedAtMs: 0,
      nowMs: 360_000,
      gates: exitGates,
    });
    expect(v.shouldExit).toBe(false);
    expect(v.reason).toBeNull();
  });
});
