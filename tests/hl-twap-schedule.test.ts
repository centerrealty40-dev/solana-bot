import { describe, expect, it, afterEach } from 'vitest';

import { computeTwapSchedule } from '../src/hyperliquid/twap/twap-schedule.js';

describe('twap-schedule', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('hold-to-end: closes at lastCycleEtaMs for all buckets', () => {
    process.env.HL_TWAP_HOLD_TO_END = '1';
    process.env.HL_TWAP_SHORT_ENABLED = '1';
    const start = 1_700_000_000_000;

    for (const minutes of [5, 15, 30, 60]) {
      const sched = computeTwapSchedule({
        size: 100,
        minutes,
        randomize: false,
        midPx: 1,
        startedAtMs: start,
      });
      expect(sched.paperOpenAtMs).toBe(start);
      expect(sched.paperCloseAtMs).toBe(start + minutes * 60_000);
      expect(sched.exitEarlyMinutes).toBe(0);
    }
  });

  it('legacy standard ≤30m: closes 10m before end', () => {
    process.env.HL_TWAP_HOLD_TO_END = '0';
    process.env.HL_TWAP_SHORT_ENABLED = '0';
    const start = 1_700_000_000_000;
    const sched = computeTwapSchedule({
      size: 100,
      minutes: 30,
      randomize: false,
      midPx: 1,
      startedAtMs: start,
    });
    expect(sched.paperOpenAtMs).toBe(start);
    expect(sched.paperCloseAtMs).toBe(start + 30 * 60_000 - 10 * 60_000);
    expect(sched.exitEarlyMinutes).toBe(10);
    expect(sched.shortTwapLane).toBe(false);
  });

  it('legacy standard >30m: exit last 25% (60m → −15m)', () => {
    process.env.HL_TWAP_HOLD_TO_END = '0';
    process.env.HL_TWAP_SHORT_ENABLED = '0';
    const start = 1_700_000_000_000;
    const sched = computeTwapSchedule({
      size: 100,
      minutes: 60,
      randomize: false,
      midPx: 1,
      startedAtMs: start,
    });
    expect(sched.exitEarlyMinutes).toBe(15);
    expect(sched.paperCloseAtMs).toBe(start + 45 * 60_000);
  });

  it('legacy short lane: close before last whale slice', () => {
    process.env.HL_TWAP_HOLD_TO_END = '0';
    process.env.HL_TWAP_SHORT_ENABLED = '1';
    const start = 1_700_000_000_000;
    const sched = computeTwapSchedule({
      size: 50,
      minutes: 10,
      randomize: false,
      midPx: 2,
      startedAtMs: start,
    });
    expect(sched.shortTwapLane).toBe(true);
    expect(sched.cycleCount).toBe(20);
    expect(sched.paperCloseAtMs).toBe(start + 19 * 30_000);
  });
});
