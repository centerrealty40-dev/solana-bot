import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';

/**
 * Soft-remove wallets from the watchlist (sets removed_at = now()).
 *
 * Usage:
 *   npm run watchlist:remove -- <wallet1> <wallet2> ...
 */
async function main(): Promise<void> {
  const wallets = process.argv.slice(2);
  if (wallets.length === 0) {
    console.error('usage: npm run watchlist:remove -- <wallet> [<wallet>...]');
    process.exit(1);
  }

  let removed = 0;
  for (const w of wallets) {
    const r = await db
      .update(schema.watchlistWallets)
      .set({ removedAt: new Date() })
      .where(dsql`${schema.watchlistWallets.wallet} = ${w}`)
      .returning({ wallet: schema.watchlistWallets.wallet });
    if (r.length > 0) {
      removed++;
      console.log(`- ${w}`);
    } else {
      console.log(`? ${w} (not in watchlist)`);
    }
  }

  console.log(`\ndone: removed ${removed} of ${wallets.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('watchlist-remove failed:', err);
  process.exit(1);
});
