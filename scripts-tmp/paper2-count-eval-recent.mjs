import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '/opt/solana-alpha/data/paper2';
const ms = Number(process.argv[3] || 3600_000);
const since = Date.now() - ms;

let files = [];
try {
  files = fs.readdirSync(dir).filter((f) => f.startsWith('pt1-') && f.endsWith('.jsonl'));
} catch (e) {
  console.error(String(e));
  process.exit(1);
}

let total = 0;
for (const f of files.sort()) {
  const fp = path.join(dir, f);
  let n = 0;
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 'eval' && (e.ts || 0) >= since) n++;
    } catch {
      /* skip */
    }
  }
  console.log(f, 'eval_last_window', n);
  total += n;
}
console.log('TOTAL', total, 'window_ms', ms, 'since_iso', new Date(since).toISOString());
