import { runScoring } from '../scoring/engine.js';
import { child } from '../core/logger.js';

const log = child('compute-scores');

/**
 * One-off CLI to run a single scoring pass and exit.
 * Useful to kick scoring from a workflow/cron without keeping the long-running service.
 *
 *   npm run scores:compute -- --no-cluster --max=500
 */
async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  const noCluster = argv.has('--no-cluster');
  const maxArg = process.argv.find((a) => a.startsWith('--max='));
  const maxWallets = maxArg ? parseInt(maxArg.slice('--max='.length), 10) : 1000;

  const r = await runScoring({ withClustering: !noCluster, maxWallets });
  log.info(r, 'done');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'failed');
  process.exit(1);
});
