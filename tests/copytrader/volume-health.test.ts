import { describe, expect, it } from 'vitest';
import {
  classifyVolumeSample,
  decideMultiWindowVolume,
  medianUsd,
  pushVolume5mSample,
} from '../../src/copytrader/volume-health.js';

const cfg = {
  minVolume5mUsd: 8_000,
  dropPct: 40,
  sampleWindow: 3,
  minWeakSamples: 2,
};

describe('volume-health', () => {
  it('pushes and caps the ring buffer', () => {
    let s: number[] | undefined;
    for (let i = 1; i <= 15; i++) s = pushVolume5mSample(s, i, 12);
    expect(s).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('median works for odd/even', () => {
    expect(medianUsd([3, 1, 2])).toBe(2);
    expect(medianUsd([4, 1, 2, 3])).toBe(2.5);
  });

  it('classifies floor and drop', () => {
    expect(classifyVolumeSample(cfg, { entryVolume5mUsd: 20_000, volume5mUsd: 5_000 })).toEqual({
      weak: true,
      reason: 'below_floor',
    });
    expect(classifyVolumeSample(cfg, { entryVolume5mUsd: 20_000, volume5mUsd: 11_000 })).toEqual({
      weak: true,
      reason: 'dropped_vs_entry',
    });
    expect(classifyVolumeSample(cfg, { entryVolume5mUsd: 20_000, volume5mUsd: 15_000 }).weak).toBe(
      false,
    );
  });

  it('does not exit on a single noisy weak tick (warming)', () => {
    const d = decideMultiWindowVolume(cfg, {
      entryVolume5mUsd: 15_437,
      samples: [15_437, 8_663],
    });
    expect(d.shouldExit).toBe(false);
    expect(d.reason).toBe('warming');
    expect(d.weakCount).toBe(1);
  });

  it('exits when 2 of last 3 samples are weak', () => {
    const d = decideMultiWindowVolume(cfg, {
      entryVolume5mUsd: 15_437,
      samples: [15_437, 14_000, 8_663, 7_500],
    });
    expect(d.shouldExit).toBe(true);
    expect(d.weakCount).toBe(2);
    expect(d.sampleCount).toBe(3);
  });

  it('holds when majority of window is still healthy', () => {
    const d = decideMultiWindowVolume(cfg, {
      entryVolume5mUsd: 20_000,
      samples: [20_000, 18_000, 8_500, 16_000],
    });
    // window = last 3: 18000 ok, 8500 weak (drop), 16000 ok → 1 weak < 2
    expect(d.shouldExit).toBe(false);
    expect(d.healthy).toBe(true);
    expect(d.weakCount).toBe(1);
  });

  it('legacy window=1 matches single-tick sell', () => {
    const d = decideMultiWindowVolume(
      { ...cfg, sampleWindow: 1, minWeakSamples: 1 },
      { entryVolume5mUsd: 20_000, samples: [11_000] },
    );
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('dropped_vs_entry');
  });
});
