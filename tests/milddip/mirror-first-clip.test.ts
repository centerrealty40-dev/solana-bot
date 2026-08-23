import { describe, expect, it } from 'vitest';
import { mirrorFirstClipLegSize } from '../../src/milddip/entry-attempt.js';

describe('mirror first clip legs', () => {
  it('divides the configured clip into equal legs', () => {
    expect(mirrorFirstClipLegSize(50, 2)).toBe(25);
    expect(mirrorFirstClipLegSize(60, 2)).toBe(30);
  });

  it('preserves the existing single-leg behavior by default', () => {
    expect(mirrorFirstClipLegSize(50, 1)).toBe(50);
    expect(mirrorFirstClipLegSize(50, 0)).toBe(50);
  });
});
