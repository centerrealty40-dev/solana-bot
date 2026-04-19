import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';

/**
 * Print the current watchlist_wallets contents (active rows first), grouped by source.
 *
 * Usage:
 *   npm run watchlist:show
 *   npm run watchlist:show -- --all          # include removed
 */
async function main(): Promise<void> {
  const includeRemoved = process.argv.includes('--all');

  const where = includeRemoved
    ? dsql`1 = 1`
    : dsql`${schema.watchlistWallets.removedAt} IS NULL`;

  const rows = await db
    .select()
    .from(schema.watchlistWallets)
    .where(where)
    .orderBy(schema.watchlistWallets.source, schema.watchlistWallets.addedAt);

  if (rows.length === 0) {
    console.log('watchlist_wallets is empty');
    console.log('seed it with: npm run watchlist:seed');
    process.exit(0);
  }

  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }

  for (const [source, list] of bySource) {
    console.log(`\n[${source}]  ${list.length} wallets`);
    console.log('Wallet                                              Added       Note');
    console.log('--------------------------------------------------  ----------  ----');
    for (const r of list) {
      const w = r.wallet.padEnd(50);
      const d = r.addedAt.toISOString().slice(0, 10);
      const n = (r.note ?? '').slice(0, 60);
      const removed = r.removedAt ? ' [REMOVED]' : '';
      console.log(`${w}  ${d}  ${n}${removed}`);
    }
  }

  console.log(`\nTotal: ${rows.length} ${includeRemoved ? '(incl. removed)' : 'active'}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('watchlist-show failed:', err);
  process.exit(1);
});
