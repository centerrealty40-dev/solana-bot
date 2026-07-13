/**
 * Volume Ephemeral guard (1.11.219, neighbor-window 1.11.545).
 *
 * Blocks entries when trading volume is concentrated in a narrow hourly window
 * within the lookback (typical one-shot wash / sybil burst — e.g. GOAT: 3 active
 * hours in 24h, peak vol5m $432k, otherwise dead).
 *
 * Known repeat mints: spike/narrow-window blocks are new-mint-only; dead live
 * vol5m is ignored when neighboring PG hourly windows show healthy volume.
 * Re-entry tail_wash (vol5m/vol1h below ratio floor) still applies on known mints.
 *
 * Uses hourly MAX(volume_5m) from PG pair snapshots. Missing PG history => safe-skip.
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';
import { isHealthyLiveVolumeSpread, vol5mToVol1hRatio } from './volume-spread-health.js';

export interface VolumeEphemeralFeatures {
  lookbackHours: number;
  hoursWithData: number;
  activeHours: number;
  peakHourVol5mUsd: number | null;
  currentVol5mUsd: number | null;
  peakToCurrentRatio: number | null;
  coverageOk: boolean;
  /** PG hourly max vol5m one hour ago (1.11.545). */
  vol5mPrev1hUsd?: number | null;
  /** PG hourly max vol5m two hours ago. */
  vol5mPrev2hUsd?: number | null;
  /** PG hourly max vol5m three hours ago. */
  vol5mPrev3hUsd?: number | null;
  /** Median hourly max vol5m over last 12h. */
  medianVol5m12hUsd?: number | null;
  /** Neighbor/adjacent-hour sanity passed (known mint dead-tick bypass). */
  neighborHealthy?: boolean;
  /** Live vol5m dead but PG neighbors healthy — do not block. */
  singleTickStaleIgnored?: boolean;
  /** Audit flag when {@link singleTickStaleIgnored}. */
  staleIgnoreFlag?: string;
  /** @deprecated Familiar bypass removed — audit field retained for journal compat. */
  familiarMintBypass?: boolean;
  /** PG hourly blocks skipped — fresh Birdeye/DexScreener shows healthy vol spread. */
  birdeyeFreshBypass?: boolean;
}

export interface VolumeEphemeralEvalResult {
  blocked: boolean;
  blockedReasons: string[];
  features: VolumeEphemeralFeatures;
}

export interface VolumeEphemeralEvalOpts {
  /** Mint with prior bot trade in lookback — relaxed tail / wash rules. */
  knownMint?: boolean;
  /** Fresh Birdeye/DexScreener quote on evalRow — skip PG-blind ephemeral blocks when spread healthy. */
  freshExternalMarketQuote?: boolean;
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

function posVol(v: unknown): number | null {
  const n = Number(v ?? 0);
  return n > 0 ? n : null;
}

function newMintVol5mVol1hRatio(row: SnapshotCandidateRow): number | null {
  return vol5mToVol1hRatio(row);
}

/** Inflated vol1h + dead vol5m tail — wash / volume decay (SCAM 6AVA re-entry RCA). */
function appendTailWashVol5mVol1hReasons(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  blockedReasons: string[],
): void {
  const vol1h = Number(row.volume_1h ?? 0);
  const vol5mWash = Number(row.volume_5m ?? 0);
  const vol5mVol1h = newMintVol5mVol1hRatio(row);
  const deadVol5mWash =
    Number.isFinite(vol5mWash) && vol5mWash < cfg.volumeEphemeralMinActiveHourVol5mUsd;
  if (
    Number.isFinite(vol1h) &&
    vol1h >= cfg.volumeGuardNewMintVol1hWashMinUsd &&
    deadVol5mWash &&
    vol5mVol1h != null &&
    vol5mVol1h < cfg.volumeGuardNewMintMinVol5mToVol1hRatio
  ) {
    blockedReasons.push(
      `volume_ephemeral:tail_wash_vol5m_vol1h=${(vol5mVol1h * 100).toFixed(1)}%<${(cfg.volumeGuardNewMintMinVol5mToVol1hRatio * 100).toFixed(0)}%_vol5m=$${Math.round(vol5mWash)}_vol1h=$${Math.round(vol1h)}`,
    );
  }
}

/**
 * True when PG neighbor hourly windows show sustained healthy vol5m — one dead live
 * tick should not block (NEST/world RCA: stale PG snapshot vs constant market).
 */
export function neighborVolumeHealthy(
  cfg: PaperTraderConfig,
  features: VolumeEphemeralFeatures,
): boolean {
  const thresh = cfg.volumeEphemeralMinActiveHourVol5mUsd;

  /** 24h active-hour count — many active hours => not a one-off stale tick. */
  if (features.activeHours >= 10) return true;

  const median12h = features.medianVol5m12hUsd;
  if (median12h != null && median12h >= thresh) return true;

  /** 2+ adjacent hours (prev3→current) with hourly max vol5m >= threshold. */
  const series = [
    features.vol5mPrev3hUsd ?? 0,
    features.vol5mPrev2hUsd ?? 0,
    features.vol5mPrev1hUsd ?? 0,
    features.currentVol5mUsd ?? 0,
  ];
  let run = 0;
  let maxAdjacent = 0;
  for (const v of series) {
    if (v >= thresh) {
      run += 1;
      maxAdjacent = Math.max(maxAdjacent, run);
    } else {
      run = 0;
    }
  }
  return maxAdjacent >= 2;
}

function evaluateKnownMintVolumeEphemeral(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  features: VolumeEphemeralFeatures,
): VolumeEphemeralEvalResult {
  const vol5m = Number(row.volume_5m ?? 0);
  const deadVol5m =
    Number.isFinite(vol5m) && vol5m < cfg.volumeEphemeralMinActiveHourVol5mUsd;
  const neighborsHealthy = neighborVolumeHealthy(cfg, features);
  const peak = features.peakHourVol5mUsd;
  const peakSignificant =
    peak != null && peak >= cfg.volumeEphemeralMinPeakVol5mUsd;

  const enriched: VolumeEphemeralFeatures = {
    ...features,
    neighborHealthy: neighborsHealthy,
  };

  if (deadVol5m && neighborsHealthy) {
    return {
      blocked: false,
      blockedReasons: [],
      features: {
        ...enriched,
        singleTickStaleIgnored: true,
        staleIgnoreFlag: 'volume_ephemeral:single_tick_stale_ignored',
      },
    };
  }

  const blockedReasons: string[] = [];
  if (cfg.volumeEphemeralKnownMintTailWashBlockEnabled) {
    appendTailWashVol5mVol1hReasons(cfg, row, blockedReasons);
    if (blockedReasons.length > 0) {
      return { blocked: true, blockedReasons, features: enriched };
    }
  }

  const sustainedDead =
    features.coverageOk &&
    features.activeHours <= cfg.volumeEphemeralMaxActiveHours &&
    deadVol5m &&
    peakSignificant &&
    !neighborsHealthy;

  if (sustainedDead) {
    blockedReasons.push(
      `volume_ephemeral:known_mint_sustained_dead_active=${features.activeHours}h_vol5m=$${Math.round(vol5m)}`,
    );
  }

  return {
    blocked: blockedReasons.length > 0,
    blockedReasons,
    features: enriched,
  };
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
        MAX(hour_max_vol5m)::float AS peak_hour_vol5m,
        MAX(hour_max_vol5m) FILTER (
          WHERE hour_bucket = date_trunc('hour', now()) - interval '1 hour'
        )::float AS vol5m_prev_1h,
        MAX(hour_max_vol5m) FILTER (
          WHERE hour_bucket = date_trunc('hour', now()) - interval '2 hours'
        )::float AS vol5m_prev_2h,
        MAX(hour_max_vol5m) FILTER (
          WHERE hour_bucket = date_trunc('hour', now()) - interval '3 hours'
        )::float AS vol5m_prev_3h,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY hour_max_vol5m) FILTER (
          WHERE hour_bucket >= date_trunc('hour', now()) - interval '12 hours'
        )::float AS median_vol5m_12h
      FROM hourly
      GROUP BY mint
    `));
    const out = r as unknown as Array<Record<string, unknown>>;
    for (const row of out) {
      const mint = String(row.mint ?? '');
      const hoursWithData = Number(row.hours_with_data ?? 0) | 0;
      const activeHours = Number(row.active_hours ?? 0) | 0;
      const peak = posVol(row.peak_hour_vol5m);
      map.set(mint, {
        lookbackHours,
        hoursWithData,
        activeHours,
        peakHourVol5mUsd: peak,
        currentVol5mUsd: null,
        peakToCurrentRatio: null,
        coverageOk: hoursWithData >= cfg.volumeEphemeralMinHoursWithData,
        vol5mPrev1hUsd: posVol(row.vol5m_prev_1h),
        vol5mPrev2hUsd: posVol(row.vol5m_prev_2h),
        vol5mPrev3hUsd: posVol(row.vol5m_prev_3h),
        medianVol5m12hUsd: posVol(row.median_vol5m_12h),
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
  opts?: VolumeEphemeralEvalOpts,
): VolumeEphemeralEvalResult {
  const lookbackHours = clampLookbackHours(cfg.volumeEphemeralLookbackHours);
  const knownMint = opts?.knownMint === true;

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

  /** Fresh Birdeye/DexScreener on evalRow: healthy vol spread proves live market — skip PG-blind blocks. */
  if (
    opts?.freshExternalMarketQuote &&
    cfg.volumeEphemeralBirdeyeFreshBypass &&
    isHealthyLiveVolumeSpread(cfg, row)
  ) {
    return {
      blocked: false,
      blockedReasons: [],
      features: { ...features, birdeyeFreshBypass: true },
    };
  }

  /** Repeat mint: spike/narrow-window blocks are new-mint-only; tail_wash + neighbor-window for dead ticks. */
  if (knownMint) {
    return evaluateKnownMintVolumeEphemeral(cfg, row, features);
  }

  const blockedReasons: string[] = [];
  if (!features.coverageOk) {
    /** PG hourly context missing — still block obvious live-snapshot wash (MUSHU RCA 2026-06-30). */
    const vol5mVol1hNoCtx = newMintVol5mVol1hRatio(row);
    const vol5mNoCtx = Number(row.volume_5m ?? 0);
    const vol1hNoCtx = Number(row.volume_1h ?? 0);
    if (
      Number.isFinite(vol1hNoCtx) &&
      vol1hNoCtx >= cfg.volumeGuardNewMintVol1hWashMinUsd &&
      Number.isFinite(vol5mNoCtx) &&
      vol5mNoCtx < cfg.volumeEphemeralMinActiveHourVol5mUsd &&
      vol5mVol1hNoCtx != null &&
      vol5mVol1hNoCtx < cfg.volumeGuardNewMintMinVol5mToVol1hRatio
    ) {
      blockedReasons.push(
        `volume_ephemeral:tail_wash_no_pg_ctx_vol5m_vol1h=${(vol5mVol1hNoCtx * 100).toFixed(1)}%<${(cfg.volumeGuardNewMintMinVol5mToVol1hRatio * 100).toFixed(0)}%_vol5m=$${Math.round(vol5mNoCtx)}_vol1h=$${Math.round(vol1hNoCtx)}`,
      );
      return { blocked: true, blockedReasons, features };
    }
    return { blocked: false, blockedReasons, features };
  }

  const vol1h = Number(row.volume_1h ?? 0);
  const minActiveHours = cfg.volumeEphemeralNewMintMinActiveHours;
  const peakSignificant =
    peak != null && peak >= cfg.volumeEphemeralMinPeakVol5mUsd;

  /** New mints: require sustained hourly volume before first entry. */
  if (minActiveHours > 0 && features.activeHours < minActiveHours) {
    const inflatedVol1h =
      Number.isFinite(vol1h) && vol1h >= cfg.volumeGuardNewMintVol1hWashMinUsd;
    if (inflatedVol1h || peakSignificant || features.activeHours > 0) {
      blockedReasons.push(
        `volume_ephemeral:new_mint_min_active_hours=${features.activeHours}/${minActiveHours}h_in_${lookbackHours}h`,
      );
      return { blocked: true, blockedReasons, features };
    }
  }

  if (peak == null || features.activeHours <= 0) {
    return { blocked: false, blockedReasons, features };
  }

  const narrowWindow = features.activeHours <= cfg.volumeEphemeralMaxActiveHours;
  const sparseHistory =
    features.hoursWithData <= cfg.volumeEphemeralMaxActiveHours + cfg.volumeEphemeralSparseHoursBuffer;

  if (narrowWindow && peakSignificant && sparseHistory) {
    blockedReasons.push(
      `volume_ephemeral:active_hours=${features.activeHours}/${features.hoursWithData}h_in_${lookbackHours}h_peak=$${Math.round(peak)}<=${cfg.volumeEphemeralMaxActiveHours}h_window`,
    );
    return { blocked: true, blockedReasons, features };
  }

  const sustainThreshold = cfg.volumeEphemeralNewMintMinActiveHours;
  const notYetSustained = sustainThreshold > 0 && features.activeHours < sustainThreshold;

  const vol5m = Number(row.volume_5m ?? 0);
  const deadVol5m =
    Number.isFinite(vol5m) && vol5m < cfg.volumeEphemeralMinActiveHourVol5mUsd;

  if (
    cfg.volumeEphemeralTailBlockEnabled &&
    narrowWindow &&
    peakSignificant &&
    peakToCurrent != null &&
    peakToCurrent <= cfg.volumeEphemeralTailMaxPeakRatio
  ) {
    blockedReasons.push(
      `volume_ephemeral:tail_vol5m=${Math.round(currentVol5m ?? 0)}/${Math.round(peak)}=${(peakToCurrent * 100).toFixed(1)}%<=${(cfg.volumeEphemeralTailMaxPeakRatio * 100).toFixed(0)}%_of_peak`,
    );
  }

  /** Dead tail after burst: block until sustain threshold even when narrowWindow aged out (MUSHU RCA). */
  if (
    cfg.volumeEphemeralTailBlockEnabled &&
    notYetSustained &&
    deadVol5m &&
    peakSignificant &&
    peakToCurrent != null &&
    peakToCurrent <= cfg.volumeEphemeralTailMaxPeakRatio &&
    !blockedReasons.some((r) => r.includes('tail_vol5m'))
  ) {
    blockedReasons.push(
      `volume_ephemeral:new_mint_tail_vol5m=${Math.round(currentVol5m ?? 0)}/${Math.round(peak)}=${(peakToCurrent * 100).toFixed(1)}%<=${(cfg.volumeEphemeralTailMaxPeakRatio * 100).toFixed(0)}%_of_peak`,
    );
  }

  /** Legacy alias kept for tests/docs — merged into notYetSustained tail above. */
  if (
    cfg.volumeEphemeralTailBlockEnabled &&
    peakSignificant &&
    peakToCurrent != null &&
    peakToCurrent <= cfg.volumeEphemeralTailMaxPeakRatio &&
    (minActiveHours <= 0 || features.activeHours < minActiveHours) &&
    !blockedReasons.some((r) => r.includes('tail_vol5m'))
  ) {
    blockedReasons.push(
      `volume_ephemeral:new_mint_tail_vol5m=${Math.round(currentVol5m ?? 0)}/${Math.round(peak)}=${(peakToCurrent * 100).toFixed(1)}%<=${(cfg.volumeEphemeralTailMaxPeakRatio * 100).toFixed(0)}%_of_peak`,
    );
  }

  appendTailWashVol5mVol1hReasons(cfg, row, blockedReasons);

  return { blocked: blockedReasons.length > 0, blockedReasons, features };
}
