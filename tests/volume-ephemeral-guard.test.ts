import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluateVolumeEphemeralGuard,
  type VolumeEphemeralFeatures,
} from '../src/papertrader/discovery/volume-ephemeral-guard.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function baseRow(over: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: 'Mint111111111111111111111111111111111111111',
    symbol: 'T',
    ts: new Date(),
    launch_ts: null,
    age_min: 3000,
    price_usd: 1,
    liquidity_usd: 160_000,
    volume_5m: 5_000,
    volume_1h: 65_000,
    buys_5m: 10,
    sells_5m: 8,
    market_cap_usd: 5e6,
    source: 'raydium',
    holder_count: 4000,
    token_age_min: 3000,
    pair_address: null,
    ...over,
  };
}

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    volumeEphemeralGuardEnabled: true,
    volumeEphemeralLookbackHours: 24,
    volumeEphemeralMinActiveHourVol5mUsd: 8_000,
    volumeEphemeralMaxActiveHours: 4,
    volumeEphemeralMinPeakVol5mUsd: 20_000,
    volumeEphemeralMinHoursWithData: 2,
    volumeEphemeralSparseHoursBuffer: 2,
    volumeEphemeralTailBlockEnabled: true,
    volumeEphemeralTailMaxPeakRatio: 0.3,
    ...over,
  } as PaperTraderConfig;
}

function ctx(over: Partial<VolumeEphemeralFeatures> = {}): VolumeEphemeralFeatures {
  return {
    lookbackHours: 24,
    hoursWithData: 3,
    activeHours: 3,
    peakHourVol5mUsd: 432_347,
    currentVol5mUsd: null,
    peakToCurrentRatio: null,
    coverageOk: true,
    ...over,
  };
}

describe('evaluateVolumeEphemeralGuard', () => {
  it('passes when guard disabled', () => {
    const r = evaluateVolumeEphemeralGuard(baseCfg({ volumeEphemeralGuardEnabled: false }), baseRow(), ctx());
    expect(r.blocked).toBe(false);
  });

  it('passes when PG coverage insufficient (safe-skip)', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow(),
      ctx({ coverageOk: false, hoursWithData: 1 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks GOAT-like narrow burst (3 active hours, high peak, sparse history)', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 19_402, symbol: 'GOAT' }),
      ctx(),
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('volume_ephemeral:'))).toBe(true);
  });

  it('passes normal coin with many active hours', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 12_000 }),
      ctx({ hoursWithData: 22, activeHours: 18, peakHourVol5mUsd: 45_000 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes when peak too small', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 3_000 }),
      ctx({ hoursWithData: 3, activeHours: 2, peakHourVol5mUsd: 9_000 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks tail of burst when current vol collapsed vs peak', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg({ volumeEphemeralSparseHoursBuffer: 0 }),
      baseRow({ volume_5m: 6_000 }),
      ctx({ hoursWithData: 8, activeHours: 4, peakHourVol5mUsd: 200_000 }),
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.includes('tail_vol5m'))).toBe(true);
  });
});
