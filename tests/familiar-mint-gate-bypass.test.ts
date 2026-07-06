import { afterEach, describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { evaluatePgDataCoverageGuard } from '../src/papertrader/discovery/pg-data-coverage-guard.js';
import { evaluateVolumeEphemeralGuard } from '../src/papertrader/discovery/volume-ephemeral-guard.js';
import { isFamiliarMint, buildKnownMintTradeHistory } from '../src/papertrader/discovery/known-mint.js';
import { lastEntryTsByMintMap } from '../src/papertrader/discovery/dip-clones.js';
import type { SnapshotCandidateRow } from '../src/papertrader/types.js';
import type { GlobalPgCoverageState, MintPgCoverageFeatures } from '../src/papertrader/discovery/pg-data-coverage-guard.js';
import type { VolumeEphemeralFeatures } from '../src/papertrader/discovery/volume-ephemeral-guard.js';

const MANLET_MINT = 'DdPrHYqM8Ueovnk9kAnAgoGhswkuaTqmxcoZzU3Zpump';
const FREE_MINT = '82XVWa111111111111111111111111111111111111';

function baseRow(over: Partial<SnapshotCandidateRow> = {}): SnapshotCandidateRow {
  return {
    mint: MANLET_MINT,
    symbol: 'manlet',
    ts: new Date(),
    launch_ts: null,
    age_min: 50_000,
    price_usd: 0.004,
    liquidity_usd: 400_000,
    volume_5m: 16_300,
    volume_1h: 120_000,
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

function pgCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    pgDataCoverageGuardEnabled: true,
    pgDataCoverageLookbackHours: 24,
    pgDataCoverageRecentHours: 6,
    pgDataCoverageMinRecentHoursWithData: 4,
    pgDataCoverageMinHourRatio: 0.5,
    pgDataCoverageStrictMinHourRatio: 0.75,
    pgDataCoverageMinSystemHourRatio: 0.3,
    pgDataCoverageMinMinutesPerHour: 5,
    pgDataCoverageMaxGapMinutes: 30,
    pgDataCoverageBlockOnPgStale: true,
    pgDataCoverageBlockBuy: true,
    pgDataCoverageStrictAfterRecoveryHours: 24,
    pgDataCoverageAutoEscalate: true,
    pgDataCoverageKnownMintGapBypass: true,
    pgDataCoverageKnownMintLookbackDays: 14,
    pgCoverageBirdeyeFreshBypass: true,
    volumeEphemeralMinActiveHourVol5mUsd: 8_000,
    volumeSybilGuardEnabled: false,
    volumeEphemeralGuardEnabled: true,
    volumeEphemeralMinHoursWithData: 2,
    ...over,
  } as PaperTraderConfig;
}

function ephemeralCfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
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
    volumeEphemeralNewMintMinActiveHours: 8,
    volumeEphemeralBirdeyeFreshBypass: true,
    ...over,
  } as PaperTraderConfig;
}

function mintCtx(over: Partial<MintPgCoverageFeatures> = {}): MintPgCoverageFeatures {
  return {
    lookbackHours: 24,
    recentHours: 6,
    minuteSamples: 500,
    hoursWithData: 20,
    recentHoursWithData: 6,
    hourCoverageRatio: 0.83,
    recentHourCoverageRatio: 1,
    maxGapMinutes: 12,
    recentMaxGapMinutes: 12,
    sybilBaselineSamples: 40,
    sybilCoverageOk: true,
    ephemeralCoverageOk: true,
    nearEntry: false,
    ...over,
  };
}

function globalStale(ageSec: number): GlobalPgCoverageState {
  return {
    pgStaleNow: true,
    worstAgeSec: ageSec,
    freshness: [
      {
        source: 'pumpswap',
        table: 'pumpswap_pair_snapshots',
        latestTs: null,
        ageSec,
        ok: false,
      },
      {
        source: 'raydium',
        table: 'raydium_pair_snapshots',
        latestTs: new Date(),
        ageSec: 120,
        ok: true,
      },
    ],
    systemHourRatio: 0.5,
    strictRecoveryActive: false,
    hoursSinceLastRecovery: 48,
    lookbackHours: 24,
    recentHours: 6,
    coverageMode: 'relaxed',
    coverageModeChanged: null,
  };
}

function freeEphemeralCtx(): VolumeEphemeralFeatures {
  return {
    lookbackHours: 24,
    hoursWithData: 3,
    activeHours: 2,
    peakHourVol5mUsd: 180_000,
    currentVol5mUsd: null,
    peakToCurrentRatio: null,
    coverageOk: true,
  };
}

describe('familiar mint tracking (audit only, no gate bypass)', () => {
  afterEach(() => {
    lastEntryTsByMintMap.delete(MANLET_MINT);
  });

  it('isFamiliarMint true for journal repeat-traded mint without bypass env', () => {
    lastEntryTsByMintMap.set(MANLET_MINT, Date.now() - 6 * 3_600_000);
    const history = buildKnownMintTradeHistory({
      lastEntryTsByMint: lastEntryTsByMintMap,
      lastPostExitBuyCooldownTsByMint: new Map(),
      lastRealExitMarketSnapshotByMint: new Map(),
      lastExitMarketSnapshotByMint: new Map(),
    });
    expect(isFamiliarMint(pgCfg(), MANLET_MINT, history)).toBe(true);
  });
});

describe('manlet-like repeat mint — Dex fresh bypass replaces familiar crutch', () => {
  afterEach(() => {
    lastEntryTsByMintMap.delete(MANLET_MINT);
  });

  it('blocks familiar mint on pg_stale without fresh Dex quote', () => {
    lastEntryTsByMintMap.set(MANLET_MINT, Date.now() - 6 * 3_600_000);
    const r = evaluatePgDataCoverageGuard(
      pgCfg(),
      baseRow(),
      mintCtx(),
      globalStale(1071),
      true,
      { knownMint: true, freshExternalMarketQuote: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_stale_now'))).toBe(true);
    expect(r.features.birdeyeFreshBypass).toBe(false);
  });

  it('passes familiar mint on pg_stale when fresh Dex quote bypass enabled', () => {
    lastEntryTsByMintMap.set(MANLET_MINT, Date.now() - 6 * 3_600_000);
    const r = evaluatePgDataCoverageGuard(
      pgCfg(),
      baseRow(),
      mintCtx(),
      globalStale(1071),
      true,
      { knownMint: true, freshExternalMarketQuote: true },
    );
    expect(r.blocked).toBe(false);
    expect(r.features.birdeyeFreshBypass).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_stale_now'))).toBe(false);
  });

  it('still blocks familiar mint on volume_ephemeral spike (DADDY-class)', () => {
    const r = evaluateVolumeEphemeralGuard(
      ephemeralCfg(),
      baseRow({ volume_5m: 2_000, volume_1h: 80_000 }),
      {
        lookbackHours: 24,
        hoursWithData: 4,
        activeHours: 3,
        peakHourVol5mUsd: 500_000,
        currentVol5mUsd: 2_000,
        peakToCurrentRatio: 0.004,
        coverageOk: true,
      },
      { knownMint: true, freshExternalMarketQuote: false },
    );
    expect(r.blocked).toBe(true);
    expect(
      r.blockedReasons.some((x) => x.startsWith('volume_ephemeral:known_mint_sustained_dead')),
    ).toBe(true);
  });
});

describe('new mint — guards stay strict', () => {
  it('blocks new mint on volume_ephemeral burst', () => {
    const r = evaluateVolumeEphemeralGuard(
      ephemeralCfg(),
      baseRow({
        mint: FREE_MINT,
        symbol: 'FREE',
        volume_5m: 3_000,
        volume_1h: 90_000,
        market_cap_usd: 800_000,
      }),
      freeEphemeralCtx(),
      { knownMint: false },
    );
    expect(r.blocked).toBe(true);
    expect(
      r.blockedReasons.some((x) => x.startsWith('volume_ephemeral:new_mint_min_active_hours')),
    ).toBe(true);
  });

  it('blocks new mint on pg_stale without fresh Dex quote', () => {
    const r = evaluatePgDataCoverageGuard(
      pgCfg(),
      baseRow({ mint: FREE_MINT, symbol: 'FREE' }),
      mintCtx(),
      globalStale(1071),
      true,
      { knownMint: false, freshExternalMarketQuote: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_stale_now'))).toBe(true);
  });
});
