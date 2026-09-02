import { describe, expect, it } from 'vitest';
import { pendingExitVerdict, shouldArmPendingExit } from '../../src/milddip/pending-exit.js';

describe('shouldArmPendingExit', () => {
  const base = {
    enabled: true,
    isPartial: false,
    sellReason: 'no_token_balance',
    guardReason: 'post_buy_grace',
  };

  it('arms only for a full balance-race exit', () => {
    expect(shouldArmPendingExit(base)).toBe(true);
    expect(shouldArmPendingExit({ ...base, guardReason: 'balance_present' })).toBe(true);
    expect(shouldArmPendingExit({ ...base, isPartial: true })).toBe(false);
    expect(shouldArmPendingExit({ ...base, enabled: false })).toBe(false);
    expect(shouldArmPendingExit({ ...base, sellReason: 'insufficient_funds' })).toBe(false);
    expect(shouldArmPendingExit({ ...base, guardReason: 'confirmed_empty' })).toBe(false);
  });
});

describe('pendingExitVerdict', () => {
  const pending = { reason: 'green_trail', decidedAtMs: 1_000, attempts: 1 };

  it('does not retry without pending state', () => {
    expect(pendingExitVerdict({ pending: null, nowMs: 2_000, ttlMs: 180_000, maxAttempts: 20 }))
      .toEqual({ fire: false, clear: false, reason: null, expiredBy: null });
  });

  it('fires a fresh pending exit with its original reason', () => {
    expect(pendingExitVerdict({ pending, nowMs: 2_000, ttlMs: 180_000, maxAttempts: 20 }))
      .toEqual({ fire: true, clear: false, reason: 'green_trail', expiredBy: null });
  });

  it('expires by ttl before checking attempts', () => {
    expect(pendingExitVerdict({ pending, nowMs: 181_001, ttlMs: 180_000, maxAttempts: 1 }))
      .toEqual({ fire: false, clear: true, reason: 'green_trail', expiredBy: 'ttl' });
  });

  it('expires after reaching the attempt limit', () => {
    expect(
      pendingExitVerdict({
        pending: { ...pending, attempts: 20 },
        nowMs: 2_000,
        ttlMs: 180_000,
        maxAttempts: 20,
      }),
    ).toEqual({ fire: false, clear: true, reason: 'green_trail', expiredBy: 'attempts' });
  });

  it('does not expire by ttl when ttl is disabled', () => {
    expect(pendingExitVerdict({ pending, nowMs: 999_999, ttlMs: 0, maxAttempts: 20 }))
      .toEqual({ fire: true, clear: false, reason: 'green_trail', expiredBy: null });
  });
});
