/**
 * Run a collector once (or N times) and print elapsedMs from JSON log lines.
 *
 *   node scripts-tmp/collector-profile-once.mjs
 *   node scripts-tmp/collector-profile-once.mjs scripts-tmp/pumpswap-collector.mjs 5
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const scriptArg = process.argv[2] || 'scripts-tmp/pumpswap-collector.mjs';
const iterations = Math.max(1, Number(process.argv[3] || 1));
const scriptPath = path.isAbsolute(scriptArg) ? scriptArg : path.join(root, scriptArg);

const elapsedList = [];

for (let i = 0; i < iterations; i += 1) {
  const r = spawnSync(process.execPath, [scriptPath, '--once'], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env },
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  let elapsed = null;
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j.msg === 'tick completed' && typeof j.elapsedMs === 'number') {
        elapsed = j.elapsedMs;
      }
    } catch {
      /* ignore */
    }
  }
  elapsedList.push(elapsed);
  if (r.status !== 0) {
    console.error(JSON.stringify({ iteration: i + 1, exitCode: r.status, stderrTail: out.slice(-2000) }));
    process.exit(r.status ?? 1);
  }
}

function pctile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.round((p / 100) * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
}

const valid = elapsedList.filter((x) => typeof x === 'number' && Number.isFinite(x));
const sorted = [...valid].sort((a, b) => a - b);
const summary = {
  script: scriptPath,
  iterations,
  elapsedMs_samples: elapsedList,
  p50: sorted.length ? pctile(sorted, 50) : null,
  p95: sorted.length ? pctile(sorted, 95) : null,
  max: sorted.length ? sorted[sorted.length - 1] : null,
  recommendIntervalMs: sorted.length ? Math.ceil((pctile(sorted, 95) || 0) * 1.2) : null,
};

console.log(JSON.stringify({ msg: 'collector-profile-once', ...summary }, null, 2));
