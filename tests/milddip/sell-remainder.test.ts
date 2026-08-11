import { describe, expect, it } from 'vitest';
import { resolveSellRemainder } from '../../src/milddip/sell-remainder.js';
import { settleAfterSuccessfulSell } from '../../src/milddip/sell-settle.js';

/**
 * Numbers are the live 6tfuqq legs (1.11.828 window) where the post-sell RPC
 * read answered the pre-sell balance and the fully-closed bag stayed tracked.
 */
describe('resolveSellRemainder', () => {
  it('rejects a post-sell read that still shows the pre-sell bag (40% leg)', () => {
    const v = resolveSellRemainder({
      beforeRaw: 217_727_192_747n,
      soldRaw: 87_090_877_098n,
      observedRaw: 215_941_362_360n,
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toBe('stale_read');
    expect(v.remainingRaw).toBe(130_636_315_649n);
  });

  it('rejects a stale read on a full close and settles flat', () => {
    const v = resolveSellRemainder({
      beforeRaw: 129_564_817_416n,
      soldRaw: 129_564_817_416n,
      observedRaw: 129_564_817_416n,
    });
    expect(v.stale).toBe(true);
    expect(v.remainingRaw).toBe(0n);
  });

  it('trusts a read at or below the arithmetic remainder', () => {
    const v = resolveSellRemainder({
      beforeRaw: 217_727_192_747n,
      soldRaw: 87_090_877_098n,
      observedRaw: 130_636_315_649n,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toBe('observed');
    expect(v.remainingRaw).toBe(130_636_315_649n);
  });

  it('absorbs rounding slack without calling the read stale', () => {
    const v = resolveSellRemainder({
      beforeRaw: 100_000_000_000n,
      soldRaw: 100_000_000_000n,
      observedRaw: 900_000_000n,
    });
    expect(v.stale).toBe(false);
    expect(v.remainingRaw).toBe(900_000_000n);
  });

  it('falls back to arithmetic when the read is missing', () => {
    const v = resolveSellRemainder({
      beforeRaw: 500n,
      soldRaw: 200n,
      observedRaw: null,
    });
    expect(v.reason).toBe('expected_only');
    expect(v.remainingRaw).toBe(300n);
  });

  it('stays unknown when the executor proved nothing and RPC is blank', () => {
    const v = resolveSellRemainder({ beforeRaw: null, soldRaw: null, observedRaw: null });
    expect(v.reason).toBe('unknown');
    expect(v.remainingRaw).toBeNull();
  });
});

describe('settleAfterSuccessfulSell relative dust', () => {
  it('flats a full close whose leftover is a rounding crumb of the bag', () => {
    const v = settleAfterSuccessfulSell({
      fraction: 1,
      remainingRaw: 1_000_000n,
      beforeRaw: 217_727_192_747n,
    });
    expect(v.action).toBe('flat');
    expect(v.reason).toBe('confirmed_empty');
  });

  it('still keeps a runner when a real slice of the bag is left', () => {
    const v = settleAfterSuccessfulSell({
      fraction: 1,
      remainingRaw: 40_000_000_000n,
      beforeRaw: 217_727_192_747n,
    });
    expect(v.action).toBe('keep_runner');
    expect(v.reason).toBe('remainder_above_dust');
  });

  it('keeps the absolute dust floor when no pre-sell balance is known', () => {
    expect(settleAfterSuccessfulSell({ fraction: 1, remainingRaw: 100n }).action).toBe(
      'flat',
    );
  });
});
