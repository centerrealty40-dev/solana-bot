import { describe, expect, it } from 'vitest';
import { evaluateSignalPriceFreshness } from '../../src/milddip/signal-price-freshness.js';

describe('evaluateSignalPriceFreshness', () => {
  it('marks a materially divergent old signal as stale', () => {
    const verdict = evaluateSignalPriceFreshness({
      signalPriceUsd: 8.244e-5,
      quotePriceUsd: 1.13e-4,
      markAgeMs: 45_001,
      maxMarkAgeMs: 45_000,
      maxDivergencePct: 15,
    });
    expect(verdict.stale).toBe(true);
    expect(verdict.divergencePct).toBeCloseTo(37.069, 2);
  });

  it('keeps the old behavior when both thresholds are disabled', () => {
    expect(evaluateSignalPriceFreshness({
      signalPriceUsd: 1,
      quotePriceUsd: 2,
      markAgeMs: 999_999,
      maxMarkAgeMs: 0,
      maxDivergencePct: 0,
    })).toEqual({ stale: false, divergencePct: 100 });
  });

  it('does not classify a fresh quote within the configured divergence', () => {
    expect(evaluateSignalPriceFreshness({
      signalPriceUsd: 100,
      quotePriceUsd: 114,
      markAgeMs: 45_000,
      maxMarkAgeMs: 45_000,
      maxDivergencePct: 15,
    }).stale).toBe(false);
  });
});
