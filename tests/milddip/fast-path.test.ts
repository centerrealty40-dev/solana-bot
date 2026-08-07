import { describe, expect, it, beforeEach } from 'vitest';
import {
  allowHotDexProbe,
  inDipBand,
  resetFastPathStateForTests,
} from '../../src/milddip/fast-path.js';

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
});
