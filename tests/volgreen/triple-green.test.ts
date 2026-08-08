import { describe, expect, it } from 'vitest';
import {
  detectTripleGreen,
  type Ohlcv1m,
  type TripleGreenGates,
} from '../../src/volgreen/triple-green.js';

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
