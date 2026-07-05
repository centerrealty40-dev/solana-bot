import { describe, expect, it } from 'vitest';
import {
  liveTailFlushSkipNote,
  shouldLiveTailFlushWalletRemainder,
} from '../src/live/tail-flush.js';

describe('shouldLiveTailFlushWalletRemainder', () => {
  it('post_close flushes any positive remainder', () => {
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 0.01, thresholdUsd: 100, context: 'post_close' }),
    ).toBe(true);
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 500, thresholdUsd: 100, context: 'post_close' }),
    ).toBe(true);
  });

  it('partial_exit flushes manlet-class remainder below threshold (journal may be 0)', () => {
    // Wave B trail flush sold partial via usd_capped_by_chain; ~$53 chain tail must flush.
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 53, thresholdUsd: 100, context: 'partial_exit' }),
    ).toBe(true);
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 99.99, thresholdUsd: 100, context: 'partial_exit' }),
    ).toBe(true);
  });

  it('partial_exit flushes only below threshold', () => {
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 99.99, thresholdUsd: 100, context: 'partial_exit' }),
    ).toBe(true);
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 100, thresholdUsd: 100, context: 'partial_exit' }),
    ).toBe(false);
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 250, thresholdUsd: 100, context: 'partial_exit' }),
    ).toBe(false);
  });

  it('periodic_heal uses same threshold rule as partial_exit', () => {
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 50, thresholdUsd: 100, context: 'periodic_heal' }),
    ).toBe(true);
    expect(
      shouldLiveTailFlushWalletRemainder({ estUsd: 150, thresholdUsd: 100, context: 'periodic_heal' }),
    ).toBe(false);
  });
});

describe('liveTailFlushSkipNote', () => {
  it('returns null when flush should proceed', () => {
    expect(
      liveTailFlushSkipNote({ estUsd: 40, thresholdUsd: 100, context: 'partial_exit' }),
    ).toBeNull();
    expect(
      liveTailFlushSkipNote({ estUsd: 200, thresholdUsd: 100, context: 'post_close' }),
    ).toBeNull();
  });

  it('returns above_threshold for large partial remainders', () => {
    expect(
      liveTailFlushSkipNote({ estUsd: 200, thresholdUsd: 100, context: 'partial_exit' }),
    ).toBe('above_threshold');
  });
});
