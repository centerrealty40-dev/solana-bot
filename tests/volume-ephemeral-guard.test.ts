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
    volumeGuardNewMintMinVol5mToVol1hRatio: 0.08,
    volumeGuardNewMintVol1hWashMinUsd: 36_000,
    volumeEphemeralNewMintMinActiveHours: 10,
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

  it('passes when PG coverage insufficient and snapshot is not wash-shaped (safe-skip)', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 12_000, volume_1h: 65_000 }),
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
      baseCfg({ volumeEphemeralNewMintMinActiveHours: 0 }),
      baseRow({ volume_5m: 3_000, volume_1h: 20_000 }),
      ctx({ hoursWithData: 3, activeHours: 2, peakHourVol5mUsd: 9_000 }),
      { knownMint: false },
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks tail of burst when current vol collapsed vs peak', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg({ volumeEphemeralSparseHoursBuffer: 0, volumeEphemeralNewMintMinActiveHours: 0 }),
      baseRow({ volume_5m: 6_000 }),
      ctx({ hoursWithData: 8, activeHours: 4, peakHourVol5mUsd: 200_000 }),
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.includes('tail_vol5m'))).toBe(true);
  });

  it('MUSHU-like new mint: 2h spike + 10h dead blocks on min active hours', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 2_800, volume_1h: 90_000, symbol: 'MUSHU' }),
      ctx({ hoursWithData: 12, activeHours: 2, peakHourVol5mUsd: 210_000 }),
      { knownMint: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.includes('new_mint_min_active_hours'))).toBe(true);
  });

  it('new mint passes when active hours meet 10h sustain threshold', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 12_000, volume_1h: 80_000 }),
      ctx({ hoursWithData: 22, activeHours: 12, peakHourVol5mUsd: 45_000 }),
      { knownMint: false },
    );
    expect(r.blockedReasons.some((x) => x.includes('new_mint_min_active_hours'))).toBe(false);
  });

  it('known mint skips min active hours gate', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 2_800, volume_1h: 90_000 }),
      ctx({ hoursWithData: 12, activeHours: 2, peakHourVol5mUsd: 210_000 }),
      { knownMint: true },
    );
    expect(r.blockedReasons.some((x) => x.includes('new_mint_min_active_hours'))).toBe(false);
  });

  it('MUSHU-like new mint: aged-out activeHours still blocked on dead tail', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg({ volumeEphemeralNewMintMinActiveHours: 0 }),
      baseRow({ volume_5m: 3_500, volume_1h: 82_000, symbol: 'MUSHU' }),
      ctx({ hoursWithData: 10, activeHours: 5, peakHourVol5mUsd: 210_000 }),
      { knownMint: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.includes('new_mint_tail_vol5m'))).toBe(true);
  });

  it('MUSHU-like new mint: dead vol5m vs high vol1h ratio blocks wash', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg({ volumeEphemeralNewMintMinActiveHours: 0 }),
      baseRow({ volume_5m: 2_800, volume_1h: 90_000 }),
      ctx({ hoursWithData: 12, activeHours: 6, peakHourVol5mUsd: 15_000 }),
      { knownMint: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.includes('tail_wash_vol5m_vol1h'))).toBe(true);
  });

  it('NEST-like known mint: 18 active hours but dead vol5m + inflated vol1h blocks wash', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg({ volumeEphemeralNewMintMinActiveHours: 0 }),
      baseRow({ volume_5m: 1_400, volume_1h: 194_000, symbol: 'NEST' }),
      ctx({ hoursWithData: 22, activeHours: 18, peakHourVol5mUsd: 45_000 }),
      { knownMint: true },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.includes('tail_wash_vol5m_vol1h'))).toBe(true);
  });

  it('MUSHU prod bypass: activeHours=5 dead tail still blocks (new mint)', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 5505, volume_1h: 168_265, symbol: 'MUSHU' }),
      ctx({ hoursWithData: 12, activeHours: 5, peakHourVol5mUsd: 153_197 }),
      { knownMint: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.length).toBeGreaterThan(0);
  });

  it('MUSHU prod bypass: activeHours=5 known mint dead tail blocks wash or tail', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 5505, volume_1h: 168_265, symbol: 'MUSHU' }),
      ctx({ hoursWithData: 12, activeHours: 5, peakHourVol5mUsd: 153_197 }),
      { knownMint: true },
    );
    expect(r.blocked).toBe(true);
  });

  it('MUSHU prod bypass: PG ctx missing still blocks obvious wash from snapshot', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg(),
      baseRow({ volume_5m: 5505, volume_1h: 168_265, symbol: 'MUSHU' }),
      ctx({ coverageOk: false, hoursWithData: 0, activeHours: 0, peakHourVol5mUsd: null }),
      { knownMint: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.includes('tail_wash_no_pg_ctx'))).toBe(true);
  });

  it('known mint with live vol5m/vol1h ratio passes wash gate', () => {
    const r = evaluateVolumeEphemeralGuard(
      baseCfg({ volumeEphemeralNewMintMinActiveHours: 0 }),
      baseRow({ volume_5m: 12_000, volume_1h: 82_000 }),
      ctx({ hoursWithData: 10, activeHours: 5, peakHourVol5mUsd: 210_000 }),
      { knownMint: true },
    );
    expect(r.blocked).toBe(false);
    expect(r.blockedReasons.some((x) => x.includes('tail_wash_vol5m_vol1h'))).toBe(false);
  });
});
