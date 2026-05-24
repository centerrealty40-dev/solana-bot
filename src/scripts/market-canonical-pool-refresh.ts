/**
 * Refresh tokens.primary_pair to max-liquidity pool across DEX snapshot tables (point C).
 */
import { sql as dsql } from 'drizzle-orm';

import { db, sql as pgSql } from '../core/db/client.js';
import { buildMintCanonicalPoolMap } from './market-snapshot-canonical-pool.js';

const SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type LatestMeta = {
  base_mint: string;
  pair_address: string;
  liq_usd: number | null;
};

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

function buildLatestOnlyQuery(table: string, mintFilter: string[] | null, maxRows: number): string {
  const mintClause =
    mintFilter && mintFilter.length > 0
      ? `AND base_mint IN (${mintFilter.map((m) => `'${m.replace(/'/g, "''")}'`).join(',')})`
      : '';
  return `
    SELECT DISTINCT ON (base_mint)
      base_mint,
      pair_address,
      liquidity_usd AS liq_usd
    FROM ${table}
    WHERE ts > NOW() - INTERVAL '90 minutes'
      AND liquidity_usd > 0
      ${mintClause}
    ORDER BY base_mint, ts DESC, liquidity_usd DESC NULLS LAST
    LIMIT ${maxRows}
  `;
}

async function refreshTokensPrimaryPairs(mintBestPool: Map<string, { pair: string; liq: number }>): Promise<number> {
  if (mintBestPool.size === 0) return 0;
  let updated = 0;
  for (const [mint, best] of mintBestPool) {
    const m = mint.trim();
    const pair = best.pair.trim();
    if (!ADDR_RE.test(m) || !ADDR_RE.test(pair) || !(best.liq > 0)) continue;
    try {
      const r = await pgSql`
        UPDATE tokens
        SET primary_pair = ${pair},
            liquidity_usd = ${best.liq},
            updated_at = now()
        WHERE mint = ${m}
          AND (
            primary_pair IS DISTINCT FROM ${pair}
            OR liquidity_usd IS DISTINCT FROM ${best.liq}
          )
      `;
      const n = Number((r as { count?: number }).count ?? 0);
      if (n > 0) updated += n;
    } catch {
      /* ignore per-mint */
    }
  }
  return updated;
}

/**
 * Update tokens.primary_pair for mints in filter (or top recent if null).
 */
export async function refreshCanonicalPoolsForMints(mints: string[]): Promise<number> {
  if (!envBool('MARKET_CANONICAL_POOL_REFRESH_ENABLED', true)) return 0;
  try {
  const filter = mints.map((m) => m.trim()).filter((m) => ADDR_RE.test(m));
  if (filter.length === 0) return 0;

  const maxRows = Math.max(filter.length, Math.min(500, envNum('MARKET_CANONICAL_POOL_REFRESH_MAX_ROWS', 250)));
  const tableLatest: Array<{ table: string; rows: LatestMeta[] }> = [];

  for (const table of SNAPSHOT_TABLES) {
    try {
      const q = buildLatestOnlyQuery(table, filter, maxRows);
      const r = await db.execute(dsql.raw(q));
      const rows = r as unknown as LatestMeta[];
      tableLatest.push({ table, rows });
    } catch {
      /* skip table */
    }
  }

  const mintCanonical = buildMintCanonicalPoolMap(tableLatest);
  const mintBestPool = new Map<string, { pair: string; liq: number }>();
  for (const [mint, entry] of mintCanonical) {
    mintBestPool.set(mint, { pair: entry.meta.pair_address, liq: entry.liq });
  }
  return refreshTokensPrimaryPairs(mintBestPool);
  } catch (err) {
    console.warn('[market-canonical-pool-refresh] failed', err);
    return 0;
  }
}

export function canonicalPoolRefreshIntervalMs(): number {
  return Math.max(3000, Math.min(60_000, envNum('MARKET_CANONICAL_POOL_REFRESH_INTERVAL_MS', 5000)));
}
