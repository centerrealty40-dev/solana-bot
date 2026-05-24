/**
 * Near-miss spike mints from PG minute bars — within gap of tier threshold, not yet alerted.
 */
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import { tierRequiredMinAbsPct } from './market-spike-tier-thresholds.js';

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Mints whose latest consecutive PG bar move is within `gapPct` below spike tier dump threshold.
 */
export async function loadPgNearMissSpikeMints(limit: number): Promise<string[]> {
  const gapPct = Math.max(0.5, Math.min(8, envNum('PRIORITY_JUPITER_SPOT_NEAR_MISS_GAP_PCT', 3)));
  const minMcap = Math.max(0, envNum('PRIORITY_JUPITER_SPOT_MIN_MCAP_USD', 2_000_000));
  const lim = Math.max(5, Math.min(80, limit));

  const q = `
    WITH snap AS (
      SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd, liquidity_usd
      FROM (
        SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd, liquidity_usd
        FROM meteora_pair_snapshots WHERE ts > NOW() - INTERVAL '45 minutes'
        UNION ALL
        SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd, liquidity_usd
        FROM raydium_pair_snapshots WHERE ts > NOW() - INTERVAL '45 minutes'
        UNION ALL
        SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd, liquidity_usd
        FROM orca_pair_snapshots WHERE ts > NOW() - INTERVAL '45 minutes'
        UNION ALL
        SELECT base_mint, ts, price_usd, market_cap_usd, fdv_usd, liquidity_usd
        FROM pumpswap_pair_snapshots WHERE ts > NOW() - INTERVAL '45 minutes'
      ) u
    ),
    ranked AS (
      SELECT
        base_mint,
        ts,
        price_usd,
        COALESCE(market_cap_usd, fdv_usd, 0) AS ref_mcap,
        liquidity_usd,
        ROW_NUMBER() OVER (PARTITION BY base_mint ORDER BY ts DESC) AS rn
      FROM snap
      WHERE price_usd > 0
    ),
    pairs AS (
      SELECT
        n.base_mint,
        n.price_usd AS px_now,
        p.price_usd AS px_prev,
        n.ref_mcap,
        n.liquidity_usd
      FROM ranked n
      JOIN ranked p ON p.base_mint = n.base_mint AND p.rn = n.rn + 1
      WHERE n.rn = 1 AND p.price_usd > 0
    )
    SELECT base_mint, px_now, px_prev, ref_mcap
    FROM pairs
    WHERE ref_mcap >= ${minMcap}
    ORDER BY ref_mcap DESC
    LIMIT ${lim * 4}
  `;

  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Record<string, unknown>[];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const mint = String(row.base_mint ?? '').trim();
    if (mint.length < 32 || seen.has(mint)) continue;
    const pxNow = Number(row.px_now);
    const pxPrev = Number(row.px_prev);
    const refMcap = Number(row.ref_mcap ?? 0);
    if (!(pxNow > 0 && pxPrev > 0 && refMcap > 0)) continue;

    const pct = ((pxNow - pxPrev) / pxPrev) * 100;
    const abs = Math.abs(pct);
    const isPump = pct >= 0;
    const minAbs = tierRequiredMinAbsPct(refMcap, isPump, 'consecutive');
    if (minAbs == null) continue;
    if (abs >= minAbs) continue;
    if (abs < minAbs - gapPct) continue;

    seen.add(mint);
    out.push(mint);
    if (out.length >= lim) break;
  }

  return out;
}
