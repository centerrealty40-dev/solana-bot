import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';
import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow } from '../types.js';
import { laneCfg } from '../filters/snapshot-filter.js';
import { CANONICAL_SNAPSHOT_ROW_ORDER_SQL, canonicalPoolLookbackMinutes } from './snapshot-canonical-pick.js';

export {
  pickCanonicalSnapshotRow,
  pickCanonicalSnapshotRowWithFreshQuote,
  dedupeSnapshotTaggedByMintCanonical,
  CANONICAL_SNAPSHOT_ROW_ORDER_SQL,
  canonicalPoolLookbackMinutes,
} from './snapshot-canonical-pick.js';

function sqlQuoteMint(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

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
  /** Pool/token age anchor: pair launch when collectors filled `launch_ts` (DexScreener `pairCreatedAt`, etc.), else first time we saw the mint in `tokens`. */
  const unions = SNAPSHOT_TABLES.map(
    (t) => `
    SELECT
      p.base_mint AS mint,
      COALESCE(tok.symbol, '?') AS symbol,
      COALESCE(tok.holder_count, 0)::int AS holder_count,
      EXTRACT(EPOCH FROM (now() - COALESCE(p.launch_ts, tok.first_seen_at, p.ts))) / 60.0 AS token_age_min,
      p.ts,
      p.launch_ts AS launch_ts,
      EXTRACT(EPOCH FROM (p.ts - COALESCE(p.launch_ts, tok.first_seen_at, p.ts))) / 60.0 AS age_min,
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
  const maxLiqFilter = lc.MAX_LIQ_USD > 0 ? `AND liquidity_usd <= ${lc.MAX_LIQ_USD}` : '';
  const maxVol5mFilter = lc.MAX_VOL_5M_USD > 0 ? `AND volume_5m <= ${lc.MAX_VOL_5M_USD}` : '';
  const minMcapFilter =
    cfg.discoveryMinMarketCapUsd > 0
      ? `AND COALESCE(market_cap_usd, 0) >= ${cfg.discoveryMinMarketCapUsd}`
      : '';

  const r = await db.execute(dsql.raw(`
    WITH raw AS (
      ${unions}
    ),
    eligible AS (
      SELECT *
      FROM raw
      WHERE COALESCE(age_min, 0) >= ${lc.MIN_AGE_MIN}
        ${maxAgeFilter}
        AND liquidity_usd >= ${lc.MIN_LIQ_USD}
        ${maxLiqFilter}
        AND volume_5m >= ${lc.MIN_VOL_5M_USD}
        ${maxVol5mFilter}
        AND buys_5m >= ${lc.MIN_BUYS_5M}
        AND sells_5m >= ${lc.MIN_SELLS_5M}
        ${minMcapFilter}
    ),
    ranked AS (
      SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY mint
               ORDER BY ${CANONICAL_SNAPSHOT_ROW_ORDER_SQL}
             ) AS rn
      FROM eligible
    )
    SELECT *
    FROM ranked
    WHERE rn = 1
    ORDER BY ${CANONICAL_SNAPSHOT_ROW_ORDER_SQL}
    LIMIT ${cfg.snapshotCandidateLimit}
  `));
  return r as unknown as SnapshotCandidateRow[];
}

function mapSnapshotRow(row: Record<string, unknown>, source: string): SnapshotCandidateRow {
  return {
    mint: String(row.mint ?? ''),
    symbol: String(row.symbol ?? '?'),
    holder_count: Number(row.holder_count ?? 0),
    token_age_min: Number(row.token_age_min ?? 0),
    ts: row.ts as Date | string,
    launch_ts: (row.launch_ts as Date | string | null) ?? null,
    age_min: row.age_min != null ? Number(row.age_min) : null,
    price_usd: Number(row.price_usd ?? 0),
    liquidity_usd: Number(row.liquidity_usd ?? 0),
    volume_5m: Number(row.volume_5m ?? 0),
    volume_1h: Number(row.volume_1h ?? 0),
    buys_5m: Number(row.buys_5m ?? 0),
    sells_5m: Number(row.sells_5m ?? 0),
    market_cap_usd: row.market_cap_usd != null ? Number(row.market_cap_usd) : null,
    pair_address: row.pair_address != null ? String(row.pair_address) : null,
    source,
  };
}

/**
 * Latest snapshot row for a mint across all collector tables (last N minutes, price > 0).
 * Канонический пул = max `liquidity_usd` среди свежих пар всех DEX (не «самый новый ts» на мёртвом пуле).
 */
export async function fetchLatestCrossVenueSnapshotRowForMint(
  mint: string,
  opts?: { lookbackMinutes?: number },
): Promise<SnapshotCandidateRow | null> {
  const m = mint.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(m)) return null;
  const lookbackMin =
    opts?.lookbackMinutes != null && Number.isFinite(opts.lookbackMinutes) && opts.lookbackMinutes > 0
      ? Math.floor(opts.lookbackMinutes)
      : canonicalPoolLookbackMinutes();
  const qm = sqlQuoteMint(m);
  const unions = SNAPSHOT_TABLES.map(
    (t) => `
    SELECT
      p.base_mint AS mint,
      COALESCE(tok.symbol, '?') AS symbol,
      COALESCE(tok.holder_count, 0)::int AS holder_count,
      EXTRACT(EPOCH FROM (now() - COALESCE(p.launch_ts, tok.first_seen_at, p.ts))) / 60.0 AS token_age_min,
      p.ts,
      p.launch_ts AS launch_ts,
      EXTRACT(EPOCH FROM (p.ts - COALESCE(p.launch_ts, tok.first_seen_at, p.ts))) / 60.0 AS age_min,
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
    WHERE p.base_mint = ${qm}
      AND p.ts >= now() - interval '${lookbackMin} minutes'
      AND COALESCE(p.price_usd, 0) > 0
  `,
  ).join('\nUNION ALL\n');

  const r = await db.execute(dsql.raw(`
    WITH raw AS (
      ${unions}
    ),
    canonical AS (
      SELECT *,
             ROW_NUMBER() OVER (
               ORDER BY ${CANONICAL_SNAPSHOT_ROW_ORDER_SQL}
             ) AS rn_canon
      FROM raw
    ),
    best AS (
      SELECT * FROM canonical WHERE rn_canon = 1
    ),
    fresh AS (
      SELECT r.*,
             ROW_NUMBER() OVER (ORDER BY r.ts DESC) AS rn_fresh
      FROM raw r
      INNER JOIN best b ON r.pair_address = b.pair_address
    )
    SELECT
      b.mint,
      b.symbol,
      b.holder_count,
      b.token_age_min,
      COALESCE(f.ts, b.ts) AS ts,
      b.launch_ts,
      b.age_min,
      COALESCE(f.price_usd, b.price_usd) AS price_usd,
      b.price_usd AS ref_price_usd,
      b.liquidity_usd,
      COALESCE(f.volume_5m, b.volume_5m) AS volume_5m,
      COALESCE(f.volume_1h, b.volume_1h) AS volume_1h,
      COALESCE(f.buys_5m, b.buys_5m) AS buys_5m,
      COALESCE(f.sells_5m, b.sells_5m) AS sells_5m,
      b.market_cap_usd,
      b.pair_address,
      b.source
    FROM best b
    LEFT JOIN fresh f ON f.rn_fresh = 1
  `));
  const rows = r as unknown as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  const mapped = mapSnapshotRow(row, String(row.source ?? '?'));
  const refPx = Number(row.ref_price_usd ?? mapped.price_usd ?? 0);
  const px = mapped.price_usd;
  if (refPx > 0 && px > 0 && mapped.market_cap_usd != null && mapped.market_cap_usd > 0 && px !== refPx) {
    mapped.market_cap_usd = mapped.market_cap_usd * (px / refPx);
  }
  return mapped;
}
