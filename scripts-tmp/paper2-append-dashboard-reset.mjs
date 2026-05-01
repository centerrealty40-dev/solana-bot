/**
 * Дописывает в конец каждого *.jsonl в PAPER2_DIR строку {"kind":"reset","ts":...}.
 * Дашборд /api/paper2 учитывает только закрытия с exitTs ≥ этого ts; журнал не удаляется.
 *
 *   node scripts-tmp/paper2-append-dashboard-reset.mjs
 *   PAPER2_DIR=/path/to/paper2 node scripts-tmp/paper2-append-dashboard-reset.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dir = process.env.PAPER2_DIR?.trim() || path.join(root, 'data', 'paper2');
const ts = Date.now();
const line = `${JSON.stringify({ kind: 'reset', ts })}\n`;

if (!fs.existsSync(dir)) {
  console.error(JSON.stringify({ ok: false, error: `missing dir ${dir}` }));
  process.exit(1);
}
const names = fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'));
for (const name of names) {
  fs.appendFileSync(path.join(dir, name), line, 'utf8');
}
console.log(JSON.stringify({ ok: true, ts, dir, files: names }));
