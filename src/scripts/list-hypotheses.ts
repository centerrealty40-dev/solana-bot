import { buildHypotheses } from '../runner/registry.js';

const all = buildHypotheses();
for (const h of all) {
  process.stdout.write(`${h.id.padEnd(8)}  ${h.describe()}\n`);
}
process.exit(0);
