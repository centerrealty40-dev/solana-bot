/**
 * Soft-remove from watchlist all wallets that bought a given honeypot/scam mint.
 * After purging, run `npm run webhook:register` to update Helius subscription.
 *
 * Usage:
 *   npm run cluster:purge -- 4hpCdBH9oz8Fhji5CdpJYbwa24FCSi967sSKhXPQbQtp
 */
import 'dotenv/config';
import { db } from '../core/db/client.js';
import { sql as dsql } from 'drizzle-orm';
import { child } from '../core/logger.js';

const log = child('cluster-purge');

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: npm run cluster:purge -- <baseMint>');
    process.exit(1);
  }

  const buyers = (await db.execute(
    dsql.raw(`
      SELECT DISTINCT s.wallet
      FROM swaps s JOIN watchlist_wallets w ON w.wallet = s.wallet
      WHERE w.removed_at IS NULL
        AND s.base_mint = '${target}'
        AND s.side = 'buy'
    `),
  )) as unknown as Array<{ wallet: string }>;

  if (buyers.length === 0) {
    console.log('No active watchlist wallets bought this mint — nothing to purge.');
    process.exit(0);
  }

  console.log(`Will soft-remove ${buyers.length} wallet(s) from watchlist:`);
  for (const b of buyers) console.log(`  ${b.wallet}`);

  // Confirm
  if (process.env.PURGE_CONFIRM !== '1') {
    console.log(
      `\nDRY RUN. Re-run with PURGE_CONFIRM=1 to actually mark them as removed:\n  PURGE_CONFIRM=1 npm run cluster:purge -- ${target}`,
    );
    process.exit(0);
  }

  const wallets = buyers.map((b) => `'${b.wallet}'`).join(',');
  await db.execute(
    dsql.raw(`
      UPDATE watchlist_wallets
      SET removed_at = now(), note = COALESCE(note,'') || ' | scam_cluster:${target}'
      WHERE wallet IN (${wallets}) AND removed_at IS NULL
    `),
  );

  log.info({ purged: buyers.length, target }, 'cluster purged');
  console.log(`\n✅ Soft-removed ${buyers.length} wallet(s).`);
  console.log(`Now refresh Helius subscription: npm run webhook:register`);
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'purge failed');
  process.exit(1);
});
