import { describe, expect, it, beforeEach } from 'vitest';
import {
  ShyftStreamCircuitBreaker,
  isSingleMintSetChange,
  mintSetSymmetricDelta,
} from '../src/papertrader/stream/shyft-shadow-resilience.js';

describe('mintSetSymmetricDelta', () => {
  it('detects single add and remove', () => {
    expect(mintSetSymmetricDelta(['a', 'b'], ['a', 'b', 'c'])).toEqual({
      added: ['c'],
      removed: [],
    });
    expect(mintSetSymmetricDelta(['a', 'b', 'c'], ['a', 'b'])).toEqual({
      added: [],
      removed: ['c'],
    });
  });
});

describe('isSingleMintSetChange', () => {
  it('true for +/- one mint', () => {
    expect(isSingleMintSetChange(['m1', 'm2'], ['m1', 'm2', 'm3'])).toBe(true);
    expect(isSingleMintSetChange(['m1', 'm2', 'm3'], ['m1', 'm2'])).toBe(true);
  });

  it('false for larger churn', () => {
    expect(isSingleMintSetChange(['m1'], ['m2', 'm3'])).toBe(false);
    expect(isSingleMintSetChange(['m1', 'm2'], ['m1', 'm2'])).toBe(false);
  });
});

describe('ShyftStreamCircuitBreaker', () => {
  it('opens after N fast fails in window', () => {
    const cb = new ShyftStreamCircuitBreaker(3, 120_000, 900_000);
    let t = 1_000_000;
    expect(cb.recordFastFail(t)).toBe(false);
    expect(cb.recordFastFail(t + 1_000)).toBe(false);
    expect(cb.recordFastFail(t + 2_000)).toBe(true);
    expect(cb.isOpen(t + 2_000)).toBe(true);
    expect(cb.remainingMs(t + 2_000)).toBe(900_000);
    expect(cb.isOpen(t + 902_001)).toBe(false);
  });

  it('prunes old failures outside window', () => {
    const cb = new ShyftStreamCircuitBreaker(3, 10_000, 60_000);
    expect(cb.recordFastFail(0)).toBe(false);
    expect(cb.recordFastFail(5_000)).toBe(false);
    expect(cb.recordFastFail(20_000)).toBe(false);
    expect(cb.recordFastFail(25_000)).toBe(false);
    expect(cb.isOpen(25_000)).toBe(false);
  });
});
