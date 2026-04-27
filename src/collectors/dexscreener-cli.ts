import { DexScreenerPoller } from './dexscreener.js';
import { child } from '../core/logger.js';

const log = child('dexscreener-cli');

/**
 * Standalone process: poll DexScreener trending and persist to DB.
 * Run via `npm run dev:collector:dexscreener`.
 */
async function main(): Promise<void> {
  const poller = new DexScreenerPoller(60);
  poller.start();
  log.info('DexScreener collector running; Ctrl+C to stop');
  process.on('SIGINT', () => {
    poller.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'collector crashed');
  process.exit(1);
});
