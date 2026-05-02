import { describe, expect, it } from 'vitest';
import { tokenAmountRawFromUsd } from '../src/live/phase4-execution.js';

describe('tokenAmountRawFromUsd (W8.0-p4)', () => {
  it('converts USD notionals at given decimals', () => {
    expect(tokenAmountRawFromUsd(100, 0.05, 6)).toBe('2000000000');
    expect(tokenAmountRawFromUsd(1, 1, 6)).toBe('1000000');
  });

  it('returns null for invalid inputs', () => {
    expect(tokenAmountRawFromUsd(0, 1, 6)).toBeNull();
    expect(tokenAmountRawFromUsd(10, 0, 6)).toBeNull();
  });
});
