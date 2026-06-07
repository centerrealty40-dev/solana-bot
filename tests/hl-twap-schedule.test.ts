import { describe, expect, it } from 'vitest';

import { computeTwapSchedule } from '../src/hyperliquid/twap/twap-schedule.js';

describe('twap-schedule', () => {
  it('opens at TWAP start and closes 10m before end', () => {
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
    expect(sched.firstCycleOpenMs).toBe(start + 30_000);
  });
});
