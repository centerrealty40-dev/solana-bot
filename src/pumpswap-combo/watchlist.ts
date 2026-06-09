import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PumpswapComboConfig } from './config.js';
import type { WatchlistRow } from './types.js';

/** PumpSwap direct executor spends wrapped SOL — USDC-quoted pools fail sim (Token insufficient funds). */
export const PUMPSWAP_WSOL_QUOTE_MINT = 'So11111111111111111111111111111111111111112';

let cache: { at: number; rows: WatchlistRow[] } | null = null;

function mapPgRow(row: Record<string, unknown>, now: number): WatchlistRow {
  const mint = String(row.base_mint ?? '');
  return {
    mint,
    symbol: mint.slice(0, 6),
    pairAddress: String(row.pair_address ?? ''),
    priceUsd: Number(row.price_usd ?? 0),
    liquidityUsd: Number(row.liquidity_usd ?? 0),
    volume5mUsd: Number(row.volume_5m ?? 0),
    marketCapUsd: Number(row.market_cap_usd ?? 0),
    snapshotTs: Number(row.snapshot_ts ?? now),
    high15mUsd: Number(row.high_15m ?? row.price_usd ?? 0),
    low15mUsd: Number(row.low_15m ?? row.price_usd ?? 0),
    low15mTs: Number(row.low_15m_ts ?? row.snapshot_ts ?? now),
  };
}

async function fetchPgWatchlistCore(cfg: PumpswapComboConfig, limit: number): Promise<WatchlistRow[]> {
  const now = Date.now();
  const windowMin = Math.max(1, Math.round(cfg.rollingHighWindowMs / 60_000));
  const lookbackMin = 45;

  const r = await db.execute(dsql.raw(`
    WITH latest AS (
      SELECT DISTINCT ON (base_mint)
        base_mint,
        pair_address,
        COALESCE(price_usd, 0)::float AS price_usd,
        COALESCE(liquidity_usd, 0)::float AS liquidity_usd,
        COALESCE(volume_5m, 0)::float AS volume_5m,
        COALESCE(market_cap_usd, fdv_usd, 0)::float AS market_cap_usd,
        EXTRACT(EPOCH FROM ts)::float * 1000 AS snapshot_ts
      FROM pumpswap_pair_snapshots
      WHERE ts >= now() - interval '${lookbackMin} minutes'
        AND quote_mint = '${PUMPSWAP_WSOL_QUOTE_MINT}'
        AND COALESCE(price_usd, 0) > 0
        AND COALESCE(liquidity_usd, 0) >= ${cfg.minLiquidityUsd}
        AND COALESCE(volume_5m, 0) >= ${cfg.minVolume5mUsd}
        AND COALESCE(market_cap_usd, fdv_usd, 0) >= ${cfg.minMarketCapUsd}
        AND COALESCE(market_cap_usd, fdv_usd, 0) <= ${cfg.maxMarketCapUsd}
      ORDER BY base_mint, ts DESC
    ),
    highs AS (
      SELECT base_mint,
        MAX(COALESCE(price_usd, 0)::float) AS high_15m,
        MIN(COALESCE(price_usd, 0)::float) AS low_15m
      FROM pumpswap_pair_snapshots
      WHERE ts >= now() - interval '${windowMin} minutes'
        AND quote_mint = '${PUMPSWAP_WSOL_QUOTE_MINT}'
        AND COALESCE(price_usd, 0) > 0
      GROUP BY base_mint
    ),
    low_pts AS (
      SELECT DISTINCT ON (base_mint)
        base_mint,
        EXTRACT(EPOCH FROM ts)::float * 1000 AS low_15m_ts
      FROM pumpswap_pair_snapshots
      WHERE ts >= now() - interval '${windowMin} minutes'
        AND quote_mint = '${PUMPSWAP_WSOL_QUOTE_MINT}'
        AND COALESCE(price_usd, 0) > 0
      ORDER BY base_mint, price_usd ASC, ts DESC
    )
    SELECT l.*,
      COALESCE(h.high_15m, l.price_usd)::float AS high_15m,
      COALESCE(h.low_15m, l.price_usd)::float AS low_15m,
      COALESCE(lp.low_15m_ts, l.snapshot_ts)::float AS low_15m_ts
    FROM latest l
    LEFT JOIN highs h ON h.base_mint = l.base_mint
    LEFT JOIN low_pts lp ON lp.base_mint = l.base_mint
    ORDER BY l.volume_5m DESC NULLS LAST, l.liquidity_usd DESC NULLS LAST
    LIMIT ${Math.max(1, limit)}
  `));

  return (r as unknown as Array<Record<string, unknown>>).map((row) => mapPgRow(row, now));
}

/** PG-only watchlist — autonomous discovery, no leader wallet. */
export async function fetchComboWatchlist(cfg: PumpswapComboConfig): Promise<WatchlistRow[]> {
  const ttl = Math.max(2000, cfg.pollIntervalMs - 500);
  const now = Date.now();
  if (cache && now - cache.at < ttl) return cache.rows;

  const rows = await fetchPgWatchlistCore(cfg, cfg.watchlistMax);
  cache = { at: now, rows };
  return rows;
}

/** Latest PumpSwap pool for mint — PG then canonical PDA via resolveMintPumpPool. */
export async function fetchMintPoolAddress(mint: string): Promise<string | null> {
  return fetchMintPoolAddressFromPg(mint);
}

/** PG pair lookup with extended lookback. */
export async function fetchMintPoolAddressFromPg(mint: string): Promise<string | null> {
  const r = await db.execute(dsql.raw(`
    SELECT pair_address
    FROM pumpswap_pair_snapshots
    WHERE base_mint = '${mint.replace(/'/g, "''")}'
      AND quote_mint = '${PUMPSWAP_WSOL_QUOTE_MINT}'
      AND ts >= now() - interval '30 days'
      AND pair_address IS NOT NULL
      AND pair_address <> ''
    ORDER BY ts DESC
    LIMIT 1
  `));
  const row = (r as unknown as Array<{ pair_address: string }>)[0];
  const addr = row?.pair_address?.trim();
  return addr ? addr : null;
}

/** PG spot — только сигнал входа, не SL/TP. */
export async function fetchMintSignalPrice(mint: string): Promise<number | null> {
  const r = await db.execute(dsql.raw(`
    SELECT COALESCE(price_usd, 0)::float AS price_usd
    FROM pumpswap_pair_snapshots
    WHERE base_mint = '${mint.replace(/'/g, "''")}'
      AND ts >= now() - interval '20 minutes'
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts DESC
    LIMIT 1
  `));
  const row = (r as unknown as Array<{ price_usd: number }>)[0];
  return row?.price_usd > 0 ? row.price_usd : null;
}

/** Test helper */
export function resetComboWatchlistCacheForTests(): void {
  cache = null;
}
