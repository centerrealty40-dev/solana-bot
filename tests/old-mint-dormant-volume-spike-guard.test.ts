import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluateOldMintDormantVolSpikeGuard,
  type OldMintDormantVolSpikeFeatures,
} from '../src/papertrader/discovery/old-mint-dormant-volume-spike-guard.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';

const DADDY_MINT = '4Cnk9EPnW5ixfLZatCPJjDB1PUtcRpVVgTQukm9epump';

function baseRow(over: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: DADDY_MINT,
    symbol: 'DADDY',
    ts: new Date(),
    launch_ts: null,
    age_min: 23980,
    price_usd: 0.02955819,
    liquidity_usd: 1_328_500,
    volume_5m: 3628,
    volume_1h: 130_113,
    buys_5m: 10,
    sells_5m: 8,
    market_cap_usd: 17_723_538,
    source: 'raydium',
    holder_count: 4000,
    token_age_min: 150 * 1440,
    pair_address: null,
    ...over,
  };
}

function baseCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    oldMintDormantVolSpikeGuardEnabled: true,
    oldMintDormantVolSpikeMinTokenAgeDays: 0,
    oldMintDormantVolSpikeMaxYoungTokenAgeDays: 2,
    oldMintDormantVolSpikeLookbackHours: 48,
    oldMintDormantVolSpikeBaselineStartHoursAgo: 48,
    oldMintDormantVolSpikeBaselineEndHoursAgo: 24,
    oldMintDormantVolSpikeRecentHours: 6,
    oldMintDormantVolSpikeDormantVol1hMaxUsd: 10_000,
    oldMintDormantVolSpikeDormantVol5mMaxUsd: 5_000,
    oldMintDormantVolSpikeMinDormantHourFraction: 0.75,
    oldMintDormantVolSpikeMinBaselineHours: 18,
    oldMintDormantVolSpikeMinSpikeVol1hUsd: 25_000,
    oldMintDormantVolSpikeVol1hRatioMin: 5,
    volumeGuardNewMintMinVol5mToVol1hRatio: 0.08,
    ...over,
  } as PaperTraderConfig;
}

/** PG context mocked from prod RCA: weak 24–48h ago, spike in last 6h. */
function daddyCtx(over: Partial<OldMintDormantVolSpikeFeatures> = {}): OldMintDormantVolSpikeFeatures {
  return {
    lookbackHours: 48,
    baselineStartHoursAgo: 48,
    baselineEndHoursAgo: 24,
    dormantLookbackHours: 48,
    recentHours: 6,
    baselineMode: 'primary',
    tokenAgeDays: null,
    baselineHoursWithData: 22,
    dormantHours: 20,
    dormantHourFraction: 0.91,
    baselineMedianVol1hUsd: 7032,
    baselineMedianVol5mUsd: 1308,
    baselineP90Vol1hUsd: 8500,
    recentMaxVol1hUsd: 130_113,
    recentMaxVol5mUsd: 743_253,
    currentVol1hUsd: null,
    currentVol5mUsd: null,
    effectiveRecentVol1hUsd: null,
    vol1hSpikeRatio: null,
    coverageOk: true,
    ...over,
  };
}

describe('evaluateOldMintDormantVolSpikeGuard', () => {
  it('passes when guard disabled', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg({ oldMintDormantVolSpikeGuardEnabled: false }),
      baseRow(),
      daddyCtx(),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes mint below post age floor (< maxYoungTokenAgeDays)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow({ token_age_min: 1 * 1440 }),
      daddyCtx(),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes when PG baseline coverage insufficient and no fresh quote (safe-skip)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow(),
      daddyCtx({ coverageOk: false, baselineHoursWithData: 8 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks DADDY-like spike on fresh Dex quote when PG baseline weak (coverageOk=false)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow(),
      daddyCtx({ coverageOk: false, baselineHoursWithData: 8 }),
      { freshExternalMarketQuote: true },
    );
    expect(r.blocked).toBe(true);
    expect(
      r.blockedReasons.some((x) => x.startsWith('ephemeral_volume_spike:live_quote_no_pg_baseline')),
    ).toBe(true);
    expect(r.features.liveQuoteNoPgBaselineBlock).toBe(true);
  });

  it('passes weak PG baseline with fresh quote when vol spread is healthy', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow({ volume_1h: 130_113, volume_5m: 18_000 }),
      daddyCtx({ coverageOk: false, baselineHoursWithData: 8 }),
      { freshExternalMarketQuote: true },
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks DADDY-like dormant→spike at any eligible age (4Cnk9EPn RCA)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(baseCfg(), baseRow(), daddyCtx());
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('ephemeral_volume_spike:'))).toBe(true);
    expect(r.features.vol1hSpikeRatio).toBeGreaterThanOrEqual(5);
  });

  it('blocks 3-day-old mint with same ephemeral spike pattern (age-agnostic)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow({ token_age_min: 3 * 1440 }),
      daddyCtx(),
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('ephemeral_volume_spike:'))).toBe(true);
  });

  it('passes normal young pump with sustained volume (no dormant baseline)', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow({
        mint: 'YoungPump111111111111111111111111111111111',
        token_age_min: 2 * 1440,
        volume_1h: 80_000,
        volume_5m: 15_000,
      }),
      daddyCtx({
        dormantHourFraction: 0.2,
        baselineMedianVol1hUsd: 45_000,
        baselineP90Vol1hUsd: 60_000,
        recentMaxVol1hUsd: 80_000,
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes when spike ratio too small', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg({ oldMintDormantVolSpikeVol1hRatioMin: 20 }),
      baseRow({ volume_1h: 12_000 }),
      daddyCtx({ recentMaxVol1hUsd: 12_000, baselineP90Vol1hUsd: 8000 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('passes when baseline was not mostly dormant', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg(),
      baseRow(),
      daddyCtx({ dormantHourFraction: 0.4 }),
    );
    expect(r.blocked).toBe(false);
  });

  it('respects legacy minTokenAgeDays when set > 0', () => {
    const r = evaluateOldMintDormantVolSpikeGuard(
      baseCfg({ oldMintDormantVolSpikeMinTokenAgeDays: 14 }),
      baseRow({ token_age_min: 10 * 1440 }),
      daddyCtx(),
    );
    expect(r.blocked).toBe(false);
  });
});
