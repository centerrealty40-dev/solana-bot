import { describe, expect, it } from 'vitest';

import {
  remainderCloseFrac,
  remainingGrossUsd,
  shouldRemainderFlush,
} from '../src/hyperliquid/oscar-remainder-flush.js';

describe('oscar-remainder-flush', () => {
  it('remainderCloseFrac converts pct to fraction', () => {
    expect(remainderCloseFrac(10)).toBe(0.1);
    expect(remainderCloseFrac(0)).toBe(0);
    expect(remainderCloseFrac(150)).toBe(1);
  });

  it('shouldRemainderFlush at 10% threshold', () => {
    expect(shouldRemainderFlush(0.1, 10)).toBe(true);
    expect(shouldRemainderFlush(0.08, 10)).toBe(true);
    expect(shouldRemainderFlush(0.125, 10)).toBe(false);
    expect(shouldRemainderFlush(0, 10)).toBe(false);
  });

  it('remainingGrossUsd tracks original notional', () => {
    expect(remainingGrossUsd(100, 0.08)).toBeCloseTo(8);
    expect(remainingGrossUsd(100, 0.125)).toBeCloseTo(12.5);
  });
});
