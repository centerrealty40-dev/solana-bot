import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluateVolumeSybilGuard,
  type VolumeSybilFeatures,
} from '../src/papertrader/discovery/volume-sybil-guard.js';
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
    volume_5m: 18_000,
    volume_1h: 65_000,
    buys_5m: 10,
    sells_5m: 8,
    market_cap_usd: 5e6,
    source: 'pumpswap',
    holder_count: 4000,
    token_age_min: 3000,
    pair_address: null,
    ...over,
  };
}

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    volumeSybilGuardEnabled: true,
    volumeSybilLookbackHours: 6,
    volumeSybilRecentMinutes: 45,
    volumeSybilBaselineP10MaxUsd: 3_000,
    volumeSybilMinBaselineSamples: 25,
    volumeSybilMinRecentVol5mUsd: 8_000,
    volumeSybilSpikeRatioMin: 6,
    volumeSybilDeadVol5mUsd: 2_500,
    volumeSybilMinDeadFraction: 0.55,
    volumeSybilVol1hAliveExemptUsd: 36_000,
    ...over,
  } as PaperTraderConfig;
}

function ctx(over: Partial<VolumeSybilFeatures> = {}): VolumeSybilFeatures {
  return {
    lookbackHours: 6,
    recentMinutes: 45,
    baselineSampleCount: 120,
    baselineDeadCount: 80,
    baselineDeadFraction: 0.67,
    baselineP10Vol5mUsd: 800,
    baselineP50Vol5mUsd: 2_000,
    recentMaxVol5mUsd: 17_000,
    currentVol5mUsd: null,
    effectiveRecentVol5mUsd: null,
    spikeRatio: null,
    coverageOk: true,
    ...over,
  };
}

describe('evaluateVolumeSybilGuard', () => {
  it('passes when guard disabled', () => {
    const r = evaluateVolumeSybilGuard(baseCfg({ volumeSybilGuardEnabled: false }), baseRow(), ctx());
    expect(r.blocked).toBe(false);
  });

  it('passes when PG coverage insufficient (safe-skip)', () => {
    const r = evaluateVolumeSybilGuard(
      baseCfg(),
      baseRow({ volume_5m: 20_000 }),
      ctx({ coverageOk: false, baselineSampleCount: 5 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks SCAM-like dead baseline + sharp vol5m spike', () => {
    const r = evaluateVolumeSybilGuard(
      baseCfg(),
      baseRow({ volume_5m: 18_362, volume_1h: 5_000 }),
      ctx({
        baselineP10Vol5mUsd: 800,
        baselineP50Vol5mUsd: 2_000,
        baselineDeadFraction: 0.67,
        recentMaxVol5mUsd: 18_362,
      }),
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('volume_sybil:'))).toBe(true);
    expect(r.features.spikeRatio).toBeGreaterThanOrEqual(6);
  });

  it('passes live coin with low p10 but high vol1h and moderate dead fraction (MANIFEST-like)', () => {
    const r = evaluateVolumeSybilGuard(
      baseCfg(),
      baseRow({ volume_5m: 20_359, volume_1h: 103_191 }),
      ctx({
        baselineP10Vol5mUsd: 1_343,
        baselineP50Vol5mUsd: 2_834,
        baselineDeadFraction: 0.43,
        recentMaxVol5mUsd: 20_359,
      }),
    );
    expect(r.blocked).toBe(false);
    expect(r.features.spikeRatio).toBeGreaterThanOrEqual(6);
  });

  it('passes when vol1h alone proves market is alive', () => {
    const r = evaluateVolumeSybilGuard(
      baseCfg(),
      baseRow({ volume_5m: 18_000, volume_1h: 80_000 }),
      ctx({
        baselineP10Vol5mUsd: 800,
        baselineP50Vol5mUsd: 2_000,
        baselineDeadFraction: 0.67,
        recentMaxVol5mUsd: 18_000,
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes gradual interest — elevated baseline p10, moderate ratio', () => {
    const r = evaluateVolumeSybilGuard(
      baseCfg(),
      baseRow({ volume_5m: 15_000 }),
      ctx({
        baselineP10Vol5mUsd: 5_500,
        baselineP50Vol5mUsd: 9_000,
        recentMaxVol5mUsd: 15_000,
        baselineDeadFraction: 0.2,
      }),
    );
    expect(r.blocked).toBe(false);
    expect(r.features.spikeRatio).toBeLessThan(6);
  });

  it('passes when recent spike too small', () => {
    const r = evaluateVolumeSybilGuard(
      baseCfg(),
      baseRow({ volume_5m: 5_000 }),
      ctx({ baselineP10Vol5mUsd: 500, recentMaxVol5mUsd: 5_000 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('uses max(current row, recent PG max) for spike detection', () => {
    const r = evaluateVolumeSybilGuard(
      baseCfg(),
      baseRow({ volume_5m: 12_000, volume_1h: 4_000 }),
      ctx({
        baselineP10Vol5mUsd: 1_000,
        baselineP50Vol5mUsd: 2_000,
        baselineDeadFraction: 0.67,
        recentMaxVol5mUsd: 4_000,
      }),
    );
    expect(r.features.effectiveRecentVol5mUsd).toBe(12_000);
    expect(r.blocked).toBe(true);
  });
});
