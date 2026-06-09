import { describe, expect, it } from 'vitest';
import { waveBSellFractionForStep } from '../../src/papertrader/executor/exit-policy-wave-b.js';

describe('follow wave B TP grid', () => {
  it('escalates sell fraction by rung k×5%', () => {
    expect(waveBSellFractionForStep(1)).toBeCloseTo(0.05, 6);
    expect(waveBSellFractionForStep(4)).toBeCloseTo(0.2, 6);
    expect(waveBSellFractionForStep(25)).toBe(1);
  });
});
