import { describe, expect, it } from 'vitest';
import { evaluateGreenTapeEntry, type GreenTapeGates } from '../../src/volgreen/green-tape-gates.js';
import { MildDipHotMintBuffer } from '../../src/milddip/hot-mints.js';

const gates: GreenTapeGates = {
  minLiquidityUsd: 12_000,
  minMarketCapUsd: 40_000,
  maxMarketCapUsd: 300_000_000,
  minPairAgeHours: 0.1,
  maxPairAgeHours: 72,
  allowedDexIds: ['pumpswap', 'pumpfun', 'raydium'],
  liquidMinPc5mPct: 5,
  liquidMaxPc5mPct: 20,
  liquidMinVolume5mUsd: 2_000,
  liquidMinBuySellRatio5m: 1,
  liquidMinTurnover5m: 0.09,
  earlyMinPc5mPct: 5,
  earlyMaxPc5mPct: 25,
  earlyMinVolume5mUsd: 400,
  earlyMinBuySellRatio5m: 2,
  earlyMinTurnover5m: 0.02,
  earlyMinMarketCapUsd: 35_000,
};

describe('evaluateGreenTapeEntry', () => {
  it('passes liquid fat green tape', () => {
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 8,
        volume5mUsd: 12_000,
        liquidityUsd: 40_000,
        marketCapUsd: 200_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
        buys5m: 40,
        sells5m: 25,
      },
      gates,
    );
    expect(v.pass).toBe(true);
    expect(v.path).toBe('liquid');
  });

  it('passes early thin green with strong buy pressure', () => {
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 6.5,
        volume5mUsd: 500,
        liquidityUsd: 17_000,
        marketCapUsd: 44_000,
        pairAgeHours: 48,
        dexId: 'pumpswap',
        buys5m: 30,
        sells5m: 4,
      },
      gates,
    );
    expect(v.pass).toBe(true);
    expect(v.path).toBe('early');
  });

  it('rejects weak green pc5m<=5 (not a real impulse)', () => {
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 3.0,
        volume5mUsd: 12_000,
        liquidityUsd: 40_000,
        marketCapUsd: 200_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
        buys5m: 40,
        sells5m: 25,
      },
      gates,
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('pc5m'))).toBe(true);
  });

  it('rejects Ef4E8v-thin vol even when pc5m is strong enough', () => {
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 6.0,
        volume5mUsd: 169.62,
        liquidityUsd: 17_073,
        marketCapUsd: 44_202,
        pairAgeHours: 48.6,
        dexId: 'pumpswap',
        buys5m: 15,
        sells5m: 2,
      },
      gates,
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('vol5m'))).toBe(true);
  });

  it('rejects red candle on both paths', () => {
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: -2,
        volume5mUsd: 12_000,
        liquidityUsd: 40_000,
        marketCapUsd: 200_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
        buys5m: 40,
        sells5m: 25,
      },
      gates,
    );
    expect(v.pass).toBe(false);
  });
});

describe('MildDipHotMintBuffer.listForEnrich', () => {
  it('ranks high-hit recent mints above low-hit fresher noise', () => {
    const buf = new MildDipHotMintBuffer({ maxMints: 50, ttlMs: 900_000 });
    const now = Date.now();
    buf.note('LowHit111111111111111111111111111111111111', now - 5_000, 1);
    buf.note('HighHit222222222222222222222222222222222222', now - 20_000, 40);
    buf.note('StaleHit333333333333333333333333333333333333', now - 400_000, 200);
    const ordered = buf.listForEnrich(now);
    expect(ordered[0]).toBe('HighHit222222222222222222222222222222222222');
  });
});
