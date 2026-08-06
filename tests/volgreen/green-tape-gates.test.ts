import { describe, expect, it } from 'vitest';
import { evaluateGreenTapeEntry } from '../../src/volgreen/green-tape-gates.js';
import { MildDipHotMintBuffer } from '../../src/milddip/hot-mints.js';

const gates = {
  minPc5mPct: 0,
  maxPc5mPct: 15,
  minVolume5mUsd: 2_000,
  minLiquidityUsd: 15_000,
  minMarketCapUsd: 50_000,
  maxMarketCapUsd: 300_000_000,
  minBuySellRatio5m: 1,
  minTurnover5m: 0.09,
  minPairAgeHours: 0.1,
  maxPairAgeHours: 72,
  allowedDexIds: ['pumpswap', 'pumpfun', 'raydium'],
};

describe('evaluateGreenTapeEntry', () => {
  it('passes a leader-like green tape mint', () => {
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
    expect(v.buySellRatio5m).toBeGreaterThan(1);
    expect(v.turnover5m).toBeGreaterThan(0.09);
  });

  it('rejects red candle', () => {
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
    expect(v.reasons.some((r) => r.includes('pc5m'))).toBe(true);
  });

  it('rejects low turnover (CASHCAT-shaped)', () => {
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 16,
        volume5mUsd: 1_970,
        liquidityUsd: 29_775,
        marketCapUsd: 112_390,
        pairAgeHours: 670,
        dexId: 'pumpswap',
        buys5m: 14,
        sells5m: 14,
      },
      gates,
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('turnover') || r.includes('vol5m') || r.includes('pc5m'))).toBe(
      true,
    );
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
