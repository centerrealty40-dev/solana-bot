/**
 * Trend structure veto (1.11.249) — blocks entry on «протухшие раннеры» / slow bleed.
 *
 * Two independent rules (each toggleable):
 *  1. No high break: last touch within tolerance of lookback peak was ≥ N days ago.
 *  2. Structural decline: price_now / high_lookback < X AND 7d price slope ≤ Y%.
 *
 * PG history from the candidate's source snapshot table (same as Policy A+).
 * Missing coverage → safe pass (do not block on sparse data).
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export interface TrendStructureFeatures {
  lookbackDays: number;
  highLookbackUsd: number | null;
  daysSinceHighBreak: number | null;
  price7dAgoUsd: number | null;
  price3dAgoUsd: number | null;
  slope7dPct: number | null;
  slope3dPct: number | null;
  pxVsHighLookback: number | null;
  /** Recent crash low within ski-slope reversal lookback (PG). */
  localLowLookbackUsd: number | null;
  /** Hours since `localLowLookbackUsd` was printed. */
  hoursSinceLocalLow: number | null;
  pgSnapsCount: number;
  coverageOk: boolean;
}

export type TrendStructureVetoResult = {
  reasons: string[];
  features: TrendStructureFeatures;
};

const EMPTY_FEATURES: TrendStructureFeatures = {
  lookbackDays: 14,
  highLookbackUsd: null,
  daysSinceHighBreak: null,
  price7dAgoUsd: null,
  price3dAgoUsd: null,
  slope7dPct: null,
  slope3dPct: null,
  pxVsHighLookback: null,
  localLowLookbackUsd: null,
  hoursSinceLocalLow: null,
  pgSnapsCount: 0,
  coverageOk: false,
};

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function emptyFeatures(cfg: PaperTraderConfig): TrendStructureFeatures {
  return { ...EMPTY_FEATURES, lookbackDays: cfg.trendVetoLookbackDays };
}

type TrendStructureVetoCfg = Pick<
  PaperTraderConfig,
  | 'trendVetoNoHighBreakEnabled'
  | 'trendVetoMinDaysSinceHighBreak'
  | 'trendVetoDeclineEnabled'
  | 'trendVetoMaxPxVsHigh14d'
  | 'trendVetoMaxSlope7dPct'
  | 'trendVetoSlope3dEnabled'
  | 'trendVetoMaxPxVsHigh3d'
  | 'trendVetoMaxSlope3dPct'
  | 'trendVetoSkiSlopeEnabled'
  | 'trendVetoSkiSlopeMaxPxVsHigh'
  | 'trendVetoSkiSlopeMinDaysSinceHigh'
  | 'trendVetoSkiSlopeReversalBypassEnabled'
  | 'trendVetoSkiSlopeReversalLookbackHours'
  | 'trendVetoSkiSlopeReversalMinBouncePct'
  | 'trendVetoSkiSlopeReversalMinHoursAfterLow'
  | 'trendVetoLookbackDays'
>;

/** Post-crash reversal: bleed ended, price holds above recent local low (febu-class base). */
export function skiSlopeReversalBypassActive(
  cfg: PaperTraderConfig,
  features: Pick<TrendStructureFeatures, 'localLowLookbackUsd' | 'hoursSinceLocalLow'>,
  snapshotPriceUsd: number,
): boolean {
  if (!cfg.trendVetoSkiSlopeReversalBypassEnabled) return false;
  const low = features.localLowLookbackUsd;
  const ageH = features.hoursSinceLocalLow;
  if (!(low != null && low > 0) || !(ageH != null && ageH >= 0) || !(snapshotPriceUsd > 0)) {
    return false;
  }
  if (ageH + 1e-9 < cfg.trendVetoSkiSlopeReversalMinHoursAfterLow) return false;
  const bouncePct = ((snapshotPriceUsd - low) / low) * 100;
  return bouncePct + 1e-9 >= cfg.trendVetoSkiSlopeReversalMinBouncePct;
}

/** Apply veto rules to pre-fetched features + current price. */
export function evaluateTrendStructureVeto(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: TrendStructureFeatures,
): TrendStructureVetoResult {
  const features: TrendStructureFeatures = ctx ?? emptyFeatures(cfg);
  const px = Number(row.price_usd ?? 0);
  if (features.highLookbackUsd != null && features.highLookbackUsd > 0 && px > 0) {
    features.pxVsHighLookback = +(px / features.highLookbackUsd).toFixed(4);
  }
  if (features.price7dAgoUsd != null && features.price7dAgoUsd > 0 && px > 0) {
    features.slope7dPct = +(((px - features.price7dAgoUsd) / features.price7dAgoUsd) * 100).toFixed(3);
  }
  if (features.price3dAgoUsd != null && features.price3dAgoUsd > 0 && px > 0) {
    features.slope3dPct = +(((px - features.price3dAgoUsd) / features.price3dAgoUsd) * 100).toFixed(3);
  }

  if (!cfg.trendStructureVetoEnabled) {
    return { reasons: [], features };
  }
  if (!features.coverageOk) {
    return { reasons: [], features };
  }

  const reasons: string[] = [];
  const v: TrendStructureVetoCfg = cfg;

  if (
    v.trendVetoNoHighBreakEnabled &&
    features.daysSinceHighBreak != null &&
    features.daysSinceHighBreak + 1e-9 >= v.trendVetoMinDaysSinceHighBreak
  ) {
    reasons.push(
      `trend_veto_no_high_break_${features.daysSinceHighBreak.toFixed(1)}d>=${v.trendVetoMinDaysSinceHighBreak}d`,
    );
  }

  if (v.trendVetoSkiSlopeEnabled) {
    const ratioOk =
      features.pxVsHighLookback != null &&
      features.pxVsHighLookback < v.trendVetoSkiSlopeMaxPxVsHigh;
    const ageOk =
      features.daysSinceHighBreak != null &&
      features.daysSinceHighBreak + 1e-9 >= v.trendVetoSkiSlopeMinDaysSinceHigh;
    const reversalBypass = skiSlopeReversalBypassActive(cfg, features, px);
    if (ratioOk && ageOk && !reversalBypass) {
      reasons.push(
        `trend_veto_ski_slope_pxVs${v.trendVetoLookbackDays}d=${(features.pxVsHighLookback! * 100).toFixed(1)}%<${(v.trendVetoSkiSlopeMaxPxVsHigh * 100).toFixed(0)}%_sinceHigh=${features.daysSinceHighBreak!.toFixed(1)}d`,
      );
    }
  }

  if (v.trendVetoDeclineEnabled) {
    const ratioOk =
      features.pxVsHighLookback != null && features.pxVsHighLookback < v.trendVetoMaxPxVsHigh14d;
    const slope7Ok =
      features.slope7dPct != null && features.slope7dPct <= v.trendVetoMaxSlope7dPct;
    const slope3Ok =
      v.trendVetoSlope3dEnabled &&
      features.slope3dPct != null &&
      features.slope3dPct <= v.trendVetoMaxSlope3dPct &&
      features.pxVsHighLookback != null &&
      features.pxVsHighLookback < v.trendVetoMaxPxVsHigh3d;
    if (ratioOk && slope7Ok) {
      reasons.push(
        `trend_veto_decline_pxVs${v.trendVetoLookbackDays}d=${(features.pxVsHighLookback! * 100).toFixed(1)}%<${(v.trendVetoMaxPxVsHigh14d * 100).toFixed(0)}%_slope7d=${features.slope7dPct!.toFixed(1)}%<=${v.trendVetoMaxSlope7dPct}%`,
      );
    } else if (slope3Ok) {
      reasons.push(
        `trend_veto_decline3d_pxVs${v.trendVetoLookbackDays}d=${(features.pxVsHighLookback! * 100).toFixed(1)}%_slope3d=${features.slope3dPct!.toFixed(1)}%<=${v.trendVetoMaxSlope3dPct}%`,
      );
    }
  }

  return { reasons, features };
}

interface TrendAggRow {
  mint: string;
  high_lookback: number | null;
  days_since_high: number | null;
  price_7d_ago: number | null;
  price_3d_ago: number | null;
  local_low_lookback: number | null;
  hours_since_local_low: number | null;
  snaps_count: number | null;
}

function mapAggRow(cfg: PaperTraderConfig, row: TrendAggRow): TrendStructureFeatures {
  const snaps = Number(row.snaps_count ?? 0) | 0;
  const high = Number(row.high_lookback ?? 0);
  return {
    lookbackDays: cfg.trendVetoLookbackDays,
    highLookbackUsd: high > 0 ? high : null,
    daysSinceHighBreak:
      row.days_since_high != null && Number.isFinite(Number(row.days_since_high))
        ? +Number(row.days_since_high).toFixed(3)
        : null,
    price7dAgoUsd: Number(row.price_7d_ago ?? 0) > 0 ? Number(row.price_7d_ago) : null,
    price3dAgoUsd: Number(row.price_3d_ago ?? 0) > 0 ? Number(row.price_3d_ago) : null,
    slope7dPct: null,
    slope3dPct: null,
    pxVsHighLookback: null,
    localLowLookbackUsd:
      row.local_low_lookback != null && Number(row.local_low_lookback) > 0
        ? Number(row.local_low_lookback)
        : null,
    hoursSinceLocalLow:
      row.hours_since_local_low != null && Number.isFinite(Number(row.hours_since_local_low))
        ? +Number(row.hours_since_local_low).toFixed(3)
        : null,
    pgSnapsCount: snaps,
    coverageOk: snaps >= cfg.trendVetoMinPgSamples,
  };
}

function trendStructureSql(
  table: string,
  mintsSql: string,
  refEpochSec: number,
  lookbackDays: number,
  peakTouchTolFrac: number,
  reversalLookbackHours: number,
): string {
  const tol = peakTouchTolFrac.toFixed(6);
  const revH = Math.max(12, Math.floor(reversalLookbackHours));
  return `
    WITH bars AS (
      SELECT base_mint AS mint, ts, COALESCE(price_usd, 0)::float AS px
        FROM ${table}
       WHERE base_mint IN (${mintsSql})
         AND ts <= to_timestamp(${refEpochSec})
         AND ts >= to_timestamp(${refEpochSec}) - interval '${lookbackDays} days'
         AND COALESCE(price_usd, 0) > 0
    ),
    per_mint AS (
      SELECT
        mint,
        MAX(px)::float AS high_lookback,
        COUNT(*)::int AS snaps_count,
        AVG(px) FILTER (
          WHERE ts >= to_timestamp(${refEpochSec}) - interval '7 days 2 hours'
            AND ts <= to_timestamp(${refEpochSec}) - interval '6 days 22 hours'
        )::float AS price_7d_ago,
        AVG(px) FILTER (
          WHERE ts >= to_timestamp(${refEpochSec}) - interval '3 days 2 hours'
            AND ts <= to_timestamp(${refEpochSec}) - interval '2 days 22 hours'
        )::float AS price_3d_ago
      FROM bars
      GROUP BY mint
    ),
    last_peak AS (
      SELECT b.mint, MAX(b.ts) AS ts_last_peak
        FROM bars b
        INNER JOIN per_mint p ON p.mint = b.mint
       WHERE b.px >= p.high_lookback * (1.0 - ${tol})
       GROUP BY b.mint
    ),
    local_low AS (
      SELECT DISTINCT ON (b.mint)
        b.mint,
        b.px AS local_low_lookback,
        EXTRACT(EPOCH FROM (to_timestamp(${refEpochSec}) - b.ts)) / 3600.0 AS hours_since_local_low
        FROM bars b
       WHERE b.ts >= to_timestamp(${refEpochSec}) - interval '${revH} hours'
       ORDER BY b.mint, b.px ASC, b.ts DESC
    )
    SELECT
      p.mint,
      p.high_lookback,
      p.snaps_count,
      p.price_7d_ago,
      p.price_3d_ago,
      ll.local_low_lookback,
      ll.hours_since_local_low,
      EXTRACT(EPOCH FROM (to_timestamp(${refEpochSec}) - lp.ts_last_peak)) / 86400.0 AS days_since_high
    FROM per_mint p
    LEFT JOIN last_peak lp ON lp.mint = p.mint
    LEFT JOIN local_low ll ON ll.mint = p.mint
  `;
}

/** Live discovery batch fetch (reference time = now). */
export async function fetchTrendStructureContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, TrendStructureFeatures>> {
  const map = new Map<string, TrendStructureFeatures>();
  if (!cfg.trendStructureVetoEnabled) return map;
  if (rows.length === 0) return map;

  const refEpochSec = Math.floor(Date.now() / 1000);
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
    const sqlText = trendStructureSql(
      table,
      mintsSql,
      refEpochSec,
      cfg.trendVetoLookbackDays,
      cfg.trendVetoPeakTouchTolerancePct / 100,
      cfg.trendVetoSkiSlopeReversalLookbackHours,
    );
    const r = (await db.execute(dsql.raw(sqlText))) as unknown as TrendAggRow[];
    for (const row of r) {
      map.set(String(row.mint), mapAggRow(cfg, row));
    }
  }
  return map;
}

/** Point-in-time fetch for backtests (one mint per call or small batch at same ts). */
export async function fetchTrendStructureContextAtTs(
  cfg: PaperTraderConfig,
  mint: string,
  source: string,
  refTsMs: number,
): Promise<TrendStructureFeatures> {
  const table = sourceSnapshotTable(source);
  if (!table) return emptyFeatures(cfg);
  const refEpochSec = Math.floor(refTsMs / 1000);
  const mintsSql = sqlQuote(mint);
  const sqlText = trendStructureSql(
    table,
    mintsSql,
    refEpochSec,
    cfg.trendVetoLookbackDays,
    cfg.trendVetoPeakTouchTolerancePct / 100,
    cfg.trendVetoSkiSlopeReversalLookbackHours,
  );
  const r = (await db.execute(dsql.raw(sqlText))) as unknown as TrendAggRow[];
  const row = r[0];
  if (!row) return emptyFeatures(cfg);
  return mapAggRow(cfg, row);
}
