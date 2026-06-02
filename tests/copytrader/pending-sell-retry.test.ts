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

  it('does not retry missing balance', () => {
    expect(isSellRetryableError('no_token_balance')).toBe(false);
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
