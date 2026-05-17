import { beforeAll, describe, expect, it } from 'vitest';

type Bar = { ts: Date; px: number; mcapUsd: number | null };

let detectRiseThenRetraceFromBars: (
  bars: Bar[],
  minRisePct: number,
  minRetraceFromPeakPct: number,
) => import('../src/scripts/market-pullback-telegram-watch.js').PullbackPick | null;
let detectLocalHighRetraceFromBars: (
  bars: Bar[],
  minRetraceFromPeakPct: number,
) => import('../src/scripts/market-pullback-telegram-watch.js').PullbackPick | null;

beforeAll(async () => {
  process.env.PULLBACK_ALERT_SKIP_MAIN = '1';
  const mod = await import('../src/scripts/market-pullback-telegram-watch.js');
  detectRiseThenRetraceFromBars = mod.detectRiseThenRetraceFromBars;
  detectLocalHighRetraceFromBars = mod.detectLocalHighRetraceFromBars;
});

function bar(tsMin: number, px: number): Bar {
  const t = new Date(`2026-05-15T12:${String(tsMin).padStart(2, '0')}:00Z`);
  return { ts: t, px, mcapUsd: 2e6 };
}

describe('detectRiseThenRetraceFromBars', () => {
  it('returns null when price ends at peak (no retrace)', () => {
    const bars = [bar(0, 1), bar(1, 1.07), bar(2, 1.12)];
    expect(detectRiseThenRetraceFromBars(bars, 6, 10)).toBeNull();
  });

  it('requires rise from anchor to peak >= minRise', () => {
    const bars = [bar(0, 1), bar(1, 1.03), bar(2, 1.03 * 0.88)];
    expect(detectRiseThenRetraceFromBars(bars, 6, 10)).toBeNull();
  });

  it('fires when rise >=6% and last bar is >=10% below peak', () => {
    const bars = [bar(0, 1), bar(1, 1.08), bar(2, 1.08 * 0.89)];
    const p = detectRiseThenRetraceFromBars(bars, 6, 10);
    expect(p).not.toBeNull();
    expect(p!.signalMode).toBe('rise_then_retrace');
    expect(p!.risePct).toBeGreaterThanOrEqual(6 - 1e-6);
    expect(p!.retraceFromPeakPct).toBeGreaterThanOrEqual(10 - 1e-6);
  });

  it('uses rightmost plateau as peak', () => {
    const bars = [bar(0, 1), bar(1, 1.1), bar(2, 1.1), bar(3, 1.1 * 0.85)];
    const p = detectRiseThenRetraceFromBars(bars, 6, 10);
    expect(p).not.toBeNull();
    expect(p!.signalMode).toBe('rise_then_retrace');
    expect(p!.peakTs.getTime()).toBe(bars[2].ts.getTime());
  });

  it('берёт последний хай ноги, а не более ранний глобальный max в окне', () => {
    const bars = [
      bar(0, 1.0),
      bar(1, 1.2),
      bar(2, 1.05),
      bar(3, 1.0),
      bar(4, 1.1),
      bar(5, 0.9),
    ];
    const p = detectRiseThenRetraceFromBars(bars, 6, 10);
    expect(p).not.toBeNull();
    expect(p!.peakTs.getTime()).toBe(bars[4].ts.getTime());
    expect(p!.peakPx).toBeCloseTo(1.1, 6);
    expect(p!.retraceFromPeakPct).toBeGreaterThanOrEqual(10 - 1e-6);
  });
});

describe('detectLocalHighRetraceFromBars', () => {
  it('fires on retrace from window peak without prior rise requirement (monotonic down)', () => {
    const bars = [bar(0, 1.2), bar(1, 1.15), bar(2, 1.0)];
    const p = detectLocalHighRetraceFromBars(bars, 10);
    expect(p).not.toBeNull();
    expect(p!.signalMode).toBe('local_high_retrace');
    expect(p!.retraceFromPeakPct).toBeGreaterThanOrEqual(10 - 1e-6);
  });

  it('returns null when rise_then would fail but local_high only checks retrace', () => {
    const bars = [bar(0, 1), bar(1, 1.02), bar(2, 1.02 * 0.88)];
    expect(detectRiseThenRetraceFromBars(bars, 6, 10)).toBeNull();
    const p = detectLocalHighRetraceFromBars(bars, 10);
    expect(p).not.toBeNull();
    expect(p!.signalMode).toBe('local_high_retrace');
  });

  it('returns null when still at peak', () => {
    const bars = [bar(0, 1), bar(1, 1.07), bar(2, 1.12)];
    expect(detectLocalHighRetraceFromBars(bars, 6)).toBeNull();
  });
});
