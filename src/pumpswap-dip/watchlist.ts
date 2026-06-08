import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import type { PumpswapDipConfig } from './config.js';
import type { WatchlistRow } from './types.js';

export async function fetchPumpswapWatchlist(cfg: PumpswapDipConfig): Promise<WatchlistRow[]> {
  const limit = Math.max(5, cfg.watchlistMax);
  const minLiq = cfg.minLiquidityUsd;
  const minMcap = cfg.minMarketCapUsd;
  const maxMcap = cfg.maxMarketCapUsd;
  const minVol5m = cfg.minVolume5mUsd;

  const r = await db.execute(dsql.raw(`
    WITH latest AS (
      SELECT DISTINCT ON (p.base_mint)
        p.base_mint::text AS mint,
        COALESCE(tok.symbol, '?') AS symbol,
        COALESCE(p.price_usd, 0)::float AS price_usd,
        COALESCE(p.liquidity_usd, 0)::float AS liquidity_usd,
        COALESCE(p.volume_5m, 0)::float AS volume_5m,
        COALESCE(p.market_cap_usd, p.fdv_usd, 0)::float AS market_cap_usd,
        p.pair_address::text AS pair_address,
        EXTRACT(EPOCH FROM p.ts) * 1000 AS snapshot_ts
      FROM pumpswap_pair_snapshots p
      LEFT JOIN tokens tok ON tok.mint = p.base_mint
      WHERE p.ts >= now() - interval '30 minutes'
        AND COALESCE(p.price_usd, 0) > 0
        AND COALESCE(p.liquidity_usd, 0) >= ${minLiq}
        AND COALESCE(p.volume_5m, 0) >= ${minVol5m}
        AND COALESCE(p.market_cap_usd, p.fdv_usd, 0) >= ${minMcap}
        AND COALESCE(p.market_cap_usd, p.fdv_usd, 0) <= ${maxMcap}
      ORDER BY p.base_mint, p.ts DESC
    )
    SELECT mint, symbol, price_usd, liquidity_usd, volume_5m, market_cap_usd, pair_address, snapshot_ts
    FROM latest
    ORDER BY volume_5m DESC
    LIMIT ${limit}
  `));

  const rows = r as unknown as Array<Record<string, unknown>>;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      mint: String(row.mint ?? ''),
      symbol: String(row.symbol ?? '?'),
      priceUsd: Number(row.price_usd ?? 0),
      liquidityUsd: Number(row.liquidity_usd ?? 0),
      volume5mUsd: Number(row.volume_5m ?? 0),
      marketCapUsd: Number(row.market_cap_usd ?? 0),
      pairAddress: row.pair_address ? String(row.pair_address) : null,
      snapshotTs: Number(row.snapshot_ts ?? Date.now()),
    }))
    .filter((row) => row.mint.length >= 32 && row.priceUsd > 0);
}

export async function fetchMintSpotPrice(mint: string): Promise<number | null> {
  const safe = mint.replace(/'/g, "''");
  const r = await db.execute(dsql.raw(`
    SELECT COALESCE(price_usd, 0)::float AS price_usd
    FROM pumpswap_pair_snapshots
    WHERE base_mint = '${safe}'
      AND ts >= now() - interval '20 minutes'
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts DESC
    LIMIT 1
  `));
  const rows = r as unknown as Array<{ price_usd: number }>;
  const px = Number(rows[0]?.price_usd ?? 0);
  return px > 0 ? px : null;
}
