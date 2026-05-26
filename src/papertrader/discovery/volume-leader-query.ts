import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';

const SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

let cache: { fetchedAtMs: number; mints: string[] } | null = null;

/** Top mints by peak volume_1h over lookback window (cross-DEX). Cached to limit PG load. */
export async function fetchVolumeLeaderMints(cfg: PaperTraderConfig): Promise<string[]> {
  if (!cfg.volumeLeaderEnabled) return [];

  const cacheMs = cfg.volumeLeaderQueryCacheSec * 1000;
  const now = Date.now();
  if (cache && now - cache.fetchedAtMs < cacheMs) {
    return cache.mints;
  }

  const lookbackH = Math.max(1, Math.min(48, cfg.volumeLeaderLookbackHours));
  const topN = Math.max(5, Math.min(100, cfg.volumeLeaderTopN));

  const unions = SNAPSHOT_TABLES.map(
    (table) => `
    SELECT base_mint::text AS mint, COALESCE(volume_1h, 0)::float AS volume_1h
    FROM ${table}
    WHERE ts >= now() - interval '${lookbackH} hours'
      AND COALESCE(price_usd, 0) > 0
  `,
  ).join('\nUNION ALL\n');

  const r = await db.execute(dsql.raw(`
    WITH raw AS (
      ${unions}
    ),
    peak AS (
      SELECT mint, MAX(volume_1h)::float AS peak_vol_1h
      FROM raw
      GROUP BY mint
      HAVING MAX(volume_1h) > 0
    )
    SELECT mint::text AS mint
    FROM peak
    ORDER BY peak_vol_1h DESC
    LIMIT ${topN}
  `));

  const rows = r as unknown as Array<{ mint: string }>;
  const mints = (Array.isArray(rows) ? rows : [])
    .map((row) => String(row.mint ?? '').trim())
    .filter((m) => m.length >= 32);

  cache = { fetchedAtMs: now, mints };
  return mints;
}

/** Test helper — сброс in-memory кэша списка лидеров. */
export function resetVolumeLeaderMintCacheForTests(): void {
  cache = null;
}
