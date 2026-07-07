import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluateVolumeEphemeralGuard,
  type VolumeEphemeralFeatures,
} from '../src/papertrader/discovery/volume-ephemeral-guard.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

function cfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
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
    volumeEphemeralNewMintMinActiveHours: 8,
    volumeEphemeralBirdeyeFreshBypass: true,
    volumeGuardNewMintMinVol5mToVol1hRatio: 0.08,
    volumeGuardNewMintVol1hWashMinUsd: 36_000,
    ...over,
  } as PaperTraderConfig;
}

function row(over: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: 'DdPrHYqM8Ueovnk9kAnAgoGhswkuaTqmxcoZzU3Zpump',
    symbol: 'MANLET',
    ts: new Date(),
    launch_ts: null,
    age_min: 50_000,
    price_usd: 0.004,
    liquidity_usd: 400_000,
    volume_5m: 2_000,
    volume_1h: 80_000,
    buys_5m: 20,
    sells_5m: 15,
    market_cap_usd: 4_140_000,
    source: 'pumpswap',
    holder_count: 8000,
    token_age_min: 50_000,
    pair_address: null,
    ...over,
  };
}

function ctx(over: Partial<VolumeEphemeralFeatures> = {}): VolumeEphemeralFeatures {
  return {
    lookbackHours: 24,
    hoursWithData: 4,
    activeHours: 3,
    peakHourVol5mUsd: 500_000,
    currentVol5mUsd: 2_000,
    peakToCurrentRatio: 0.004,
    coverageOk: true,
    ...over,
  };
}

describe('familiar bypass removed', () => {
  it('still blocks manlet-like familiar spike pattern', () => {
    const res = evaluateVolumeEphemeralGuard(cfg(), row(), ctx());
    expect(res.blocked).toBe(true);
    expect(res.blockedReasons.some((x) => x.startsWith('volume_ephemeral:'))).toBe(true);
  });
});
