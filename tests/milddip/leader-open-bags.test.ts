import { describe, expect, it } from 'vitest';
import {
  leaderOpenBagDropReason,
  leaderOpenBagRearmDecision,
  selectLeaderOpenBagRetryKeys,
  upsertLeaderOpenBag,
  type LeaderOpenBagEntry,
} from '../../src/milddip/leader-open-bags.js';

const entry = (overrides: Partial<LeaderOpenBagEntry> = {}): LeaderOpenBagEntry => ({
  mint: 'Mint111111111111111111111111111111111111',
  leader: 'Leader111111111111111111111111111111111',
  fillPriceUsd: 1,
  sizeUsd: 10,
  leaderBuyAtMs: 1_000,
  lastCheckAtMs: 0,
  lastReason: 'tracked',
  ...overrides,
});

describe('leader open bags', () => {
  it('upserts by mint and leader and evicts the oldest entry', () => {
    const store = {
      'old|leader': entry({ mint: 'old', leader: 'leader', leaderBuyAtMs: 1 }),
    };
    upsertLeaderOpenBag(store, entry({ mint: 'new', leader: 'leader', leaderBuyAtMs: 2 }), 2);
    upsertLeaderOpenBag(store, entry({ mint: 'new', leader: 'leader', sizeUsd: 20 }), 2);
    upsertLeaderOpenBag(store, entry({ mint: 'latest', leader: 'leader', leaderBuyAtMs: 3 }), 2);
    expect(Object.keys(store)).toEqual(['new|leader', 'latest|leader']);
    expect(store['new|leader'].sizeUsd).toBe(20);
  });

  it('selects due entries in deterministic order within budget', () => {
    const entries = {
      a: entry({ mint: 'a', lastCheckAtMs: 100, leaderBuyAtMs: 20 }),
      b: entry({ mint: 'b', lastCheckAtMs: 50, leaderBuyAtMs: 30 }),
      c: entry({ mint: 'c', lastCheckAtMs: 50, leaderBuyAtMs: 10 }),
      d: entry({ mint: 'd', lastCheckAtMs: 190 }),
    };
    expect(
      selectLeaderOpenBagRetryKeys({
        entries,
        nowMs: 200,
        intervalMs: 50,
        maxPerPass: 2,
      }),
    ).toEqual(['c', 'b']);
  });

  it.each([
    ['leader_flat', { leaderHolds: false }],
    ['expired', { maxAgeMs: 10 }],
    ['already_open', { weHoldPosition: true }],
    ['active_watch', { activeWatch: true }],
  ] as const)('returns %s drop reason', (reason, overrides) => {
    expect(
      leaderOpenBagDropReason({
        nowMs: 1_100,
        entry: entry({ leaderBuyAtMs: 1_000 }),
        maxAgeMs: 1_000,
        leaderHolds: true,
        weHoldPosition: false,
        activeWatch: false,
        ...overrides,
      }),
    ).toBe(reason);
  });

  it('keeps a healthy bag', () => {
    expect(
      leaderOpenBagDropReason({
        nowMs: 1_100,
        entry: entry({ leaderBuyAtMs: 1_000 }),
        maxAgeMs: 1_000,
        leaderHolds: true,
        weHoldPosition: false,
        activeWatch: false,
      }),
    ).toBeNull();
  });

  it('treats zero max age as unlimited', () => {
    expect(
      leaderOpenBagDropReason({
        nowMs: 10_000_000,
        entry: entry({ leaderBuyAtMs: 1_000 }),
        maxAgeMs: 0,
        leaderHolds: true,
        weHoldPosition: false,
        activeWatch: false,
      }),
    ).toBeNull();
  });

  it('prioritizes already-traded and cooldown rearm decisions', () => {
    const args = {
      nowMs: 2_000,
      entry: entry({ leaderBuyAtMs: 1_000 }),
      maxAgeMs: 0,
      cooldownUntilMs: 0,
      alreadyTraded: true,
      leaderHolds: true,
      weHoldPosition: false,
      activeWatch: false,
    };
    expect(leaderOpenBagRearmDecision(args)).toBe('already_traded');
    expect(
      leaderOpenBagRearmDecision({ ...args, alreadyTraded: false, cooldownUntilMs: 3_000 }),
    ).toBe('cooldown');
    expect(
      leaderOpenBagRearmDecision({ ...args, alreadyTraded: false, cooldownUntilMs: 0, weHoldPosition: true }),
    ).toBe('already_open');
  });
});
