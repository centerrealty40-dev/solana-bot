import { describe, expect, it } from 'vitest';
import {
  buildOhlcv1mFromPriceSamples,
  detectFirstStrongGreen,
  detectLeaderImpulseGreen,
  detectTripleGreen,
  type Ohlcv1m,
  type TripleGreenGates,
} from '../../src/volgreen/triple-green.js';

describe('buildOhlcv1mFromPriceSamples', () => {
  it('stitches open to previous close for sparse ticks', () => {
    const nowMs = 1_786_268_500_000;
    const bars = buildOhlcv1mFromPriceSamples(
      [
        { tsMs: nowMs - 120_000, priceUsd: 1.0 },
        { tsMs: nowMs - 60_000, priceUsd: 1.1 },
        { tsMs: nowMs - 5_000, priceUsd: 1.4 },
      ],
      { nowMs },
    );
    expect(bars.length).toBe(3);
    expect(bars[1]!.open).toBe(1.0);
    expect(bars[1]!.close).toBe(1.1);
    expect(bars[2]!.open).toBe(1.1);
    expect(bars[2]!.close).toBe(1.4);
    const fs = detectFirstStrongGreen(
      bars,
      { ...gates, firstStrongMinPc: 20, hugeMinVolUsd: 0 },
      Math.floor(nowMs / 1000),
    );
    expect(fs.pass).toBe(true);
  });
});

const gates: TripleGreenGates = {
  enabled: true,
  smallMinPc: 1,
  smallMaxPc: 12,
  hugeMinPc: 13,
  hugeMinVolUsd: 200,
  maxAgeAfterHugeMs: 180_000,
};

function bar(ts: number, o: number, c: number, vol: number): Ohlcv1m {
  return {
    ts,
    open: o,
    high: Math.max(o, c),
    low: Math.min(o, c),
    close: c,
    volumeUsd: vol,
  };
}

describe('detectTripleGreen', () => {
  it('matches Prometheus pattern: +6.5, +9.3, +30.5', () => {
    // Synthetic prices matching % bodies.
    const t0 = 1_786_175_100; // huge open unix
    const bars: Ohlcv1m[] = [
      bar(t0 - 180, 1.0, 0.95, 50), // red noise
      bar(t0 - 120, 1.0, 1.065, 149), // +6.5%
      bar(t0 - 60, 1.065, 1.164, 209), // +9.3%
      bar(t0, 1.164, 1.519, 1838), // +30.5%
    ];
    const v = detectTripleGreen(bars, gates, t0 + 70); // ~1m after huge open
    expect(v.pass).toBe(true);
    expect(v.pattern?.huge).toBeGreaterThanOrEqual(20);
  });

  it('rejects single huge first candle (newborn vertical)', () => {
    const t0 = 1_786_175_100;
    const bars: Ohlcv1m[] = [
      bar(t0 - 120, 1.0, 0.9, 10),
      bar(t0 - 60, 0.9, 0.85, 10),
      bar(t0, 0.85, 8.5, 5000), // +900% alone
    ];
    const v = detectTripleGreen(bars, gates, t0 + 30);
    expect(v.pass).toBe(false);
  });

  it('matches Paul-class: +3.3, +1.2, +16.6', () => {
    const t0 = 1_786_179_060;
    const bars: Ohlcv1m[] = [
      bar(t0 - 120, 1.0, 1.033, 311),
      bar(t0 - 60, 1.033, 1.045, 2), // +1.2%
      bar(t0, 1.045, 1.218, 3197), // +16.6%
    ];
    const v = detectTripleGreen(bars, gates, t0 + 70);
    expect(v.pass).toBe(true);
    expect(v.pattern?.huge).toBeGreaterThanOrEqual(13);
  });

  it('rejects three equal medium greens (no huge leg)', () => {
    const t0 = 1_786_175_100;
    const bars: Ohlcv1m[] = [
      bar(t0 - 120, 1.0, 1.08, 100),
      bar(t0 - 60, 1.08, 1.166, 100),
      bar(t0, 1.166, 1.259, 100), // ~8% each
    ];
    const v = detectTripleGreen(bars, gates, t0 + 30);
    expect(v.pass).toBe(false);
  });

  it('builds local 1m bars from price samples', () => {
    const now = Date.now();
    const samples = [
      { tsMs: now - 125_000, priceUsd: 1.0 },
      { tsMs: now - 100_000, priceUsd: 1.05 },
      { tsMs: now - 70_000, priceUsd: 1.08 },
      { tsMs: now - 40_000, priceUsd: 1.2 },
      { tsMs: now - 10_000, priceUsd: 1.5 },
    ];
    const bars = buildOhlcv1mFromPriceSamples(samples, { nowMs: now });
    expect(bars.length).toBeGreaterThanOrEqual(2);
    expect(bars[0]!.open).toBeGreaterThan(0);
  });

  it('first-strong accepts latest huge with mild prior (8XjTbP -8.8/16.1/42)', () => {
    const t0 = 1_786_266_830;
    const bars: Ohlcv1m[] = [
      bar(t0 - 120, 1.0, 0.912, 100), // -8.8%
      bar(t0 - 60, 0.912, 1.059, 200), // +16.1%
      bar(t0, 1.059, 1.504, 800), // +42%
    ];
    const g = {
      ...gates,
      hugeMinPc: 10,
      smallMaxPc: 18,
      hugeMinVolUsd: 100,
      firstStrongMinPc: 20,
      firstStrongMaxPriorPc: 18,
    };
    expect(detectTripleGreen(bars, g, t0 + 30).pass).toBe(false);
    const fs = detectFirstStrongGreen(bars, g, t0 + 30);
    expect(fs.pass).toBe(true);
    expect(fs.pattern?.huge).toBeGreaterThanOrEqual(40);
  });

  it('first-strong rejects when prior was already huge', () => {
    const t0 = 1_786_266_830;
    const bars: Ohlcv1m[] = [
      bar(t0 - 60, 1.0, 1.9, 500), // +90% prior
      bar(t0, 1.9, 2.3, 500), // +21% latest
    ];
    const g = {
      ...gates,
      firstStrongMinPc: 20,
      firstStrongMaxPriorPc: 18,
      hugeMinVolUsd: 100,
    };
    expect(detectFirstStrongGreen(bars, g, t0 + 30).pass).toBe(false);
  });

  it('leader flex accepts huge-in-middle (BJWHLm 1.2/82.4/14.4)', () => {
    const t0 = 1_786_225_357;
    const bars: Ohlcv1m[] = [
      bar(t0 - 120, 1.0, 1.012, 200), // +1.2%
      bar(t0 - 60, 1.012, 1.846, 5000), // +82.4%
      bar(t0, 1.846, 2.112, 2000), // +14.4%
    ];
    const classic = detectTripleGreen(bars, { ...gates, hugeMinPc: 10, smallMaxPc: 18 }, t0 + 30);
    expect(classic.pass).toBe(false);
    const flex = detectLeaderImpulseGreen(
      bars,
      { ...gates, hugeMinPc: 10, smallMaxPc: 18, hugeMinVolUsd: 100 },
      t0 + 30,
    );
    expect(flex.pass).toBe(true);
    expect(flex.pattern?.huge).toBeGreaterThan(50);
  });

  it('rejects stale huge (older than maxAgeAfterHugeMs)', () => {
    const t0 = 1_786_175_100;
    const bars: Ohlcv1m[] = [
      bar(t0 - 120, 1.0, 1.065, 149),
      bar(t0 - 60, 1.065, 1.164, 209),
      bar(t0, 1.164, 1.519, 1838),
    ];
    const v = detectTripleGreen(bars, gates, t0 + 400); // >180s
    expect(v.pass).toBe(false);
  });
});
