/**
 * PG data coverage guard (1.11.222, recent-window 1.11.226, auto-escalate 1.11.227).
 *
 * When `pgDataCoverageAutoEscalate` is on, uses **relaxed** recent-window checks during PG
 * outage/recovery; restores **full** 24h system ratio + strict recovery + full mint history
 * automatically when metrics are healthy again.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import {
  type DexSnapshotFreshness,
  DEX_PAIR_SNAPSHOT_TABLES,
  fetchDexSnapshotFreshness,
  filterFreshnessForPgStaleBlocking,
  isMintLaneSnapshotStale,
  snapshotMaxAgeSecFromEnv,
} from '../../ingestion/pair-snapshot-freshness.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export type PgCoverageMode = 'relaxed' | 'full';

export interface GlobalPgCoverageState {
  pgStaleNow: boolean;
  worstAgeSec: number | null;
  /** Per-source snapshot ages (discovery tick cache). */
  freshness: readonly DexSnapshotFreshness[];
  systemHourRatio: number | null;
  strictRecoveryActive: boolean;
  hoursSinceLastRecovery: number | null;
  lookbackHours: number;
  recentHours: number;
  coverageMode: PgCoverageMode;
  /** Set when mode flipped this tick (for Telegram). */
  coverageModeChanged: PgCoverageMode | null;
}

export interface MintPgCoverageFeatures {
  lookbackHours: number;
  recentHours: number;
  minuteSamples: number;
  hoursWithData: number;
  recentHoursWithData: number;
  hourCoverageRatio: number | null;
  recentHourCoverageRatio: number | null;
  maxGapMinutes: number | null;
  recentMaxGapMinutes: number | null;
  sybilBaselineSamples: number;
  sybilCoverageOk: boolean;
  ephemeralCoverageOk: boolean;
  nearEntry: boolean;
  /** True when known-mint gap bypass removed pg_gap block reasons this eval. */
  knownMintGapBypass?: boolean;
  /** @deprecated Familiar stale bypass removed — use birdeyeFreshBypass. */
  familiarMintStaleBypass?: boolean;
  /** True when fresh Birdeye/DexScreener quote removed PG coverage buy blocks. */
  birdeyeFreshBypass?: boolean;
}

export interface PgDataCoverageEvalResult {
  blocked: boolean;
  blockedReasons: string[];
  features: MintPgCoverageFeatures;
}

const EMPTY_MINT: MintPgCoverageFeatures = {
  lookbackHours: 0,
  recentHours: 0,
  minuteSamples: 0,
  hoursWithData: 0,
  recentHoursWithData: 0,
  hourCoverageRatio: null,
  recentHourCoverageRatio: null,
  maxGapMinutes: null,
  recentMaxGapMinutes: null,
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

function clampRecentHours(h: number, lookbackHours: number): number {
  return Math.max(3, Math.min(lookbackHours, Math.round(h)));
}

function snapshotGapStatePath(): string {
  return (
    process.env.SNAPSHOT_FRESHNESS_STATE_PATH?.trim() ||
    path.join('data', 'snapshot-freshness-watch-state.json')
  );
}

interface SnapshotGapStateFile {
  stale?: boolean;
  lastRecoveryAt?: number;
  pgCoverageMode?: PgCoverageMode;
  pgCoverageModeSince?: number;
}

function readSnapshotGapStateFile(): SnapshotGapStateFile {
  try {
    const raw = fs.readFileSync(snapshotGapStatePath(), 'utf8');
    return JSON.parse(raw) as SnapshotGapStateFile;
  } catch {
    return {};
  }
}

function writeSnapshotGapStatePatch(patch: Partial<SnapshotGapStateFile>): void {
  try {
    const prev = readSnapshotGapStateFile();
    const next = { ...prev, ...patch };
    fs.mkdirSync(path.dirname(snapshotGapStatePath()), { recursive: true });
    fs.writeFileSync(snapshotGapStatePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Hours since last PG snapshot recovery (null if unknown / never stale). */
export function readHoursSinceSnapshotRecovery(): number | null {
  const st = readSnapshotGapStateFile();
  if (st.lastRecoveryAt != null && Number.isFinite(st.lastRecoveryAt)) {
    return (Date.now() - st.lastRecoveryAt) / 3_600_000;
  }
  return null;
}

/** Whether relaxed recent-window tier should apply (exported for tests). */
export function resolvePgCoverageRelaxedMode(
  cfg: PaperTraderConfig,
  args: {
    pgStaleNow: boolean;
    systemHourRatio: number | null;
    hoursSinceLastRecovery: number | null;
  },
): boolean {
  if (!cfg.pgDataCoverageGuardEnabled) return false;
  if (!cfg.pgDataCoverageAutoEscalate) {
    return (
      cfg.pgDataCoverageMinSystemHourRatio === 0 &&
      cfg.pgDataCoverageStrictAfterRecoveryHours === 0
    );
  }
  if (args.pgStaleNow) return true;
  if (
    cfg.pgDataCoverageStrictAfterRecoveryHours > 0 &&
    args.hoursSinceLastRecovery != null &&
    args.hoursSinceLastRecovery >= 0 &&
    args.hoursSinceLastRecovery < cfg.pgDataCoverageStrictAfterRecoveryHours
  ) {
    return true;
  }
  const minSys = cfg.pgDataCoverageMinSystemHourRatio;
  if (minSys > 0 && args.systemHourRatio != null && args.systemHourRatio < minSys) {
    return true;
  }
  return false;
}

function effectiveMinHourRatio(cfg: PaperTraderConfig, strictRecoveryActive: boolean): number {
  if (!strictRecoveryActive) return cfg.pgDataCoverageMinHourRatio;
  return Math.max(cfg.pgDataCoverageMinHourRatio, cfg.pgDataCoverageStrictMinHourRatio);
}

/** Once per discovery tick — global PG health for coverage decisions. */
export async function fetchGlobalPgCoverageState(cfg: PaperTraderConfig): Promise<GlobalPgCoverageState> {
  const lookbackHours = clampLookbackHours(cfg.pgDataCoverageLookbackHours);
  const recentHours = clampRecentHours(cfg.pgDataCoverageRecentHours, lookbackHours);
  const maxAgeSec = snapshotMaxAgeSecFromEnv();
  const freshness = await fetchDexSnapshotFreshness(maxAgeSec);
  const blockingFreshness = filterFreshnessForPgStaleBlocking(freshness);
  const pgStaleNow = blockingFreshness.some((r) => !r.ok);
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
  const relaxed = resolvePgCoverageRelaxedMode(cfg, {
    pgStaleNow,
    systemHourRatio,
    hoursSinceLastRecovery,
  });
  const coverageMode: PgCoverageMode = relaxed ? 'relaxed' : 'full';

  const prevMode = readSnapshotGapStateFile().pgCoverageMode ?? null;
  let coverageModeChanged: PgCoverageMode | null = null;
  if (prevMode != null && prevMode !== coverageMode) {
    coverageModeChanged = coverageMode;
  } else if (prevMode == null && cfg.pgDataCoverageAutoEscalate && relaxed) {
    coverageModeChanged = coverageMode;
  }
  if (prevMode !== coverageMode) {
    writeSnapshotGapStatePatch({
      pgCoverageMode: coverageMode,
      pgCoverageModeSince: Date.now(),
    });
  }

  const strictRecoveryActive =
    coverageMode === 'full' &&
    cfg.pgDataCoverageStrictAfterRecoveryHours > 0 &&
    hoursSinceLastRecovery != null &&
    hoursSinceLastRecovery >= 0 &&
    hoursSinceLastRecovery < cfg.pgDataCoverageStrictAfterRecoveryHours;

  return {
    pgStaleNow,
    worstAgeSec,
    freshness,
    systemHourRatio,
    strictRecoveryActive,
    hoursSinceLastRecovery,
    lookbackHours,
    recentHours,
    coverageMode,
    coverageModeChanged,
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
  const recentHours = global.recentHours;
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
      recent_scoped AS (
        SELECT base_mint AS mint, ts
        FROM ${table}
        WHERE ts >= now() - interval '${recentHours} hours'
          AND base_mint IN (${mintsSql})
      ),
      gaps AS (
        SELECT
          mint,
          ts,
          LAG(ts) OVER (PARTITION BY mint ORDER BY ts) AS prev_ts
        FROM scoped
      ),
      recent_gaps AS (
        SELECT
          mint,
          ts,
          LAG(ts) OVER (PARTITION BY mint ORDER BY ts) AS prev_ts
        FROM recent_scoped
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
      recent_agg AS (
        SELECT
          mint,
          COUNT(DISTINCT date_trunc('hour', ts))::int AS recent_hours_with_data,
          MAX(
            CASE
              WHEN prev_ts IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (ts - prev_ts)) / 60.0
            END
          )::float AS recent_max_gap_minutes
        FROM recent_gaps
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
        COALESCE(r.recent_hours_with_data, 0)::int AS recent_hours_with_data,
        r.recent_max_gap_minutes,
        COALESCE(s.baseline_n, 0)::int AS sybil_baseline_samples
      FROM agg a
      LEFT JOIN recent_agg r ON r.mint = a.mint
      LEFT JOIN sybil s ON s.mint = a.mint
    `));

    const out = r as unknown as Array<Record<string, unknown>>;
    for (const row of out) {
      const mint = String(row.mint ?? '');
      const hoursWithData = Number(row.hours_with_data ?? 0) | 0;
      const recentHoursWithData = Number(row.recent_hours_with_data ?? 0) | 0;
      const minuteSamples = Number(row.minute_samples ?? 0) | 0;
      const maxGap =
        row.max_gap_minutes != null && Number(row.max_gap_minutes) > 0
          ? Number(row.max_gap_minutes)
          : null;
      const recentMaxGap =
        row.recent_max_gap_minutes != null && Number(row.recent_max_gap_minutes) > 0
          ? Number(row.recent_max_gap_minutes)
          : null;
      const sybilBaselineSamples = Number(row.sybil_baseline_samples ?? 0) | 0;
      const hourCoverageRatio =
        lookbackHours > 0 ? +(hoursWithData / lookbackHours).toFixed(4) : null;
      const recentHourCoverageRatio =
        recentHours > 0 ? +(recentHoursWithData / recentHours).toFixed(4) : null;

      const sybilCoverageOk =
        !cfg.volumeSybilGuardEnabled ||
        sybilBaselineSamples >= cfg.volumeSybilMinBaselineSamples;
      const ephemeralCoverageOk =
        !cfg.volumeEphemeralGuardEnabled ||
        recentHoursWithData >= cfg.pgDataCoverageMinRecentHoursWithData;

      map.set(mint, {
        lookbackHours,
        recentHours,
        minuteSamples,
        hoursWithData,
        recentHoursWithData,
        hourCoverageRatio,
        recentHourCoverageRatio,
        maxGapMinutes: maxGap,
        recentMaxGapMinutes: recentMaxGap,
        sybilBaselineSamples,
        sybilCoverageOk,
        ephemeralCoverageOk,
        nearEntry: false,
      });
    }
  }
  return map;
}

/** True for per-mint PG minute-bar gap block reasons (not pg_stale / thin coverage). */
export function isPgCoverageGapBlockReason(reason: string): boolean {
  return (
    reason.startsWith('data_coverage:pg_gap_in_recent_history') ||
    reason.startsWith('data_coverage:pg_gap_in_history')
  );
}

/** True for lane/global PG snapshot staleness block (not minute-bar gaps). */
export function isPgStaleNowBlockReason(reason: string): boolean {
  return reason.startsWith('data_coverage:pg_stale_now');
}

/** Block entry when PG history is too thin or gapped to trust volume guards. */
export function evaluatePgDataCoverageGuard(
  cfg: PaperTraderConfig,
  _row: SnapshotCandidateRow,
  ctx: MintPgCoverageFeatures | undefined,
  global: GlobalPgCoverageState,
  nearEntry: boolean,
  opts?: { knownMint?: boolean; freshExternalMarketQuote?: boolean },
): PgDataCoverageEvalResult {
  if (!cfg.pgDataCoverageGuardEnabled) {
    return { blocked: false, blockedReasons: [], features: EMPTY_MINT };
  }

  const features: MintPgCoverageFeatures = {
    ...(ctx ?? EMPTY_MINT),
    lookbackHours: global.lookbackHours,
    recentHours: global.recentHours,
    nearEntry,
  };

  const blockedReasons: string[] = [];
  const relaxed = global.coverageMode === 'relaxed';
  const strictRecoveryActive = global.strictRecoveryActive;
  const minHourRatio = effectiveMinHourRatio(cfg, strictRecoveryActive);
  const recentHours = global.recentHours;
  const lookbackHours = global.lookbackHours;
  const minRecentHours = cfg.pgDataCoverageMinRecentHoursWithData;

  if (cfg.pgDataCoverageBlockOnPgStale) {
    const laneStale = isMintLaneSnapshotStale(
      _row.source,
      global.freshness ?? [],
      snapshotMaxAgeSecFromEnv(),
    );
    if (laneStale.stale) {
      blockedReasons.push(
        `data_coverage:pg_stale_now_worst_age_sec=${laneStale.ageSec ?? global.worstAgeSec ?? 'null'}`,
      );
    }
  }

  if (
    !relaxed &&
    cfg.pgDataCoverageMinSystemHourRatio > 0 &&
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
    if (relaxed) {
      const recentHourRatio = mintCtx.recentHourCoverageRatio ?? 0;
      if (
        cfg.volumeEphemeralGuardEnabled &&
        (mintCtx.recentHoursWithData < minRecentHours || recentHourRatio < minHourRatio)
      ) {
        blockedReasons.push(
          `data_coverage:recent_pg_insufficient=${mintCtx.recentHoursWithData}h/${recentHours}h_ratio=${(recentHourRatio * 100).toFixed(0)}%<${(minHourRatio * 100).toFixed(0)}%`,
        );
      }

      if (
        mintCtx.recentMaxGapMinutes != null &&
        mintCtx.recentMaxGapMinutes > cfg.pgDataCoverageMaxGapMinutes
      ) {
        blockedReasons.push(
          `data_coverage:pg_gap_in_recent_history=${Math.round(mintCtx.recentMaxGapMinutes)}m>${cfg.pgDataCoverageMaxGapMinutes}m`,
        );
      }
    } else {
      const hourRatio = mintCtx.hourCoverageRatio ?? 0;
      const minFullHours = Math.ceil(lookbackHours * minHourRatio);
      if (
        cfg.volumeEphemeralGuardEnabled &&
        (mintCtx.hoursWithData < minFullHours || hourRatio < minHourRatio)
      ) {
        blockedReasons.push(
          `data_coverage:pg_insufficient=${mintCtx.hoursWithData}h/${lookbackHours}h_ratio=${(hourRatio * 100).toFixed(0)}%<${(minHourRatio * 100).toFixed(0)}%`,
        );
      }

      if (
        mintCtx.maxGapMinutes != null &&
        mintCtx.maxGapMinutes > cfg.pgDataCoverageMaxGapMinutes
      ) {
        blockedReasons.push(
          `data_coverage:pg_gap_in_history=${Math.round(mintCtx.maxGapMinutes)}m>${cfg.pgDataCoverageMaxGapMinutes}m`,
        );
      }
    }

    if (cfg.volumeSybilGuardEnabled && !mintCtx.sybilCoverageOk) {
      const need = cfg.volumeSybilMinBaselineSamples;
      blockedReasons.push(
        `data_coverage:sybil_pg_insufficient_samples=${mintCtx.sybilBaselineSamples}/${need}`,
      );
    }
  }

  let knownMintGapBypass = false;
  if (
    opts?.knownMint &&
    cfg.pgDataCoverageKnownMintGapBypass &&
    blockedReasons.some(isPgCoverageGapBlockReason)
  ) {
    const filtered = blockedReasons.filter((r) => !isPgCoverageGapBlockReason(r));
    if (filtered.length !== blockedReasons.length) {
      knownMintGapBypass = true;
      blockedReasons.length = 0;
      blockedReasons.push(...filtered);
    }
  }

  let birdeyeFreshBypass = false;
  if (
    opts?.freshExternalMarketQuote &&
    cfg.pgCoverageBirdeyeFreshBypass &&
    blockedReasons.length > 0
  ) {
    birdeyeFreshBypass = true;
    blockedReasons.length = 0;
  }

  const blockBuy = cfg.pgDataCoverageBlockBuy;
  return {
    blocked: blockBuy && blockedReasons.length > 0,
    blockedReasons: blockBuy ? blockedReasons : [],
    features: { ...features, knownMintGapBypass, birdeyeFreshBypass },
  };
}
