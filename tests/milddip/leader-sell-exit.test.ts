import { describe, expect, it } from 'vitest';
import { decideLeaderSellExit } from '../../src/milddip/leader-sell-exit.js';

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

  it('supports an optional minimum hold', () => {
    expect(decideLeaderSellExit({ ...base, minHoldMs: 20_000 }).reason).toBe('min_hold');
  });

  it('exits on a fresh configured leader sale', () => {
    expect(decideLeaderSellExit(base)).toEqual({ shouldExit: true, reason: 'leader_sell' });
  });
});
