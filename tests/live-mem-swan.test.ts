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
  classifySwan,
  computeSwanMetric,
  consumeMemSwanRisingEdge,
  memSwanDropTriggered,
  memSwanLiquidationDue,
  resetMemSwanStateForTest,
  resolveMemSwanStatus,
  seedMemSwanActiveForTest,
  type MemSwanParams,
  type MemSwanRunnerRow,
} from '../src/live/mem-swan.js';

const PARAMS: MemSwanParams = {
  topN: 40,
  minRunnerV1hUsd: 10_000,
  minRunners: 5,
  ewDropPct: 14,
  breadthRedMinPct: 65,
  breadthEwDropPct: 8,
};

function row(mint: string, priceNow: number, priceBase: number, v1h: number): MemSwanRunnerRow {
  return { mint, priceNow, priceBase, v1hMax: v1h };
}

describe('computeSwanMetric', () => {
  it('equal-weights the top-N runners by peak 1h volume and drops thin runners', () => {
    const rows: MemSwanRunnerRow[] = [
      row('a', 80, 100, 500_000), // -20%
      row('b', 82, 100, 400_000), // -18%
      row('c', 84, 100, 300_000), // -16%
      row('d', 50, 100, 500), // ignored (v1h < min)
    ];
    const m = computeSwanMetric(rows, PARAMS, 1000);
    expect(m.runnerCount).toBe(3);
    expect(m.ewReturnPct).toBeCloseTo(-18, 5); // mean(-20,-18,-16)
    expect(m.breadthRedPct).toBe(100);
    expect(m.ts).toBe(1000);
  });

  it('respects topN (only the N highest-volume runners contribute)', () => {
    const rows: MemSwanRunnerRow[] = [
      row('a', 50, 100, 900_000), // -50%, highest vol
      row('b', 60, 100, 800_000), // -40%
      row('c', 120, 100, 10_000), // +20%, lowest vol (excluded by topN=2)
    ];
    const m = computeSwanMetric(rows, { ...PARAMS, topN: 2 }, 1);
    expect(m.runnerCount).toBe(2);
    expect(m.ewReturnPct).toBeCloseTo(-45, 5);
  });

  it('clamps absurd returns and drops non-positive prices', () => {
    const rows: MemSwanRunnerRow[] = [
      row('a', 3000, 100, 500_000), // +2900% -> clamped out
      row('b', 0, 100, 500_000), // dropped (priceNow<=0)
      row('c', 80, 100, 500_000), // -20%
    ];
    const m = computeSwanMetric(rows, PARAMS, 1);
    expect(m.runnerCount).toBe(1);
    expect(m.ewReturnPct).toBeCloseTo(-20, 5);
  });
});

describe('classifySwan', () => {
  it('is invalid (never triggers) with too few valid runners — anti-phantom', () => {
    const rows = [row('a', 50, 100, 500_000), row('b', 50, 100, 500_000)];
    const m = computeSwanMetric(rows, PARAMS, 1);
    const c = classifySwan(m, PARAMS);
    expect(c.valid).toBe(false);
    expect(c.triggered).toBe(false);
  });

  it('triggers on a deep equal-weight drop (>= ewDropPct) with enough runners', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`m${i}`, 80, 100, 500_000)); // -20% each
    const m = computeSwanMetric(rows, PARAMS, 1);
    const c = classifySwan(m, PARAMS);
    expect(c.valid).toBe(true);
    expect(c.triggered).toBe(true);
  });

  it('does not trigger on a shallow drop above the threshold', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`m${i}`, 95, 100, 500_000)); // -5% each
    const m = computeSwanMetric(rows, PARAMS, 1);
    const c = classifySwan(m, PARAMS);
    expect(c.valid).toBe(true);
    expect(c.triggered).toBe(false);
  });

  it('breadth path triggers when most runners red even if EW is mild (one outlier green)', () => {
    const rows: MemSwanRunnerRow[] = [
      ...Array.from({ length: 7 }, (_, i) => row(`red${i}`, 88, 100, 500_000)), // -12%
      row('green', 120, 100, 400_000), // +20% outlier
    ];
    const m = computeSwanMetric(rows, PARAMS, 1);
    expect(m.breadthRedPct).toBeCloseTo((7 / 8) * 100, 1);
    expect(m.ewReturnPct).toBeCloseTo(-8, 1);
    expect(memSwanDropTriggered(m, PARAMS)).toBe(true);
    const c = classifySwan(m, PARAMS);
    expect(c.triggered).toBe(true);
  });
});

describe('resolveMemSwanStatus / rising edge', () => {
  beforeEach(() => resetMemSwanStateForTest());

  it('is disabled when the feature flag is off', () => {
    const cfg = { liveMemSwanEnabled: false, liveMemSwanMode: 'liquidate' } as unknown as LiveOscarConfig;
    expect(resolveMemSwanStatus(cfg).kind).toBe('disabled');
  });

  it('is disabled when mode is off even if enabled', () => {
    const cfg = { liveMemSwanEnabled: true, liveMemSwanMode: 'off' } as unknown as LiveOscarConfig;
    expect(resolveMemSwanStatus(cfg).kind).toBe('disabled');
  });

  it('returns unknown (fail-safe) before the first refresh has computed state', () => {
    const cfg = {
      liveMemSwanEnabled: true,
      liveMemSwanMode: 'shadow',
      liveMemSwanRefreshSec: 60,
      liveMemSwanMaxStaleSec: 900,
    } as unknown as LiveOscarConfig;
    expect(resolveMemSwanStatus(cfg).kind).toBe('unknown');
  });

  it('has no rising edge to consume before any swan starts', () => {
    const cfg = {
      liveMemSwanEnabled: true,
      liveMemSwanMode: 'liquidate',
      liveMemSwanMaxStaleSec: 900,
    } as unknown as LiveOscarConfig;
    expect(consumeMemSwanRisingEdge(cfg)).toBeNull();
  });

  it('memSwanLiquidationDue is true while swan active and metrics are fresh', () => {
    const cfg = {
      liveMemSwanEnabled: true,
      liveMemSwanMode: 'liquidate',
      liveMemSwanMaxStaleSec: 900,
      liveMemSwanRefreshSec: 60,
    } as unknown as LiveOscarConfig;
    seedMemSwanActiveForTest();
    expect(memSwanLiquidationDue(cfg)).toBe(true);
  });

  it('memSwanLiquidationDue is false when swan inactive', () => {
    const cfg = {
      liveMemSwanEnabled: true,
      liveMemSwanMode: 'liquidate',
      liveMemSwanMaxStaleSec: 900,
    } as unknown as LiveOscarConfig;
    expect(memSwanLiquidationDue(cfg)).toBe(false);
  });
});
