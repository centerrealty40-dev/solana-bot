import { config } from '../core/config.js';
import { deleteAllHeliusWebhooks } from '../collectors/helius-webhook.js';
import { child } from '../core/logger.js';

const log = child('helius-wipe');

/**
 * Emergency stop-cock: deletes EVERY webhook registered against the current
 * HELIUS_API_KEY. Use this if credits start burning unexpectedly.
 *
 * Usage:
 *   HELIUS_MODE=wallets npm run helius:wipe
 *
 * NB: requires HELIUS_MODE != 'off' so the guard lets the DELETE through.
 */
async function main(): Promise<void> {
  if (!config.heliusApiKey) {
    log.error('HELIUS_API_KEY is empty; nothing to do');
    process.exit(1);
  }
  if (config.heliusMode === 'off') {
    log.error('HELIUS_MODE=off; temporarily set HELIUS_MODE=wallets to allow DELETE through guard');
    process.exit(1);
  }
  log.warn('about to delete ALL helius webhooks for this api key');
  const { deleted } = await deleteAllHeliusWebhooks();
  log.info({ deleted }, 'wipe complete');
}

main().catch((err) => {
  log.error({ err }, 'wipe failed');
  process.exit(1);
});
