import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluatePgDataCoverageGuard,
  type GlobalPgCoverageState,
  type MintPgCoverageFeatures,
  resolvePgCoverageRelaxedMode,
} from '../src/papertrader/discovery/pg-data-coverage-guard.js';
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
    pgDataCoverageStrictAfterRecoveryHours: 24,
    pgDataCoverageAutoEscalate: true,
    volumeSybilGuardEnabled: true,
    volumeSybilMinBaselineSamples: 25,
    volumeEphemeralGuardEnabled: true,
    volumeEphemeralMinHoursWithData: 2,
    ...over,
  } as PaperTraderConfig;
}

function globalState(over: Partial<GlobalPgCoverageState> = {}): GlobalPgCoverageState {
  return {
    pgStaleNow: false,
    worstAgeSec: 60,
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

  it('blocks when PG is stale now', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx(),
      globalState({ pgStaleNow: true, worstAgeSec: 900 }),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_stale_now'))).toBe(true);
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
});
