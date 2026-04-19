import { HypothesisRunner } from '../runner/hypothesis-runner.js';
import { buildHypotheses } from '../runner/registry.js';
import { child } from '../core/logger.js';

const log = child('run-hypothesis');

/**
 * Run one specific hypothesis in isolation:
 *   npm run hypothesis:run -- h1
 */
async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    log.error('usage: run-hypothesis <id>');
    process.exit(1);
  }
  const all = buildHypotheses();
  const target = all.find((h) => h.id === id);
  if (!target) {
    log.error({ id, available: all.map((h) => h.id) }, 'unknown hypothesis');
    process.exit(1);
  }
  const runner = new HypothesisRunner();
  runner.register(target);
  await runner.start();
  log.info({ id }, 'running single hypothesis');
  process.on('SIGINT', () => {
    runner.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'run failed');
  process.exit(1);
});
