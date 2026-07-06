/**
 * Old-mint dormant volume spike guard.
 *
 * Blocks entries on long-lived mints where PG history shows a prolonged quiet baseline
 * followed by a sudden vol1h/vol5m explosion (e.g. DADDY 4Cnk9EPn: ~dead Jun 23–26,
 * then Jul 4 vol1h $2.1M vs median ~$7k — sybil guard exempted on high vol1h).
 *
 * Young pump mints (< maxYoungTokenAgeDays) are never blocked.
 * Missing PG baseline coverage => safe-skip.
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export interface OldMintDormantVolSpikeFeatures {
  lookbackHours: number;
  dormantLookbackHours: number;
  recentHours: number;
  tokenAgeDays: number | null;
  baselineHoursWithData: number;
  dormantHours: number;
  dormantHourFraction: number | null;
  baselineMedianVol1hUsd: number | null;
  baselineMedianVol5mUsd: number | null;
  baselineP90Vol1hUsd: number | null;
  recentMaxVol1hUsd: number | null;
  recentMaxVol5mUsd: number | null;
  currentVol1hUsd: number | null;
  currentVol5mUsd: number | null;
  effectiveRecentVol1hUsd: number | null;
  vol1hSpikeRatio: number | null;
  coverageOk: boolean;
}

export interface OldMintDormantVolSpikeEvalResult {
  blocked: boolean;
  blockedReasons: string[];
  features: OldMintDormantVolSpikeFeatures;
}

const EMPTY_FEATURES: OldMintDormantVolSpikeFeatures = {
  lookbackHours: 0,
  dormantLookbackHours: 0,
  recentHours: 0,
  tokenAgeDays: null,
  baselineHoursWithData: 0,
  dormantHours: 0,
  dormantHourFraction: null,
  baselineMedianVol1hUsd: null,
  baselineMedianVol5mUsd: null,
  baselineP90Vol1hUsd: null,
  recentMaxVol1hUsd: null,
  recentMaxVol5mUsd: null,
  currentVol1hUsd: null,
  currentVol5mUsd: null,
  effectiveRecentVol1hUsd: null,
  vol1hSpikeRatio: null,
  coverageOk: false,
};

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function clampHours(h: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(h)));
}

function posVol(v: unknown): number | null {
  const n = Number(v ?? 0);
  return n > 0 ? n : null;
}

function tokenAgeDaysFromRow(row: SnapshotCandidateRow): number | null {
  const ageMin = Number(row.token_age_min ?? row.age_min ?? 0);
  if (!Number.isFinite(ageMin) || ageMin <= 0) return null;
  return +(ageMin / 1440).toFixed(2);
}

/**
 * Batch-fetch dormant-baseline vs recent-spike metrics (one SQL per DEX table).
 */
export async function fetchOldMintDormantVolSpikeContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, OldMintDormantVolSpikeFeatures>> {
  const map = new Map<string, OldMintDormantVolSpikeFeatures>();
  if (!cfg.oldMintDormantVolSpikeGuardEnabled) return map;
  if (rows.length === 0) return map;

  const lookbackHours = clampHours(cfg.oldMintDormantVolSpikeLookbackHours, 48, 168);
  const dormantLookbackHours = clampHours(
    cfg.oldMintDormantVolSpikeDormantLookbackHours,
    24,
    lookbackHours - 6,
  );
  const recentHours = clampHours(cfg.oldMintDormantVolSpikeRecentHours, 3, 24);
  const dormantVol1hMax = cfg.oldMintDormantVolSpikeDormantVol1hMaxUsd;
  const dormantVol5mMax = cfg.oldMintDormantVolSpikeDormantVol5mMaxUsd;

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
      WITH hourly AS (
        SELECT
          base_mint AS mint,
          date_trunc('hour', ts) AS hour_bucket,
          MAX(COALESCE(volume_1h, 0))::float AS hour_max_vol1h,
          MAX(COALESCE(volume_5m, 0))::float AS hour_max_vol5m
        FROM ${table}
        WHERE ts >= now() - interval '${lookbackHours} hours'
          AND base_mint IN (${mintsSql})
        GROUP BY base_mint, date_trunc('hour', ts)
      )
      SELECT
        mint,
        COUNT(*) FILTER (
          WHERE hour_bucket >= date_trunc('hour', now()) - interval '${dormantLookbackHours} hours'
            AND hour_bucket < date_trunc('hour', now()) - interval '${recentHours} hours'
        )::int AS baseline_hours,
        COUNT(*) FILTER (
          WHERE hour_bucket >= date_trunc('hour', now()) - interval '${dormantLookbackHours} hours'
            AND hour_bucket < date_trunc('hour', now()) - interval '${recentHours} hours'
            AND hour_max_vol1h <= ${dormantVol1hMax}
            AND hour_max_vol5m <= ${dormantVol5mMax}
        )::int AS dormant_hours,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY hour_max_vol1h) FILTER (
          WHERE hour_bucket >= date_trunc('hour', now()) - interval '${dormantLookbackHours} hours'
            AND hour_bucket < date_trunc('hour', now()) - interval '${recentHours} hours'
        )::float AS baseline_median_vol1h,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY hour_max_vol5m) FILTER (
          WHERE hour_bucket >= date_trunc('hour', now()) - interval '${dormantLookbackHours} hours'
            AND hour_bucket < date_trunc('hour', now()) - interval '${recentHours} hours'
        )::float AS baseline_median_vol5m,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY hour_max_vol1h) FILTER (
          WHERE hour_bucket >= date_trunc('hour', now()) - interval '${dormantLookbackHours} hours'
            AND hour_bucket < date_trunc('hour', now()) - interval '${recentHours} hours'
        )::float AS baseline_p90_vol1h,
        MAX(hour_max_vol1h) FILTER (
          WHERE hour_bucket >= date_trunc('hour', now()) - interval '${recentHours} hours'
        )::float AS recent_max_vol1h,
        MAX(hour_max_vol5m) FILTER (
          WHERE hour_bucket >= date_trunc('hour', now()) - interval '${recentHours} hours'
        )::float AS recent_max_vol5m
      FROM hourly
      GROUP BY mint
    `));
    const out = r as unknown as Array<Record<string, unknown>>;
    for (const row of out) {
      const mint = String(row.mint ?? '');
      const baselineHours = Number(row.baseline_hours ?? 0) | 0;
      const dormantHours = Number(row.dormant_hours ?? 0) | 0;
      const dormantFrac = baselineHours > 0 ? +(dormantHours / baselineHours).toFixed(4) : null;
      map.set(mint, {
        lookbackHours,
        dormantLookbackHours,
        recentHours,
        tokenAgeDays: null,
        baselineHoursWithData: baselineHours,
        dormantHours,
        dormantHourFraction: dormantFrac,
        baselineMedianVol1hUsd: posVol(row.baseline_median_vol1h),
        baselineMedianVol5mUsd: posVol(row.baseline_median_vol5m),
        baselineP90Vol1hUsd: posVol(row.baseline_p90_vol1h),
        recentMaxVol1hUsd: posVol(row.recent_max_vol1h),
        recentMaxVol5mUsd: posVol(row.recent_max_vol5m),
        currentVol1hUsd: null,
        currentVol5mUsd: null,
        effectiveRecentVol1hUsd: null,
        vol1hSpikeRatio: null,
        coverageOk: baselineHours >= cfg.oldMintDormantVolSpikeMinBaselineHours,
      });
    }
  }
  return map;
}

/** Apply old-mint dormant volume spike rules to one candidate. */
export function evaluateOldMintDormantVolSpikeGuard(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: OldMintDormantVolSpikeFeatures,
): OldMintDormantVolSpikeEvalResult {
  if (!cfg.oldMintDormantVolSpikeGuardEnabled) {
    return { blocked: false, blockedReasons: [], features: EMPTY_FEATURES };
  }

  const tokenAgeDays = tokenAgeDaysFromRow(row);
  const maxYoungDays = cfg.oldMintDormantVolSpikeMaxYoungTokenAgeDays;
  if (tokenAgeDays != null && tokenAgeDays < maxYoungDays) {
    return {
      blocked: false,
      blockedReasons: [],
      features: { ...EMPTY_FEATURES, tokenAgeDays },
    };
  }

  const minOldDays = cfg.oldMintDormantVolSpikeMinTokenAgeDays;
  if (tokenAgeDays == null || tokenAgeDays < minOldDays) {
    return {
      blocked: false,
      blockedReasons: [],
      features: { ...(ctx ?? EMPTY_FEATURES), tokenAgeDays },
    };
  }

  const baseCtx = ctx ?? EMPTY_FEATURES;
  const currentVol1h = Number(row.volume_1h ?? 0) > 0 ? Number(row.volume_1h) : null;
  const currentVol5m = Number(row.volume_5m ?? 0) > 0 ? Number(row.volume_5m) : null;
  const recentMaxVol1h = baseCtx.recentMaxVol1hUsd;
  const effectiveRecentVol1h =
    currentVol1h != null || recentMaxVol1h != null
      ? Math.max(currentVol1h ?? 0, recentMaxVol1h ?? 0)
      : null;

  const baselineRef =
    baseCtx.baselineP90Vol1hUsd != null
      ? Math.max(baseCtx.baselineP90Vol1hUsd, 500)
      : baseCtx.baselineMedianVol1hUsd != null
        ? Math.max(baseCtx.baselineMedianVol1hUsd, 500)
        : null;

  const vol1hSpikeRatio =
    effectiveRecentVol1h != null && baselineRef != null && baselineRef > 0
      ? +(effectiveRecentVol1h / baselineRef).toFixed(2)
      : null;

  const features: OldMintDormantVolSpikeFeatures = {
    ...baseCtx,
    tokenAgeDays,
    currentVol1hUsd: currentVol1h,
    currentVol5mUsd: currentVol5m,
    effectiveRecentVol1hUsd: effectiveRecentVol1h,
    vol1hSpikeRatio,
  };

  const blockedReasons: string[] = [];
  if (!features.coverageOk) {
    return { blocked: false, blockedReasons, features };
  }

  const dormantFrac = features.dormantHourFraction ?? 0;
  const mostlyDormant = dormantFrac >= cfg.oldMintDormantVolSpikeMinDormantHourFraction;
  const lowBaseline =
    features.baselineMedianVol1hUsd != null &&
    features.baselineMedianVol1hUsd <= cfg.oldMintDormantVolSpikeDormantVol1hMaxUsd;
  const wasDormant = mostlyDormant && lowBaseline;

  const activeSpike =
    effectiveRecentVol1h != null &&
    effectiveRecentVol1h >= cfg.oldMintDormantVolSpikeMinSpikeVol1hUsd;
  const sharpSpike =
    vol1hSpikeRatio != null && vol1hSpikeRatio >= cfg.oldMintDormantVolSpikeVol1hRatioMin;

  if (wasDormant && activeSpike && sharpSpike) {
    blockedReasons.push(
      `old_mint_sudden_volume_spike:age=${tokenAgeDays}d_vol1h=$${Math.round(effectiveRecentVol1h ?? 0)}/baseline_p90=$${Math.round(features.baselineP90Vol1hUsd ?? features.baselineMedianVol1hUsd ?? 0)}=${vol1hSpikeRatio}x_dormant=${(dormantFrac * 100).toFixed(0)}%`,
    );
  }

  return { blocked: blockedReasons.length > 0, blockedReasons, features };
}
