import { describe, expect, it } from 'vitest';
import {
  isPreSendSimFailureMessage,
  isRetryableBuySimError,
  isRetryablePreBroadcastError,
  isRetryableSellSimError,
} from '../src/live/execution-retry-errors.js';

describe('execution-retry-errors', () => {
  it('does not tight-loop retry swap-http-429 pre-broadcast', () => {
    expect(isRetryablePreBroadcastError('swap-http-429')).toBe(false);
    expect(isRetryablePreBroadcastError('swap-http-503')).toBe(true);
    expect(isRetryablePreBroadcastError('quote_stale:120ms>80ms')).toBe(true);
    expect(isRetryablePreBroadcastError('no_quote')).toBe(true);
    expect(isRetryablePreBroadcastError('chase_aborted:buy:4%')).toBe(false);
  });

  it('sell retries send_failed but not confirm_timeout or swap-http-429', () => {
    expect(isRetryableSellSimError('swap-http-429')).toBe(false);
    expect(isRetryableSellSimError('send_failed:429')).toBe(true);
    expect(isRetryableSellSimError('confirm_timeout:60s')).toBe(false);
    expect(isRetryableSellSimError('sim_failed:InstructionError')).toBe(true);
  });

  it('buy retries send_failed but not insufficient funds or swap-http-429', () => {
    expect(isRetryableBuySimError('swap-http-429')).toBe(false);
    expect(isRetryableBuySimError('send_failed:429')).toBe(true);
    expect(isRetryableBuySimError('insufficient_wallet_sol_for_buy')).toBe(false);
    expect(isRetryableBuySimError('sim_failed:InsufficientFunds')).toBe(false);
  });

  it('buy retries SOLANGELES-class pre-send sim / slippage messages', () => {
    const solAngelesMsg =
      'rpc_error:Transaction simulation failed: Error processing Instruction 6: custom program error: 0x1771';
    expect(isPreSendSimFailureMessage(solAngelesMsg)).toBe(true);
    expect(isRetryableBuySimError(solAngelesMsg)).toBe(true);
    expect(isRetryableBuySimError('qn_rpc_error:Transaction simulation failed')).toBe(true);
    expect(isRetryableBuySimError('sim_failed:{"InstructionError":[6,{"Custom":6001}]}')).toBe(true);
  });
});
