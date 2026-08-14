import { describe, expect, it, beforeEach } from 'vitest';
import {
  allowHotDexProbe,
  dumpH1PumpGateOk,
  dumpRallyGateOk,
  inDipBand,
  requireStreamPriceForDipSource,
  resetFastPathStateForTests,
  streamDipInBandOk,
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

  it('1.11.801 H1 pump gate rejects D2zNEW 30→27 pullback', () => {
    // H1 +46%, dump −10% off peak — not a dip.
    expect(
      dumpH1PumpGateOk({
        priceChange1hPct: 46,
        dumpExtentPct: -10,
        h1PumpMinPct: 15,
        minDumpPct: -15,
      }),
    ).toBe(false);
    expect(
      dumpH1PumpGateOk({
        priceChange1hPct: 46,
        dumpExtentPct: -18,
        h1PumpMinPct: 15,
        minDumpPct: -15,
      }),
    ).toBe(true);
    // No H1 pump → gate off.
    expect(
      dumpH1PumpGateOk({
        priceChange1hPct: 8,
        dumpExtentPct: -5,
        h1PumpMinPct: 15,
        minDumpPct: -15,
      }),
    ).toBe(true);
  });

  it('1.11.790 dump rally gate rejects EjD5-class pump wick', () => {
    // +40% into peak, −2.7% wick → need 16% dump at frac 0.4.
    expect(
      dumpRallyGateOk({
        dumpExtentPct: -2.7,
        rallyIntoPeakPct: 40,
        minRallyPct: 12,
        minDumpFracOfRally: 0.4,
      }),
    ).toBe(false);
    expect(
      dumpRallyGateOk({
        dumpExtentPct: -18,
        rallyIntoPeakPct: 40,
        minRallyPct: 12,
        minDumpFracOfRally: 0.4,
      }),
    ).toBe(true);
    // Small rally → gate off.
    expect(
      dumpRallyGateOk({
        dumpExtentPct: -3,
        rallyIntoPeakPct: 8,
        minRallyPct: 12,
        minDumpFracOfRally: 0.4,
      }),
    ).toBe(true);
  });

  it('1.11.790 streamDipInBandOk needs dump extent + current dd + rally', () => {
    expect(
      streamDipInBandOk({
        dumpExtentPct: -2.7,
        currentDrawdownPct: -2.7,
        rallyIntoPeakPct: 40,
        minDipPct: -25,
        maxDipPct: -2,
        dumpRallyGateMinPct: 12,
        dumpRallyMinFrac: 0.4,
      }),
    ).toBe(false);
    expect(
      streamDipInBandOk({
        dumpExtentPct: -15,
        currentDrawdownPct: -12,
        rallyIntoPeakPct: 20,
        minDipPct: -25,
        maxDipPct: -2,
        dumpRallyGateMinPct: 12,
        dumpRallyMinFrac: 0.4,
      }),
    ).toBe(true);
    // Reclaimed toward peak — current out of band.
    expect(
      streamDipInBandOk({
        dumpExtentPct: -15,
        currentDrawdownPct: -1,
        rallyIntoPeakPct: 20,
        minDipPct: -25,
        maxDipPct: -2,
        dumpRallyGateMinPct: 12,
        dumpRallyMinFrac: 0.4,
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

  it('1.11.802/807 Dex/TD/wait-dip sources skip requireStreamPrice', () => {
    expect(requireStreamPriceForDipSource('dex')).toBe(false);
    expect(requireStreamPriceForDipSource('dex+stream')).toBe(false);
    expect(requireStreamPriceForDipSource('turn_dump_knife')).toBe(false);
    // Parked seat is anchored to its own signal (ceiling + chase caps).
    expect(requireStreamPriceForDipSource('wait_dip')).toBe(false);
    expect(requireStreamPriceForDipSource('stream')).toBe(true);
    expect(requireStreamPriceForDipSource('mild_stabilize')).toBe(true);
    expect(requireStreamPriceForDipSource(null)).toBe(true);
  });

  it('1.11.921 structuralOk relaxes turn only on fresh leader co-buy', () => {
    const cfg = stubCfg(50_000);
    (cfg.entry as { minTurnover5mLiq: number }).minTurnover5mLiq = 0.06;
    const lowTurn = stubMetrics({
      volume5mUsd: 1500,
      liquidityUsd: 50_000,
    }); // turn 0.03
    expect(structuralOk(lowTurn, cfg, true, false)).toBe(false);
    expect(structuralOk(lowTurn, cfg, true, true)).toBe(true);
  });
});
