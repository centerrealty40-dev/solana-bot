import { describe, expect, it } from 'vitest';
import {
  countConsecutiveVolDecline,
  loadKnifeVolDecayConfig,
  minuteBucketMs,
  recordVolDeclineSample,
  volDecayExitTriggered,
} from '../src/scripts/knife-vol-decay-exit.js';

describe('knife-vol-decay-exit', () => {
  it('counts consecutive minute-over-minute declines from the tail', () => {
    const samples = [
      { bucketMs: 0, volUsd: 100_000 },
      { bucketMs: 60_000, volUsd: 95_000 },
      { bucketMs: 120_000, volUsd: 90_000 },
      { bucketMs: 180_000, volUsd: 88_000 },
    ];
    expect(countConsecutiveVolDecline(samples)).toBe(3);
    expect(volDecayExitTriggered(samples, 3)).toBe(true);
    expect(volDecayExitTriggered(samples, 4)).toBe(false);
  });

  it('resets the decline chain when volume flat or rises', () => {
    const samples = [
      { bucketMs: 0, volUsd: 100_000 },
      { bucketMs: 60_000, volUsd: 90_000 },
      { bucketMs: 120_000, volUsd: 90_000 },
      { bucketMs: 180_000, volUsd: 85_000 },
    ];
    expect(countConsecutiveVolDecline(samples)).toBe(1);
  });

  it('replaces the current minute bucket instead of duplicating', () => {
    const t0 = minuteBucketMs(125_000);
    const first = recordVolDeclineSample([], 50_000, t0 + 5_000);
    expect(first.samples).toHaveLength(1);
    const second = recordVolDeclineSample(first.samples, 48_000, t0 + 40_000);
    expect(second.samples).toHaveLength(1);
    expect(second.samples[0]!.volUsd).toBe(48_000);
  });

  it('defaults to 5 consecutive minutes and vol5m metric (scalp)', () => {
    const cfg = loadKnifeVolDecayConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.consecutiveMin).toBe(5);
    expect(cfg.sampleMs).toBe(60_000);
    expect(cfg.metric).toBe('vol5m');
  });

  it('fires exit after 5 strict declines', () => {
    let samples: Array<{ bucketMs: number; volUsd: number }> = [];
    const base = minuteBucketMs(Date.now());
    for (let i = 0; i < 6; i += 1) {
      const vol = 50_000 - i * 2_000;
      const r = recordVolDeclineSample(samples, vol, base + i * 60_000);
      samples = r.samples;
    }
    expect(countConsecutiveVolDecline(samples)).toBe(5);
    expect(volDecayExitTriggered(samples, 5)).toBe(true);
  });
});
