import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { DynamicKillstopShadow, DynamicKillstopShadowStatus, OpenTrade } from '../types.js';
import type { PaperTraderConfig } from '../config.js';
import { sourceSnapshotTable } from '../dip-detector.js';

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function pctFromEntry(entry: number, px: number): number {
  if (!(entry > 0) || !(px > 0)) return NaN;
  return (px / entry - 1) * 100;
}

/**
 * Clamp a proposed kill price (below entry) into [minKillDropPct, maxKillDropPct] distance from entry.
 * `minKillDropPct` / `maxKillDropPct` are positive magnitudes in percent points (e.g. 12 means at least ~12% drawdown).
 */
export function clampKillPriceUsd(args: {
  entryPriceUsd: number;
  rawKillPriceUsd: number;
  minKillDropPct: number;
  maxKillDropPct: number;
}): { cappedKillPriceUsd: number; flags: Array<'max_capped' | 'min_capped'> } {
  const { entryPriceUsd, rawKillPriceUsd, minKillDropPct, maxKillDropPct } = args;
  const flags: Array<'max_capped' | 'min_capped'> = [];
  const maxFloor = entryPriceUsd * (1 - maxKillDropPct / 100); // deeper than this is forbidden
  const minCeil = entryPriceUsd * (1 - minKillDropPct / 100); // shallower than this is forbidden (need at least min drawdown)

  let x = rawKillPriceUsd;
  // Too deep -> raise kill price toward entry (less loss allowed than raw support implied).
  if (x < maxFloor) {
    x = maxFloor;
    flags.push('max_capped');
  }
  // Too shallow -> lower kill price away from entry (need at least min drawdown).
  if (x > minCeil) {
    x = minCeil;
    flags.push('min_capped');
  }
  return { cappedKillPriceUsd: x, flags };
}

type HourlyMinRow = { bucket_ms: string | number | null; min_px: string | number | null };

function parseHourlyMins(rows: HourlyMinRow[]): Array<{ bucketMs: number; minPx: number }> {
  const out: Array<{ bucketMs: number; minPx: number }> = [];
  for (const r of rows) {
    const bm = Number(r.bucket_ms ?? NaN);
    const px = Number(r.min_px ?? NaN);
    if (!Number.isFinite(bm) || !Number.isFinite(px) || !(px > 0)) continue;
    out.push({ bucketMs: bm, minPx: px });
  }
  out.sort((a, b) => a.bucketMs - b.bucketMs);
  return out;
}

function touchesNearSupport(
  mins: Array<{ minPx: number }>,
  support: number,
  clusterPct: number,
): number {
  if (!(support > 0)) return 0;
  const lo = support * (1 - clusterPct / 100);
  const hi = support * (1 + clusterPct / 100);
  let n = 0;
  for (const m of mins) {
    if (m.minPx >= lo && m.minPx <= hi) n++;
  }
  return n;
}

/**
 * Pick the highest local-minimum "support" strictly below entry from an hourly min series.
 * If no strict local minima exist, fall back to the global minimum below entry.
 */
export function pickSupportBelowEntry(args: {
  hourlyMins: Array<{ minPx: number }>;
  entryPriceUsd: number;
  clusterPct: number;
  minTouches: number;
}): { support: number | null; clusterTouches: number; mode: 'local_min' | 'global_min' | 'none' } {
  const { hourlyMins, entryPriceUsd, clusterPct, minTouches } = args;
  if (!(entryPriceUsd > 0) || hourlyMins.length === 0) return { support: null, clusterTouches: 0, mode: 'none' };

  const pxSeries = hourlyMins.map((m) => m.minPx);
  const candidates: number[] = [];
  for (let i = 0; i < pxSeries.length; i++) {
    const v = pxSeries[i];
    if (!(v > 0) || !(v < entryPriceUsd)) continue;
    const left = i > 0 ? pxSeries[i - 1] : Number.POSITIVE_INFINITY;
    const right = i + 1 < pxSeries.length ? pxSeries[i + 1] : Number.POSITIVE_INFINITY;
    if (v < left && v < right) candidates.push(v);
  }

  const tryPick = (mode: 'local_min' | 'global_min', pool: number[]) => {
    const below = pool.filter((p) => p > 0 && p < entryPriceUsd);
    if (below.length === 0) return { support: null as number | null, clusterTouches: 0, mode: 'none' as const };
    below.sort((a, b) => b - a); // highest first (closest support under entry)
    for (const s of below) {
      const touches = touchesNearSupport(hourlyMins, s, clusterPct);
      if (touches >= minTouches) return { support: s, clusterTouches: touches, mode };
    }
    const s = below[0];
    return { support: s, clusterTouches: touchesNearSupport(hourlyMins, s, clusterPct), mode };
  };

  if (candidates.length > 0) {
    return tryPick('local_min', candidates);
  }

  // Fallback: global minimum below entry (still useful when the series is monotone / noisy).
  const belowAll = pxSeries.filter((p) => p > 0 && p < entryPriceUsd);
  if (!belowAll.length) return { support: null, clusterTouches: 0, mode: 'none' };
  const gmin = Math.min(...belowAll);
  if (!Number.isFinite(gmin)) return { support: null, clusterTouches: 0, mode: 'none' };
  const touches = touchesNearSupport(hourlyMins, gmin, clusterPct);
  return { support: gmin, clusterTouches: touches, mode: 'global_min' };
}

export async function computeDynamicKillstopShadowForOpen(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
}): Promise<DynamicKillstopShadow> {
  const { cfg, ot } = args;
  const ts = Date.now();
  const mint = ot.mint;
  const source = ot.source?.trim() || null;
  const pair = ot.pairAddress?.trim() ? ot.pairAddress.trim() : null;
  const table = source ? sourceSnapshotTable(source) : null;

  const windowDays = cfg.dynamicKillstopShadowWindowDays;
  const bufferPct = cfg.dynamicKillstopShadowBufferPct;
  const minKillDropPct = cfg.dynamicKillstopShadowMinKillDropPct;
  const maxKillDropPct = cfg.dynamicKillstopShadowMaxKillDropPct;
  const clusterPct = cfg.dynamicKillstopShadowSupportClusterPct;
  const minTouches = cfg.dynamicKillstopShadowMinTouches;
  const minHourly = cfg.dynamicKillstopShadowMinHourlySamples;

  const entryPriceUsd = ot.legs[0]?.marketPrice ?? ot.avgEntryMarket ?? ot.avgEntry;
  const entryMarketCapUsd = ot.metricType === 'mc' && Number.isFinite(ot.entryMcUsd) && ot.entryMcUsd > 0 ? ot.entryMcUsd : null;

  const base = (status: DynamicKillstopShadowStatus, reason: string, extra: Partial<DynamicKillstopShadow> = {}) => {
    const recommendedAction: DynamicKillstopShadow['recommendedAction'] =
      status.startsWith('used') ? 'use_dynamic' : 'fallback_static';
    const shadow: DynamicKillstopShadow = {
      version: 'dynamic-killstop-shadow-v1',
      status,
      recommendedAction,
      reason,
      ts,
      mint,
      source,
      table,
      pairAddress: pair,
      windowDays,
      entryPriceUsd,
      entryMarketCapUsd,
      supportPriceUsd: null,
      supportDistancePct: null,
      clusterTouches: 0,
      rawKillPriceUsd: null,
      rawKillDropPct: null,
      cappedKillPriceUsd: null,
      cappedKillDropPct: null,
      dcaPriceUsd: null,
      dcaDropPct: null,
      params: {
        bufferPct,
        minKillDropPct,
        maxKillDropPct,
        supportClusterPct: clusterPct,
        minTouches,
        minHourlySamples: minHourly,
      },
      coverage: {
        hourlySamples: 0,
        rawSamples: 0,
        firstTs: null,
        lastTs: null,
      },
      ...extra,
    };
    return shadow;
  };

  if (!cfg.dynamicKillstopShadowEnabled) {
    return base('fallback_disabled', 'shadow_disabled');
  }
  if (!table) {
    return base('fallback_no_table', `no_snapshot_table_for_source:${source ?? 'unknown'}`);
  }
  if (!(entryPriceUsd > 0)) {
    return base('fallback_bad_input', 'bad_entry_price');
  }

  const qm = sqlQuote(mint);
  const qp = pair ? sqlQuote(pair) : null;
  const pairClause = qp ? `pair_address::text = ${qp}` : 'true';

  try {
    const statsSql = `
      SELECT
        COUNT(*)::int AS raw_n,
        COUNT(DISTINCT date_trunc('hour', ts))::int AS hour_n,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts
      FROM ${table}
      WHERE base_mint = ${qm}
        AND ts >= now() - (${windowDays}::text || ' days')::interval
        AND COALESCE(price_usd, 0) > 0
        AND (${pairClause})
    `;
    const statsRes = await db.execute(dsql.raw(statsSql));
    const statsRow = (statsRes as unknown as Array<Record<string, unknown>>)[0] ?? {};
    const rawSamples = Number(statsRow.raw_n ?? 0);
    const hourlySamples = Number(statsRow.hour_n ?? 0);
    const firstTs = statsRow.first_ts != null ? String(statsRow.first_ts) : null;
    const lastTs = statsRow.last_ts != null ? String(statsRow.last_ts) : null;

    if (!(rawSamples > 0) || !(hourlySamples > 0)) {
      return base('fallback_no_history', 'no_rows_in_window', {
        coverage: { hourlySamples: 0, rawSamples: Math.max(0, rawSamples), firstTs, lastTs },
      });
    }
    if (hourlySamples < minHourly) {
      return base('fallback_low_coverage', `hourly_samples_${hourlySamples}_lt_${minHourly}`, {
        coverage: { hourlySamples, rawSamples, firstTs, lastTs },
      });
    }

    const seriesSql = `
      SELECT
        (EXTRACT(epoch FROM date_trunc('hour', ts)) * 1000)::bigint AS bucket_ms,
        MIN(COALESCE(price_usd, 0))::float8 AS min_px
      FROM ${table}
      WHERE base_mint = ${qm}
        AND ts >= now() - (${windowDays}::text || ' days')::interval
        AND COALESCE(price_usd, 0) > 0
        AND (${pairClause})
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const seriesRes = await db.execute(dsql.raw(seriesSql));
    const hourly = parseHourlyMins(seriesRes as unknown as HourlyMinRow[]);
    if (hourly.length === 0) {
      return base('fallback_no_history', 'hourly_series_empty', {
        coverage: { hourlySamples, rawSamples, firstTs, lastTs },
      });
    }

    const picked = pickSupportBelowEntry({
      hourlyMins: hourly,
      entryPriceUsd,
      clusterPct,
      minTouches,
    });
    if (picked.support == null) {
      return base('fallback_no_support_below_entry', 'no_support_below_entry', {
        coverage: { hourlySamples: hourly.length, rawSamples, firstTs, lastTs },
      });
    }

    const support = picked.support;
    const supportDistancePct = pctFromEntry(entryPriceUsd, support);
    if (Number.isFinite(supportDistancePct) && supportDistancePct < -maxKillDropPct) {
      return base(
        'fallback_support_too_far',
        `support_too_far_${supportDistancePct.toFixed(2)}pct_lt_neg_${maxKillDropPct}`,
        {
          supportPriceUsd: support,
          supportDistancePct: Number.isFinite(supportDistancePct) ? supportDistancePct : null,
          clusterTouches: picked.clusterTouches,
          coverage: { hourlySamples: hourly.length, rawSamples, firstTs, lastTs },
        },
      );
    }

    const rawKillPriceUsd = support * (1 - bufferPct / 100);
    const rawKillDropPct = pctFromEntry(entryPriceUsd, rawKillPriceUsd);
    const clamped = clampKillPriceUsd({
      entryPriceUsd,
      rawKillPriceUsd,
      minKillDropPct,
      maxKillDropPct,
    });
    const cappedKillPriceUsd = clamped.cappedKillPriceUsd;
    const cappedKillDropPct = pctFromEntry(entryPriceUsd, cappedKillPriceUsd);
    const dcaPriceUsd = (entryPriceUsd + cappedKillPriceUsd) / 2;
    const dcaDropPct = pctFromEntry(entryPriceUsd, dcaPriceUsd);

    const minCapped = clamped.flags.includes('min_capped');
    const maxCapped = clamped.flags.includes('max_capped');
    const status: DynamicKillstopShadowStatus =
      minCapped || maxCapped ? 'used_min_capped' : 'used';

    return {
      version: 'dynamic-killstop-shadow-v1',
      status,
      recommendedAction: 'use_dynamic',
      reason:
        `ok:${picked.mode}` +
        (minCapped || maxCapped ? `:${clamped.flags.join(',')}` : '') +
        `:touches=${picked.clusterTouches}`,
      ts,
      mint,
      source,
      table,
      pairAddress: pair,
      windowDays,
      entryPriceUsd,
      entryMarketCapUsd,
      supportPriceUsd: support,
      supportDistancePct: Number.isFinite(supportDistancePct) ? supportDistancePct : null,
      clusterTouches: picked.clusterTouches,
      rawKillPriceUsd,
      rawKillDropPct: Number.isFinite(rawKillDropPct) ? rawKillDropPct : null,
      cappedKillPriceUsd,
      cappedKillDropPct: Number.isFinite(cappedKillDropPct) ? cappedKillDropPct : null,
      dcaPriceUsd: Number.isFinite(dcaPriceUsd) ? dcaPriceUsd : null,
      dcaDropPct: Number.isFinite(dcaDropPct) ? dcaDropPct : null,
      params: {
        bufferPct,
        minKillDropPct,
        maxKillDropPct,
        supportClusterPct: clusterPct,
        minTouches,
        minHourlySamples: minHourly,
      },
      coverage: { hourlySamples: hourly.length, rawSamples, firstTs, lastTs },
    };
  } catch (e) {
    return base('fallback_query_error', `pg:${(e as Error)?.message?.slice(0, 200) ?? 'unknown'}`);
  }
}
