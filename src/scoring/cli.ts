import cron from 'node-cron';
import { runScoring } from './engine.js';
import { child } from '../core/logger.js';

const log = child('scoring-cli');

/**
 * Long-running scoring service: kicks off a full scoring pass on startup
 * and again every hour at minute :07 (offset to avoid colliding with other crons).
 *
 * Intermediate "fast" passes (without expensive clustering) run every 15 minutes.
 *
 * Run via `npm run dev:scoring`.
 */
async function main(): Promise<void> {
  log.info('initial scoring run...');
  const r = await runScoring({ withClustering: true });
  log.info(r, 'initial run done');

  cron.schedule('7 * * * *', async () => {
    try {
      const result = await runScoring({ withClustering: true });
      log.info(result, 'hourly scoring done');
    } catch (err) {
      log.error({ err: String(err) }, 'hourly scoring failed');
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await runScoring({ withClustering: false });
      log.info(result, '15-min scoring done');
    } catch (err) {
      log.error({ err: String(err) }, '15-min scoring failed');
    }
  });

  log.info('cron schedules registered; service running');
}

main().catch((err) => {
  log.error({ err }, 'scoring service crashed');
  process.exit(1);
});
