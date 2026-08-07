import { describe, expect, it } from 'vitest';
import { inDipBand } from '../../src/milddip/fast-path.js';

describe('fast-path helpers', () => {
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
});
