import { describe, expect, it, beforeEach } from 'vitest';
import {
  allowHotDexProbe,
  inDipBand,
  resetFastPathStateForTests,
  streamOnlyDexDipOk,
  streamOnlyNearTroughOk,
  structuralOk,
} from '../../src/milddip/fast-path.js';
import type { MildDipConfig } from '../../src/milddip/config.js';
import type { MildDipCandidateMetrics } from '../../src/milddip/gates.js';

function stubCfg(minMcap = 50_000): MildDipConfig {
  return {
    entry: {
      minDipPct: -25,
      maxDipPct: -8,
      minVolume5mUsd: 1500,
      minLiquidityUsd: 10_000,
      minMarketCapUsd: minMcap,
      maxMarketCapUsd: 300_000_000,
      minPairAgeHours: 0.5,
      maxPairAgeHours: 0,
      allowedDexIds: ['pumpswap', 'pumpfun', 'raydium'],
    },
  } as unknown as MildDipConfig;
}

function stubMetrics(partial: Partial<MildDipCandidateMetrics> = {}): MildDipCandidateMetrics {
  return {
    priceChange5mPct: -12,
    volume5mUsd: 5_000,
    liquidityUsd: 20_000,
    marketCapUsd: 80_000,
    pairAgeHours: 2,
    dexId: 'pumpswap',
    buys5m: 10,
    sells5m: 10,
    volume1hUsd: 40_000,
    priceChange1hPct: -15,
    ...partial,
  };
}

describe('fast-path helpers', () => {
  beforeEach(() => {
    resetFastPathStateForTests();
  });

  it('main band is (−25, −5] exclusive min', () => {
    expect(inDipBand(-15, -25, -5)).toBe(true);
    expect(inDipBand(-5, -25, -5)).toBe(true);
    expect(inDipBand(-2.5, -25, -5)).toBe(false);
    expect(inDipBand(-25, -25, -5)).toBe(false);
    expect(inDipBand(-34, -25, -5)).toBe(false);
    expect(inDipBand(null, -25, -5)).toBe(false);
  });

  it('stream-only depth −10 rejects Gs2Liw-class −5.2% wiggle', () => {
    const streamOnlyMax = -10;
    const wiggle = -5.214;
    const dump = -13.06;
    expect(wiggle <= streamOnlyMax).toBe(false);
    expect(dump <= streamOnlyMax).toBe(true);
    // Still in main band — Dex confirm would allow it.
    expect(inDipBand(wiggle, -25, -5)).toBe(true);
  });

  it('stream-only requires Dex still red (JBKWfC phantom reclaim)', () => {
    // Ring −21% but Dex ≈ flat after reclaim — leaders sat out.
    expect(
      streamOnlyDexDipOk({
        requireDexDip: true,
        dexPc5m: -0.53,
        dexMaxDipPct: -8,
      }),
    ).toBe(false);
    // Leader-style mild_deep: Dex still printing dump.
    expect(
      streamOnlyDexDipOk({
        requireDexDip: true,
        dexPc5m: -13.31,
        dexMaxDipPct: -8,
      }),
    ).toBe(true);
    // Deep knife Dex (−37) while stream in main — ok.
    expect(
      streamOnlyDexDipOk({
        requireDexDip: true,
        dexPc5m: -37.13,
        dexMaxDipPct: -8,
      }),
    ).toBe(true);
    // Missing Dex print → reject unless allowMissingDex.
    expect(
      streamOnlyDexDipOk({
        requireDexDip: true,
        dexPc5m: null,
        dexMaxDipPct: -8,
      }),
    ).toBe(false);
    expect(
      streamOnlyDexDipOk({
        requireDexDip: true,
        allowMissingDex: true,
        dexPc5m: null,
        dexMaxDipPct: -8,
      }),
    ).toBe(true);
    // Flag off → legacy allow (but green still blocked by default).
    expect(
      streamOnlyDexDipOk({
        requireDexDip: false,
        dexPc5m: -0.53,
        dexMaxDipPct: -8,
      }),
    ).toBe(true);
    expect(
      streamOnlyDexDipOk({
        requireDexDip: false,
        blockDexGreen: true,
        dexPc5m: 2.5,
        dexMaxDipPct: -8,
      }),
    ).toBe(false);
  });

  it('1.11.779 near-trough: early dump OK, reclaim bounce rejected', () => {
    // Early dump: still sitting on trough.
    expect(
      streamOnlyNearTroughOk({
        enabled: true,
        bounceFromTroughPct: 0.8,
        maxBouncePct: 3,
        sampleCount: 5,
        minSamples: 3,
      }),
    ).toBe(true);
    // JBKWfC-class reclaim: large bounce off trough while ring peak→last still red.
    expect(
      streamOnlyNearTroughOk({
        enabled: true,
        bounceFromTroughPct: 18,
        maxBouncePct: 3,
        sampleCount: 8,
        minSamples: 3,
      }),
    ).toBe(false);
    // Too few samples.
    expect(
      streamOnlyNearTroughOk({
        enabled: true,
        bounceFromTroughPct: 0.5,
        maxBouncePct: 3,
        sampleCount: 1,
        minSamples: 3,
      }),
    ).toBe(false);
  });

  it('allowHotDexProbe throttles per mint and per minute', () => {
    const mintA = 'Agmu8Xgn7rU4zFv4DMPrEBhYDdPsmiEG5hCiYyvSpump';
    const mintB = 'BsKtZlDummyMintForHotDexProbeThrottleTestxxxx1';
    const t0 = 1_700_000_000_000;
    expect(allowHotDexProbe(mintA, t0, 10_000, 40)).toBe(true);
    // Same mint inside gap → blocked.
    expect(allowHotDexProbe(mintA, t0 + 5_000, 10_000, 40)).toBe(false);
    // After gap → allowed.
    expect(allowHotDexProbe(mintA, t0 + 10_000, 10_000, 40)).toBe(true);
    // Different mint still allowed.
    expect(allowHotDexProbe(mintB, t0 + 10_000, 10_000, 40)).toBe(true);
  });

  it('allowHotDexProbe enforces maxPerMin budget', () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 3; i += 1) {
      const mint = `Mint${i}${'x'.repeat(40)}`;
      expect(allowHotDexProbe(mint, t0 + i, 0, 3)).toBe(true);
    }
    expect(allowHotDexProbe(`Mint3${'x'.repeat(40)}`, t0 + 3, 0, 3)).toBe(false);
    // New minute window resets.
    expect(allowHotDexProbe(`Mint4${'x'.repeat(40)}`, t0 + 60_000, 0, 3)).toBe(true);
  });

  it('allowHotDexProbe rejects disabled maxPerMin', () => {
    expect(
      allowHotDexProbe('Agmu8Xgn7rU4zFv4DMPrEBhYDdPsmiEG5hCiYyvSpump', Date.now(), 10_000, 0),
    ).toBe(false);
  });

  it('structuralOk always enforces min mcap (scale-in path removed)', () => {
    const cfg = stubCfg(50_000);
    const crushed = stubMetrics({ marketCapUsd: 22_000 });
    expect(structuralOk(crushed, cfg)).toBe(false);
    const ok = stubMetrics({ marketCapUsd: 60_000 });
    expect(structuralOk(ok, cfg)).toBe(true);
    const huge = stubMetrics({ marketCapUsd: 400_000_000 });
    expect(structuralOk(huge, cfg)).toBe(false);
  });
});
