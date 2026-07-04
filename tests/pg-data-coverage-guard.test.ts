import { afterEach, describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluatePgDataCoverageGuard,
  type GlobalPgCoverageState,
  type MintPgCoverageFeatures,
  resolvePgCoverageRelaxedMode,
} from '../src/papertrader/discovery/pg-data-coverage-guard.js';
import {
  isPgCoverageKnownMint,
  lastEntryTsByMintMap,
  lastPostExitBuyCooldownTsByMintMap,
} from '../src/papertrader/discovery/dip-clones.js';
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
    pgDataCoverageGuardEnabled: true,
    pgDataCoverageLookbackHours: 24,
    pgDataCoverageRecentHours: 6,
    pgDataCoverageMinRecentHoursWithData: 4,
    pgDataCoverageMinHourRatio: 0.5,
    pgDataCoverageStrictMinHourRatio: 0.75,
    pgDataCoverageMinSystemHourRatio: 0.7,
    pgDataCoverageMinMinutesPerHour: 45,
    pgDataCoverageMaxGapMinutes: 30,
    pgDataCoverageBlockOnPgStale: true,
    pgDataCoverageBlockBuy: true,
    pgDataCoverageStrictAfterRecoveryHours: 24,
    pgDataCoverageAutoEscalate: true,
    pgDataCoverageKnownMintGapBypass: false,
    pgDataCoverageKnownMintLookbackDays: 14,
    volumeSybilGuardEnabled: true,
    volumeSybilMinBaselineSamples: 25,
    volumeEphemeralGuardEnabled: true,
    volumeEphemeralMinHoursWithData: 2,
    ...over,
  } as PaperTraderConfig;
}

function globalState(over: Partial<GlobalPgCoverageState> = {}): GlobalPgCoverageState {
  const freshness = over.freshness ?? [
    { source: 'raydium', table: 'raydium_pair_snapshots', latestTs: new Date(), ageSec: 60, ok: true },
    { source: 'pumpswap', table: 'pumpswap_pair_snapshots', latestTs: new Date(), ageSec: 60, ok: true },
    { source: 'meteora', table: 'meteora_pair_snapshots', latestTs: new Date(), ageSec: 60, ok: true },
    { source: 'moonshot', table: 'moonshot_pair_snapshots', latestTs: new Date(), ageSec: 900, ok: false },
  ];
  return {
    pgStaleNow: false,
    worstAgeSec: 60,
    freshness,
    systemHourRatio: 0.85,
    strictRecoveryActive: false,
    hoursSinceLastRecovery: null,
    lookbackHours: 24,
    recentHours: 6,
    coverageMode: 'full',
    coverageModeChanged: null,
    ...over,
  };
}

function mintCtx(over: Partial<MintPgCoverageFeatures> = {}): MintPgCoverageFeatures {
  return {
    lookbackHours: 24,
    recentHours: 6,
    minuteSamples: 400,
    hoursWithData: 20,
    recentHoursWithData: 5,
    hourCoverageRatio: 20 / 24,
    recentHourCoverageRatio: 5 / 6,
    maxGapMinutes: 5,
    recentMaxGapMinutes: 5,
    sybilBaselineSamples: 40,
    sybilCoverageOk: true,
    ephemeralCoverageOk: true,
    nearEntry: true,
    ...over,
  };
}

describe('resolvePgCoverageRelaxedMode', () => {
  it('returns relaxed when PG is stale', () => {
    expect(
      resolvePgCoverageRelaxedMode(baseCfg(), {
        pgStaleNow: true,
        systemHourRatio: 0.9,
        hoursSinceLastRecovery: 48,
      }),
    ).toBe(true);
  });

  it('returns relaxed within strict-after-recovery window', () => {
    expect(
      resolvePgCoverageRelaxedMode(baseCfg(), {
        pgStaleNow: false,
        systemHourRatio: 0.9,
        hoursSinceLastRecovery: 6,
      }),
    ).toBe(true);
  });

  it('returns relaxed when system hour ratio is low', () => {
    expect(
      resolvePgCoverageRelaxedMode(baseCfg(), {
        pgStaleNow: false,
        systemHourRatio: 0.45,
        hoursSinceLastRecovery: 48,
      }),
    ).toBe(true);
  });

  it('returns full when all metrics healthy', () => {
    expect(
      resolvePgCoverageRelaxedMode(baseCfg(), {
        pgStaleNow: false,
        systemHourRatio: 0.85,
        hoursSinceLastRecovery: 48,
      }),
    ).toBe(false);
  });

  it('manual relaxed when auto-escalate off and full tier env disabled', () => {
    expect(
      resolvePgCoverageRelaxedMode(
        baseCfg({
          pgDataCoverageAutoEscalate: false,
          pgDataCoverageMinSystemHourRatio: 0,
          pgDataCoverageStrictAfterRecoveryHours: 0,
        }),
        { pgStaleNow: false, systemHourRatio: 0.3, hoursSinceLastRecovery: 0 },
      ),
    ).toBe(true);
  });
});

describe('evaluatePgDataCoverageGuard', () => {
  it('returns not blocked when guard disabled', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageGuardEnabled: false }),
      baseRow(),
      mintCtx(),
      globalState(),
      true,
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks when PG is stale now for mint lane source', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow({ source: 'raydium' }),
      mintCtx(),
      globalState({
        pgStaleNow: true,
        worstAgeSec: 900,
        freshness: [
          { source: 'raydium', table: 'raydium_pair_snapshots', latestTs: null, ageSec: 900, ok: false },
          { source: 'pumpswap', table: 'pumpswap_pair_snapshots', latestTs: new Date(), ageSec: 120, ok: true },
        ],
      }),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_stale_now'))).toBe(true);
  });

  it('does not block pumpswap mint when only moonshot/meteora lane is stale', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow({ source: 'pumpswap' }),
      mintCtx(),
      globalState({
        pgStaleNow: true,
        worstAgeSec: 804,
        freshness: [
          { source: 'pumpswap', table: 'pumpswap_pair_snapshots', latestTs: new Date(), ageSec: 188, ok: true },
          { source: 'raydium', table: 'raydium_pair_snapshots', latestTs: new Date(), ageSec: 68, ok: true },
          { source: 'meteora', table: 'meteora_pair_snapshots', latestTs: null, ageSec: 848, ok: false },
          { source: 'moonshot', table: 'moonshot_pair_snapshots', latestTs: null, ageSec: 804, ok: false },
        ],
      }),
      true,
    );
    expect(r.blocked).toBe(false);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_stale_now'))).toBe(false);
  });

  it('ignores low system hour ratio in relaxed mode', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx(),
      globalState({ coverageMode: 'relaxed', systemHourRatio: 0.4 }),
      true,
    );
    expect(r.blocked).toBe(false);
  });

  it('blocks when system hour ratio is low in full mode', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx(),
      globalState({ coverageMode: 'full', systemHourRatio: 0.4 }),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:system_pg_hour_ratio'))).toBe(
      true,
    );
  });

  it('blocks when recent hour coverage is insufficient in relaxed mode', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx({ recentHoursWithData: 2, recentHourCoverageRatio: 2 / 6 }),
      globalState({ coverageMode: 'relaxed' }),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:recent_pg_insufficient'))).toBe(
      true,
    );
  });

  it('blocks when full lookback coverage is insufficient in full mode', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx({ hoursWithData: 8, hourCoverageRatio: 8 / 24 }),
      globalState({ coverageMode: 'full' }),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_insufficient'))).toBe(true);
  });

  it('blocks when sybil baseline samples are insufficient', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx({ sybilBaselineSamples: 5, sybilCoverageOk: false }),
      globalState(),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:sybil_pg_insufficient'))).toBe(
      true,
    );
  });

  it('blocks when recent mint history has a large gap in relaxed mode', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageMaxGapMinutes: 30 }),
      baseRow(),
      mintCtx({ recentMaxGapMinutes: 180 }),
      globalState({ coverageMode: 'relaxed' }),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_gap_in_recent_history'))).toBe(
      true,
    );
  });

  it('blocks when full mint history has a large gap in full mode', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageMaxGapMinutes: 30 }),
      baseRow(),
      mintCtx({ maxGapMinutes: 180 }),
      globalState({ coverageMode: 'full' }),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_gap_in_history'))).toBe(
      true,
    );
  });

  it('passes in relaxed mode when recent coverage is sufficient despite bad 24h system ratio', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx(),
      globalState({ coverageMode: 'relaxed', systemHourRatio: 0.35 }),
      true,
    );
    expect(r.blocked).toBe(false);
  });

  it('bypasses recent pg gap for known mint when flag enabled', () => {
    const mint = baseRow().mint;
    lastEntryTsByMintMap.set(mint, Date.now() - 2 * 24 * 3_600_000);
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageKnownMintGapBypass: true }),
      baseRow(),
      mintCtx({ recentMaxGapMinutes: 180 }),
      globalState({ coverageMode: 'relaxed' }),
      true,
      { knownMint: true },
    );
    expect(r.blocked).toBe(false);
    expect(r.features.knownMintGapBypass).toBe(true);
    lastEntryTsByMintMap.delete(mint);
  });

  it('still blocks known mint on pg_stale_now when gap bypass enabled', () => {
    const mint = baseRow().mint;
    lastEntryTsByMintMap.set(mint, Date.now() - 1 * 24 * 3_600_000);
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageKnownMintGapBypass: true }),
      baseRow({ source: 'raydium' }),
      mintCtx({ recentMaxGapMinutes: 180 }),
      globalState({
        coverageMode: 'relaxed',
        pgStaleNow: true,
        worstAgeSec: 900,
        freshness: [
          { source: 'raydium', table: 'raydium_pair_snapshots', latestTs: null, ageSec: 900, ok: false },
          { source: 'pumpswap', table: 'pumpswap_pair_snapshots', latestTs: new Date(), ageSec: 120, ok: true },
        ],
      }),
      true,
      { knownMint: true },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_stale_now'))).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_gap'))).toBe(false);
    lastEntryTsByMintMap.delete(mint);
  });

  it('blocks new mint pg gap even when bypass flag enabled', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageKnownMintGapBypass: true }),
      baseRow(),
      mintCtx({ recentMaxGapMinutes: 180 }),
      globalState({ coverageMode: 'relaxed' }),
      true,
      { knownMint: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_gap_in_recent_history'))).toBe(
      true,
    );
  });

  it('blocks full-mode pg gap for new mint', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageKnownMintGapBypass: true }),
      baseRow(),
      mintCtx({ maxGapMinutes: 180 }),
      globalState({ coverageMode: 'full' }),
      true,
      { knownMint: false },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_gap_in_history'))).toBe(true);
  });

  it('does not block buy when pgDataCoverageBlockBuy is false (default)', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageBlockBuy: false }),
      baseRow({ source: 'raydium' }),
      mintCtx({ sybilBaselineSamples: 11, sybilCoverageOk: false }),
      globalState({
        pgStaleNow: true,
        worstAgeSec: 1172,
        freshness: [
          { source: 'raydium', table: 'raydium_pair_snapshots', latestTs: null, ageSec: 1172, ok: false },
          { source: 'pumpswap', table: 'pumpswap_pair_snapshots', latestTs: new Date(), ageSec: 120, ok: true },
        ],
      }),
      true,
    );
    expect(r.blocked).toBe(false);
    expect(r.blockedReasons).toEqual([]);
    expect(r.features.sybilBaselineSamples).toBe(11);
    expect(r.features.nearEntry).toBe(true);
  });

  it('bypasses PG coverage blocks when fresh external market quote is available', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageBlockBuy: true, pgCoverageBirdeyeFreshBypass: true }),
      baseRow({ source: 'pumpswap' }),
      mintCtx({
        recentHoursWithData: 3,
        recentHourCoverageRatio: 0.5,
        sybilBaselineSamples: 12,
        sybilCoverageOk: false,
        recentMaxGapMinutes: 42,
      }),
      globalState({
        pgStaleNow: true,
        worstAgeSec: 1028,
        freshness: [
          { source: 'pumpswap', table: 'pumpswap_pair_snapshots', latestTs: null, ageSec: 1028, ok: false },
        ],
        coverageMode: 'relaxed',
      }),
      true,
      { freshExternalMarketQuote: true },
    );
    expect(r.blocked).toBe(false);
    expect(r.blockedReasons).toEqual([]);
    expect(r.features.birdeyeFreshBypass).toBe(true);
  });

  it('still blocks on PG coverage when external quote bypass is disabled', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageBlockBuy: true, pgCoverageBirdeyeFreshBypass: false }),
      baseRow({ source: 'pumpswap' }),
      mintCtx({ sybilBaselineSamples: 12, sybilCoverageOk: false }),
      globalState({ coverageMode: 'relaxed' }),
      true,
      { freshExternalMarketQuote: true },
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:sybil_pg_insufficient'))).toBe(true);
    expect(r.features.birdeyeFreshBypass).toBeFalsy();
  });
});

describe('isPgCoverageKnownMint', () => {
  const mint = 'KnownMint111111111111111111111111111111111';

  afterEach(() => {
    lastEntryTsByMintMap.delete(mint);
    lastPostExitBuyCooldownTsByMintMap.delete(mint);
  });

  it('returns false when bypass disabled', () => {
    lastEntryTsByMintMap.set(mint, Date.now());
    expect(isPgCoverageKnownMint(baseCfg(), mint)).toBe(false);
  });

  it('returns true for recent entry within lookback', () => {
    lastEntryTsByMintMap.set(mint, Date.now() - 3 * 24 * 3_600_000);
    expect(
      isPgCoverageKnownMint(baseCfg({ pgDataCoverageKnownMintGapBypass: true }), mint),
    ).toBe(true);
  });

  it('returns true for recent exit within lookback', () => {
    lastPostExitBuyCooldownTsByMintMap.set(mint, Date.now() - 5 * 24 * 3_600_000);
    expect(
      isPgCoverageKnownMint(baseCfg({ pgDataCoverageKnownMintGapBypass: true }), mint),
    ).toBe(true);
  });

  it('returns false when last trade older than lookback', () => {
    lastEntryTsByMintMap.set(mint, Date.now() - 20 * 24 * 3_600_000);
    expect(
      isPgCoverageKnownMint(
        baseCfg({ pgDataCoverageKnownMintGapBypass: true, pgDataCoverageKnownMintLookbackDays: 14 }),
        mint,
      ),
    ).toBe(false);
  });
});
