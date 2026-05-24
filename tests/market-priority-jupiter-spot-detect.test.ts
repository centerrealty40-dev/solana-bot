import { describe, expect, it } from 'vitest';

process.env.SPIKE_ALERT_SKIP_MAIN = '1';
process.env.SPIKE_ALERT_TIERED_BY_MCAP = '1';

import {
  detectJupiterLocalHighRetrace,
  detectJupiterRiseThenRetrace,
  detectJupiterSpikeMove,
  pctChange,
  type JupiterSpotDetectConfig,
} from '../src/scripts/market-priority-jupiter-spot-detect.js';

const cfg: JupiterSpotDetectConfig = {
  rollingMinMinutes: 3,
  rollingMaxMinutes: 10,
  pumpMinPct: 30,
  tieredByMcap: true,
  dumpTier1McapUsd: 1_500_000,
  dumpTier2McapUsd: 3_000_000,
  dumpTier3McapUsd: 7_000_000,
  dumpTier1MinPctConsec: 14,
  dumpTier2MinPctConsec: 11,
  dumpTier3MinPctConsec: 8,
  dumpTier1MinPctRolling: 15,
  dumpTier2MinPctRolling: 12,
  dumpTier3MinPctRolling: 10,
  minPullbackRetracePct: 10,
  minRetracePumpPct: 6,
  minRetraceRetracePct: 10,
  scanMinutesPullback: 60,
  scanMinutesRetrace: 90,
};

describe('market-priority-jupiter-spot-detect', () => {
  it('pctChange', () => {
    expect(pctChange(100, 90)).toBeCloseTo(-10);
    expect(pctChange(100, 130)).toBeCloseTo(30);
  });

  it('detects tier2 dump on rolling window', () => {
    const t0 = Date.now() - 5 * 60_000;
    const samples = [
      { tsMs: t0, priceUsd: 1.0 },
      { tsMs: t0 + 60_000, priceUsd: 1.05 },
      { tsMs: t0 + 4 * 60_000, priceUsd: 0.88 },
    ];
    const hit = detectJupiterSpikeMove(samples, 4_000_000, cfg);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('dump');
    expect(Math.abs(hit!.pct)).toBeGreaterThanOrEqual(11);
  });

  it('detects local high retrace for dips', () => {
    const t0 = Date.now() - 20 * 60_000;
    const samples = [
      { tsMs: t0, priceUsd: 1.0 },
      { tsMs: t0 + 5 * 60_000, priceUsd: 1.2 },
      { tsMs: t0 + 10 * 60_000, priceUsd: 1.05 },
    ];
    const hit = detectJupiterLocalHighRetrace(samples, 10, 30);
    expect(hit).not.toBeNull();
    expect(hit!.retraceFromPeakPct).toBeCloseTo(12.5, 1);
  });

  it('detects rise-then-retrace pattern', () => {
    const t0 = Date.now() - 30 * 60_000;
    const samples = [
      { tsMs: t0, priceUsd: 1.0 },
      { tsMs: t0 + 8 * 60_000, priceUsd: 1.08 },
      { tsMs: t0 + 15 * 60_000, priceUsd: 0.95 },
    ];
    const hit = detectJupiterRiseThenRetrace(samples, 6, 10, 60);
    expect(hit).not.toBeNull();
    expect(hit!.retraceFromPeakPct).toBeGreaterThanOrEqual(10);
  });
});
