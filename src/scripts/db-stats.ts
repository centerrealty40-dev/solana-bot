/**
 * Diagnostic snapshot of the trading state straight from Postgres.
 *
 * Avoids the `psql + source .env` dance which is brittle (the `&` in the
 * Neon connection string gets interpreted by bash as a background-job marker
 * unless the value is single-quoted, and silently leaks the password to the
 * terminal). This script loads the URL through dotenv and queries directly,
 * so it works regardless of how the .env line is formatted.
 *
 *   npm run db:stats
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('db-stats');

async function main(): Promise<void> {
  const minutesArg = Number(process.env.DB_STATS_MINUTES ?? '30');
  const since = `interval '${minutesArg} minutes'`;

  console.log(`==== DB stats — last ${minutesArg} min ====\n`);

  const total = await db.execute<{ total: string; last: Date | null }>(
    dsql.raw(
      `SELECT COUNT(*)::text AS total, MAX(block_time) AS last
       FROM swaps WHERE created_at > now() - ${since}`,
    ),
  );
  const totalRow = (total as unknown as Array<{ total: string; last: Date | null }>)[0];
  console.log(`All swaps inserted:  ${totalRow?.total ?? '0'}`);
  console.log(`Last block_time:     ${totalRow?.last ?? '(none)'}\n`);

  const wlSwaps = await db.execute<{
    wallet: string;
    swaps: string;
    last_swap: Date;
    max_usd: number;
  }>(
    dsql.raw(`
      SELECT s.wallet, COUNT(*)::text AS swaps, MAX(s.block_time) AS last_swap, MAX(s.amount_usd)::float AS max_usd
      FROM swaps s
      JOIN watchlist_wallets w ON w.wallet = s.wallet
      WHERE s.created_at > now() - ${since}
        AND w.removed_at IS NULL
      GROUP BY s.wallet
      ORDER BY MAX(s.block_time) DESC
      LIMIT 20
    `),
  );
  const wlRows = wlSwaps as unknown as Array<{
    wallet: string;
    swaps: string;
    last_swap: Date;
    max_usd: number;
  }>;
  console.log(`Watchlist wallets active in window: ${wlRows.length}`);
  if (wlRows.length > 0) {
    console.log('Wallet                                              Swaps  Max USD     Last seen');
    console.log('--------------------------------------------------  -----  ----------  --------------------');
    for (const r of wlRows) {
      console.log(
        `${r.wallet.padEnd(50)}  ${String(r.swaps).padStart(5)}  ${('$' + Number(r.max_usd ?? 0).toFixed(0)).padStart(10)}  ${String(r.last_swap)}`,
      );
    }
  }
  console.log('');

  const buysByMint = await db.execute<{
    base_mint: string;
    distinct_buyers: string;
    buys: string;
    last: Date;
  }>(
    dsql.raw(`
      SELECT s.base_mint, COUNT(DISTINCT s.wallet)::text AS distinct_buyers,
             COUNT(*)::text AS buys, MAX(s.block_time) AS last
      FROM swaps s
      JOIN watchlist_wallets w ON w.wallet = s.wallet
      WHERE s.created_at > now() - ${since}
        AND w.removed_at IS NULL
        AND s.side = 'buy'
      GROUP BY s.base_mint
      ORDER BY COUNT(*) DESC
      LIMIT 10
    `),
  );
  const buyRows = buysByMint as unknown as Array<{
    base_mint: string;
    distinct_buyers: string;
    buys: string;
    last: Date;
  }>;
  console.log(`Top mints bought BY watchlist in window: ${buyRows.length}`);
  if (buyRows.length > 0) {
    console.log('Mint                                                  Buyers  Buys  Last');
    console.log('----------------------------------------------------  ------  ----  --------------------');
    for (const r of buyRows) {
      console.log(
        `${r.base_mint.padEnd(52)}  ${String(r.distinct_buyers).padStart(6)}  ${String(r.buys).padStart(4)}  ${String(r.last)}`,
      );
    }
  }
  console.log('');

  // Also surface state of the copy_seen_mints table so we can tell whether
  // the First-N gate is blocking everything (it will, if Helius drip-fed us
  // the same wallet's prior buys before the watchlist became active).
  const seen = await db.execute<{ total: string; last: Date | null }>(
    dsql.raw(`SELECT COUNT(*)::text AS total, MAX(first_seen_at) AS last FROM copy_seen_mints`),
  );
  const seenRow = (seen as unknown as Array<{ total: string; last: Date | null }>)[0];
  console.log(`copy_seen_mints rows total:  ${seenRow?.total ?? '0'}`);
  console.log(`copy_seen_mints last claim:  ${seenRow?.last ?? '(none)'}`);

  const positions = await db.execute<{ status: string; n: string }>(
    dsql.raw(
      `SELECT status, COUNT(*)::text AS n FROM positions
       WHERE hypothesis_id = 'copy_h8'
       GROUP BY status`,
    ),
  );
  const posRows = positions as unknown as Array<{ status: string; n: string }>;
  console.log('\ncopy_h8 positions by status:');
  if (posRows.length === 0) console.log('  (none)');
  for (const r of posRows) console.log(`  ${r.status.padEnd(8)} ${r.n}`);

  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'db-stats failed');
  process.exit(1);
});
