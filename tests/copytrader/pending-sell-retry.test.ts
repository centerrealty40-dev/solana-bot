import { describe, expect, it } from 'vitest';
import { isSellRetryableError } from '../../src/copytrader/pending-sell-retry.js';
import { isPendingSellExpired } from '../../src/copytrader/pending-sell-retry.js';

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

  it('does not retry missing balance', () => {
    expect(isSellRetryableError('no_token_balance')).toBe(false);
  });

  it('retries jupiter sell quote failures', () => {
    expect(isSellRetryableError('jupiter_sell_quote_failed')).toBe(true);
  });

  it('retries swap build failures', () => {
    expect(isSellRetryableError('swap_build:route_not_found')).toBe(true);
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
