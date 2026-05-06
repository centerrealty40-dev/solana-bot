/**
 * Пост-трейдинг аналитика по локальным JSONL + опционально PG (DATABASE_URL или SA_PG_DSN).
 *
 *   npm run paper2:post-analyze
 *   npm run paper2:post-analyze -- --since-hours 168
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}\n`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error(`\n[exit ${r.status}] ${label}`);
  }
  return r.status === 0;
}

const sinceH = arg('--since-hours', '168');
const jsonl = [
  path.join(root, 'data/paper2/pt1-dno.jsonl'),
  path.join(root, 'data/paper2/pt1-diprunner.jsonl'),
  path.join(root, 'data/paper2/pt1-oscar.jsonl'),
].filter((p) => fs.existsSync(p));

if (jsonl.length === 0) {
  console.error('No paper JSONL under data/paper2/ (expected pt1-dno, pt1-diprunner, pt1-oscar).');
  process.exit(1);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

run(
  `Expectancy window (${sinceH}h)`,
  npx,
  ['tsx', 'src/scripts/paper2-expectancy-window.ts', '--since-hours', sinceH, '--jsonl', ...jsonl],
);

run(
  'Expectancy window (full local journal — 8760h)',
  npx,
  ['tsx', 'src/scripts/paper2-expectancy-window.ts', '--since-hours', '8760', '--jsonl', ...jsonl],
);

run(
  `Timeout slice (${sinceH}h)`,
  npx,
  ['tsx', 'src/scripts/paper2-timeout-slice.ts', '--since-hours', sinceH, '--jsonl', ...jsonl],
);

run('Cross-strategy mint comparison', process.execPath, [
  path.join(root, 'scripts-tmp/post-trade-compare-strategies.mjs'),
]);

run('KILLSTOP / SL root scan (entry features vs winners)', process.execPath, [
  path.join(root, 'scripts-tmp/analyze-kill-sl-roots.mjs'),
]);

const dsn = process.env.DATABASE_URL || process.env.SA_PG_DSN;
if (!dsn) {
  console.log(`\n${'='.repeat(72)}
PG-backed steps SKIPPED (set DATABASE_URL or SA_PG_DSN):
  npm run paper2:loss-attribution -- --since-hours ${sinceH} --dir data/paper2 --path-hours 48
  npm run paper2:universe-matrix -- --since-hours ${sinceH} --dir data/paper2 --step-ms 60000 --no-ideal-grid
${'='.repeat(72)}\n`);
  process.exit(0);
}

run(
  `Loss attribution (${sinceH}h closes, ±48h PG path)`,
  npx,
  ['tsx', 'src/scripts/paper2-loss-attribution-deep-dive.ts', '--since-hours', sinceH, '--path-hours', '48', '--dir', 'data/paper2'],
  { env: { ...process.env, DATABASE_URL: dsn, SA_PG_DSN: dsn } },
);

run(
  `Universe × strategy matrix (${sinceH}h opens, no brute grid)`,
  npx,
  [
    'tsx',
    'src/scripts/paper2-universe-strategy-matrix.ts',
    '--since-hours',
    sinceH,
    '--dir',
    'data/paper2',
    '--step-ms',
    '60000',
    '--no-ideal-grid',
  ],
  { env: { ...process.env, DATABASE_URL: dsn, SA_PG_DSN: dsn } },
);
