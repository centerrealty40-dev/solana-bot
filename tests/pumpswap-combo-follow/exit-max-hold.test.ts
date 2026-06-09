import { describe, expect, it } from 'vitest';
import { followHoldSec, followMaxHoldDue } from '../../src/pumpswap-combo-follow/exit-max-hold.js';
import type { FollowPosition } from '../../src/pumpswap-combo-follow/types.js';

function pos(openedAt: number): FollowPosition {
  return {
    mint: 'm',
    symbol: 'sym',
    legs: [],
    remainingFrac: 1,
    openedAt,
    rungsTaken: [],
    botPeakUsd: 0,
    leaderWallet: 'hnu5',
  };
}

describe('exit-max-hold', () => {
  it('holdSec from openedAt', () => {
    const now = 1_000_000;
    expect(followHoldSec(pos(now - 90_000), now)).toBe(90);
  });

  it('max hold due after limit', () => {
    const now = 10_000_000;
    const maxMs = 3 * 3600 * 1000;
    expect(followMaxHoldDue(pos(now - maxMs - 1), maxMs, now)).toBe(true);
    expect(followMaxHoldDue(pos(now - maxMs + 1000), maxMs, now)).toBe(false);
  });

  it('max hold off when 0', () => {
    expect(followMaxHoldDue(pos(0), 0)).toBe(false);
  });
});
