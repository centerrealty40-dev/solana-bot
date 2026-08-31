import { describe, expect, it } from 'vitest';
import { leaderActiveAtMs, leaderActiveNow } from '../../src/milddip/leader-active.js';

describe('leader-active', () => {
  it('returns null and false when disabled', () => {
    expect(leaderActiveAtMs({ leaderSeenAtMs: 100, seedHitAtMs: 200 })).toBe(200);
    expect(
      leaderActiveNow({
        gates: { enabled: false, windowMs: 900_000 },
        nowMs: 500,
        leaderSeenAtMs: 200,
      }),
    ).toBe(false);
  });

  it('does not activate with a zero window', () => {
    expect(
      leaderActiveNow({
        gates: { enabled: true, windowMs: 0 },
        nowMs: 100,
        leaderSeenAtMs: 100,
      }),
    ).toBe(false);
  });

  it('keeps both re-entry bypasses disabled when the feature is off', () => {
    const leaderActive = leaderActiveNow({
      gates: { enabled: false, windowMs: 900_000 },
      nowMs: 1_100,
      leaderSeenAtMs: 1_000,
    });
    expect(leaderActive).toBe(false);
    expect(['rebuy_below_exit', 'cooldown_bounce'].map(() => leaderActive)).toEqual([
      false,
      false,
    ]);
  });

  it('ignores null, NaN, and non-positive timestamps', () => {
    expect(
      leaderActiveAtMs({
        leaderSeenAtMs: null,
        seedHitAtMs: Number.NaN,
      }),
    ).toBe(null);
    expect(leaderActiveAtMs({ leaderSeenAtMs: 0, seedHitAtMs: -1 })).toBe(null);
  });

  it('uses the freshest timestamp from memory and seed', () => {
    expect(leaderActiveAtMs({ leaderSeenAtMs: 200, seedHitAtMs: 300 })).toBe(300);
    expect(leaderActiveAtMs({ leaderSeenAtMs: 400, seedHitAtMs: 300 })).toBe(400);
  });

  it('accepts the exact window boundary and future timestamps', () => {
    expect(
      leaderActiveNow({
        gates: { enabled: true, windowMs: 900_000 },
        nowMs: 1_900_000,
        leaderSeenAtMs: 1_000_000,
      }),
    ).toBe(true);
    expect(
      leaderActiveNow({
        gates: { enabled: true, windowMs: 900_000 },
        nowMs: 900_000,
        leaderSeenAtMs: 1_000_000,
      }),
    ).toBe(true);
  });

  it('rejects a stale timestamp', () => {
    expect(
      leaderActiveNow({
        gates: { enabled: true, windowMs: 900_000 },
        nowMs: 1_900_001,
        leaderSeenAtMs: 1_000_000,
      }),
    ).toBe(false);
  });
});
