import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';

/**
 * Manually add wallets to the watchlist.
 *
 * Usage:
 *   npm run watchlist:add -- <wallet1> <wallet2> ...
 *   npm run watchlist:add -- --note "twitter:@kookcap" Hb6NS...
 *
 * Source is set to 'manual'.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let note: string | null = null;
  const wallets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--note' && args[i + 1]) {
      note = args[++i] ?? null;
      continue;
    }
    wallets.push(args[i]!);
  }

  if (wallets.length === 0) {
    console.error('usage: npm run watchlist:add -- [--note "..."] <wallet> [<wallet>...]');
    process.exit(1);
  }

  const valid = wallets.filter((w) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w));
  const invalid = wallets.filter((w) => !valid.includes(w));
  if (invalid.length > 0) {
    console.error('invalid wallet format:', invalid.join(', '));
    process.exit(1);
  }

  let inserted = 0;
  let reactivated = 0;
  for (const wallet of valid) {
    const existing = await db
      .select()
      .from(schema.watchlistWallets)
      .where(dsql`${schema.watchlistWallets.wallet} = ${wallet}`)
      .limit(1);
    if (existing.length === 0) {
      await db.insert(schema.watchlistWallets).values({
        wallet,
        source: 'manual',
        note,
      });
      inserted++;
      console.log(`+ ${wallet}`);
    } else {
      await db
        .update(schema.watchlistWallets)
        .set({ removedAt: null, note: note ?? existing[0]!.note })
        .where(dsql`${schema.watchlistWallets.wallet} = ${wallet}`);
      reactivated++;
      console.log(`~ ${wallet} (reactivated)`);
    }
  }

  console.log(`\ndone: inserted ${inserted}, reactivated ${reactivated}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('watchlist-add failed:', err);
  process.exit(1);
});
