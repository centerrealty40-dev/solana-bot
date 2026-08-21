import { describe, expect, it } from 'vitest';
import {
  __resetGreenMinuteJupiterRefreshForTests,
  greenMinuteJupiterStats,
  requestGreenMinuteJupiterRefresh,
} from '../../src/milddip/green-minute-jupiter-refresh.js';

const mint = (n: number) => `${String(n).padStart(2, '0')}${'A'.repeat(40)}`;

describe('mirror Jupiter quote feed', () => {
  it('always quotes new mirror candidates when the mirror cap is unlimited', async () => {
    __resetGreenMinuteJupiterRefreshForTests();
    const quoted: string[] = [];
    const quote = async ({ mint: candidate }: { mint: string }) => {
      quoted.push(candidate);
      return 1;
    };
    expect(requestGreenMinuteJupiterRefresh({
      mint: mint(1),
      nowMs: 1_000,
      snapshotPriceUsd: 1,
      enabled: true,
      minGapMs: 0,
      ttlMs: 60_000,
      maxMints: 0,
      maxInFlight: 16,
      probeUsd: 1,
      slippageBps: 50,
      quote,
      source: 'leader_mirror_jupiter',
    })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestGreenMinuteJupiterRefresh({
      mint: mint(2),
      nowMs: 2_000,
      snapshotPriceUsd: 1,
      enabled: true,
      minGapMs: 0,
      ttlMs: 60_000,
      maxMints: 0,
      maxInFlight: 16,
      probeUsd: 1,
      slippageBps: 50,
      quote,
      source: 'leader_mirror_jupiter',
    })).toBe(true);
    await Promise.resolve();
    expect(requestGreenMinuteJupiterRefresh({
      mint: mint(3),
      nowMs: 3_000,
      snapshotPriceUsd: 1,
      enabled: true,
      minGapMs: 0,
      ttlMs: 60_000,
      maxMints: 0,
      maxInFlight: 16,
      probeUsd: 1,
      slippageBps: 50,
      quote,
      source: 'leader_mirror_jupiter',
    })).toBe(true);
    expect(greenMinuteJupiterStats(3_000, 60_000, 'leader_mirror_jupiter').activeMints).toBe(3);
    expect(quoted).toContain(mint(3));
  });

  it('keeps the green lane capped independently', async () => {
    __resetGreenMinuteJupiterRefreshForTests();
    const quote = async () => 1;
    expect(requestGreenMinuteJupiterRefresh({
      mint: mint(5),
      nowMs: 1_000,
      snapshotPriceUsd: 1,
      enabled: true,
      minGapMs: 0,
      ttlMs: 60_000,
      maxMints: 1,
      maxInFlight: 1,
      probeUsd: 1,
      slippageBps: 50,
      quote,
      source: 'green_jupiter',
    })).toBe(true);
    await Promise.resolve();
    expect(requestGreenMinuteJupiterRefresh({
      mint: mint(6),
      nowMs: 2_000,
      snapshotPriceUsd: 1,
      enabled: true,
      minGapMs: 0,
      ttlMs: 60_000,
      maxMints: 1,
      maxInFlight: 1,
      probeUsd: 1,
      slippageBps: 50,
      quote,
      source: 'green_jupiter',
    })).toBe(false);
    expect(greenMinuteJupiterStats(2_000, 60_000, 'green_jupiter').capRejected).toBe(1);
  });

  it('expires candidates after the short mirror TTL', async () => {
    __resetGreenMinuteJupiterRefreshForTests();
    expect(requestGreenMinuteJupiterRefresh({
      mint: mint(4),
      nowMs: 1_000,
      snapshotPriceUsd: 1,
      enabled: true,
      minGapMs: 0,
      ttlMs: 30_000,
      maxMints: 1,
      maxInFlight: 1,
      probeUsd: 1,
      slippageBps: 50,
      quote: async () => 1,
      source: 'leader_mirror_jupiter',
    })).toBe(true);
    await Promise.resolve();
    expect(greenMinuteJupiterStats(31_001, 30_000, 'leader_mirror_jupiter').activeMints).toBe(0);
  });

  it('keeps each source alive when the other source uses a shorter TTL', async () => {
    __resetGreenMinuteJupiterRefreshForTests();
    const request = (
      candidate: string,
      source: 'green_jupiter' | 'leader_mirror_jupiter',
      nowMs = 1_000,
    ) =>
      requestGreenMinuteJupiterRefresh({
        mint: candidate,
        nowMs,
        snapshotPriceUsd: 1,
        enabled: true,
        minGapMs: 0,
        ttlMs: source === 'green_jupiter' ? 60_000 : 30_000,
        maxMints: 0,
        maxInFlight: 16,
        probeUsd: 1,
        slippageBps: 50,
        quote: async () => 1,
        source,
      });
    expect(request(mint(7), 'green_jupiter')).toBe(true);
    expect(request(mint(8), 'leader_mirror_jupiter')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestGreenMinuteJupiterRefresh({
      mint: mint(8),
      nowMs: 31_001,
      snapshotPriceUsd: 1,
      enabled: true,
      minGapMs: 0,
      ttlMs: 30_000,
      maxMints: 0,
      maxInFlight: 16,
      probeUsd: 1,
      slippageBps: 50,
      quote: async () => 1,
      source: 'leader_mirror_jupiter',
    })).toBe(true);
    expect(greenMinuteJupiterStats(31_001, 60_000, 'green_jupiter').activeMints).toBe(1);
    expect(request(mint(7), 'green_jupiter', 31_001)).toBe(true);
    expect(greenMinuteJupiterStats(31_001, 30_000, 'leader_mirror_jupiter').activeMints).toBe(1);
  });
});
