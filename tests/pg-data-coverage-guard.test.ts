import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import {
  evaluatePgDataCoverageGuard,
  type GlobalPgCoverageState,
  type MintPgCoverageFeatures,
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
    pgDataCoverageMinHourRatio: 0.5,
    pgDataCoverageStrictMinHourRatio: 0.75,
    pgDataCoverageMinSystemHourRatio: 0.7,
    pgDataCoverageMinMinutesPerHour: 45,
    pgDataCoverageMaxGapMinutes: 30,
    pgDataCoverageBlockOnPgStale: true,
    pgDataCoverageStrictAfterRecoveryHours: 24,
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
    systemHourRatio: 0.95,
    strictRecoveryActive: false,
    hoursSinceLastRecovery: null,
    lookbackHours: 24,
    ...over,
  };
}

function mintCtx(over: Partial<MintPgCoverageFeatures> = {}): MintPgCoverageFeatures {
  return {
    lookbackHours: 24,
    minuteSamples: 400,
    hoursWithData: 14,
    hourCoverageRatio: 14 / 24,
    maxGapMinutes: 5,
    sybilBaselineSamples: 40,
    sybilCoverageOk: true,
    ephemeralCoverageOk: true,
    nearEntry: true,
    ...over,
  };
}

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

  it('blocks when system hour ratio is low (global gap)', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx(),
      globalState({ systemHourRatio: 0.4 }),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:system_pg_hour_ratio'))).toBe(
      true,
    );
  });

  it('blocks when mint hour coverage is insufficient for ephemeral guard', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx({ hoursWithData: 3, hourCoverageRatio: 3 / 24 }),
      globalState(),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:ephemeral_pg_insufficient'))).toBe(
      true,
    );
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

  it('blocks when mint history has a large gap', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageMaxGapMinutes: 30 }),
      baseRow(),
      mintCtx({ maxGapMinutes: 180 }),
      globalState(),
      true,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons.some((x) => x.startsWith('data_coverage:pg_gap_in_mint_history'))).toBe(
      true,
    );
  });

  it('passes when coverage is sufficient', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg(),
      baseRow(),
      mintCtx(),
      globalState(),
      true,
    );
    expect(r.blocked).toBe(false);
  });

  it('uses stricter hour ratio during recovery window', () => {
    const r = evaluatePgDataCoverageGuard(
      baseCfg({ pgDataCoverageStrictMinHourRatio: 0.75 }),
      baseRow(),
      mintCtx({ hoursWithData: 14, hourCoverageRatio: 14 / 24 }),
      globalState({ strictRecoveryActive: true, hoursSinceLastRecovery: 2 }),
      true,
    );
    expect(r.blocked).toBe(true);
  });
});
