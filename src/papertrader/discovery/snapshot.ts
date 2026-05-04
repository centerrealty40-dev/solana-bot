import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow } from '../types.js';
import { laneCfg } from '../filters/snapshot-filter.js';

const SNAPSHOT_TABLES: Array<{ table: string; source: string }> = [
  { table: 'raydium_pair_snapshots', source: 'raydium' },
  { table: 'meteora_pair_snapshots', source: 'meteora' },
  { table: 'orca_pair_snapshots', source: 'orca' },
  { table: 'moonshot_pair_snapshots', source: 'moonshot' },
  { table: 'pumpswap_pair_snapshots', source: 'pumpswap' },
];

export async function fetchSnapshotLaneCandidates(
  cfg: PaperTraderConfig,
  lane: Lane,
): Promise<SnapshotCandidateRow[]> {
  const lc = laneCfg(cfg, lane);
  const unions = SNAPSHOT_TABLES.map(
    (t) => `
    SELECT
      p.base_mint AS mint,
      COALESCE(tok.symbol, '?') AS symbol,
      COALESCE(tok.holder_count, 0)::int AS holder_count,
      EXTRACT(EPOCH FROM (now() - COALESCE(tok.first_seen_at, p.ts))) / 60.0 AS token_age_min,
      p.ts,
      NULL::timestamptz AS launch_ts,
      EXTRACT(EPOCH FROM (p.ts - COALESCE(tok.first_seen_at, p.ts))) / 60.0 AS age_min,
      COALESCE(p.price_usd, 0)::float AS price_usd,
      COALESCE(p.liquidity_usd, 0)::float AS liquidity_usd,
      COALESCE(p.volume_5m, 0)::float AS volume_5m,
      COALESCE(p.volume_1h, 0)::float AS volume_1h,
      COALESCE(p.buys_5m, 0)::int AS buys_5m,
      COALESCE(p.sells_5m, 0)::int AS sells_5m,
      COALESCE(p.market_cap_usd, p.fdv_usd, 0)::float AS market_cap_usd,
      p.pair_address::text AS pair_address,
      '${t.source}'::text AS source
    FROM ${t.table} p
    LEFT JOIN tokens tok ON tok.mint = p.base_mint
    WHERE p.ts >= now() - interval '30 minutes'
      AND COALESCE(p.price_usd, 0) > 0
  `,
  ).join('\nUNION ALL\n');

  const maxAgeFilter = lc.MAX_AGE_MIN > 0 ? `AND COALESCE(age_min, 0) <= ${lc.MAX_AGE_MIN}` : '';

  const r = await db.execute(dsql.raw(`
    WITH raw AS (
      ${unions}
    ),
    ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY mint ORDER BY ts DESC) AS rn
      FROM raw
    )
    SELECT *
    FROM ranked
    WHERE rn = 1
      AND COALESCE(age_min, 0) >= ${lc.MIN_AGE_MIN}
      ${maxAgeFilter}
      AND liquidity_usd >= ${lc.MIN_LIQ_USD}
      AND volume_5m >= ${lc.MIN_VOL_5M_USD}
      AND buys_5m >= ${lc.MIN_BUYS_5M}
      AND sells_5m >= ${lc.MIN_SELLS_5M}
    ORDER BY ts DESC
    LIMIT ${cfg.snapshotCandidateLimit}
  `));
  return r as unknown as SnapshotCandidateRow[];
}
