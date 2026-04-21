/**
 * Re-register the Helius enhanced webhook with the CURRENT contents of
 * watchlist_wallets. Run after every watchlist:seed:* that adds new addresses.
 *
 *   npm run webhook:register
 *
 * Idempotent: if a webhook for our HELIUS_WEBHOOK_URL already exists, it is
 * UPDATEd with the new address list rather than recreated.
 */
import { ensureHeliusWebhook } from '../collectors/helius-webhook.js';
import { refreshWatchlistCache } from '../runner/copy-trader.js';
import { child } from '../core/logger.js';

const log = child('webhook-register');

async function main(): Promise<void> {
  const id = await ensureHeliusWebhook();
  if (!id) {
    log.warn('webhook NOT registered (HELIUS_MODE=off or guard blocked)');
    process.exit(1);
  }
  const size = await refreshWatchlistCache();
  log.info({ webhookId: id, watchlistSize: size }, 'webhook registered / updated');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'register failed');
  process.exit(1);
});
