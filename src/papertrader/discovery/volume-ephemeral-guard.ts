/**
 * Volume Ephemeral guard (1.11.219).
 *
 * Blocks entries when trading volume is concentrated in a narrow hourly window
 * within the lookback (typical one-shot wash / sybil burst — e.g. GOAT: 3 active
 * hours in 24h, peak vol5m $432k, otherwise dead).
 *
 * Uses hourly MAX(volume_5m) from PG pair snapshots. Missing PG history => safe-skip.
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export interface VolumeEphemeralFeatures {
  lookbackHours: number;
  hoursWithData: number;
  activeHours: number;
  peakHourVol5mUsd: number | null;
  currentVol5mUsd: number | null;
  peakToCurrentRatio: number | null;
  coverageOk: boolean;
}

export interface VolumeEphemeralEvalResult {
  blocked: boolean;
  blockedReasons: string[];
  features: VolumeEphemeralFeatures;
}

const EMPTY_FEATURES: VolumeEphemeralFeatures = {
  lookbackHours: 0,
  hoursWithData: 0,
  activeHours: 0,
  peakHourVol5mUsd: null,
  currentVol5mUsd: null,
  peakToCurrentRatio: null,
  coverageOk: false,
};

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function clampLookbackHours(h: number): number {
  return Math.max(12, Math.min(48, Math.round(h)));
}

/**
 * Batch-fetch hourly volume concentration metrics (one SQL per DEX table).
 */
export async function fetchVolumeEphemeralContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, VolumeEphemeralFeatures>> {
  const map = new Map<string, VolumeEphemeralFeatures>();
  if (!cfg.volumeEphemeralGuardEnabled) return map;
  if (rows.length === 0) return map;

  const lookbackHours = clampLookbackHours(cfg.volumeEphemeralLookbackHours);
  const activeThresh = cfg.volumeEphemeralMinActiveHourVol5mUsd;

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
          MAX(COALESCE(volume_5m, 0))::float AS hour_max_vol5m
        FROM ${table}
        WHERE ts >= now() - interval '${lookbackHours} hours'
          AND base_mint IN (${mintsSql})
        GROUP BY base_mint, date_trunc('hour', ts)
      )
      SELECT
        mint,
        COUNT(*)::int AS hours_with_data,
        COUNT(*) FILTER (WHERE hour_max_vol5m >= ${activeThresh})::int AS active_hours,
        MAX(hour_max_vol5m)::float AS peak_hour_vol5m
      FROM hourly
      GROUP BY mint
    `));
    const out = r as unknown as Array<Record<string, unknown>>;
    for (const row of out) {
      const mint = String(row.mint ?? '');
      const hoursWithData = Number(row.hours_with_data ?? 0) | 0;
      const activeHours = Number(row.active_hours ?? 0) | 0;
      const peak =
        Number(row.peak_hour_vol5m ?? 0) > 0 ? Number(row.peak_hour_vol5m) : null;
      map.set(mint, {
        lookbackHours,
        hoursWithData,
        activeHours,
        peakHourVol5mUsd: peak,
        currentVol5mUsd: null,
        peakToCurrentRatio: null,
        coverageOk: hoursWithData >= cfg.volumeEphemeralMinHoursWithData,
      });
    }
  }
  return map;
}

/** Apply ephemeral-volume rules to one candidate. */
export function evaluateVolumeEphemeralGuard(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: VolumeEphemeralFeatures,
): VolumeEphemeralEvalResult {
  const lookbackHours = clampLookbackHours(cfg.volumeEphemeralLookbackHours);

  if (!cfg.volumeEphemeralGuardEnabled) {
    return { blocked: false, blockedReasons: [], features: EMPTY_FEATURES };
  }

  const baseCtx = ctx ?? EMPTY_FEATURES;
  const currentVol5m = Number(row.volume_5m ?? 0) > 0 ? Number(row.volume_5m) : null;
  const peak = baseCtx.peakHourVol5mUsd;
  const peakToCurrent =
    peak != null && peak > 0 && currentVol5m != null
      ? +(currentVol5m / peak).toFixed(4)
      : null;

  const features: VolumeEphemeralFeatures = {
    ...baseCtx,
    lookbackHours,
    currentVol5mUsd: currentVol5m,
    peakToCurrentRatio: peakToCurrent,
  };

  const blockedReasons: string[] = [];
  if (!features.coverageOk) {
    return { blocked: false, blockedReasons, features };
  }
  if (peak == null || features.activeHours <= 0) {
    return { blocked: false, blockedReasons, features };
  }

  const narrowWindow = features.activeHours <= cfg.volumeEphemeralMaxActiveHours;
  const significantPeak = peak >= cfg.volumeEphemeralMinPeakVol5mUsd;
  const sparseHistory =
    features.hoursWithData <= cfg.volumeEphemeralMaxActiveHours + cfg.volumeEphemeralSparseHoursBuffer;

  if (narrowWindow && significantPeak && sparseHistory) {
    blockedReasons.push(
      `volume_ephemeral:active_hours=${features.activeHours}/${features.hoursWithData}h_in_${lookbackHours}h_peak=$${Math.round(peak)}<=${cfg.volumeEphemeralMaxActiveHours}h_window`,
    );
    return { blocked: true, blockedReasons, features };
  }

  if (
    cfg.volumeEphemeralTailBlockEnabled &&
    narrowWindow &&
    significantPeak &&
    peakToCurrent != null &&
    peakToCurrent <= cfg.volumeEphemeralTailMaxPeakRatio
  ) {
    blockedReasons.push(
      `volume_ephemeral:tail_vol5m=${Math.round(currentVol5m ?? 0)}/${Math.round(peak)}=${(peakToCurrent * 100).toFixed(1)}%<=${(cfg.volumeEphemeralTailMaxPeakRatio * 100).toFixed(0)}%_of_peak`,
    );
  }

  return { blocked: blockedReasons.length > 0, blockedReasons, features };
}
