import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStreamHealthWatchdogForTests,
  evaluateStreamResolveHealth,
  maybeAlertStreamResolveBlind,
} from '../../src/milddip/stream-health.js';

describe('stream-health watchdog', () => {
  beforeEach(() => {
    __resetStreamHealthWatchdogForTests();
  });

  it('flags blind when overflow delta explodes', () => {
    const v = evaluateStreamResolveHealth(
      {
        resolved: 100,
        failed: 0,
        droppedOverflow: 1_000,
        droppedStale: 0,
        queued: 48,
        volumeMarks: 10,
      },
      {
        resolved: 150,
        failed: 0,
        droppedOverflow: 5_000,
        droppedStale: 0,
        queued: 48,
        volumeMarks: 12,
      },
      { overflowDeltaWarn: 2_000, overflowRatioWarn: 0.85, minEvents: 200 },
    );
    expect(v.blind).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('resolve_overflow_delta'))).toBe(true);
  });

  it('flags high drop ratio', () => {
    const v = evaluateStreamResolveHealth(
      {
        resolved: 0,
        failed: 0,
        droppedOverflow: 0,
        droppedStale: 0,
        queued: 0,
        volumeMarks: 0,
      },
      {
        resolved: 50,
        failed: 0,
        droppedOverflow: 950,
        droppedStale: 0,
        queued: 48,
        volumeMarks: 0,
      },
      { overflowDeltaWarn: 50_000, overflowRatioWarn: 0.85, minEvents: 200 },
    );
    expect(v.blind).toBe(true);
    expect(v.reasons.some((r) => r.includes('resolve_drop_ratio'))).toBe(true);
  });

  it('alerts once then respects cooldown', async () => {
    let called = 0;
    const send = (async () => {
      called += 1;
      return true;
    }) as unknown as typeof import('../../src/core/telegram/sender.js').sendTagged;

    const zero = {
      resolved: 0,
      failed: 0,
      droppedOverflow: 0,
      droppedStale: 0,
      queued: 0,
      volumeMarks: 0,
    };
    await maybeAlertStreamResolveBlind({
      snap: zero,
      nowMs: 1_000,
      cooldownMs: 60_000,
      overflowDeltaWarn: 1_000,
      enabled: true,
      send,
    });
    const a = await maybeAlertStreamResolveBlind({
      snap: { ...zero, resolved: 10, droppedOverflow: 3_000, queued: 48 },
      nowMs: 2_000,
      cooldownMs: 60_000,
      overflowDeltaWarn: 1_000,
      enabled: true,
      send,
    });
    expect(a.blind).toBe(true);
    expect(called).toBe(1);
    expect(a.alerted).toBe(true);

    const b = await maybeAlertStreamResolveBlind({
      snap: { ...zero, resolved: 20, droppedOverflow: 6_000, queued: 48 },
      nowMs: 3_000,
      cooldownMs: 60_000,
      overflowDeltaWarn: 1_000,
      enabled: true,
      send,
    });
    expect(b.blind).toBe(true);
    expect(b.alerted).toBe(false);
    expect(called).toBe(1);
  });
});
