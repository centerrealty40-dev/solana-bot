import { fetchWalletHistory } from '../collectors/helius-webhook.js';
import { processHeliusBatch } from '../collectors/helius-webhook.js';
import { getActiveWallets30d } from '../core/db/repository.js';
import { child } from '../core/logger.js';

const log = child('backfill-wallets');

/**
 * Pull last `limit` enhanced txs for each wallet provided on argv,
 * or for the top-N most active wallets if no argv given.
 *
 * Usage:
 *   npm run backfill:wallets                  # top-100 active
 *   npm run backfill:wallets <addr1> <addr2>  # specific
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let wallets = argv;
  if (wallets.length === 0) {
    wallets = (await getActiveWallets30d(5)).slice(0, 100);
    log.info({ n: wallets.length }, 'no wallets given, picking top active');
  }
  let totalInserted = 0;
  for (const w of wallets) {
    log.info({ wallet: w }, 'backfilling');
    const txs = await fetchWalletHistory(w, 500);
    const inserted = await processHeliusBatch(txs);
    totalInserted += inserted;
    log.info({ wallet: w, txs: txs.length, inserted }, 'wallet done');
  }
  log.info({ totalInserted }, 'backfill complete');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'backfill failed');
  process.exit(1);
});
