import { describe, expect, it } from 'vitest';
import { isHealthyLiveVolumeSpread, vol5mToVol1hRatio } from '../src/papertrader/discovery/volume-spread-health.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';

function cfg(): Pick<
  PaperTraderConfig,
  | 'volumeGuardNewMintVol1hWashMinUsd'
  | 'volumeGuardNewMintMinVol5mToVol1hRatio'
  | 'volumeEphemeralMinActiveHourVol5mUsd'
> {
  return {
    volumeGuardNewMintVol1hWashMinUsd: 36_000,
    volumeGuardNewMintMinVol5mToVol1hRatio: 0.08,
    volumeEphemeralMinActiveHourVol5mUsd: 8_000,
  };
}

describe('vol5mToVol1hRatio', () => {
  it('computes ratio from row volumes', () => {
    expect(vol5mToVol1hRatio({ volume_5m: 12_000, volume_1h: 80_000 })).toBe(0.15);
  });
});

describe('isHealthyLiveVolumeSpread', () => {
  it('passes DADDY-like healthy Birdeye spread', () => {
    expect(
      isHealthyLiveVolumeSpread(cfg(), { volume_5m: 15_000, volume_1h: 90_000 }),
    ).toBe(true);
  });

  it('fails MUSHU-like tail wash', () => {
    expect(
      isHealthyLiveVolumeSpread(cfg(), { volume_5m: 2_800, volume_1h: 90_000 }),
    ).toBe(false);
  });
});
