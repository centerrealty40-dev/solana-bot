/**
 * PG data coverage guard (1.11.222).
 *
 * When minute-bar history in PG is incomplete (gaps, thin coverage, live stale),
 * volume guards cannot reliably detect sybil/ephemeral patterns — safe-skip would
 * let entries through. This guard blocks and surfaces ADVICE in Telegram instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import {
  DEX_PAIR_SNAPSHOT_TABLES,
  fetchDexSnapshotFreshness,
  snapshotMaxAgeSecFromEnv,
} from '../../ingestion/pair-snapshot-freshness.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export interface GlobalPgCoverageState {
  pgStaleNow: boolean;
  worstAgeSec: number | null;
  systemHourRatio: number | null;
  strictRecoveryActive: boolean;
  hoursSinceLastRecovery: number | null;
  lookbackHours: number;
}

export interface MintPgCoverageFeatures {
  lookbackHours: number;
  minuteSamples: number;
  hoursWithData: number;
  hourCoverageRatio: number | null;
  maxGapMinutes: number | null;
  sybilBaselineSamples: number;
  sybilCoverageOk: boolean;
  ephemeralCoverageOk: boolean;
  nearEntry: boolean;
}

export interface PgDataCoverageEvalResult {
  blocked: boolean;
  blockedReasons: string[];
  features: MintPgCoverageFeatures;
}

const EMPTY_MINT: MintPgCoverageFeatures = {
  lookbackHours: 0,
  minuteSamples: 0,
  hoursWithData: 0,
  hourCoverageRatio: null,
  maxGapMinutes: null,
  sybilBaselineSamples: 0,
  sybilCoverageOk: false,
  ephemeralCoverageOk: false,
  nearEntry: false,
};

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function clampLookbackHours(h: number): number {
  return Math.max(6, Math.min(48, Math.round(h)));
}

function snapshotGapStatePath(): string {
  return (
    process.env.SNAPSHOT_FRESHNESS_STATE_PATH?.trim() ||
    path.join('data', 'snapshot-freshness-watch-state.json')
  );
}

/** Hours since last PG snapshot recovery (null if unknown / never stale). */
export function readHoursSinceSnapshotRecovery(): number | null {
  try {
    const raw = fs.readFileSync(snapshotGapStatePath(), 'utf8');
    const st = JSON.parse(raw) as { lastRecoveryAt?: number };
    if (st.lastRecoveryAt != null && Number.isFinite(st.lastRecoveryAt)) {
      return (Date.now() - st.lastRecoveryAt) / 3_600_000;
    }
  } catch {
    /* no state file */
  }
  return null;
}

function effectiveMinHourRatio(cfg: PaperTraderConfig, strictRecoveryActive: boolean): number {
  if (!strictRecoveryActive) return cfg.pgDataCoverageMinHourRatio;
  return Math.max(cfg.pgDataCoverageMinHourRatio, cfg.pgDataCoverageStrictMinHourRatio);
}

/** Once per discovery tick — global PG health for coverage decisions. */
export async function fetchGlobalPgCoverageState(cfg: PaperTraderConfig): Promise<GlobalPgCoverageState> {
  const lookbackHours = clampLookbackHours(cfg.pgDataCoverageLookbackHours);
  const maxAgeSec = snapshotMaxAgeSecFromEnv();
  const freshness = await fetchDexSnapshotFreshness(maxAgeSec);
  const pgStaleNow = freshness.some((r) => !r.ok);
  let worstAgeSec: number | null = null;
  for (const r of freshness) {
    if (r.ageSec == null || !Number.isFinite(r.ageSec)) {
      worstAgeSec = null;
      break;
    }
    if (worstAgeSec == null || r.ageSec > worstAgeSec) worstAgeSec = r.ageSec;
  }

  let systemHourRatio: number | null = null;
  if (cfg.pgDataCoverageGuardEnabled) {
    const minMinutesPerHour = Math.max(1, cfg.pgDataCoverageMinMinutesPerHour);
    const ratios: number[] = [];
    for (const { table } of DEX_PAIR_SNAPSHOT_TABLES) {
      try {
        const r = await db.execute(dsql.raw(`
          WITH hourly AS (
            SELECT
              date_trunc('hour', ts) AS h,
              COUNT(DISTINCT date_trunc('minute', ts))::int AS minute_count
            FROM ${table}
            WHERE ts >= now() - interval '${lookbackHours} hours'
            GROUP BY 1
          )
          SELECT
            COUNT(*) FILTER (WHERE minute_count >= ${minMinutesPerHour})::float
              / NULLIF(COUNT(*)::float, 0) AS hour_ratio
          FROM hourly
        `));
        const row = (r as unknown as Array<{ hour_ratio: number | null }>)[0];
        if (row?.hour_ratio != null && Number.isFinite(Number(row.hour_ratio))) {
          ratios.push(Number(row.hour_ratio));
        }
      } catch {
        /* skip table */
      }
    }
    if (ratios.length > 0) {
      systemHourRatio = Math.min(...ratios);
    }
  }

  const hoursSinceLastRecovery = readHoursSinceSnapshotRecovery();
  const strictRecoveryActive =
    hoursSinceLastRecovery != null &&
    hoursSinceLastRecovery >= 0 &&
    hoursSinceLastRecovery < cfg.pgDataCoverageStrictAfterRecoveryHours;

  return {
    pgStaleNow,
    worstAgeSec,
    systemHourRatio,
    strictRecoveryActive,
    hoursSinceLastRecovery,
    lookbackHours,
  };
}

/**
 * Batch-fetch per-mint PG coverage (one SQL per DEX table).
 */
export async function fetchMintPgCoverageMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
  global: GlobalPgCoverageState,
): Promise<Map<string, MintPgCoverageFeatures>> {
  const map = new Map<string, MintPgCoverageFeatures>();
  if (!cfg.pgDataCoverageGuardEnabled || rows.length === 0) return map;

  const lookbackHours = global.lookbackHours;
  const sybilLookback = Math.max(3, Math.min(12, Math.round(cfg.volumeSybilLookbackHours)));
  const sybilRecent = Math.max(15, Math.min(sybilLookback * 60 - 15, Math.round(cfg.volumeSybilRecentMinutes)));

  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const t = sourceSnapshotTable(r.source);
    if (!t) continue;
    const arr = byTable.get(t) ?? [];
    arr.push(r.mint);
    byTable.set(t, arr);
  }

  for (const [table, mintsRaw] of byTable.entries()) {
    const uniq = [...new Set(mintsRaw)];
    if (uniq.length === 0) continue;
    const mintsSql = uniq.map(sqlQuote).join(',');

    const r = await db.execute(dsql.raw(`
      WITH scoped AS (
        SELECT base_mint AS mint, ts
        FROM ${table}
        WHERE ts >= now() - interval '${lookbackHours} hours'
          AND base_mint IN (${mintsSql})
      ),
      gaps AS (
        SELECT
          mint,
          ts,
          LAG(ts) OVER (PARTITION BY mint ORDER BY ts) AS prev_ts
        FROM scoped
      ),
      agg AS (
        SELECT
          mint,
          COUNT(*)::int AS minute_samples,
          COUNT(DISTINCT date_trunc('hour', ts))::int AS hours_with_data,
          MAX(
            CASE
              WHEN prev_ts IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (ts - prev_ts)) / 60.0
            END
          )::float AS max_gap_minutes
        FROM gaps
        GROUP BY mint
      ),
      sybil AS (
        SELECT
          base_mint AS mint,
          COUNT(*) FILTER (
            WHERE ts >= now() - interval '${sybilLookback} hours'
              AND ts < now() - interval '${sybilRecent} minutes'
          )::int AS baseline_n
        FROM ${table}
        WHERE ts >= now() - interval '${sybilLookback} hours'
          AND base_mint IN (${mintsSql})
        GROUP BY base_mint
      )
      SELECT
        a.mint,
        a.minute_samples,
        a.hours_with_data,
        a.max_gap_minutes,
        COALESCE(s.baseline_n, 0)::int AS sybil_baseline_samples
      FROM agg a
      LEFT JOIN sybil s ON s.mint = a.mint
    `));

    const out = r as unknown as Array<Record<string, unknown>>;
    for (const row of out) {
      const mint = String(row.mint ?? '');
      const hoursWithData = Number(row.hours_with_data ?? 0) | 0;
      const minuteSamples = Number(row.minute_samples ?? 0) | 0;
      const maxGap =
        row.max_gap_minutes != null && Number(row.max_gap_minutes) > 0
          ? Number(row.max_gap_minutes)
          : null;
      const sybilBaselineSamples = Number(row.sybil_baseline_samples ?? 0) | 0;
      const hourCoverageRatio =
        lookbackHours > 0 ? +(hoursWithData / lookbackHours).toFixed(4) : null;

      const sybilCoverageOk =
        !cfg.volumeSybilGuardEnabled ||
        sybilBaselineSamples >= cfg.volumeSybilMinBaselineSamples;
      const ephemeralCoverageOk =
        !cfg.volumeEphemeralGuardEnabled ||
        hoursWithData >= cfg.volumeEphemeralMinHoursWithData;

      map.set(mint, {
        lookbackHours,
        minuteSamples,
        hoursWithData,
        hourCoverageRatio,
        maxGapMinutes: maxGap,
        sybilBaselineSamples,
        sybilCoverageOk,
        ephemeralCoverageOk,
        nearEntry: false,
      });
    }
  }
  return map;
}

/** Block entry when PG history is too thin or gapped to trust volume guards. */
export function evaluatePgDataCoverageGuard(
  cfg: PaperTraderConfig,
  _row: SnapshotCandidateRow,
  ctx: MintPgCoverageFeatures | undefined,
  global: GlobalPgCoverageState,
  nearEntry: boolean,
): PgDataCoverageEvalResult {
  if (!cfg.pgDataCoverageGuardEnabled) {
    return { blocked: false, blockedReasons: [], features: EMPTY_MINT };
  }

  const features: MintPgCoverageFeatures = {
    ...(ctx ?? EMPTY_MINT),
    lookbackHours: global.lookbackHours,
    nearEntry,
  };

  const blockedReasons: string[] = [];
  const minHourRatio = effectiveMinHourRatio(cfg, global.strictRecoveryActive);

  if (cfg.pgDataCoverageBlockOnPgStale && global.pgStaleNow) {
    blockedReasons.push(
      `data_coverage:pg_stale_now_worst_age_sec=${global.worstAgeSec ?? 'null'}`,
    );
  }

  if (
    global.systemHourRatio != null &&
    global.systemHourRatio < cfg.pgDataCoverageMinSystemHourRatio
  ) {
    blockedReasons.push(
      `data_coverage:system_pg_hour_ratio=${(global.systemHourRatio * 100).toFixed(0)}%<${(cfg.pgDataCoverageMinSystemHourRatio * 100).toFixed(0)}%`,
    );
  }

  const mintCtx = ctx;
  if (mintCtx == null || mintCtx.minuteSamples <= 0) {
    if (cfg.volumeSybilGuardEnabled || cfg.volumeEphemeralGuardEnabled) {
      blockedReasons.push('data_coverage:no_pg_history_for_mint');
    }
  } else {
    const hourRatio = mintCtx.hourCoverageRatio ?? 0;
    if (
      cfg.volumeEphemeralGuardEnabled &&
      (mintCtx.hoursWithData < cfg.volumeEphemeralMinHoursWithData ||
        hourRatio < minHourRatio)
    ) {
      blockedReasons.push(
        `data_coverage:ephemeral_pg_insufficient=${mintCtx.hoursWithData}h/${global.lookbackHours}h_ratio=${(hourRatio * 100).toFixed(0)}%<${(minHourRatio * 100).toFixed(0)}%`,
      );
    }

    if (cfg.volumeSybilGuardEnabled && !mintCtx.sybilCoverageOk) {
      const need = cfg.volumeSybilMinBaselineSamples;
      blockedReasons.push(
        `data_coverage:sybil_pg_insufficient_samples=${mintCtx.sybilBaselineSamples}/${need}`,
      );
    }

    if (
      mintCtx.maxGapMinutes != null &&
      mintCtx.maxGapMinutes > cfg.pgDataCoverageMaxGapMinutes
    ) {
      blockedReasons.push(
        `data_coverage:pg_gap_in_mint_history=${Math.round(mintCtx.maxGapMinutes)}m>${cfg.pgDataCoverageMaxGapMinutes}m`,
      );
    }
  }

  return {
    blocked: blockedReasons.length > 0,
    blockedReasons,
    features,
  };
}
