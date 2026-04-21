/**
 * Time-stop sweep for the copy-trader: close any paper position older than
 * 48h at last-known price (DexScreener / Jupiter). Safe to run on a cron.
 *
 *   npm run copy:sweep           # one-shot
 *   * /30 * * * *  npm run copy:sweep   # cron, every 30 min
 */
import { sweepStaleCopyPositions } from '../runner/copy-trader.js';
import { getJupPrices } from '../collectors/jupiter-price.js';
import { child } from '../core/logger.js';

const log = child('copy-sweep');

async function main(): Promise<void> {
  const result = await sweepStaleCopyPositions(async (mint) => {
    const prices = await getJupPrices([mint]);
    return prices[mint] ?? null;
  });
  log.info({ closed: result.closed }, 'sweep done');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'sweep failed');
  process.exit(1);
});
