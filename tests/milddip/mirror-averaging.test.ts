import { describe, expect, it } from 'vitest';
import { recentMirrorLocalLow, parseMirrorOhlcvList } from '../../src/milddip/mirror-averaging.js';

describe('mirror averaging local low', () => {
  it('parses candles, excludes the tail, and finds the minimum low', () => {
    const now = 10_000_000;
    const candles = parseMirrorOhlcvList([
      [Math.floor((now - 3_600_000) / 1000), 10, 11, 7, 9, 1],
      [Math.floor((now - 1_200_000) / 1000), 10, 11, 6, 9, 1],
      [Math.floor((now - 300_000) / 1000), 10, 11, 2, 9, 1],
    ]);
    expect(recentMirrorLocalLow({
      candles,
      nowMs: now,
      windowMs: 3_600_000,
      excludeTailMs: 900_000,
    })).toBe(6);
  });

  it('returns null when the valid window is empty', () => {
    expect(recentMirrorLocalLow({
      candles: [{ tsMs: 9_900_000, low: 1 }],
      nowMs: 10_000_000,
      windowMs: 3_600_000,
      excludeTailMs: 900_000,
    })).toBeNull();
  });
});
