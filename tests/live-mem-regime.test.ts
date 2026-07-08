import { describe, it, expect, beforeEach, vi } from 'vitest';

// Avoid opening a real Postgres connection / writing JSONL on import.
vi.mock('../src/core/db/client.js', () => ({
  sql: Object.assign(vi.fn(), { unsafe: vi.fn() }),
  db: { execute: vi.fn() },
}));
vi.mock('../src/live/store-jsonl.js', () => ({
  appendLiveJsonlEvent: vi.fn(),
}));

import type { LiveOscarConfig } from '../src/live/config.js';
import {
  applyHysteresis,
  classifyRegime,
  computeRegimeMetrics,
  initHysteresis,
  resetMemRegimeStateForTest,
  resolveMemRegimeGateStatus,
  type MemRegimeParams,
  type MemRegimeRunnerRow,
} from '../src/live/mem-regime.js';

const PARAMS: MemRegimeParams = {
  minRunnerV1hUsd: 10_000,
  minRunners: 5,
  breadthRedPct: 58,
  ewDropPct: 1,
  medDropPct: 0.8,
  requiredSignals: 2,
};

function row(mint: string, priceNow: number, priceBase: number, v1h: number): MemRegimeRunnerRow {
  return { mint, priceNow, priceBase, v1hMax: v1h, liq: 5000 };
}

describe('computeRegimeMetrics', () => {
  it('filters out sub-threshold-volume mints and computes breadth/ew/median', () => {
    const rows: MemRegimeRunnerRow[] = [
      row('a', 90, 100, 50_000), // -10%
      row('b', 95, 100, 50_000), // -5%
      row('c', 102, 100, 50_000), // +2%
      row('d', 80, 100, 50_000), // -20%
      row('e', 50, 100, 500), // ignored (v1h < min)
    ];
    const m = computeRegimeMetrics(rows, PARAMS, 1000);
    expect(m.runnerCount).toBe(4);
    expect(m.breadthRedPct).toBe(75); // 3 of 4 red
    expect(m.ewReturnPct).toBeCloseTo(-8.25, 5); // mean(-10,-5,+2,-20)
    expect(m.medReturnPct).toBeCloseTo(-7.5, 5); // median(-10,-5) -> (-10 + -5)/2
    expect(m.ts).toBe(1000);
  });

  it('clamps absurd returns and drops non-positive prices', () => {
    const rows: MemRegimeRunnerRow[] = [
      row('a', 1000, 100, 50_000), // +900% -> clamped out
      row('b', 0, 100, 50_000), // dropped (priceNow<=0)
      row('c', 99, 100, 50_000), // -1%
    ];
    const m = computeRegimeMetrics(rows, PARAMS, 1);
    expect(m.runnerCount).toBe(1);
    expect(m.ewReturnPct).toBeCloseTo(-1, 5);
  });
});

describe('classifyRegime', () => {
  it('is invalid with too few runners', () => {
    const rows = [row('a', 90, 100, 50_000), row('b', 91, 100, 50_000)];
    const m = computeRegimeMetrics(rows, PARAMS, 1);
    const c = classifyRegime(m, PARAMS);
    expect(c.valid).toBe(false);
    expect(c.riskOff).toBe(false);
  });

  it('flags risk-off when >= requiredSignals fire (broad drain)', () => {
    // 6 runners, 5 red, ew ~ -10%, median negative -> breadth+ew+med all fire
    const rows = [
      row('a', 90, 100, 50_000),
      row('b', 88, 100, 50_000),
      row('c', 92, 100, 50_000),
      row('d', 85, 100, 50_000),
      row('e', 95, 100, 50_000),
      row('f', 101, 100, 50_000),
    ];
    const m = computeRegimeMetrics(rows, PARAMS, 1);
    const c = classifyRegime(m, PARAMS);
    expect(c.valid).toBe(true);
    expect(c.riskOff).toBe(true);
    expect(c.signals).toEqual(expect.arrayContaining(['breadth', 'ew_drop', 'med_drop']));
  });

  it('stays risk-on when only one signal fires', () => {
    // Mildly red breadth but tiny magnitude: breadth may fire, ew/med do not.
    const rows = [
      row('a', 99.9, 100, 50_000),
      row('b', 99.9, 100, 50_000),
      row('c', 99.9, 100, 50_000),
      row('d', 99.9, 100, 50_000),
      row('e', 100.2, 100, 50_000),
      row('f', 100.2, 100, 50_000),
    ];
    const m = computeRegimeMetrics(rows, PARAMS, 1);
    const c = classifyRegime(m, PARAMS);
    expect(c.riskOff).toBe(false);
  });
});

describe('applyHysteresis', () => {
  it('requires N consecutive risk-off windows before flipping', () => {
    let st = initHysteresis();
    expect(st.confirmed).toBe('risk-on');
    st = applyHysteresis(st, { valid: true, riskOff: true, signals: ['breadth', 'ew_drop'] }, 2);
    expect(st.confirmed).toBe('risk-on'); // 1st window: not yet
    st = applyHysteresis(st, { valid: true, riskOff: true, signals: ['breadth', 'ew_drop'] }, 2);
    expect(st.confirmed).toBe('risk-off'); // 2nd consecutive: flip
  });

  it('recovers back to risk-on after N consecutive risk-on windows', () => {
    let st: ReturnType<typeof initHysteresis> = { confirmed: 'risk-off', offStreak: 3, onStreak: 0 };
    st = applyHysteresis(st, { valid: true, riskOff: false, signals: [] }, 2);
    expect(st.confirmed).toBe('risk-off');
    st = applyHysteresis(st, { valid: true, riskOff: false, signals: [] }, 2);
    expect(st.confirmed).toBe('risk-on');
  });

  it('does not flip on insufficient-data windows (resets streaks, keeps confirmed)', () => {
    let st: ReturnType<typeof initHysteresis> = { confirmed: 'risk-off', offStreak: 5, onStreak: 0 };
    st = applyHysteresis(st, { valid: false, riskOff: false, signals: [] }, 2);
    expect(st.confirmed).toBe('risk-off');
    expect(st.offStreak).toBe(0);
    expect(st.onStreak).toBe(0);
  });
});

describe('resolveMemRegimeGateStatus', () => {
  beforeEach(() => resetMemRegimeStateForTest());

  it('is disabled when the feature flag is off', () => {
    const cfg = { liveMemRegimeEnabled: false, liveMemRegimeMode: 'gate' } as unknown as LiveOscarConfig;
    expect(resolveMemRegimeGateStatus(cfg).kind).toBe('disabled');
  });

  it('is disabled when mode is off even if enabled', () => {
    const cfg = { liveMemRegimeEnabled: true, liveMemRegimeMode: 'off' } as unknown as LiveOscarConfig;
    expect(resolveMemRegimeGateStatus(cfg).kind).toBe('disabled');
  });

  it('returns unknown (fail-open) before the first refresh has computed state', () => {
    const cfg = {
      liveMemRegimeEnabled: true,
      liveMemRegimeMode: 'shadow',
      liveMemRegimeRefreshSec: 60,
      liveMemRegimeMaxStaleSec: 300,
    } as unknown as LiveOscarConfig;
    expect(resolveMemRegimeGateStatus(cfg).kind).toBe('unknown');
  });
});
