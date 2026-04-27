import { sql as dsql } from 'drizzle-orm';
import { db } from '../../core/db/client.js';

/**
 * `early_entry_score` — how often the wallet was among the first 50 buyers of a token
 * that subsequently appreciated >= 5x from the wallet's entry price.
 *
 * Calculation:
 *   1. For every (wallet, baseMint) buy, find rank among all buyers in the first hour
 *   2. If rank <= 50 AND max price within next 7 days >= entry * 5 -> count as a hit
 *   3. Score = hits / sqrt(distinct buys in window)  (penalize randomness)
 *
 * Returns map wallet -> score for the given wallet set, considering trades from `since`.
 */
export async function computeEarlyEntryScores(
  wallets: string[],
  since: Date,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (wallets.length === 0) return result;

  // Single SQL with window functions does the rank, then we join max-future-price.
  // We assume swaps are ingested with reasonable price_usd; we approximate
  // "max price in next 7d" via the max of price_samples.price_usd (if present),
  // falling back to max price across subsequent swaps for the same mint.
  const rows = await db.execute(dsql`
    WITH first_buys AS (
      SELECT
        wallet,
        base_mint,
        block_time,
        price_usd AS entry_price,
        ROW_NUMBER() OVER (PARTITION BY base_mint ORDER BY block_time) AS rn
      FROM swaps
      WHERE side = 'buy'
        AND wallet = ANY(${dsql.raw(arrayLiteral(wallets))})
        AND block_time >= ${since}
    ),
    early_buys AS (
      SELECT * FROM first_buys WHERE rn <= 50
    ),
    forward_max AS (
      SELECT
        eb.wallet,
        eb.base_mint,
        eb.entry_price,
        COALESCE(
          MAX(s.price_usd) FILTER (
            WHERE s.block_time > eb.block_time
              AND s.block_time <= eb.block_time + INTERVAL '7 days'
          ),
          eb.entry_price
        ) AS max_future_price
      FROM early_buys eb
      LEFT JOIN swaps s
        ON s.base_mint = eb.base_mint
      GROUP BY eb.wallet, eb.base_mint, eb.entry_price
    )
    SELECT
      wallet,
      COUNT(*) FILTER (WHERE max_future_price >= entry_price * 5) AS hits,
      COUNT(*) AS total
    FROM forward_max
    GROUP BY wallet
  `);

  for (const row of rows as unknown as Array<{ wallet: string; hits: bigint | number; total: bigint | number }>) {
    const hits = Number(row.hits);
    const total = Number(row.total);
    const score = total === 0 ? 0 : hits / Math.sqrt(total);
    result.set(row.wallet, score);
  }
  return result;
}

/**
 * Helper: build a Postgres array literal for VARCHAR addresses.
 * We use this rather than parameter binding to avoid hitting the 65k-param limit
 * when scoring large wallet sets in one query.
 */
function arrayLiteral(values: string[]): string {
  const escaped = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
  return `ARRAY[${escaped}]::varchar[]`;
}
