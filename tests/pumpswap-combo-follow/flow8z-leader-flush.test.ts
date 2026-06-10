import { describe, expect, it } from 'vitest';
import {
  evaluateLeaderPoolFlush,
  isLeaderFlatAfterSell,
  leaderFlushExitReason,
} from '../../src/pumpswap-combo-follow/flow8z-leader-flush.js';
import type { LeaderSellRef } from '../../src/pumpswap-combo-follow/types.js';

const openedAt = 1_000_000;

function sellRef(overrides: Partial<LeaderSellRef> = {}): LeaderSellRef {
  return {
    ts: openedAt + 10_000,
    signature: 'sig',
    priceUsd: 1,
    sellUsd: 200,
    leaderPostBalanceRaw: '1000',
    leaderFlat: false,
    ...overrides,
  };
}

describe('evaluateLeaderPoolFlush', () => {
  it('skips flush on small leader scalp sell when minSellUsd set', () => {
    const v = evaluateLeaderPoolFlush({
      nowMs: openedAt + 80_000,
      enabled: true,
      sellRef: sellRef({ sellUsd: 205 }),
      openedAt,
      minSellUsd: 500,
      largeSellDelayMs: 60_000,
      flatFlushDelayMs: 0,
    });
    expect(v.shouldFlush).toBe(false);
    expect(v.reason).toBe('small_sell_skipped');
  });

  it('flushes after delay on large leader sell', () => {
    const ref = sellRef({ sellUsd: 600 });
    const early = evaluateLeaderPoolFlush({
      nowMs: ref.ts + 30_000,
      enabled: true,
      sellRef: ref,
      openedAt,
      minSellUsd: 500,
      largeSellDelayMs: 60_000,
      flatFlushDelayMs: 0,
    });
    expect(early.shouldFlush).toBe(false);
    expect(early.reason).toBe('not_due');

    const late = evaluateLeaderPoolFlush({
      nowMs: ref.ts + 60_000,
      enabled: true,
      sellRef: ref,
      openedAt,
      minSellUsd: 500,
      largeSellDelayMs: 60_000,
      flatFlushDelayMs: 0,
    });
    expect(late.shouldFlush).toBe(true);
    expect(late.reason).toBe('large_sell');
  });

  it('flushes immediately when leader is flat (full exit)', () => {
    const ref = sellRef({
      sellUsd: 50,
      leaderFlat: true,
      leaderPostBalanceRaw: '0',
    });
    const v = evaluateLeaderPoolFlush({
      nowMs: ref.ts + 1,
      enabled: true,
      sellRef: ref,
      openedAt,
      minSellUsd: 500,
      largeSellDelayMs: 60_000,
      flatFlushDelayMs: 0,
    });
    expect(v.shouldFlush).toBe(true);
    expect(v.reason).toBe('leader_flat');
    expect(leaderFlushExitReason(v.reason)).toBe('flow8z_leader_flat_flush');
  });

  it('legacy minSellUsd=0 flushes any sell after delay', () => {
    const ref = sellRef({ sellUsd: 80 });
    const v = evaluateLeaderPoolFlush({
      nowMs: ref.ts + 60_000,
      enabled: true,
      sellRef: ref,
      openedAt,
      minSellUsd: 0,
      largeSellDelayMs: 60_000,
      flatFlushDelayMs: 0,
    });
    expect(v.shouldFlush).toBe(true);
    expect(v.reason).toBe('large_sell');
  });

  it('ignores leader sell before position open', () => {
    const v = evaluateLeaderPoolFlush({
      nowMs: openedAt + 100_000,
      enabled: true,
      sellRef: sellRef({ ts: openedAt - 1000 }),
      openedAt,
      minSellUsd: 500,
      largeSellDelayMs: 60_000,
      flatFlushDelayMs: 0,
    });
    expect(v.shouldFlush).toBe(false);
    expect(v.reason).toBe('no_sell');
  });
});

describe('isLeaderFlatAfterSell', () => {
  it('detects flat from leaderPostBalanceRaw', () => {
    expect(isLeaderFlatAfterSell(sellRef({ leaderPostBalanceRaw: '0', leaderFlat: false }))).toBe(
      true,
    );
  });
});
