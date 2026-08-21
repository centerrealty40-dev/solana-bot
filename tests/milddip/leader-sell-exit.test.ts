import { describe, expect, it } from 'vitest';
import {
  decideLeaderSellExit,
  mirrorLeaderSellRetryDue,
} from '../../src/milddip/leader-sell-exit.js';

const leader = '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ';
const event = {
  mint: 'Mint111',
  leader,
  signature: 'sig',
  blockTimeMs: 100_000,
  fillPriceUsd: 1,
  markPnlPct: 5,
};
const base = {
  enabled: true,
  lane: 'leader_mirror',
  leaders: [leader],
  event,
  openedAtMs: 100_000,
  nowMs: 110_000,
  maxAgeMs: 60_000,
};

describe('decideLeaderSellExit', () => {
  it('requires the feature and mirror lane', () => {
    expect(decideLeaderSellExit({ ...base, enabled: false }).shouldExit).toBe(false);
    expect(decideLeaderSellExit({ ...base, lane: 'dip' }).reason).toBe('wrong_lane');
  });

  it('rejects an unknown leader, stale sale, and sale before entry', () => {
    expect(decideLeaderSellExit({ ...base, leaders: ['other'] }).reason).toBe('leader_not_allowed');
    expect(decideLeaderSellExit({ ...base, nowMs: 200_001, maxAgeMs: 60_000 }).reason).toBe('stale');
    expect(decideLeaderSellExit({ ...base, openedAtMs: 100_001 }).reason).toBe('before_entry');
  });

  it('uses freshness when the mirror position has no saved leader-buy timestamp', () => {
    expect(decideLeaderSellExit({ ...base, openedAtMs: undefined })).toEqual({
      shouldExit: true,
      reason: 'leader_sell',
    });
  });

  it('accepts a sale after the copied leader buy but rejects one before it', () => {
    expect(
      decideLeaderSellExit({ ...base, openedAtMs: 90_000 }),
    ).toMatchObject({ shouldExit: true });
    expect(
      decideLeaderSellExit({
        ...base,
        event: { ...event, blockTimeMs: 80_000 },
        openedAtMs: 90_000,
      }),
    ).toEqual({ shouldExit: false, reason: 'before_entry' });
  });

  it('can block an observation before our own fill', () => {
    expect(
      decideLeaderSellExit({
        ...base,
        lane: 'leader_mirror',
        openedAtMs: 90_000,
        nowMs: 110_000,
      }),
    ).toMatchObject({ shouldExit: true });
  });

  it('supports an optional minimum hold', () => {
    expect(decideLeaderSellExit({ ...base, minHoldMs: 20_000 }).reason).toBe('min_hold');
  });

  it('exits on a fresh configured leader sale', () => {
    expect(decideLeaderSellExit(base)).toEqual({ shouldExit: true, reason: 'leader_sell' });
  });

  it('sends the first durable attempt immediately and spaces retries by five seconds', () => {
    expect(mirrorLeaderSellRetryDue(undefined, 1_000)).toBe(true);
    expect(mirrorLeaderSellRetryDue(1_000, 5_999)).toBe(false);
    expect(mirrorLeaderSellRetryDue(1_000, 6_000)).toBe(true);
  });
});
