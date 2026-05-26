/**
 * Volume Sybil guard (1.11.216).
 *
 * Blocks entries on mints whose recent 5m volume spikes sharply from a long
 * "dead" baseline — typical wash/sybil liquidity burst pattern (dead → spike → dead).
 *
 * Lookback window (default 6h) excludes the recent window (default 45m). Baseline
 * "dead" requires low p10 AND high dead-fraction AND low p50 — not p10 alone (live
 * coins like MANIFEST have low p10 from quiet 5m buckets but high vol1h / median vol).
 * Spike via max recent vol5m vs baseline p10. High vol1h => alive market exempt.
 * Missing PG history => safe-skip (do not block), same as Policy A+.
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export interface VolumeSybilFeatures {
  lookbackHours: number;
  recentMinutes: number;
  baselineSampleCount: number;
  baselineDeadCount: number;
  baselineDeadFraction: number | null;
  baselineP10Vol5mUsd: number | null;
  baselineP50Vol5mUsd: number | null;
  recentMaxVol5mUsd: number | null;
  currentVol5mUsd: number | null;
  effectiveRecentVol5mUsd: number | null;
  spikeRatio: number | null;
  coverageOk: boolean;
}

export interface VolumeSybilEvalResult {
  blocked: boolean;
  blockedReasons: string[];
  features: VolumeSybilFeatures;
}

const EMPTY_FEATURES: VolumeSybilFeatures = {
  lookbackHours: 0,
  recentMinutes: 0,
  baselineSampleCount: 0,
  baselineDeadCount: 0,
  baselineDeadFraction: null,
  baselineP10Vol5mUsd: null,
  baselineP50Vol5mUsd: null,
  recentMaxVol5mUsd: null,
  currentVol5mUsd: null,
  effectiveRecentVol5mUsd: null,
  spikeRatio: null,
  coverageOk: false,
};

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function clampLookbackHours(h: number): number {
  return Math.max(3, Math.min(12, Math.round(h)));
}

function clampRecentMinutes(m: number, lookbackHours: number): number {
  const maxRecent = lookbackHours * 60 - 15;
  return Math.max(15, Math.min(maxRecent, Math.round(m)));
}

/**
 * Batch-fetch volume sybil metrics for all candidates (one SQL per DEX table).
 */
export async function fetchVolumeSybilContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, VolumeSybilFeatures>> {
  const map = new Map<string, VolumeSybilFeatures>();
  if (!cfg.volumeSybilGuardEnabled) return map;
  if (rows.length === 0) return map;

  const lookbackHours = clampLookbackHours(cfg.volumeSybilLookbackHours);
  const recentMinutes = clampRecentMinutes(cfg.volumeSybilRecentMinutes, lookbackHours);
  const deadThresh = cfg.volumeSybilDeadVol5mUsd;

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
      SELECT
        base_mint AS mint,
        COUNT(*) FILTER (
          WHERE ts >= now() - interval '${lookbackHours} hours'
            AND ts < now() - interval '${recentMinutes} minutes'
        )::int AS baseline_n,
        COUNT(*) FILTER (
          WHERE ts >= now() - interval '${lookbackHours} hours'
            AND ts < now() - interval '${recentMinutes} minutes'
            AND COALESCE(volume_5m, 0) <= ${deadThresh}
        )::int AS dead_n,
        PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY COALESCE(volume_5m, 0)) FILTER (
          WHERE ts >= now() - interval '${lookbackHours} hours'
            AND ts < now() - interval '${recentMinutes} minutes'
        )::float AS baseline_p10,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY COALESCE(volume_5m, 0)) FILTER (
          WHERE ts >= now() - interval '${lookbackHours} hours'
            AND ts < now() - interval '${recentMinutes} minutes'
        )::float AS baseline_p50,
        MAX(COALESCE(volume_5m, 0)) FILTER (
          WHERE ts >= now() - interval '${recentMinutes} minutes'
        )::float AS recent_max_vol5m
      FROM ${table}
      WHERE ts >= now() - interval '${lookbackHours} hours'
        AND base_mint IN (${mintsSql})
      GROUP BY base_mint
    `));
    const out = r as unknown as Array<Record<string, unknown>>;
    for (const row of out) {
      const mint = String(row.mint ?? '');
      const baselineN = Number(row.baseline_n ?? 0) | 0;
      const deadN = Number(row.dead_n ?? 0) | 0;
      const baselineP10 = Number(row.baseline_p10 ?? 0) > 0 ? Number(row.baseline_p10) : null;
      const baselineP50 = Number(row.baseline_p50 ?? 0) > 0 ? Number(row.baseline_p50) : null;
      const recentMax =
        Number(row.recent_max_vol5m ?? 0) > 0 ? Number(row.recent_max_vol5m) : null;
      const deadFrac = baselineN > 0 ? +(deadN / baselineN).toFixed(4) : null;
      map.set(mint, {
        lookbackHours,
        recentMinutes,
        baselineSampleCount: baselineN,
        baselineDeadCount: deadN,
        baselineDeadFraction: deadFrac,
        baselineP10Vol5mUsd: baselineP10,
        baselineP50Vol5mUsd: baselineP50,
        recentMaxVol5mUsd: recentMax,
        currentVol5mUsd: null,
        effectiveRecentVol5mUsd: null,
        spikeRatio: null,
        coverageOk: baselineN >= cfg.volumeSybilMinBaselineSamples,
      });
    }
  }
  return map;
}

/** Apply volume sybil rules to one candidate; fills spike ratio from row + PG context. */
export function evaluateVolumeSybilGuard(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: VolumeSybilFeatures,
): VolumeSybilEvalResult {
  const lookbackHours = clampLookbackHours(cfg.volumeSybilLookbackHours);
  const recentMinutes = clampRecentMinutes(cfg.volumeSybilRecentMinutes, lookbackHours);

  if (!cfg.volumeSybilGuardEnabled) {
    return { blocked: false, blockedReasons: [], features: EMPTY_FEATURES };
  }

  const baseCtx = ctx ?? EMPTY_FEATURES;
  const currentVol5m = Number(row.volume_5m ?? 0) > 0 ? Number(row.volume_5m) : null;
  const recentMax = baseCtx.recentMaxVol5mUsd;
  const effectiveRecent =
    currentVol5m != null || recentMax != null
      ? Math.max(currentVol5m ?? 0, recentMax ?? 0)
      : null;

  const baselineP10 = baseCtx.baselineP10Vol5mUsd;
  const baselineFloor = baselineP10 != null ? Math.max(baselineP10, 100) : null;
  const spikeRatio =
    effectiveRecent != null && baselineFloor != null && baselineFloor > 0
      ? +(effectiveRecent / baselineFloor).toFixed(2)
      : null;

  const features: VolumeSybilFeatures = {
    ...baseCtx,
    lookbackHours,
    recentMinutes,
    currentVol5mUsd: currentVol5m,
    effectiveRecentVol5mUsd: effectiveRecent,
    spikeRatio,
  };

  const blockedReasons: string[] = [];
  if (!features.coverageOk) {
    return { blocked: false, blockedReasons, features };
  }
  if (baselineP10 == null || effectiveRecent == null || spikeRatio == null) {
    return { blocked: false, blockedReasons, features };
  }

  const vol1h = Number(row.volume_1h ?? 0);
  if (Number.isFinite(vol1h) && vol1h >= cfg.volumeSybilVol1hAliveExemptUsd) {
    return { blocked: false, blockedReasons, features };
  }

  const deadFrac = baseCtx.baselineDeadFraction ?? 0;
  const baselineP50 = baseCtx.baselineP50Vol5mUsd;
  const lowP10 = baselineP10 <= cfg.volumeSybilBaselineP10MaxUsd;
  const mostlyDead = deadFrac >= cfg.volumeSybilMinDeadFraction;
  const lowMedian =
    baselineP50 != null && baselineP50 <= cfg.volumeSybilDeadVol5mUsd;
  const quietBaseline = lowP10 && mostlyDead && lowMedian;
  const activeSpike = effectiveRecent >= cfg.volumeSybilMinRecentVol5mUsd;
  const sharpSpike = spikeRatio >= cfg.volumeSybilSpikeRatioMin;

  if (quietBaseline && activeSpike && sharpSpike) {
    blockedReasons.push(
      `volume_sybil:recent=$${Math.round(effectiveRecent)}/p10=$${Math.round(baselineP10)}=${spikeRatio}x>=${cfg.volumeSybilSpikeRatioMin}x`,
    );
  }

  return { blocked: blockedReasons.length > 0, blockedReasons, features };
}
