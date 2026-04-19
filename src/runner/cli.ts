import { HypothesisRunner } from './hypothesis-runner.js';
import { buildHypotheses } from './registry.js';
import { child } from '../core/logger.js';

const log = child('runner-cli');

/**
 * Long-running runner service: registers all hypotheses and starts the swap/exit loops.
 *
 * Run via `npm run dev:runner`.
 */
async function main(): Promise<void> {
  const runner = new HypothesisRunner();
  const arg = process.argv.slice(2);
  const onlyArg = arg.find((a) => a.startsWith('--only='));
  const onlyIds = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;
  const all = buildHypotheses();
  const selected = onlyIds ? all.filter((h) => onlyIds.has(h.id)) : all;
  for (const h of selected) runner.register(h);
  await runner.start();
  log.info({ hypotheses: selected.map((h) => h.id) }, 'runner started');

  process.on('SIGINT', () => {
    log.info('shutting down');
    runner.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'runner crashed');
  process.exit(1);
});
