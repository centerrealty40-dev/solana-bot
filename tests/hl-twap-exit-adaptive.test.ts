import { describe, expect, it, afterEach } from 'vitest';

import {
  twapDurationGate,
  twapExitEarlyMinutesForDuration,
} from '../src/hyperliquid/twap/twap-duration.js';

describe('twap exit adaptive', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('hold-to-end returns 0 early minutes', () => {
    process.env.HL_TWAP_HOLD_TO_END = '1';
    process.env.HL_TWAP_SHORT_ENABLED = '0';
    expect(twapExitEarlyMinutesForDuration(16)).toBe(0);
    expect(twapExitEarlyMinutesForDuration(60)).toBe(0);
  });

  it('≤30m uses fixed −10m', () => {
    process.env.HL_TWAP_HOLD_TO_END = '0';
    process.env.HL_TWAP_SHORT_ENABLED = '0';
    expect(twapExitEarlyMinutesForDuration(16)).toBe(10);
    expect(twapExitEarlyMinutesForDuration(30)).toBe(10);
  });

  it('>30m uses last 25%', () => {
    process.env.HL_TWAP_HOLD_TO_END = '0';
    process.env.HL_TWAP_SHORT_ENABLED = '0';
    expect(twapExitEarlyMinutesForDuration(60)).toBe(15);
    expect(twapExitEarlyMinutesForDuration(120)).toBe(30);
  });

  it('60m passes duration gate with adaptive hold', () => {
    process.env.HL_TWAP_SHORT_ENABLED = '0';
    expect(twapDurationGate(60).allow).toBe(true);
  });
});
