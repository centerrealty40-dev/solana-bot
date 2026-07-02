import { describe, expect, it } from 'vitest';

import type { OscarCandle } from '../src/hyperliquid/oscar-perp/candles.js';
import { barsForMinutes } from '../src/hyperliquid/oscar-perp/candles.js';
import type { HlOscarPerpConfig } from '../src/hyperliquid/oscar-perp/config.js';
import {
  evaluateLocalHighVeto,
  evaluateOscarEntry,
  evaluateRecoveryVeto,
} from '../src/hyperliquid/oscar-perp/entry-signal.js';

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

function withWindowRange(
  candles: OscarCandle[],
  windowBars: number,
  high: number,
  low: number,
  close: number,
): OscarCandle[] {
  const out = candles.map((c) => ({ ...c }));
  const i = out.length - 1;
  for (let j = i - windowBars + 1; j <= i; j++) {
    out[j] = { ...out[j]!, high, low, close: j === i ? close : close };
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
  dipMinDropPct: -12,
  dipMaxDropPct: -50,
  dipMinImpulsePct: 8,
  dipLookbackWindowsMin: [120],
  dipCooldownMin: 30,
  recoveryVetoEnabled: false,
  recoveryVetoWindowsMin: [30, 60],
  recoveryVetoMaxBouncePct: 12,
  localHighVetoEnabled: false,
  localHighVetoWindowsMin: [30, 60, 120],
  localHighVetoMaxDistancePct: 2,
  tpRungs: [0.08, 0.12, 0.16],
  trailArmFrac: 0.08,
  trailStepDropFrac: 0.025,
  tpSellFrac: 0.5,
  trailSellFrac: 0.2,
  timeStopHours: 12,
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

describe('hl-oscar-perp entry-signal dip filter', () => {
  it('fires at −12% dip when impulse passes', () => {
    const bars = barsForMinutes(120);
    const need = barsForMinutes(720) + 2;
    let candles = flatCandles(need, 100);
    candles = withWindowDip(candles, bars, 100, 87.5, 80);
    const signal = evaluateOscarEntry(baseCfg, 'SOL', candles);
    expect(signal).not.toBeNull();
    expect(signal!.dipPct).toBeLessThanOrEqual(-12);
  });

  it('rejects shallow dip above −12% floor', () => {
    const bars = barsForMinutes(120);
    const need = barsForMinutes(720) + 1;
    let candles = flatCandles(need, 100);
    candles = withWindowDip(candles, bars, 100, 90, 90);
    expect(evaluateOscarEntry(baseCfg, 'SOL', candles)).toBeNull();
  });

  it('rejects when impulse below min when filter enabled', () => {
    const bars = barsForMinutes(120);
    const need = barsForMinutes(720) + 1;
    let candles = flatCandles(need, 100);
    candles = withWindowDip(candles, bars, 100, 87, 92);
    const cfg = { ...baseCfg, dipMinImpulsePct: 10 };
    expect(evaluateOscarEntry(cfg, 'SOL', candles)).toBeNull();
  });
});

describe('hl-oscar-perp entry-signal recovery veto', () => {
  it('blocks entry when 30m bounce ≥12% from low', () => {
    const bars120 = barsForMinutes(120);
    const bars30 = barsForMinutes(30);
    const need = barsForMinutes(720) + 2;
    let candles = flatCandles(need, 100);
    candles = withWindowRange(candles, bars120, 100, 80, 87);
    candles = withWindowRange(candles, bars30, 100, 75, 87);
    const cfg = { ...baseCfg, recoveryVetoEnabled: true };
    expect(evaluateOscarEntry(cfg, 'SOL', candles)).toBeNull();
    const i = candles.length - 1;
    const veto = evaluateRecoveryVeto(cfg, candles, i, 87, 120);
    expect(veto.reasons.some((r) => r.startsWith('recovery_veto_30m'))).toBe(true);
  });

  it('allows entry when recovery veto disabled', () => {
    const bars120 = barsForMinutes(120);
    const bars30 = barsForMinutes(30);
    const need = barsForMinutes(720) + 2;
    let candles = flatCandles(need, 100);
    candles = withWindowRange(candles, bars120, 100, 80, 87);
    candles = withWindowRange(candles, bars30, 100, 75, 87);
    expect(evaluateOscarEntry(baseCfg, 'SOL', candles)).not.toBeNull();
  });
});

describe('hl-oscar-perp entry-signal local-high veto', () => {
  it('blocks entry when price within 2% of 30m high', () => {
    const bars120 = barsForMinutes(120);
    const bars30 = barsForMinutes(30);
    const need = barsForMinutes(720) + 2;
    let candles = flatCandles(need, 100);
    candles = withWindowRange(candles, bars120, 100, 75, 88);
    const i = candles.length - 1;
    for (let j = i - bars30 + 1; j <= i; j++) {
      candles[j] = { ...candles[j]!, high: 89, low: 75, close: j === i ? 88 : 100 };
    }
    const cfg = { ...baseCfg, localHighVetoEnabled: true };
    expect(evaluateOscarEntry(cfg, 'SOL', candles)).toBeNull();
    const veto = evaluateLocalHighVeto(cfg, candles, i, 88);
    expect(veto.reasons.some((r) => r.startsWith('local_high_veto_30m'))).toBe(true);
  });
});
