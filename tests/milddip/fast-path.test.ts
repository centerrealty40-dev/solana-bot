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
});
