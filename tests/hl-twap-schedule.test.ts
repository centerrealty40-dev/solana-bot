import { describe, expect, it } from 'vitest';

import {
  computeTwapSchedule,
  formatTwapScheduleLines,
  HL_TWAP_SLICE_INTERVAL_SEC,
} from '../src/hyperliquid/twap/twap-schedule.js';

describe('hl-twap schedule', () => {
  it('uses 30s slices: 90 min → 180 cycles', () => {
    const startedAtMs = Date.UTC(2026, 5, 4, 11, 25, 40);
    const s = computeTwapSchedule({
      size: 9000,
      minutes: 90,
      randomize: false,
      midPx: 65,
      startedAtMs,
    });
    expect(s.cycleCount).toBe(180);
    expect(s.sizePerCycle).toBeCloseTo(50, 5);
    expect(s.notionalPerCycleUsd).toBeCloseTo(50 * 65, 0);
    expect(s.firstCycleOpenMs).toBe(startedAtMs + 30_000);
    expect(s.paperOpenAtMs).toBe(s.firstCycleOpenMs);
    expect(s.lastCycleEtaMs).toBe(startedAtMs + 90 * 60_000);
    expect(s.paperCloseAtMs).toBe(startedAtMs + 90 * 60_000 - 30_000);
    expect(s.sliceIntervalSec).toBe(HL_TWAP_SLICE_INTERVAL_SEC);
  });

  it('formats schedule lines in Russian', () => {
    const sig = {
      displaySymbol: 'HYPE',
      size: 7600,
      minutes: 5,
      randomize: true,
      midPx: 65.71,
      startedAtMs: Date.UTC(2026, 5, 4, 11, 25, 40),
    };
    const schedule = computeTwapSchedule(sig);
    const lines = formatTwapScheduleLines(sig, schedule, (v) => `$${v.toFixed(0)}`);
    expect(lines[0]).toMatch(/Первый цикл \(МСК\):/);
    expect(lines[1]).toMatch(/ETA последнего цикла \(МСК\):/);
    expect(lines[2]).toMatch(/Бумага: вход/);
    expect(lines[3]).toContain('Циклов: 10');
    expect(lines[3]).toContain('рандом');
    expect(lines[4]).toContain('HYPE');
  });
});
