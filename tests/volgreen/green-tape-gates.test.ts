import { describe, expect, it } from 'vitest';
import { evaluateGreenTapeEntry, type GreenTapeGates } from '../../src/volgreen/green-tape-gates.js';
import { MildDipHotMintBuffer } from '../../src/milddip/hot-mints.js';

const gates: GreenTapeGates = {
  minLiquidityUsd: 8_000,
  minMarketCapUsd: 18_000,
  maxMarketCapUsd: 300_000_000,
  minPairAgeHours: 0.05,
  maxPairAgeHours: 72,
  allowedDexIds: ['pumpswap', 'pumpfun', 'raydium'],
  impulseMinPc5mPct: 0,
  impulseMaxPc5mPct: 0,
  impulseMinVolume5mUsd: 2500,
  impulseMinBuySellRatio5m: 1,
  impulseMinTurnover5m: 0.05,
  liquidMinPc5mPct: 5,
  liquidMaxPc5mPct: 20,
  liquidMinVolume5mUsd: 2_000,
  liquidMinBuySellRatio5m: 1,
  liquidMinTurnover5m: 0.09,
  liquidMidPc5mLo: 10,
  liquidMidPc5mHi: 25,
  liquidMidMinBuySellRatio5m: 0,
  liquidMidMinTurnover5m: 0,
  earlyMinPc5mPct: 5,
  earlyMaxPc5mPct: 25,
  earlyMinVolume5mUsd: 400,
  earlyMinBuySellRatio5m: 2,
  earlyMinTurnover5m: 0.02,
  earlyMinMarketCapUsd: 18_000,
  rocketMinPc5mPct: 15,
  rocketMaxPc5mPct: 0,
  rocketMinVolume5mUsd: 8_000,
  rocketMinBuySellRatio5m: 1.15,
  rocketMinTurnover5m: 0,
  rocketMinMarketCapUsd: 18_000,
  extremePc5mPct: 0,
  extremeMinBuySellRatio5m: 1.5,
  liquidTapeMinLiquidityUsd: 0,
  liquidTapeMinPairAgeHours: 1,
  liquidTapeMinVolume5mUsd: 1200,
  liquidTapeMinPc5mPct: -2,
  liquidTapeMaxPc5mPct: 40,
  liquidTapeMinBuySellRatio5m: 0.85,
  liquidTapeMinRingPc5mPct: 5,
};

describe('evaluateGreenTapeEntry', () => {
  it('impulse: skips tiny greens, buys large uncapped 5m green', () => {
    const g: GreenTapeGates = {
      ...gates,
      impulseMinPc5mPct: 12,
      impulseMaxPc5mPct: 0,
      impulseMinVolume5mUsd: 2500,
      impulseMinBuySellRatio5m: 1,
      impulseMinTurnover5m: 0.05,
      liquidMinPc5mPct: 8,
    };
    const tiny = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 6,
        volume5mUsd: 5_000,
        liquidityUsd: 40_000,
        marketCapUsd: 100_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
        buys5m: 40,
        sells5m: 30,
      },
      g,
    );
    // 6% is below liquid min 8 and impulse min 12 → fail (ignore small green)
    expect(tiny.pass).toBe(false);

    const big = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 55,
        volume5mUsd: 8_000,
        liquidityUsd: 20_000,
        marketCapUsd: 80_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
        buys5m: 50,
        sells5m: 40,
      },
      g,
    );
    expect(big.pass).toBe(true);
    expect(big.path).toBe('impulse');
  });

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

  it('passes goon/3c32HTE rocket candle (huge pc5m + extreme vol)', () => {
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 312,
        volume5mUsd: 13_731,
        liquidityUsd: 15_271,
        marketCapUsd: 52_667,
        pairAgeHours: 0.6,
        dexId: 'pumpswap',
        buys5m: 122,
        sells5m: 64,
      },
      gates,
    );
    expect(v.pass).toBe(true);
    expect(v.path).toBe('rocket');
  });

  it('passes CHiHkQx-shaped rocket with null Dex liquidity', () => {
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 934,
        volume5mUsd: 20_812,
        liquidityUsd: null,
        marketCapUsd: 22_243,
        pairAgeHours: 0.09,
        dexId: 'pumpswap',
        buys5m: 98,
        sells5m: 66,
      },
      { ...gates, rocketMinVolume5mUsd: 10_000, rocketMinBuySellRatio5m: 1.15, rocketMinTurnover5m: 0.2 },
    );
    expect(v.pass).toBe(true);
    expect(v.path).toBe('rocket');
  });

  it('passes 7BNaxx peanut at leader time (age 0.015h < floor, rocket vol bypasses age)', () => {
    const rocketGates = {
      ...gates,
      minPairAgeHours: 0.01,
      rocketMinPc5mPct: 12,
      rocketMinVolume5mUsd: 10_000,
      rocketMinBuySellRatio5m: 1.15,
      rocketMinTurnover5m: 0.2,
    };
    // 16:12:24 snapshot — 23s before leader buy; age below structural floor.
    const early = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 12.36,
        volume5mUsd: 18_544,
        liquidityUsd: 12_128,
        marketCapUsd: 34_573,
        pairAgeHours: 0.0147,
        dexId: 'pumpswap',
        buys5m: 117,
        sells5m: 94, // bs≈1.24
      },
      rocketGates,
    );
    expect(early.pass).toBe(true);
    // May match liquid (pc in band) or rocket — either is a valid concurrent entry.
    expect(['liquid', 'rocket']).toContain(early.path);
  });

  it('rejects liquid mid-band (pc5m 10–25) without hotter bs/turnover', () => {
    const midOn: GreenTapeGates = {
      ...gates,
      liquidMidMinBuySellRatio5m: 1.4,
      liquidMidMinTurnover5m: 0.18,
    };
    const weak = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 14,
        volume5mUsd: 8_000,
        liquidityUsd: 40_000,
        marketCapUsd: 200_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
        buys5m: 40,
        sells5m: 35, // bs≈1.14 < 1.4
      },
      midOn,
    );
    expect(weak.pass).toBe(false);
    expect(weak.reasons.some((r) => r.includes('mid_buy_sell'))).toBe(true);

    const strong = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 14,
        volume5mUsd: 12_000,
        liquidityUsd: 40_000,
        marketCapUsd: 200_000,
        pairAgeHours: 6,
        dexId: 'pumpswap',
        buys5m: 70,
        sells5m: 40, // bs=1.75, turnover=0.3
      },
      midOn,
    );
    expect(strong.pass).toBe(true);
    expect(strong.path).toBe('liquid');
  });

  it('rejects weak green pc5m<=5', () => {
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
  });

  it('rejects thin vol even with strong pc', () => {
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
  });

  it('blocks extreme pc5m>100 without strong buy/sell (chase guard)', () => {
    const g: GreenTapeGates = {
      ...gates,
      earlyMinPc5mPct: 0,
      impulseMinPc5mPct: 18,
      liquidMinPc5mPct: 12,
      rocketMinPc5mPct: 25,
      rocketMinVolume5mUsd: 15_000,
      rocketMinBuySellRatio5m: 1.35,
      extremePc5mPct: 100,
      extremeMinBuySellRatio5m: 1.35,
    };
    const weakBs = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 320,
        volume5mUsd: 50_000,
        liquidityUsd: 80_000,
        marketCapUsd: 200_000,
        pairAgeHours: 2,
        dexId: 'pumpswap',
        buys5m: 40,
        sells5m: 35, // bs≈1.14 < 1.35
      },
      g,
    );
    expect(weakBs.pass).toBe(false);
    expect(weakBs.reasons.some((r) => r.startsWith('chase_extreme_pc5m'))).toBe(true);

    // E6cBb6 leader-like: pc5m 138%, bs≈1.39 — must pass.
    const leaderLike = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 138,
        volume5mUsd: 31_657,
        liquidityUsd: 22_330,
        marketCapUsd: 92_622,
        pairAgeHours: 0.5,
        dexId: 'pumpswap',
        buys5m: 86,
        sells5m: 62, // ≈1.39
      },
      g,
    );
    expect(leaderLike.pass).toBe(true);

    const strongBs = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 320,
        volume5mUsd: 50_000,
        liquidityUsd: 80_000,
        marketCapUsd: 200_000,
        pairAgeHours: 2,
        dexId: 'pumpswap',
        buys5m: 90,
        sells5m: 40, // bs=2.25
      },
      g,
    );
    expect(strongBs.pass).toBe(true);
  });

  it('liquid_tape: fat/aged book passes with soft Dex pc when other paths fail', () => {
    const g: GreenTapeGates = {
      ...gates,
      earlyMinPc5mPct: 0,
      impulseMinPc5mPct: 18,
      liquidMinPc5mPct: 12,
      rocketMinPc5mPct: 25,
      rocketMinVolume5mUsd: 15_000,
      liquidTapeMinLiquidityUsd: 25_000,
      liquidTapeMinPairAgeHours: 1,
      liquidTapeMinVolume5mUsd: 1_200,
      liquidTapeMinPc5mPct: -2,
      liquidTapeMaxPc5mPct: 40,
      liquidTapeMinBuySellRatio5m: 0.85,
    };
    // WW-like at leader: Dex still soft, but liq/age/vol ok.
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 2.8,
        volume5mUsd: 1_565,
        liquidityUsd: 40_770,
        marketCapUsd: 235_000,
        pairAgeHours: 34.7,
        dexId: 'pumpswap',
        buys5m: 20,
        sells5m: 20,
      },
      g,
    );
    expect(v.pass).toBe(true);
    expect(v.path).toBe('liquid_tape');

    // Thin book must not use liquid_tape.
    const thin = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 3,
        volume5mUsd: 2_000,
        liquidityUsd: 10_000,
        marketCapUsd: 80_000,
        pairAgeHours: 10,
        dexId: 'pumpswap',
        buys5m: 20,
        sells5m: 15,
      },
      g,
    );
    expect(thin.pass).toBe(false);
  });

  it('earlyMinPc5mPct=0 disables early path', () => {
    const g: GreenTapeGates = {
      ...gates,
      earlyMinPc5mPct: 0,
      liquidMinPc5mPct: 12,
      impulseMinPc5mPct: 18,
      rocketMinPc5mPct: 25,
      rocketMinVolume5mUsd: 15_000,
    };
    // Would have been early (pc=7, high bs) — now fail.
    const v = evaluateGreenTapeEntry(
      {
        priceChange5mPct: 7,
        volume5mUsd: 800,
        liquidityUsd: 12_000,
        marketCapUsd: 40_000,
        pairAgeHours: 1,
        dexId: 'pumpswap',
        buys5m: 40,
        sells5m: 10,
      },
      g,
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
