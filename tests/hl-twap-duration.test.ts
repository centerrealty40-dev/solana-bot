import { describe, expect, it } from 'vitest';

import { twapDurationGate } from '../src/hyperliquid/twap/twap-duration.js';

describe('twap-duration', () => {
  it('defaults: 16–120m allowed, ≤15 and >120 blocked', () => {
    expect(twapDurationGate(15).allow).toBe(false);
    expect(twapDurationGate(15).reason).toBe('twap_too_short');
    expect(twapDurationGate(16).allow).toBe(true);
    expect(twapDurationGate(120).allow).toBe(true);
    expect(twapDurationGate(121).allow).toBe(false);
    expect(twapDurationGate(121).reason).toBe('twap_too_long');
  });
});
