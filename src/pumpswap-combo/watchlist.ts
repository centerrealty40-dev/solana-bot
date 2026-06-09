import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PumpswapComboConfig } from './config.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { fetchShadowBuyMints, type ShadowBuyMint } from './shadow-wallet.js';
import { resolveMintPumpPool } from './pool-resolve.js';
import { quotePumpSwapSpotPriceUsd } from './pumpswap-direct.js';
import type { WatchlistRow } from './types.js';

/** PumpSwap direct executor spends wrapped SOL — USDC-quoted pools fail sim (Token insufficient funds). */
export const PUMPSWAP_WSOL_QUOTE_MINT = 'So11111111111111111111111111111111111111112';

let cache: { at: number; rows: WatchlistRow[] } | null = null;

type PgWatchlistOpts = {
  /** Skip vol5m filter — shadow + broad discovery. */
  relaxed?: boolean;
  lookbackMinutes?: number;
};

function mapPgRow(row: Record<string, unknown>, now: number, fromShadow = false): WatchlistRow {
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
    fromShadow,
  };
}

function mintInClause(mints: string[]): string {
  return mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(',');
}

async function fetchPgWatchlistCore(
  cfg: PumpswapComboConfig,
  limit: number,
  mintFilter?: string[],
  opts?: PgWatchlistOpts,
): Promise<WatchlistRow[]> {
  const now = Date.now();
  const windowMin = Math.max(1, Math.round(cfg.rollingHighWindowMs / 60_000));
  const lookbackMin = opts?.lookbackMinutes ?? 45;
  const volFilter = opts?.relaxed
    ? ''
    : `AND COALESCE(volume_5m, 0) >= ${cfg.minVolume5mUsd}`;
  const mintWhere =
    mintFilter?.length ? `AND base_mint IN (${mintInClause(mintFilter)})` : '';

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
        ${volFilter}
        AND COALESCE(market_cap_usd, fdv_usd, 0) >= ${cfg.minMarketCapUsd}
        AND COALESCE(market_cap_usd, fdv_usd, 0) <= ${cfg.maxMarketCapUsd}
        ${mintWhere}
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
        ${mintWhere}
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
        ${mintWhere}
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

async function buildShadowWatchlistRow(
  cfg: PumpswapComboConfig,
  buy: ShadowBuyMint,
  now: number,
): Promise<WatchlistRow | null> {
  const pool = await resolveMintPumpPool(cfg.rpcUrl, buy.mint);
  if (!pool) return null;

  let priceUsd = buy.fillPriceUsd;
  if (!(priceUsd > 0)) {
    priceUsd = (await quotePumpSwapSpotPriceUsd({ rpcUrl: cfg.rpcUrl, poolAddress: pool })) ?? 0;
  }
  if (!(priceUsd > 0)) return null;

  const refHigh = buy.fillPriceUsd > 0 ? Math.max(priceUsd, buy.fillPriceUsd) : priceUsd;
  return {
    mint: buy.mint,
    symbol: buy.mint.slice(0, 6),
    pairAddress: pool,
    priceUsd,
    liquidityUsd: cfg.minLiquidityUsd,
    volume5mUsd: 0,
    marketCapUsd: cfg.minMarketCapUsd,
    snapshotTs: now,
    high15mUsd: refHigh * 1.05,
    low15mUsd: priceUsd,
    low15mTs: buy.boughtAtMs,
    fromShadow: true,
  };
}

export async function fetchComboWatchlist(cfg: PumpswapComboConfig): Promise<WatchlistRow[]> {
  const ttl = Math.max(2000, cfg.pollIntervalMs - 500);
  const now = Date.now();
  if (cache && now - cache.at < ttl) return cache.rows;

  const shadowBuys = cfg.shadowWalletEnabled
    ? await fetchShadowBuyMints(cfg, getSolUsd())
    : [];
  const shadowSet = new Set(shadowBuys.map((s) => s.mint));

  const shadowPgRows =
    shadowBuys.length > 0
      ? (
          await fetchPgWatchlistCore(cfg, shadowBuys.length, shadowBuys.map((s) => s.mint), {
            relaxed: true,
            lookbackMinutes: 7 * 24 * 60,
          })
        ).map((r) => ({ ...r, fromShadow: true }))
      : [];
  const shadowPgByMint = new Map(shadowPgRows.map((r) => [r.mint, r]));

  const shadowRows: WatchlistRow[] = [];
  for (const buy of shadowBuys) {
    const enriched = shadowPgByMint.get(buy.mint);
    if (enriched) {
      shadowRows.push(enriched);
      continue;
    }
    const built = await buildShadowWatchlistRow(cfg, buy, now);
    if (built) shadowRows.push(built);
  }

  const have = new Set(shadowRows.map((r) => r.mint));
  const pgLimit = Math.max(5, cfg.watchlistMax - shadowRows.length);
  const pgRows = await fetchPgWatchlistCore(cfg, pgLimit, undefined, { relaxed: true });
  const merged: WatchlistRow[] = [...shadowRows];
  for (const row of pgRows) {
    if (have.has(row.mint)) continue;
    merged.push({ ...row, fromShadow: shadowSet.has(row.mint) });
    have.add(row.mint);
    if (merged.length >= cfg.watchlistMax) break;
  }

  cache = { at: now, rows: merged };
  return merged;
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
