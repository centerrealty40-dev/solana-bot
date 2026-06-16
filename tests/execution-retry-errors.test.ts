import { describe, expect, it } from 'vitest';
import {
  isRetryableBuySimError,
  isRetryablePreBroadcastError,
  isRetryableSellSimError,
} from '../src/live/execution-retry-errors.js';

describe('execution-retry-errors', () => {
  it('retries swap-http-429 and quote_stale pre-broadcast', () => {
    expect(isRetryablePreBroadcastError('swap-http-429')).toBe(true);
    expect(isRetryablePreBroadcastError('swap-http-503')).toBe(true);
    expect(isRetryablePreBroadcastError('quote_stale:120ms>80ms')).toBe(true);
    expect(isRetryablePreBroadcastError('no_quote')).toBe(true);
    expect(isRetryablePreBroadcastError('chase_aborted:buy:4%')).toBe(false);
  });

  it('sell retries pre-broadcast and send_failed but not confirm_timeout', () => {
    expect(isRetryableSellSimError('swap-http-429')).toBe(true);
    expect(isRetryableSellSimError('send_failed:429')).toBe(true);
    expect(isRetryableSellSimError('confirm_timeout:60s')).toBe(false);
    expect(isRetryableSellSimError('sim_failed:InstructionError')).toBe(true);
  });

  it('buy retries pre-broadcast and send_failed but not insufficient funds', () => {
    expect(isRetryableBuySimError('swap-http-429')).toBe(true);
    expect(isRetryableBuySimError('send_failed:429')).toBe(true);
    expect(isRetryableBuySimError('insufficient_wallet_sol_for_buy')).toBe(false);
    expect(isRetryableBuySimError('sim_failed:InsufficientFunds')).toBe(false);
  });
});
