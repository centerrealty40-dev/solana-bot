import { afterEach, describe, expect, it } from 'vitest';

import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import { twapCancelExitDelayMinutes } from '../src/hyperliquid/twap/twap-duration.js';
import {
  pendingWhaleExitMs,
  scheduleWhaleExitDelay,
  takeDueWhaleExit,
} from '../src/hyperliquid/twap/twap-whale-exit.js';
import { shouldCloseOnWhaleTwapCancel } from '../src/hyperliquid/twap/user-rating.js';

describe('twap-whale-exit delay', () => {
  const env = process.env;

  afterEach(() => {
    process.env = { ...env };
  });

  it('defaults cancel exit delay to 2 minutes', () => {
    delete process.env.HL_TWAP_CANCEL_EXIT_DELAY_MINUTES;
    expect(twapCancelExitDelayMinutes()).toBe(2);
  });

  it('schedules exit and fires after delay', () => {
    process.env.HL_TWAP_CANCEL_EXIT_DELAY_MINUTES = '2';
    const state = createTwapWatchState();
    const t0 = 1_000_000;
    expect(scheduleWhaleExitDelay(state, '0xabc', 'twap_terminated', t0)).toBe(true);
    expect(takeDueWhaleExit(state, '0xabc', t0 + 60_000)).toBeNull();
    expect(pendingWhaleExitMs(state, '0xabc', t0 + 60_000)).toBe(60_000);
    expect(takeDueWhaleExit(state, '0xabc', t0 + 2 * 60_000)).toBe('twap_terminated');
  });

  it('upgrades generic twap_ended_feed reason to specific status', () => {
    process.env.HL_TWAP_CANCEL_EXIT_DELAY_MINUTES = '2';
    const state = createTwapWatchState();
    const t0 = 0;
    scheduleWhaleExitDelay(state, '0xabc', 'twap_ended_feed', t0);
    scheduleWhaleExitDelay(state, '0xabc', 'twap_error', t0);
    expect(takeDueWhaleExit(state, '0xabc', t0 + 120_000)).toBe('twap_error');
  });

  it('delay 0 returns false so caller closes immediately', () => {
    process.env.HL_TWAP_CANCEL_EXIT_DELAY_MINUTES = '0';
    const state = createTwapWatchState();
    expect(scheduleWhaleExitDelay(state, '0xabc', 'twap_error')).toBe(false);
  });
});

describe('shouldCloseOnWhaleTwapCancel', () => {
  it('cancel/error/terminated yes; finished/activated no', () => {
    expect(shouldCloseOnWhaleTwapCancel('terminated')).toBe(true);
    expect(shouldCloseOnWhaleTwapCancel('error')).toBe(true);
    expect(shouldCloseOnWhaleTwapCancel('cancelled')).toBe(true);
    expect(shouldCloseOnWhaleTwapCancel('finished')).toBe(false);
    expect(shouldCloseOnWhaleTwapCancel('activated')).toBe(false);
  });
});
