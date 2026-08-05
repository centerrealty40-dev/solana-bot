import { describe, expect, it } from 'vitest';
import { evaluateStreamWatchdog } from '../../src/copytrader/stream-watchdog.js';

const healthySnap = {
  connected: true,
  subscribed: true,
  mode: 'transactionSubscribe',
  lastOpenAtMs: 1_000,
  lastSubscribedAtMs: 1_100,
  lastNotifyAtMs: 5_000,
  lastSignatureAtMs: 5_000,
  notifyCount: 3,
  reconnectCount: 0,
};

describe('evaluateStreamWatchdog', () => {
  it('ok when stream healthy and no misses', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 10_000,
      enabled: true,
      health: healthySnap,
      pollMissesThisCycle: 0,
      missStreak: 0,
      missThreshold: 2,
    });
    expect(d).toMatchObject({
      healthy: true,
      reason: 'ok',
      forceReconnect: false,
      useFastPoll: false,
      nextMissStreak: 0,
      nextSilentStreak: 0,
    });
  });

  it('does not treat quiet market (0 notifies) as unhealthy', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 3_600_000,
      enabled: true,
      health: { ...healthySnap, notifyCount: 0, lastNotifyAtMs: 0 },
      pollMissesThisCycle: 0,
      missStreak: 0,
      missThreshold: 2,
    });
    expect(d.healthy).toBe(true);
    expect(d.reason).toBe('ok');
  });

  it('fast-polls when disconnected but does not reconnect before first open', () => {
    const boot = evaluateStreamWatchdog({
      nowMs: 10_000,
      enabled: true,
      health: {
        ...healthySnap,
        connected: false,
        subscribed: false,
        lastOpenAtMs: 0,
      },
      pollMissesThisCycle: 0,
      missStreak: 0,
      missThreshold: 2,
    });
    expect(boot).toMatchObject({
      healthy: false,
      reason: 'disconnected',
      forceReconnect: false,
      useFastPoll: true,
    });

    const dropped = evaluateStreamWatchdog({
      nowMs: 10_000,
      enabled: true,
      health: { ...healthySnap, connected: false, subscribed: false, lastOpenAtMs: 1_000 },
      pollMissesThisCycle: 0,
      missStreak: 0,
      missThreshold: 2,
    });
    expect(dropped).toMatchObject({
      healthy: false,
      reason: 'disconnected',
      forceReconnect: true,
      useFastPoll: true,
    });
  });

  it('not_subscribed after grace → reconnect', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 20_000,
      enabled: true,
      health: {
        ...healthySnap,
        connected: true,
        subscribed: false,
        lastOpenAtMs: 1_000,
      },
      pollMissesThisCycle: 0,
      missStreak: 0,
      missThreshold: 2,
      subscribeGraceMs: 15_000,
    });
    expect(d).toMatchObject({
      healthy: false,
      reason: 'not_subscribed',
      forceReconnect: true,
      useFastPoll: true,
    });
  });

  it('accumulates miss streak then fast-polls WITHOUT force reconnect', () => {
    const first = evaluateStreamWatchdog({
      nowMs: 10_000,
      enabled: true,
      health: healthySnap,
      pollMissesThisCycle: 1,
      missStreak: 0,
      missThreshold: 2,
    });
    expect(first).toMatchObject({
      healthy: true,
      reason: 'ok',
      nextMissStreak: 1,
      forceReconnect: false,
    });

    const second = evaluateStreamWatchdog({
      nowMs: 12_000,
      enabled: true,
      health: healthySnap,
      pollMissesThisCycle: 1,
      missStreak: first.nextMissStreak,
      missThreshold: 2,
    });
    expect(second).toMatchObject({
      healthy: false,
      reason: 'poll_miss_streak',
      forceReconnect: false,
      useFastPoll: true,
    });
    expect(second.nextMissStreak).toBeGreaterThanOrEqual(2);
  });

  it('does not treat early poll race as silent_stream (grace 60s)', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 20_000, // 19s after subscribe — under 60s default grace
      enabled: true,
      health: {
        ...healthySnap,
        notifyCount: 0,
        lastNotifyAtMs: 0,
        lastSubscribedAtMs: 1_100,
      },
      pollMissesThisCycle: 1,
      missStreak: 0,
      missThreshold: 5,
    });
    expect(d.reason).not.toBe('silent_stream');
    expect(d.preferLogsSubscribe).toBeFalsy();
  });

  it('silent stream reconnects but keeps transactionSubscribe on first hits', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 120_000,
      enabled: true,
      health: {
        ...healthySnap,
        notifyCount: 0,
        lastNotifyAtMs: 0,
        lastSubscribedAtMs: 1_100,
      },
      pollMissesThisCycle: 1,
      missStreak: 0,
      missThreshold: 5,
      silentStreak: 0,
      silentPreferLogsAfter: 3,
      silentStreamGraceMs: 60_000,
    });
    expect(d).toMatchObject({
      healthy: false,
      reason: 'silent_stream',
      forceReconnect: true,
      preferLogsSubscribe: false,
      useFastPoll: true,
      nextSilentStreak: 1,
    });
  });

  it('only briefly prefers logsSubscribe after repeated silent hits', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 120_000,
      enabled: true,
      health: {
        ...healthySnap,
        notifyCount: 0,
        lastNotifyAtMs: 0,
        lastSubscribedAtMs: 1_100,
      },
      pollMissesThisCycle: 1,
      missStreak: 0,
      missThreshold: 5,
      silentStreak: 2,
      silentPreferLogsAfter: 3,
      silentStreamGraceMs: 60_000,
    });
    expect(d).toMatchObject({
      reason: 'silent_stream',
      forceReconnect: true,
      preferLogsSubscribe: true,
      nextSilentStreak: 3,
    });
  });

  it('retries transactionSubscribe when stuck on logsSubscribe', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 200_000,
      enabled: true,
      health: {
        ...healthySnap,
        mode: 'logsSubscribe',
        lastSubscribedAtMs: 1_100,
        forcingLogsSubscribe: false,
        notifyCount: 10,
        lastNotifyAtMs: 50_000,
      },
      pollMissesThisCycle: 0,
      missStreak: 0,
      missThreshold: 5,
      logsSubscribeRetryMs: 120_000,
    });
    expect(d).toMatchObject({
      healthy: false,
      reason: 'retry_transaction_subscribe',
      forceReconnect: true,
      preferLogsSubscribe: false,
    });
  });

  it('clears miss streak when poll finds nothing stream missed', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 10_000,
      enabled: true,
      health: healthySnap,
      pollMissesThisCycle: 0,
      missStreak: 1,
      missThreshold: 2,
    });
    expect(d.nextMissStreak).toBe(0);
    expect(d.healthy).toBe(true);
  });

  it('stream_disabled is healthy (poll-only lane)', () => {
    const d = evaluateStreamWatchdog({
      nowMs: 10_000,
      enabled: false,
      health: null,
      pollMissesThisCycle: 5,
      missStreak: 9,
      missThreshold: 2,
    });
    expect(d).toMatchObject({
      healthy: true,
      reason: 'stream_disabled',
      useFastPoll: false,
      nextMissStreak: 0,
    });
  });
});
