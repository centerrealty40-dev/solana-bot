import { describe, expect, it } from 'vitest';

import type { OscarCandle } from '../src/hyperliquid/oscar-perp/candles.js';
import { barsForMinutes } from '../src/hyperliquid/oscar-perp/candles.js';
import type { HlOscarPerpConfig } from '../src/hyperliquid/oscar-perp/config.js';
import { evaluateOscarEntry } from '../src/hyperliquid/oscar-perp/entry-signal.js';

function flatCandles(count: number, price: number, tsStart = 1_700_000_000_000): OscarCandle[] {
  const step = 15 * 60 * 1000;
  return Array.from({ length: count }, (_, i) => ({
    ts: tsStart + i * step,
    open: price,
    high: price,
    low: price,
    close: price,
  }));
}

function withWindowDip(
  candles: OscarCandle[],
  windowBars: number,
  high: number,
  close: number,
  low: number,
): OscarCandle[] {
  const out = candles.map((c) => ({ ...c }));
  const i = out.length - 1;
  for (let j = i - windowBars + 1; j <= i; j++) {
    out[j] = { ...out[j]!, high, low, close: j === i ? close : high };
  }
  return out;
}

const baseCfg: HlOscarPerpConfig = {
  enabled: true,
  mode: 'dry_run',
  privateKey: null,
  masterAddress: '0x0',
  testnet: false,
  leverage: 2,
  positionNotionalUsd: 100,
  positionMarginUsd: 50,
  stagedEntryEnabled: true,
  leg1GrossUsd: 30,
  leg2GrossUsd: 30,
  leg3GrossUsd: 40,
  leg2DropPct: 5,
  leg3DropPct: 10,
  positionKillDropPct: 45,
  stagedKillDropPct: 45,
  dipMinDropPct: -7,
  dipMaxDropPct: -50,
  dipMinImpulsePct: 0,
  dipLookbackWindowsMin: [120],
  dipCooldownMin: 30,
  timeStopHours: 0,
  maxOpenPositions: 4,
  minDayVolumeUsd: 100_000,
  pollIntervalMs: 60_000,
  candleRefreshMs: 300_000,
  scanBatchSize: 25,
  candleFetchConcurrency: 4,
  slippageTolerance: 0.01,
  journalPath: '',
  heartbeatPath: '',
  drawdownStopUsd: 500,
  drawdownCheckMs: 60_000,
  remainderClosePct: 10,
  marginReserveUsd: 25,
};

describe('hl-oscar-perp entry-signal impulse filter', () => {
  it('fires at −7% dip when dipMinImpulsePct=0 (impulse filter off)', () => {
    const bars = barsForMinutes(120);
    const need = barsForMinutes(720) + 2;
    let candles = flatCandles(need, 100);
    candles = withWindowDip(candles, bars, 100, 92.5, 92.5);
    const signal = evaluateOscarEntry(baseCfg, 'SOL', candles);
    expect(signal).not.toBeNull();
    expect(signal!.dipPct).toBeLessThanOrEqual(-7);
  });

  it('rejects shallow dip above −7% floor', () => {
    const bars = barsForMinutes(120);
    const need = barsForMinutes(720) + 1;
    let candles = flatCandles(need, 100);
    candles = withWindowDip(candles, bars, 100, 96, 96);
    expect(evaluateOscarEntry(baseCfg, 'SOL', candles)).toBeNull();
  });

  it('rejects when impulse below min when filter enabled', () => {
    const bars = barsForMinutes(120);
    const need = barsForMinutes(720) + 1;
    let candles = flatCandles(need, 100);
    candles = withWindowDip(candles, bars, 100, 93, 92.5);
    const cfg = { ...baseCfg, dipMinImpulsePct: 10 };
    expect(evaluateOscarEntry(cfg, 'SOL', candles)).toBeNull();
  });
});
