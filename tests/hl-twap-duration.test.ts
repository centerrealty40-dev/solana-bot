import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  isShortTwapMinutes,
  twapDurationGate,
} from '../src/hyperliquid/twap/twap-duration.js';

describe('twap-duration', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.HL_TWAP_SHORT_ENABLED = '1';
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('short lane: 1–14m allowed, 15m gap, 16+ standard', () => {
    expect(twapDurationGate(5).allow).toBe(true);
    expect(twapDurationGate(5).reason).toBe('ok_short');
    expect(twapDurationGate(14).allow).toBe(true);
    expect(twapDurationGate(15).allow).toBe(false);
    expect(twapDurationGate(15).reason).toBe('twap_too_short');
    expect(twapDurationGate(16).allow).toBe(true);
    expect(twapDurationGate(16).reason).toBe('ok');
    expect(twapDurationGate(120).allow).toBe(true);
    expect(twapDurationGate(121).allow).toBe(false);
    expect(twapDurationGate(121).reason).toBe('twap_too_long');
  });

  it('isShortTwapMinutes respects enable flag', () => {
    process.env.HL_TWAP_SHORT_ENABLED = '0';
    expect(isShortTwapMinutes(10)).toBe(false);
    expect(twapDurationGate(10).allow).toBe(false);
  });
});
