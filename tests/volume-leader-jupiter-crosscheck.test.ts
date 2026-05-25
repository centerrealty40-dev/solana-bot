import { describe, expect, it } from 'vitest';
import { jupiterCrossCheckDivergenceOk } from '../src/papertrader/discovery/volume-leader-jupiter-crosscheck.js';

describe('volume-leader jupiter cross-check', () => {
  it('accepts divergence within min/max band', () => {
    expect(jupiterCrossCheckDivergenceOk(1, 1.02, 0.5, 35)).toBe(true);
    expect(jupiterCrossCheckDivergenceOk(1, 0.98, 0.5, 35)).toBe(true);
  });

  it('rejects divergence below min (noise)', () => {
    expect(jupiterCrossCheckDivergenceOk(1, 1.002, 0.5, 35)).toBe(false);
  });

  it('rejects divergence above max (wild mismatch)', () => {
    expect(jupiterCrossCheckDivergenceOk(1, 1.5, 0.5, 35)).toBe(false);
  });

  it('min 0 allows tiny divergence', () => {
    expect(jupiterCrossCheckDivergenceOk(1, 1.001, 0, 35)).toBe(true);
  });
});
