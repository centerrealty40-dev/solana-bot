import { describe, expect, it } from 'vitest';
import {
  isPendingSellExpired,
  isSellRetryableError,
  nextSellSlippageBps,
} from '../../src/copytrader/pending-sell-retry.js';

describe('isSellRetryableError', () => {
  it('retries Jupiter 0x1771 slippage', () => {
    expect(
      isSellRetryableError(
        'rpc_error:Transaction simulation failed: custom program error: 0x1771',
      ),
    ).toBe(true);
  });

  it('retries confirm_timeout', () => {
    expect(isSellRetryableError('confirm_timeout')).toBe(true);
  });

  it('retries Jupiter Custom:6024 sim_failed', () => {
    expect(
      isSellRetryableError('sim_failed:{"InstructionError":[3,{"Custom":6024}]}'),
    ).toBe(true);
  });

  it('does not retry missing balance', () => {
    expect(isSellRetryableError('no_token_balance')).toBe(false);
  });
});

describe('nextSellSlippageBps', () => {
  it('bumps slippage on each retry up to max', () => {
    expect(
      nextSellSlippageBps({
        baseBps: 400,
        currentBps: undefined,
        bumpBps: 100,
        maxBps: 2000,
      }),
    ).toBe(500);
    expect(
      nextSellSlippageBps({
        baseBps: 400,
        currentBps: 500,
        bumpBps: 100,
        maxBps: 2000,
      }),
    ).toBe(600);
  });
});

describe('isPendingSellExpired', () => {
  it('expires after retryUntilTs', () => {
    expect(
      isPendingSellExpired(
        {
          id: 'ps_1',
          mint: 'm',
          symbol: 'S',
          leaderSignature: 'sig',
          leaderSellTs: 0,
          dueTs: 1000,
          fraction: 0.5,
          retryUntilTs: 5000,
        },
        5001,
      ),
    ).toBe(true);
  });
});
