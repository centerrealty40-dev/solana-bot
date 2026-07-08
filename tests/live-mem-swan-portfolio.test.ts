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
  classifyPortfolioSwan,
  computePortfolioMetric,
  consumeMemSwanPortRisingEdge,
  ingestMemSwanPortfolioTick,
  recordMemSwanPortfolioMark,
  resetMemSwanPortStateForTest,
  memSwanPortSnapshot,
  type PortfolioParams,
} from '../src/live/mem-swan-portfolio.js';

const PARAMS: PortfolioParams = {
  rollMin: 360,
  baselineTolMin: 30,
  ewDropPct: 25,
  minPositions: 8,
};

describe('computePortfolioMetric', () => {
  it('equal-weights valid now/base pairs and reports breadth', () => {
    const m = computePortfolioMetric([
      { pnow: 70, pbase: 100 }, // -30%
      { pnow: 80, pbase: 100 }, // -20%
      { pnow: 110, pbase: 100 }, // +10%
      { pnow: 0, pbase: 100 }, // dropped (no now price)
      { pnow: 50, pbase: 0 }, // dropped (no base)
    ]);
    expect(m.positionCount).toBe(3);
    expect(m.ewReturnPct).toBeCloseTo((-30 - 20 + 10) / 3, 3);
    expect(m.breadthRedPct).toBeCloseTo((2 / 3) * 100, 3);
  });

  it('returns nulls when nothing valid', () => {
    const m = computePortfolioMetric([{ pnow: 0, pbase: 0 }]);
    expect(m.positionCount).toBe(0);
    expect(m.ewReturnPct).toBeNull();
  });
});

describe('classifyPortfolioSwan', () => {
  it('is invalid (never triggers) below minPositions', () => {
    const m = computePortfolioMetric(Array.from({ length: 4 }, () => ({ pnow: 50, pbase: 100 })));
    const c = classifyPortfolioSwan(m, PARAMS);
    expect(c.valid).toBe(false);
    expect(c.triggered).toBe(false);
  });

  it('triggers on a deep equal-weight drop with enough positions', () => {
    const m = computePortfolioMetric(Array.from({ length: 10 }, () => ({ pnow: 70, pbase: 100 }))); // -30%
    const c = classifyPortfolioSwan(m, PARAMS);
    expect(c.valid).toBe(true);
    expect(c.triggered).toBe(true);
  });

  it('does not trigger on a shallow drop', () => {
    const m = computePortfolioMetric(Array.from({ length: 10 }, () => ({ pnow: 90, pbase: 100 }))); // -10%
    const c = classifyPortfolioSwan(m, PARAMS);
    expect(c.valid).toBe(true);
    expect(c.triggered).toBe(false);
  });
});

function cfg(over: Partial<LiveOscarConfig> = {}): LiveOscarConfig {
  return {
    executionMode: 'live',
    liveMemSwanPortEnabled: true,
    liveMemSwanPortMode: 'liquidate',
    liveMemSwanPortRollMin: 360,
    liveMemSwanPortBaselineTolMin: 30,
    liveMemSwanPortEwDropPct: 25,
    liveMemSwanPortMinPositions: 3,
    liveMemSwanPortMaxStaleSec: 180,
    liveMemSwanPortResumeMin: 120,
    liveMemSwanPortJournalEverySec: 600,
    ...over,
  } as unknown as LiveOscarConfig;
}

describe('ingest + rising edge', () => {
  beforeEach(() => resetMemSwanPortStateForTest());

  it('does not trigger during warmup (no base sample yet), then triggers once base + deep drop exist', () => {
    const c = cfg();
    const now = 1_000_000_000_000;
    vi.useFakeTimers();
    try {
      // t0: record baseline marks and ingest. No base older than rollMin yet → invalid/no trigger.
      vi.setSystemTime(now);
      recordMemSwanPortfolioMark('a', 100);
      recordMemSwanPortfolioMark('b', 100);
      recordMemSwanPortfolioMark('c', 100);
      ingestMemSwanPortfolioTick(c);
      expect(consumeMemSwanPortRisingEdge(c)).toBeNull();

      // t1 = t0 + 6h1m: same mints crashed -30%. Now a base ~6h old exists → trigger.
      vi.setSystemTime(now + (360 + 1) * 60_000);
      recordMemSwanPortfolioMark('a', 70);
      recordMemSwanPortfolioMark('b', 70);
      recordMemSwanPortfolioMark('c', 70);
      ingestMemSwanPortfolioTick(c);
      const edge = consumeMemSwanPortRisingEdge(c);
      expect(edge).not.toBeNull();
      // Edge consumed once.
      expect(consumeMemSwanPortRisingEdge(c)).toBeNull();
      expect(memSwanPortSnapshot().active).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rising edge is suppressed when the last compute is stale', () => {
    const c = cfg({ liveMemSwanPortMaxStaleSec: 60 } as Partial<LiveOscarConfig>);
    const now = 2_000_000_000_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      recordMemSwanPortfolioMark('a', 100);
      recordMemSwanPortfolioMark('b', 100);
      recordMemSwanPortfolioMark('c', 100);
      ingestMemSwanPortfolioTick(c);
      vi.setSystemTime(now + (360 + 1) * 60_000);
      recordMemSwanPortfolioMark('a', 70);
      recordMemSwanPortfolioMark('b', 70);
      recordMemSwanPortfolioMark('c', 70);
      ingestMemSwanPortfolioTick(c);
      // Advance well past maxStaleSec before consuming.
      vi.setSystemTime(now + (360 + 1) * 60_000 + 120_000);
      expect(consumeMemSwanPortRisingEdge(c)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
