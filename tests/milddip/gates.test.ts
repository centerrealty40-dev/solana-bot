import { describe, expect, it } from 'vitest';
import {
  evaluateMildDipEntry,
  evaluateMildDipExit,
  type MildDipEntryGates,
} from '../../src/milddip/gates.js';

const baseGates: MildDipEntryGates = {
  minDipPct: -20,
  maxDipPct: 0,
  minVolume5mUsd: 8_000,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 5_000_000,
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

describe('evaluateMildDipExit', () => {
  it('takes profit at +10%', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.1,
      openedAtMs: 0,
      nowMs: 60_000,
      gates: { tpGainPct: 10, timeStopMs: 360_000 },
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('take_profit');
  });

  it('time-stops after hold', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.02,
      openedAtMs: 0,
      nowMs: 360_000,
      gates: { tpGainPct: 10, timeStopMs: 360_000 },
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('time_stop');
  });

  it('holds when neither TP nor time-stop', () => {
    const v = evaluateMildDipExit({
      entryPriceUsd: 1,
      markPriceUsd: 1.02,
      openedAtMs: 0,
      nowMs: 60_000,
      gates: { tpGainPct: 10, timeStopMs: 360_000 },
    });
    expect(v.shouldExit).toBe(false);
    expect(v.reason).toBeNull();
  });
});
