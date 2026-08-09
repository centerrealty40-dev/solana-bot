import { describe, expect, it } from 'vitest';
import {
  HOLDING_DUST_RAW,
  POST_BUY_EMPTY_DROP_GRACE_MS,
  verdictDropEmptyOnNoBalance,
} from '../../src/milddip/sell-empty-guard.js';

describe('verdictDropEmptyOnNoBalance', () => {
  const openedAtMs = 1_000_000;

  it('keeps tracking when on-chain balance is present (RPC race)', () => {
    const v = verdictDropEmptyOnNoBalance({
      onchainRaw: 466_754_138_374n,
      openedAtMs,
      nowMs: openedAtMs + 8_000,
    });
    expect(v).toEqual({ drop: false, reason: 'balance_present' });
  });

  it('keeps tracking during post-buy grace even if RPC shows empty', () => {
    const v = verdictDropEmptyOnNoBalance({
      onchainRaw: 0n,
      openedAtMs,
      nowMs: openedAtMs + 8_000,
    });
    expect(v.drop).toBe(false);
    expect(v.reason).toBe('post_buy_grace');
    expect(POST_BUY_EMPTY_DROP_GRACE_MS).toBeGreaterThan(8_000);
  });

  it('drops only after grace when still empty', () => {
    const v = verdictDropEmptyOnNoBalance({
      onchainRaw: 0n,
      openedAtMs,
      nowMs: openedAtMs + POST_BUY_EMPTY_DROP_GRACE_MS + 1,
    });
    expect(v).toEqual({ drop: true, reason: 'confirmed_empty' });
  });

  it('treats dust as empty for drop purposes after grace', () => {
    const v = verdictDropEmptyOnNoBalance({
      onchainRaw: HOLDING_DUST_RAW,
      openedAtMs,
      nowMs: openedAtMs + POST_BUY_EMPTY_DROP_GRACE_MS + 1,
    });
    expect(v.drop).toBe(true);
  });
});
