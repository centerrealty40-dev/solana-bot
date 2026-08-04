import { describe, expect, it } from 'vitest';
import { isRpcCapacityError } from '../../src/copytrader/rpc.js';

describe('isRpcCapacityError', () => {
  it('detects helius max usage', () => {
    expect(isRpcCapacityError(429, 'max usage reached')).toBe(true);
  });
  it('detects alchemy monthly capacity', () => {
    expect(isRpcCapacityError(429, 'Monthly capacity limit exceeded')).toBe(true);
  });
  it('ignores ordinary rate limit text', () => {
    expect(isRpcCapacityError(429, 'Too many requests')).toBe(false);
  });
});
