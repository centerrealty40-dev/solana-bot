import { describe, expect, it } from 'vitest';

import type { HlOscarMajorsScalpConfig } from '../src/hyperliquid/oscar-majors/config.js';
import { evaluateScalpEntry, posIn24hRange } from '../src/hyperliquid/oscar-majors/scalp-entry.js';
import type { OscarCandle } from '../src/hyperliquid/oscar-majors/candles.js';
import {
  computeScalpExitActions,
  scalpSlFrac,
} from '../src/hyperliquid/oscar-majors/scalp-exit-engine.js';
import type { OscarOpenPosition } from '../src/hyperliquid/oscar-majors/position-types.js';

const MS = 15 * 60 * 1000;

function scalpCfg(overrides: Partial<HlOscarMajorsScalpConfig> = {}): HlOscarMajorsScalpConfig {
  return {
    enabled: true,
    mode: 'dry_run',
    dipPct: -2,
    windowMin: 120,
    rangeMaxPct: 0.4,
    tpRungs: [0.005, 0.01],
    slPct: 2.5,
    timeStopMin: 240,
    cooldownMin: 30,
    marginUsd: 25,
    leverage: 2,
    grossUsd: 50,
    maxOpenPositions: 2,
    tpSellFrac: 0.5,
    trailSellFrac: 0.25,
    trailArmPct: 0.8,
    trailStepPct: 0.4,
    maxFunding8h: 0.0001,
    ...overrides,
  };
}

function flatCandles(base: number, count: number, dipAtEnd = false): OscarCandle[] {
  const out: OscarCandle[] = [];
  for (let i = 0; i < count; i++) {
    const px = dipAtEnd && i === count - 1 ? base * 0.97 : base;
    out.push({ ts: i * MS, open: px, high: base, low: px, close: px });
  }
  return out;
}

function testPos(overrides: Partial<OscarOpenPosition> = {}): OscarOpenPosition {
  return {
    coin: 'BTC',
    tradeMode: 'scalp',
    avgEntryPx: 100,
    signalPrice: 100,
    remainingFraction: 1,
    tpLevelsTaken: new Set(),
    trailLevelsTaken: new Set(),
    maxTpTaken: 0,
    peakPnlFrac: -Infinity,
    trailAnchor: 0,
    preArmReached: false,
    entryTs: Date.now() - 60_000,
    ...overrides,
  } as OscarOpenPosition;
}

describe('hl-oscar-majors scalp-entry', () => {
  it('fires at −2% from 2h high', () => {
    const candles = flatCandles(100, 20, true);
    const sig = evaluateScalpEntry(scalpCfg(), 'BTC', candles);
    expect(sig).not.toBeNull();
    expect(sig!.dipPct).toBeLessThanOrEqual(-2);
    expect(sig!.windowMin).toBe(120);
  });

  it('skips when dip above threshold', () => {
    const candles = flatCandles(100, 20, false);
    candles[candles.length - 1]!.close = 99;
    const sig = evaluateScalpEntry(scalpCfg(), 'BTC', candles);
    expect(sig).toBeNull();
  });

  it('skips when posIn24hRange above max', () => {
    const candles: OscarCandle[] = [];
    for (let i = 0; i < 100; i++) {
      candles.push({ ts: i * MS, open: 100, high: 110, low: 90, close: 105 });
    }
    candles[candles.length - 1]!.close = 99;
    candles[candles.length - 1]!.low = 99;
    const range = posIn24hRange(candles, candles.length - 1);
    expect(range).not.toBeNull();
    expect(range!).toBeGreaterThan(0.4);
    const sig = evaluateScalpEntry(scalpCfg(), 'BTC', candles);
    expect(sig).toBeNull();
  });

  it('allows entry when range filter off', () => {
    const candles = flatCandles(100, 100, true);
    const sig = evaluateScalpEntry(scalpCfg({ rangeMaxPct: null }), 'BTC', candles);
    expect(sig).not.toBeNull();
  });
});

describe('hl-oscar-majors scalp-exit-engine', () => {
  it('scalpSlFrac is −2.5%', () => {
    expect(scalpSlFrac(scalpCfg())).toBeCloseTo(-0.025);
  });

  it('fires SCALP_SL at −2.5%', () => {
    const pos = testPos();
    const actions = computeScalpExitActions(pos, scalpCfg(), 97.5, 97.4, 97.5, Date.now(), 10);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'full', reason: 'SCALP_SL' });
  });

  it('fires TP level 1 at +0.5%', () => {
    const pos = testPos();
    const actions = computeScalpExitActions(pos, scalpCfg(), 100.5, 100, 100.5, Date.now(), 10);
    const tp = actions.filter((a) => a.kind === 'partial' && a.reason === 'TP');
    expect(tp).toHaveLength(1);
    expect(tp[0]).toMatchObject({ fraction: 0.5, level: 1 });
  });

  it('fires both TP rungs at +1%', () => {
    const pos = testPos();
    const actions = computeScalpExitActions(pos, scalpCfg(), 101, 100, 101, Date.now(), 10);
    const tp = actions.filter((a) => a.kind === 'partial' && a.reason === 'TP');
    expect(tp).toHaveLength(2);
  });

  it('fires TIME_STOP after 240 min', () => {
    const pos = testPos({ entryTs: Date.now() - 241 * 60_000 });
    const actions = computeScalpExitActions(pos, scalpCfg(), 100, 100, 100, Date.now(), 10);
    expect(actions.some((a) => a.kind === 'full' && a.reason === 'TIME_STOP')).toBe(true);
  });
});
