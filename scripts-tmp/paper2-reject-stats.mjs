/**
 * Сводка причин отказов из paper2 jsonl за последние N часов.
 * Учитывает: kind=eval с pass=false (поле reasons), kind=eval-skip-open (поле reason).
 *
 * Usage:
 *   node scripts-tmp/paper2-reject-stats.mjs [hours] [jsonl path...]
 * Default hours=2, paths=data/paper2/pt1-*.jsonl от cwd.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const hours = Number(process.argv[2] || process.env.HOURS || 2);
const cutoff = Date.now() - hours * 3600 * 1000;

const defaultGlob = () => {
  const dir = path.join(process.cwd(), 'data', 'paper2');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('pt1-') && f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
};

let files = process.argv.slice(3).filter(Boolean);
if (!files.length) files = defaultGlob();

const counts = new Map();

function bump(key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

async function scanFile(fp) {
  const st = fs.createReadStream(fp, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: st, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    let ts = j.ts;
    if (typeof ts !== 'number') continue;
    if (ts < 1e12) ts *= 1000;
    if (ts < cutoff) continue;

    const sid = j.strategyId ? `[${j.strategyId}] ` : '';

    if (j.kind === 'eval' && j.pass === false && Array.isArray(j.reasons)) {
      for (const r of j.reasons) {
        if (typeof r === 'string' && r.length) bump(`${sid}[eval] ${r}`);
      }
    }
    if (j.kind === 'eval-skip-open' && typeof j.reason === 'string' && j.reason.length) {
      bump(`${sid}[skip-open] ${j.reason}`);
    }
  }
}

for (const fp of files) {
  const abs = path.isAbsolute(fp) ? fp : path.join(process.cwd(), fp);
  if (!fs.existsSync(abs)) {
    console.error(JSON.stringify({ warn: 'missing_file', path: abs }));
    continue;
  }
  await scanFile(abs);
}

const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const total = sorted.reduce((s, [, n]) => s + n, 0);

console.log(
  JSON.stringify(
    {
      hours,
      cutoffIso: new Date(cutoff).toISOString(),
      files,
      totalRejectReasonHits: total,
      distinctReasons: sorted.length,
      byCountDesc: sorted.map(([reason, count]) => ({ count, reason })),
    },
    null,
    2,
  ),
);
