/**
 * Range-base dip (1.11.587): sideways 48h compression + flush from range low.
 *
 * When standard dip windows fail (`dip_no_window_pass`) because impulse is flat in
 * 2h/6h/12h windows, allow entry if:
 *  - 48h range span is tight (sideways base)
 *  - net 48h move is small (not trending)
 *  - price dumps from 48h range low with live vol5m spike
 */

import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { SnapshotCandidateRow } from '../types.js';
import { sourceSnapshotTable } from '../dip-detector.js';

export interface RangeBaseDipFeatures {
  lookbackHours: number;
  rangeLo: number | null;
  rangeHi: number | null;
  rangeAvg: number | null;
  rangeSpanPct: number | null;
  netMove48hPct: number | null;
  dropFromRangeLowPct: number | null;
  vol5mSpikeRatio: number | null;
  pgSnapsCount: number;
  coverageOk: boolean;
}

export interface RangeBaseDipResult {
  pass: boolean;
  reasons: string[];
  features: RangeBaseDipFeatures;
  dipLookbackUsedMin: number | null;
  dipPct: number | null;
  impulsePct: number | null;
}

const EMPTY: RangeBaseDipFeatures = {
  lookbackHours: 48,
  rangeLo: null,
  rangeHi: null,
  rangeAvg: null,
  rangeSpanPct: null,
  netMove48hPct: null,
  dropFromRangeLowPct: null,
  vol5mSpikeRatio: null,
  pgSnapsCount: 0,
  coverageOk: false,
};

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function emptyFeatures(cfg: PaperTraderConfig): RangeBaseDipFeatures {
  return { ...EMPTY, lookbackHours: cfg.dipRangeBaseLookbackHours };
}

interface AggRow {
  mint: string;
  range_lo: number | null;
  range_hi: number | null;
  range_avg: number | null;
  first_px: number | null;
  last_px: number | null;
  snaps_count: number | null;
}

function rangeBaseSql(table: string, mintsSql: string, lookbackHours: number): string {
  return `
    WITH bars AS (
      SELECT base_mint AS mint, ts,
             COALESCE(price_usd, 0)::float AS px
        FROM ${table}
       WHERE base_mint IN (${mintsSql})
         AND ts >= now() - interval '${lookbackHours} hours'
         AND COALESCE(price_usd, 0) > 0
    ),
    per_mint AS (
      SELECT
        mint,
        MIN(px)::float AS range_lo,
        MAX(px)::float AS range_hi,
        AVG(px)::float AS range_avg,
        (array_agg(px ORDER BY ts ASC))[1]::float AS first_px,
        (array_agg(px ORDER BY ts DESC))[1]::float AS last_px,
        COUNT(*)::int AS snaps_count
      FROM bars
      GROUP BY mint
    )
    SELECT * FROM per_mint
  `;
}

function mapRow(cfg: PaperTraderConfig, row: AggRow): RangeBaseDipFeatures {
  const lo = Number(row.range_lo ?? 0);
  const hi = Number(row.range_hi ?? 0);
  const avg = Number(row.range_avg ?? 0);
  const first = Number(row.first_px ?? 0);
  const last = Number(row.last_px ?? 0);
  const snaps = Number(row.snaps_count ?? 0) | 0;
  const spanPct =
    lo > 0 && hi > 0 && avg > 0 ? +(((hi - lo) / avg) * 100).toFixed(3) : null;
  const netMove =
    first > 0 && last > 0 ? +(((last - first) / first) * 100).toFixed(3) : null;
  return {
    lookbackHours: cfg.dipRangeBaseLookbackHours,
    rangeLo: lo > 0 ? lo : null,
    rangeHi: hi > 0 ? hi : null,
    rangeAvg: avg > 0 ? avg : null,
    rangeSpanPct: spanPct,
    netMove48hPct: netMove,
    dropFromRangeLowPct: null,
    vol5mSpikeRatio: null,
    pgSnapsCount: snaps,
    coverageOk: snaps >= cfg.dipRangeBaseMinPgSamples,
  };
}

export async function fetchRangeBaseDipContextMap(
  cfg: PaperTraderConfig,
  rows: SnapshotCandidateRow[],
): Promise<Map<string, RangeBaseDipFeatures>> {
  const map = new Map<string, RangeBaseDipFeatures>();
  if (!cfg.dipRangeBaseEnabled || rows.length === 0) return map;

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
    const sqlText = rangeBaseSql(
      table,
      uniq.map(sqlQuote).join(','),
      cfg.dipRangeBaseLookbackHours,
    );
    const r = (await db.execute(dsql.raw(sqlText))) as unknown as AggRow[];
    for (const row of r) {
      map.set(String(row.mint), mapRow(cfg, row));
    }
  }
  return map;
}

export function evaluateRangeBaseDip(
  cfg: PaperTraderConfig,
  row: SnapshotCandidateRow,
  ctx?: RangeBaseDipFeatures,
): RangeBaseDipResult {
  const features: RangeBaseDipFeatures = ctx ?? emptyFeatures(cfg);
  const px = Number(row.price_usd ?? 0);
  const vol5m = Number(row.volume_5m ?? 0);
  const vol1h = Number(row.volume_1h ?? 0);
  const lookbackMin = cfg.dipRangeBaseLookbackHours * 60;

  if (features.rangeLo != null && features.rangeLo > 0 && px > 0) {
    features.dropFromRangeLowPct = +((px / features.rangeLo - 1) * 100).toFixed(3);
  }
  if (vol1h > 0 && vol5m > 0) {
    features.vol5mSpikeRatio = +(vol5m / (vol1h / 12)).toFixed(2);
  }

  if (!cfg.dipRangeBaseEnabled) {
    return {
      pass: false,
      reasons: [],
      features,
      dipLookbackUsedMin: null,
      dipPct: null,
      impulsePct: null,
    };
  }
  if ((row.token_age_min ?? 0) < cfg.dipMinAgeMin) {
    return {
      pass: false,
      reasons: [`range_base_age<${cfg.dipMinAgeMin}m`],
      features,
      dipLookbackUsedMin: null,
      dipPct: null,
      impulsePct: null,
    };
  }
  if (!features.coverageOk) {
    return { pass: false, reasons: [], features, dipLookbackUsedMin: null, dipPct: null, impulsePct: null };
  }

  const reasons: string[] = [];

  if (features.rangeSpanPct == null) {
    reasons.push('range_base_span_unknown');
  } else if (features.rangeSpanPct > cfg.dipRangeBaseMaxSpanPct) {
    reasons.push(
      `range_base_span${features.rangeSpanPct.toFixed(1)}%>${cfg.dipRangeBaseMaxSpanPct}%`,
    );
  }

  if (features.netMove48hPct == null) {
    reasons.push('range_base_net_move_unknown');
  } else if (Math.abs(features.netMove48hPct) >= cfg.dipRangeBaseMaxNetMovePct) {
    reasons.push(
      `range_base_net_move${features.netMove48hPct.toFixed(1)}%>=${cfg.dipRangeBaseMaxNetMovePct}%`,
    );
  }

  if (features.vol5mSpikeRatio == null || features.vol5mSpikeRatio <= 0) {
    reasons.push('range_base_no_vol5m_spike');
  } else if (features.vol5mSpikeRatio + 1e-9 < cfg.dipRangeBaseMinVol5mSpikeMult) {
    reasons.push(
      `range_base_vol5m_spike<${cfg.dipRangeBaseMinVol5mSpikeMult}x(${features.vol5mSpikeRatio.toFixed(1)}x)`,
    );
  }

  if (features.dropFromRangeLowPct == null) {
    reasons.push('range_base_drop_unknown');
  } else {
    if (features.dropFromRangeLowPct > cfg.dipMinDropPct) {
      reasons.push(
        `range_base_drop${features.dropFromRangeLowPct.toFixed(1)}%>${cfg.dipMinDropPct}%`,
      );
    }
    if (features.dropFromRangeLowPct < cfg.dipMaxDropPct) {
      reasons.push(
        `range_base_drop${features.dropFromRangeLowPct.toFixed(1)}%<${cfg.dipMaxDropPct}%`,
      );
    }
  }

  const impulsePct =
    features.rangeLo != null && features.rangeHi != null && features.rangeLo > 0
      ? +((features.rangeHi / features.rangeLo - 1) * 100).toFixed(2)
      : null;

  if (reasons.length > 0) {
    return {
      pass: false,
      reasons,
      features,
      dipLookbackUsedMin: null,
      dipPct: features.dropFromRangeLowPct,
      impulsePct,
    };
  }

  return {
    pass: true,
    reasons: [
      `range_base_dip:span${features.rangeSpanPct!.toFixed(1)}%_net${features.netMove48hPct!.toFixed(1)}%_drop${features.dropFromRangeLowPct!.toFixed(1)}%_vol5m${features.vol5mSpikeRatio!.toFixed(1)}x`,
    ],
    features,
    dipLookbackUsedMin: lookbackMin,
    dipPct: features.dropFromRangeLowPct,
    impulsePct,
  };
}
