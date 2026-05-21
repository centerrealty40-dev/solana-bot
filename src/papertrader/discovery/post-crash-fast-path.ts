/**
 * Post-crash fast path (1.11.250).
 *
 * After a vol-spike + sharp drop within a recent lookback, allow dip entry when price
 * has stabilized — measured vs the crash peak, not vs rolling 2h/12h highs that
 * flatten after the dump (swarms 2026-05-21 case).
 *
 * Does NOT bypass Policy A+, bs, or vol1h snapshot floors — only substitutes dip
 * window math and optionally local-high-veto on flat post-crash plateaus.
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export interface PostCrashContextFeatures {
  lookbackMin: number;
  peakPx: number | null;
  minutesSincePeak: number | null;
  dropFromPeakPct: number | null;
  maxVol5mSpikeRatio: number | null;
  price15mAgo: number | null;
  priceChange15mPct: number | null;
  pgSnapsCount: number;
  coverageOk: boolean;
}

export interface PostCrashFastPathResult {
  pass: boolean;
  reasons: string[];
  features: PostCrashContextFeatures;
  /** Synthetic lookback label for recovery-veto (minutes since crash peak, capped). */
  dipLookbackUsedMin: number | null;
}

const EMPTY: PostCrashContextFeatures = {
  lookbackMin: 180,
  peakPx: null,
  minutesSincePeak: null,
  dropFromPeakPct: null,
  maxVol5mSpikeRatio: null,
  price15mAgo: null,
  priceChange15mPct: null,
  pgSnapsCount: 0,
  coverageOk: false,
};

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function emptyFeatures(cfg: PaperTraderConfig): PostCrashContextFeatures {
  return { ...EMPTY, lookbackMin: cfg.postCrashFastPathLookbackMin };
}

interface AggRow {
  mint: string;
  peak_px: number | null;
  minutes_since_peak: number | null;
  max_vol5m_spike_ratio: number | null;
  price_15m_ago: number | null;
  snaps_count: number | null;
}

function postCrashSql(table: string, mintsSql: string, lookbackMin: number): string {
  return `
    WITH bars AS (
      SELECT base_mint AS mint, ts,
             COALESCE(price_usd, 0)::float AS px,
             COALESCE(volume_5m, 0)::float AS vol5m,
             COALESCE(volume_1h, 0)::float AS vol1h
        FROM ${table}
       WHERE base_mint IN (${mintsSql})
         AND ts >= now() - interval '${lookbackMin} minutes'
         AND COALESCE(price_usd, 0) > 0
    ),
    peaks AS (
      SELECT mint, MAX(px)::float AS peak_px FROM bars GROUP BY mint
    ),
    peak_touch AS (
      SELECT b.mint, MAX(b.ts) AS peak_ts
        FROM bars b
        INNER JOIN peaks p ON p.mint = b.mint
       WHERE b.px >= p.peak_px * 0.995
       GROUP BY b.mint
    ),
    per_mint AS (
      SELECT
        p.mint,
        p.peak_px,
        EXTRACT(EPOCH FROM (now() - pt.peak_ts)) / 60.0 AS minutes_since_peak,
        MAX(CASE WHEN b.vol1h > 0 THEN b.vol5m / (b.vol1h / 12.0) ELSE NULL END)::float AS max_vol5m_spike_ratio,
        AVG(b.px) FILTER (
          WHERE b.ts >= now() - interval '17 minutes'
            AND b.ts <= now() - interval '13 minutes'
        )::float AS price_15m_ago,
        COUNT(*)::int AS snaps_count
      FROM peaks p
      INNER JOIN peak_touch pt ON pt.mint = p.mint
      INNER JOIN bars b ON b.mint = p.mint
      GROUP BY p.mint, p.peak_px, pt.peak_ts
    )
    SELECT * FROM per_mint
  `;
}

function mapRow(cfg: PaperTraderConfig, row: AggRow): PostCrashContextFeatures {
  const snaps = Number(row.snaps_count ?? 0) | 0;
  const peak = Number(row.peak_px ?? 0);
  return {
    lookbackMin: cfg.postCrashFastPathLookbackMin,
    peakPx: peak > 0 ? peak : null,
    minutesSincePeak:
      row.minutes_since_peak != null && Number.isFinite(Number(row.minutes_since_peak))
        ? +Number(row.minutes_since_peak).toFixed(2)
        : null,
    dropFromPeakPct: null,
    maxVol5mSpikeRatio:
      row.max_vol5m_spike_ratio != null && Number.isFinite(Number(row.max_vol5m_spike_ratio))
        ? +Number(row.max_vol5m_spike_ratio).toFixed(2)
        : null,
    price15mAgo: Number(row.price_15m_ago ?? 0) > 0 ? Number(row.price_15m_ago) : null,
    priceChange15mPct: null,
    pgSnapsCount: snaps,
    coverageOk: snaps >= cfg.postCrashFastPathMinPgSamples,
  };
}

export async function fetchPostCrashContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, PostCrashContextFeatures>> {
  const map = new Map<string, PostCrashContextFeatures>();
  if (!cfg.postCrashFastPathEnabled || rows.length === 0) return map;

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
    const sqlText = postCrashSql(table, uniq.map(sqlQuote).join(','), cfg.postCrashFastPathLookbackMin);
    const r = (await db.execute(dsql.raw(sqlText))) as unknown as AggRow[];
    for (const row of r) {
      map.set(String(row.mint), mapRow(cfg, row));
    }
  }
  return map;
}

/** Evaluate post-crash fast path for one candidate (after standard dip failed). */
export function evaluatePostCrashFastPath(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: PostCrashContextFeatures,
): PostCrashFastPathResult {
  const features: PostCrashContextFeatures = ctx ?? emptyFeatures(cfg);
  const px = Number(row.price_usd ?? 0);
  if (features.peakPx != null && features.peakPx > 0 && px > 0) {
    features.dropFromPeakPct = +((px / features.peakPx - 1) * 100).toFixed(3);
  }
  if (features.price15mAgo != null && features.price15mAgo > 0 && px > 0) {
    features.priceChange15mPct = +(((px - features.price15mAgo) / features.price15mAgo) * 100).toFixed(3);
  }

  if (!cfg.postCrashFastPathEnabled) {
    return { pass: false, reasons: [], features, dipLookbackUsedMin: null };
  }
  if ((row.token_age_min ?? 0) < cfg.dipMinAgeMin) {
    return {
      pass: false,
      reasons: [`post_crash_age<${cfg.dipMinAgeMin}m`],
      features,
      dipLookbackUsedMin: null,
    };
  }
  if (!features.coverageOk) {
    return { pass: false, reasons: [], features, dipLookbackUsedMin: null };
  }

  const reasons: string[] = [];

  if (features.maxVol5mSpikeRatio == null) {
    reasons.push('post_crash_no_vol_spike');
  } else if (features.maxVol5mSpikeRatio + 1e-9 < cfg.postCrashFastPathMinVolSpikeMult) {
    reasons.push(
      `post_crash_spike<${cfg.postCrashFastPathMinVolSpikeMult}x(${features.maxVol5mSpikeRatio.toFixed(1)}x)`,
    );
  }

  if (features.minutesSincePeak == null) {
    reasons.push('post_crash_peak_age_unknown');
  } else {
    if (features.minutesSincePeak + 1e-9 < cfg.postCrashFastPathStabilizeMin) {
      reasons.push(
        `post_crash_too_fresh_${features.minutesSincePeak.toFixed(0)}m<${cfg.postCrashFastPathStabilizeMin}m`,
      );
    }
    if (features.minutesSincePeak > cfg.postCrashFastPathMaxAgeMin) {
      reasons.push(
        `post_crash_too_old_${features.minutesSincePeak.toFixed(0)}m>${cfg.postCrashFastPathMaxAgeMin}m`,
      );
    }
  }

  if (features.dropFromPeakPct == null) {
    reasons.push('post_crash_drop_unknown');
  } else {
    if (features.dropFromPeakPct > cfg.postCrashFastPathMinDropPct) {
      reasons.push(
        `post_crash_drop${features.dropFromPeakPct.toFixed(1)}%>${cfg.postCrashFastPathMinDropPct}%`,
      );
    }
    if (features.dropFromPeakPct < cfg.postCrashFastPathMaxDropPct) {
      reasons.push(
        `post_crash_drop${features.dropFromPeakPct.toFixed(1)}%<${cfg.postCrashFastPathMaxDropPct}%`,
      );
    }
  }

  if (
    features.priceChange15mPct != null &&
    features.priceChange15mPct < cfg.postCrashFastPathMaxKnife15mPct
  ) {
    reasons.push(
      `post_crash_knife_15m=${features.priceChange15mPct.toFixed(1)}%<${cfg.postCrashFastPathMaxKnife15mPct}%`,
    );
  }

  const pass = reasons.length === 0;
  const dipLookbackUsedMin =
    pass && features.minutesSincePeak != null
      ? Math.max(30, Math.min(cfg.postCrashFastPathLookbackMin, Math.round(features.minutesSincePeak)))
      : null;

  if (pass) {
    return {
      pass: true,
      reasons: [
        `post_crash_fast:drop${features.dropFromPeakPct!.toFixed(1)}%_spike${features.maxVol5mSpikeRatio!.toFixed(1)}x_age${features.minutesSincePeak!.toFixed(0)}m`,
      ],
      features,
      dipLookbackUsedMin,
    };
  }

  return { pass: false, reasons, features, dipLookbackUsedMin: null };
}

/** When post-crash path passed, skip local-high veto (flat plateau at crash floor). */
export function shouldBypassLocalHighVetoForPostCrash(
  cfg: PaperTraderConfig,
  postCrash: PostCrashFastPathResult | undefined,
  entryPath: string | undefined,
): boolean {
  return (
    cfg.postCrashFastPathEnabled &&
    cfg.postCrashFastPathBypassLocalHighVeto &&
    entryPath === 'post_crash_fast' &&
    postCrash?.pass === true
  );
}
