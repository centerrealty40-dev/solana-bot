import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { computeTwapSchedule } from '../src/hyperliquid/twap/twap-schedule.js';

describe('twap-schedule', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('standard ≤30m: closes 10m before end', () => {
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

  it('standard >30m: exit last 25% (60m → −15m)', () => {
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

  it('short lane: close before last whale slice', () => {
    process.env.HL_TWAP_SHORT_ENABLED = '1';
    const start = 1_700_000_000_000;
    const sched = computeTwapSchedule({
      size: 50,
      minutes: 5,
      randomize: false,
      midPx: 2,
      startedAtMs: start,
    });
    expect(sched.shortTwapLane).toBe(true);
    expect(sched.cycleCount).toBe(10);
    // 9th slice boundary = start + 9×30s
    expect(sched.paperCloseAtMs).toBe(start + 9 * 30_000);
  });
});
