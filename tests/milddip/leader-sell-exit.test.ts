import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decideLeaderSellExit,
  isLeaderSellEventValidForPosition,
  mirrorLeaderSellRetryDue,
  selectNewerLeaderSellEvent,
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
const loopSource = readFileSync(new URL('../../src/milddip/loop.ts', import.meta.url), 'utf8');

describe('decideLeaderSellExit', () => {
  it('validates a sell against the bound leader session and position entry', () => {
    expect(
      isLeaderSellEventValidForPosition({
        event,
        leader,
        leaderBuyTsMs: 100_000,
        openedAtMs: 100_000,
      }),
    ).toBe(true);
    expect(
      isLeaderSellEventValidForPosition({
        event: { ...event, leader: 'other' },
        leader,
        leaderBuyTsMs: 100_000,
        openedAtMs: 100_000,
      }),
    ).toBe(false);
    expect(
      isLeaderSellEventValidForPosition({
        event: { ...event, blockTimeMs: 99_999 },
        leader,
        leaderBuyTsMs: 100_000,
        openedAtMs: 100_000,
      }),
    ).toBe(false);
    expect(
      isLeaderSellEventValidForPosition({
        event: { ...event, blockTimeMs: 100_000 },
        leader,
        leaderBuyTsMs: 90_000,
        openedAtMs: 100_001,
      }),
    ).toBe(false);
  });

  it('prefers a newer live sell over an older durable intent', () => {
    expect(selectNewerLeaderSellEvent(event, { ...event, blockTimeMs: 100_001 })).toEqual({
      ...event,
      blockTimeMs: 100_001,
    });
    expect(selectNewerLeaderSellEvent(event, null)).toEqual(event);
  });

  it('drops stale intents before evaluating the same-tick feed sell', () => {
    const staleIntent = { ...event, blockTimeMs: 90_000 };
    const freshFeed = { ...event, blockTimeMs: 110_000 };
    expect(
      isLeaderSellEventValidForPosition({
        event: staleIntent,
        leader,
        leaderBuyTsMs: 100_000,
        openedAtMs: 100_000,
      }),
    ).toBe(false);
    expect(
      isLeaderSellEventValidForPosition({
        event: freshFeed,
        leader,
        leaderBuyTsMs: 100_000,
        openedAtMs: 100_000,
      }),
    ).toBe(true);
    expect(loopSource).toContain("kind: 'mirror_leader_sell_intent_dropped'");
    expect(loopSource).toContain('delete pos.mirrorLeaderSellIntent');
    expect(loopSource).toContain('const leaderSellEvent = selectNewerLeaderSellEvent');
    expect(loopSource).toContain("reason: 'mirror_leader_sell'");
  });

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
