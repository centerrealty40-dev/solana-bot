import { describe, expect, it } from 'vitest';
import {
  isImpulsePlayedOut,
  isThinEarlyTape,
} from '../../src/volgreen/entry-quality.js';

describe('entry-quality guards', () => {
  it('detects impulse played out when last is >5% below 5m peak', () => {
    const nowMs = 1_700_000_000_000;
    const samples = [
      { tsMs: nowMs - 240_000, priceUsd: 1.0 },
      { tsMs: nowMs - 180_000, priceUsd: 1.1 },
      { tsMs: nowMs - 120_000, priceUsd: 1.2 }, // peak
      { tsMs: nowMs - 60_000, priceUsd: 1.15 },
      { tsMs: nowMs - 5_000, priceUsd: 1.12 }, // −6.7% from peak
    ];
    const v = isImpulsePlayedOut(samples, {
      nowMs,
      lookbackMs: 300_000,
      maxDdPct: 5,
      minSamples: 4,
    });
    expect(v.hit).toBe(true);
    expect(v.ddPct!).toBeLessThan(-5);
  });

  it('does not flag when still near peak', () => {
    const nowMs = 1_700_000_000_000;
    const samples = [
      { tsMs: nowMs - 180_000, priceUsd: 1.0 },
      { tsMs: nowMs - 120_000, priceUsd: 1.1 },
      { tsMs: nowMs - 60_000, priceUsd: 1.2 },
      { tsMs: nowMs - 5_000, priceUsd: 1.19 },
    ];
    const v = isImpulsePlayedOut(samples, {
      nowMs,
      maxDdPct: 5,
      minSamples: 4,
    });
    expect(v.hit).toBe(false);
  });

  it('flags thin early tape (few samples / short span)', () => {
    const nowMs = Date.now();
    const thin = [
      { tsMs: nowMs - 20_000, priceUsd: 1.0 },
      { tsMs: nowMs - 5_000, priceUsd: 1.1 },
    ];
    const v = isThinEarlyTape(thin, {
      nowMs,
      minSamples: 6,
      minSpanMs: 60_000,
      lookbackMs: 600_000,
    });
    expect(v.hit).toBe(true);
    expect(v.samples).toBe(2);
  });

  it('accepts dense early tape', () => {
    const nowMs = 1_700_000_000_000;
    const samples: Array<{ tsMs: number; priceUsd: number }> = [];
    for (let i = 0; i < 8; i++) {
      samples.push({
        tsMs: nowMs - (8 - i) * 20_000,
        priceUsd: 1 + i * 0.01,
      });
    }
    const v = isThinEarlyTape(samples, {
      nowMs,
      minSamples: 6,
      minSpanMs: 60_000,
    });
    expect(v.hit).toBe(false);
    expect(v.samples).toBeGreaterThanOrEqual(6);
  });
});
