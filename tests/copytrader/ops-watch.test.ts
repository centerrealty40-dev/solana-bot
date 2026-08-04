import { describe, expect, it } from 'vitest';
import { evaluateCopyOpsWatch } from '../../src/copytrader/ops-watch.js';

const th = {
  leaderIdleMs: 6 * 3_600_000,
  buyStallMs: 2 * 3_600_000,
  stuckSellMs: 30 * 60_000,
  streamDeadMs: 15 * 60_000,
};

describe('evaluateCopyOpsWatch', () => {
  it('alerts leader idle', () => {
    const now = 10 * 3_600_000;
    const alerts = evaluateCopyOpsWatch(
      {
        nowMs: now,
        appName: 'copy-trader-8zkg',
        lastLeaderActivityTs: now - 7 * 3_600_000,
        lastOurBuyTs: now,
        leaderBuysInWindow: 0,
        positions: [],
        pendingSells: [],
        stream: null,
      },
      th,
    );
    expect(alerts.some((a) => a.key === 'leader_idle')).toBe(true);
  });

  it('alerts buy stall when leader bought but we did not', () => {
    const now = 5 * 3_600_000;
    const alerts = evaluateCopyOpsWatch(
      {
        nowMs: now,
        appName: 'copy-trader-8zkg',
        lastLeaderActivityTs: now - 60_000,
        lastOurBuyTs: now - 3 * 3_600_000,
        leaderBuysInWindow: 4,
        positions: [],
        pendingSells: [],
        stream: null,
      },
      th,
    );
    expect(alerts.some((a) => a.key === 'buy_stall')).toBe(true);
  });

  it('alerts stuck pending sell (orphan risk)', () => {
    const now = 1_000_000;
    const alerts = evaluateCopyOpsWatch(
      {
        nowMs: now,
        appName: 'x',
        lastLeaderActivityTs: now,
        lastOurBuyTs: now,
        leaderBuysInWindow: 0,
        positions: [],
        pendingSells: [{ mint: 'Mint111', leaderSellTs: now - 40 * 60_000, attempts: 8, symbol: 'ABC' }],
        stream: null,
      },
      th,
    );
    expect(alerts.some((a) => a.key.startsWith('stuck_sell:'))).toBe(true);
  });

  it('alerts stream dead after long silence', () => {
    const now = 1_000_000;
    const alerts = evaluateCopyOpsWatch(
      {
        nowMs: now,
        appName: 'x',
        lastLeaderActivityTs: now,
        lastOurBuyTs: now,
        leaderBuysInWindow: 0,
        positions: [],
        pendingSells: [],
        stream: {
          subscribed: true,
          notifyCount: 0,
          lastSubscribedAtMs: now - 20 * 60_000,
          lastNotifyAtMs: 0,
        },
      },
      th,
    );
    expect(alerts.some((a) => a.key === 'stream_dead')).toBe(true);
  });

  it('stays quiet when healthy', () => {
    const now = 1_000_000;
    const alerts = evaluateCopyOpsWatch(
      {
        nowMs: now,
        appName: 'x',
        lastLeaderActivityTs: now - 60_000,
        lastOurBuyTs: now - 60_000,
        leaderBuysInWindow: 1,
        positions: [],
        pendingSells: [],
        stream: {
          subscribed: true,
          notifyCount: 5,
          lastSubscribedAtMs: now - 60_000,
          lastNotifyAtMs: now - 10_000,
        },
      },
      th,
    );
    expect(alerts).toEqual([]);
  });
});
