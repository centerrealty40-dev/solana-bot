import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetGreenMinuteJupiterRefreshForTests,
  greenMinuteJupiterStats,
  releaseGreenMinuteJupiterRefresh,
  requestGreenMinuteJupiterRefresh,
  tickGreenMinuteJupiterRefresh,
} from '../../src/milddip/green-minute-jupiter-refresh.js';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';

describe('GREEN Jupiter minute refresh', () => {
  beforeEach(() => {
    __resetGreenMinuteJupiterRefreshForTests();
  });

  it('writes a successful bounded quote into the GREEN source', async () => {
    const mint = 'GreenJupiterRefreshMintxxxxxxxxxxxxxxxxxxxxxx1';
    const requested = requestGreenMinuteJupiterRefresh({
      mint,
      nowMs: 1_000_000,
      snapshotPriceUsd: 0.001,
      enabled: true,
      minGapMs: 3_000,
      ttlMs: 600_000,
      maxMints: 2,
      maxInFlight: 1,
      probeUsd: 1,
      slippageBps: 150,
      quote: async () => 0.002,
    });
    expect(requested).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(greenMinuteJupiterStats(1_000_000).quoteAttempts).toBe(1);
    expect(greenMinuteJupiterStats(1_000_000).quoteSuccesses).toBe(1);
    expect(mildDipPriceRing.lastPriceBySource(mint, 'green_jupiter')).not.toBeNull();
  });

  it('enforces candidate cap, min-gap, in-flight cap, and TTL', async () => {
    const mintA = 'GreenJupiterCapMintAxxxxxxxxxxxxxxxxxxxxxxxx1';
    const mintB = 'GreenJupiterCapMintBxxxxxxxxxxxxxxxxxxxxxxxx1';
    let resolveQuote: ((price: number) => void) | undefined;
    const quote = () =>
      new Promise<number>((resolve) => {
        resolveQuote = resolve;
      });
    expect(
      requestGreenMinuteJupiterRefresh({
        mint: mintA,
        nowMs: 1_000_000,
        snapshotPriceUsd: 0.001,
        enabled: true,
        minGapMs: 3_000,
        ttlMs: 10_000,
        maxMints: 1,
        maxInFlight: 1,
        probeUsd: 1,
        slippageBps: 150,
        quote,
      }),
    ).toBe(true);
    expect(
      requestGreenMinuteJupiterRefresh({
        mint: mintA,
        nowMs: 1_001_000,
        snapshotPriceUsd: 0.001,
        enabled: true,
        minGapMs: 3_000,
        ttlMs: 10_000,
        maxMints: 1,
        maxInFlight: 1,
        probeUsd: 1,
        slippageBps: 150,
        quote,
      }),
    ).toBe(false);
    expect(
      requestGreenMinuteJupiterRefresh({
        mint: mintB,
        nowMs: 1_002_000,
        snapshotPriceUsd: 0.001,
        enabled: true,
        minGapMs: 3_000,
        ttlMs: 10_000,
        maxMints: 1,
        maxInFlight: 1,
        probeUsd: 1,
        slippageBps: 150,
        quote,
      }),
    ).toBe(false);
    expect(greenMinuteJupiterStats(1_002_000).capRejected).toBe(1);
    resolveQuote?.(0.002);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(greenMinuteJupiterStats(1_020_001, 10_000).activeMints).toBe(0);
  });

  it('counts quote failures', async () => {
    const mint = 'GreenJupiterErrorMintxxxxxxxxxxxxxxxxxxxxxxx1';
    expect(
      requestGreenMinuteJupiterRefresh({
        mint,
        nowMs: 2_000_000,
        snapshotPriceUsd: 0.001,
        enabled: true,
        minGapMs: 3_000,
        ttlMs: 600_000,
        maxMints: 2,
        maxInFlight: 1,
        probeUsd: 1,
        slippageBps: 150,
        quote: async () => {
          throw new Error('quote failed');
        },
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(greenMinuteJupiterStats(2_000_000).quoteErrors).toBe(1);
  });

  it('uses known mint decimals and stops polling after candidate grace', async () => {
    const mint = 'GreenJupiterGraceMintxxxxxxxxxxxxxxxxxxxxxxx1';
    mildDipPriceRing.noteMintDecimals(mint, 9);
    let seenDecimals: number | null = null;
    const quote = async (args: { tokenDecimals: number }) => {
      seenDecimals = args.tokenDecimals;
      return 0.002;
    };
    expect(
      requestGreenMinuteJupiterRefresh({
        mint,
        nowMs: 3_000_000,
        snapshotPriceUsd: 0.001,
        enabled: true,
        minGapMs: 3_000,
        ttlMs: 600_000,
        maxMints: 2,
        maxInFlight: 1,
        probeUsd: 1,
        slippageBps: 150,
        quote,
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seenDecimals).toBe(9);
    tickGreenMinuteJupiterRefresh({
      nowMs: 3_090_001,
      enabled: true,
      minGapMs: 3_000,
      ttlMs: 600_000,
      maxInFlight: 1,
      graceMs: 90_000,
    });
    expect(greenMinuteJupiterStats(3_090_001).quoteAttempts).toBe(1);
  });

  it('preserves min-gap memory when a candidate slot is released', async () => {
    const mint = 'GreenJupiterReleasedMintxxxxxxxxxxxxxxxxxxxx1';
    const quote = async () => 0.002;
    expect(
      requestGreenMinuteJupiterRefresh({
        mint,
        nowMs: 4_000_000,
        snapshotPriceUsd: 0.001,
        enabled: true,
        minGapMs: 5_000,
        ttlMs: 30_000,
        maxMints: 1,
        maxInFlight: 1,
        probeUsd: 1,
        slippageBps: 150,
        quote,
        source: 'leader_mirror_jupiter',
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseGreenMinuteJupiterRefresh({
      source: 'leader_mirror_jupiter',
      keepMints: new Set(),
    });
    expect(
      requestGreenMinuteJupiterRefresh({
        mint,
        nowMs: 4_001_000,
        snapshotPriceUsd: 0.001,
        enabled: true,
        minGapMs: 5_000,
        ttlMs: 30_000,
        maxMints: 1,
        maxInFlight: 1,
        probeUsd: 1,
        slippageBps: 150,
        quote,
        source: 'leader_mirror_jupiter',
      }),
    ).toBe(false);
    expect(
      requestGreenMinuteJupiterRefresh({
        mint,
        nowMs: 4_005_001,
        snapshotPriceUsd: 0.001,
        enabled: true,
        minGapMs: 5_000,
        ttlMs: 30_000,
        maxMints: 1,
        maxInFlight: 1,
        probeUsd: 1,
        slippageBps: 150,
        quote,
        source: 'leader_mirror_jupiter',
      }),
    ).toBe(true);
  });
});
