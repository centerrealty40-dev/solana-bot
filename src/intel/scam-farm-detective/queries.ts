/**
 * Scam-farm SQL phase (A): all bounded by lookback; uses existing indexes
 * (money_flows: source+time, swaps: base+time, tokens).
 *
 * Rug / anchor definition (MVP, documented for operators):
 * - `tokens.blacklisted` — manual or heuristics
 * - OR (liquidity_usd below SCAM_FARM_RUG_MIN_LIQ_USD AND mcap/fdv collapsed vs local peak)
 *   is approximated as: not blacklisted but `liquidity_usd` present and
 *   below `minLiq` AND `firstSeenAt` within lookback (very young illiquid) — weak signal
 */
import { sql } from 'drizzle-orm';
import type { DB } from '../../core/db/client.js';
import type { ScamFarmConfig } from './config.js';

export type SyncFundRow = {
  sourceWallet: string;
  bucket: number;
  nTargets: number;
  minA: number;
  maxA: number;
  targets: string[] | null;
};

export type RugCohortRow = {
  funder: string;
  nWallets: number;
  anchorMint: string;
  earlyWallets: string[] | null;
};

export type OrchestrateRow = {
  buyer: string;
  seller: string;
  mint: string;
  buyT: string;
  sellT: string;
  link: 'flow' | 'funder' | 'both' | 'unknown';
};

/**
 * 1) Quasi-synchronous multi-target SOL funding from a small set of funders
 *    (tight time buckets + amount spread).
 */
export async function querySyncFunding(db: DB, c: ScamFarmConfig): Promise<SyncFundRow[]> {
  const w = c.fundingWindowSec;
  const d = c.lookbackDays;
  const minT = c.fundingMinTargets;
  const relTol = c.fundingAmountRelTolerance;
  const cap = c.maxSqlRows;
  const rows = (await db.execute(sql`
    WITH m AS (
      SELECT
        source_wallet,
        target_wallet,
        amount,
        (FLOOR(EXTRACT(EPOCH FROM tx_time) / ${w}) * ${w})::bigint AS bucket
      FROM money_flows
      WHERE asset = 'SOL'
        AND source_wallet IS NOT NULL
        AND target_wallet IS NOT NULL
        AND source_wallet != target_wallet
        AND tx_time > now() - (interval '1' day * ${d})
    ),
    agg AS (
      SELECT
        m.source_wallet,
        m.bucket,
        COUNT(DISTINCT m.target_wallet)::int AS n_targets,
        MIN(m.amount) AS min_a,
        MAX(m.amount) AS max_a,
        array_agg(DISTINCT m.target_wallet) AS targets
      FROM m
      GROUP BY m.source_wallet, m.bucket
      HAVING
        COUNT(DISTINCT m.target_wallet) >= ${minT}
        AND MIN(m.amount) > 0
        AND (MAX(m.amount) - MIN(m.amount)) / MIN(m.amount) < ${relTol}
    )
    SELECT
      a.source_wallet,
      a.bucket,
      a.n_targets,
      a.min_a,
      a.max_a,
      a.targets
    FROM agg a
    LIMIT ${cap}
  `)) as unknown as Array<{
    source_wallet: string;
    bucket: string | number;
    n_targets: number;
    min_a: string | number;
    max_a: string | number;
    targets: string[] | null;
  }>;

  return rows.map((r) => ({
    sourceWallet: r.source_wallet,
    bucket: Number(r.bucket),
    nTargets: r.n_targets,
    minA: Number(r.min_a),
    maxA: Number(r.max_a),
    targets: r.targets,
  }));
}

/**
 * 2) Wallets that bought a rug-anchor mint very early, sharing the same
 *    `wallets.funding_source` funder.
 */
export async function queryRugCohortByFunder(db: DB, c: ScamFarmConfig): Promise<RugCohortRow[]> {
  const d = c.lookbackDays;
  const lim = c.rugAnchorEarlyBuyersLimit;
  const minL = c.minLiquidityUsdRugHeuristic;
  const cap = Math.min(500, c.maxSqlRows);
  const rows = (await db.execute(sql`
    WITH rug_mints AS (
      SELECT t.mint
      FROM tokens t
      WHERE t.blacklisted = true
        OR (t.liquidity_usd IS NOT NULL
            AND t.liquidity_usd < ${minL}
            AND t.first_seen_at > now() - (interval '1' day * ${d}) * 2
           )
    ),
    early_buys AS (
      SELECT s.base_mint AS mint,
        s.wallet,
        s.block_time,
        ROW_NUMBER() OVER (PARTITION BY s.base_mint ORDER BY s.block_time ASC) AS rn
      FROM swaps s
      INNER JOIN rug_mints r ON r.mint = s.base_mint
      WHERE s.side = 'buy'
        AND s.block_time > now() - (interval '1' day * ${d})
    ),
    top_buyers AS (
      SELECT e.mint, e.wallet
      FROM early_buys e
      WHERE e.rn <= ${lim}
    )
    SELECT
      w.funding_source AS funder,
      tb.mint AS anchor_mint,
      COUNT(DISTINCT tb.wallet)::int AS n_wallets,
      array_agg(DISTINCT tb.wallet) AS early_wallets
    FROM top_buyers tb
    INNER JOIN wallets w ON w.address = tb.wallet
    WHERE w.funding_source IS NOT NULL
    GROUP BY w.funding_source, tb.mint
    HAVING COUNT(DISTINCT tb.wallet) >= 2
    LIMIT ${cap}
  `)) as unknown as Array<{
    funder: string;
    anchor_mint: string;
    n_wallets: number;
    early_wallets: string[] | null;
  }>;

  return rows.map((r) => ({
    funder: r.funder,
    nWallets: r.n_wallets,
    anchorMint: r.anchor_mint,
    earlyWallets: r.early_wallets,
  }));
}

/**
 * 3) Split-ticket: BUY on A, SELL on B (same base mint, rug list), A→B in money_flows
 *    in the trade window, or same funder in `wallets`.
 */
export async function queryOrchestratedSplit(db: DB, c: ScamFarmConfig): Promise<OrchestrateRow[]> {
  const d = c.lookbackDays;
  const h = c.orchestrationMaxPairAgeHours;
  const cap = c.maxSqlRows;
  const rows = (await db.execute(sql`
    WITH rug_mints AS (
      SELECT t.mint
      FROM tokens t
      WHERE t.blacklisted = true
      LIMIT 2000
    ),
    s1b AS (
      SELECT s1.*
      FROM swaps s1
      INNER JOIN rug_mints r ON r.mint = s1.base_mint
      WHERE s1.side = 'buy'
        AND s1.block_time > now() - (interval '1' day * ${d})
      ORDER BY s1.block_time DESC
      LIMIT 1500
    ),
    legs AS (
      SELECT
        s1.base_mint AS mint,
        s1.wallet AS buyer,
        s2.wallet AS seller,
        s1.block_time AS t_buy,
        s2.block_time AS t_sell
      FROM s1b s1
      JOIN swaps s2
        ON s1.base_mint = s2.base_mint
        AND s1.side = 'buy' AND s2.side = 'sell'
        AND s1.wallet != s2.wallet
        AND s1.block_time < s2.block_time
        AND s2.block_time < s1.block_time + (interval '1' hour * ${h})
    ),
    with_link AS (
      SELECT
        l.*,
        EXISTS (
          SELECT 1 FROM money_flows mf
          WHERE mf.source_wallet = l.buyer
            AND mf.target_wallet = l.seller
            AND mf.tx_time >= l.t_buy - interval '2 days'
            AND mf.tx_time <= l.t_sell + interval '2 days'
        ) AS has_flow,
        wa.funding_source AS f_buy,
        wb.funding_source AS f_sell
      FROM legs l
      JOIN wallets wa ON wa.address = l.buyer
      JOIN wallets wb ON wb.address = l.seller
    )
    SELECT
      w.buyer,
      w.seller,
      w.mint,
      w.t_buy::text AS t_buy,
      w.t_sell::text AS t_sell,
      w.has_flow,
      w.f_buy,
      w.f_sell
    FROM with_link w
    WHERE w.has_flow = true OR (w.f_buy IS NOT NULL AND w.f_buy = w.f_sell)
    LIMIT ${cap}
  `)) as unknown as Array<{
    buyer: string;
    seller: string;
    mint: string;
    t_buy: string;
    t_sell: string;
    has_flow: boolean;
    f_buy: string | null;
    f_sell: string | null;
  }>;

  return rows.map((r) => {
    const link: OrchestrateRow['link'] = r.has_flow
      ? r.f_buy && r.f_buy === r.f_sell
        ? 'both'
        : 'flow'
      : r.f_buy && r.f_buy === r.f_sell
        ? 'funder'
        : 'unknown';
    return {
      buyer: r.buyer,
      seller: r.seller,
      mint: r.mint,
      buyT: r.t_buy,
      sellT: r.t_sell,
      link,
    };
  });
}
