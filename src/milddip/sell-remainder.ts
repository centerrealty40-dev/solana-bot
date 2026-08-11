/**
 * Resolve the SPL remainder after a confirmed sell.
 *
 * Live incident (1.11.828, 8h window): every successful sell leg was settled
 * against an RPC balance read taken ~0ms after the send, and that read still
 * returned the *pre-sell* balance. `6tfuqq` sold 40% of 217_727_192_747 and the
 * post-sell read answered 215_941_362_360; the full close of the 60% remainder
 * answered 129_564_817_416 — in both cases the amount we had just sold.
 *
 * `settleAfterSuccessfulSell` therefore saw `remainder_above_dust`, kept the
 * runner, and the exit engine kept firing on a bag the wallet no longer held:
 * 230 `Custom:6024` (InsufficientFunds) + 230 `no_token_balance` legs across 53
 * mints, up to 74 sell attempts on a single mint, with the ghost position
 * holding an open-book slot until a later exit finally reported empty.
 *
 * The executor already knows the authoritative numbers — the balance it sized
 * against and the amount it sent — so the arithmetic remainder is trustworthy
 * and an RPC read above it can only mean the node has not observed our sell.
 */

/** Relative slack on the expected remainder (rounding, concurrent dust legs). */
const STALE_TOLERANCE_DIVISOR = 100n;

export type RemainderVerdict = {
  /** Best remainder estimate to settle against. */
  remainingRaw: bigint | null;
  /** RPC answered above the arithmetic remainder — it has not seen our sell. */
  stale: boolean;
  reason: 'observed' | 'stale_read' | 'expected_only' | 'unknown';
};

/**
 * Combine the executor's arithmetic remainder with a fresh RPC read.
 *
 * `beforeRaw`/`soldRaw` come from the sell executor (the balance it sized
 * against and the amount it sent). `observedRaw` is a post-sell RPC read.
 */
export function resolveSellRemainder(args: {
  beforeRaw: bigint | null;
  soldRaw: bigint | null;
  observedRaw: bigint | null;
}): RemainderVerdict {
  const { beforeRaw, soldRaw, observedRaw } = args;

  const expected =
    beforeRaw != null && soldRaw != null && beforeRaw >= 0n && soldRaw >= 0n
      ? beforeRaw > soldRaw
        ? beforeRaw - soldRaw
        : 0n
      : null;

  if (expected == null) {
    return observedRaw == null
      ? { remainingRaw: null, stale: false, reason: 'unknown' }
      : { remainingRaw: observedRaw, stale: false, reason: 'observed' };
  }
  if (observedRaw == null) {
    return { remainingRaw: expected, stale: false, reason: 'expected_only' };
  }

  const slack = beforeRaw != null ? beforeRaw / STALE_TOLERANCE_DIVISOR : 0n;
  if (observedRaw > expected + slack) {
    // Node still on the pre-sell state. Never settle a bag we no longer hold.
    return { remainingRaw: expected, stale: true, reason: 'stale_read' };
  }
  // At or below expectation: the read saw our sell (possibly plus other legs).
  return { remainingRaw: observedRaw, stale: false, reason: 'observed' };
}
