/**
 * Диагностика paper2 jsonl: за последние N часов по каждому strategyId —
 * eval pass/fail, skip-open по причинам, последний open.
 *
 *   node scripts-tmp/paper2-strategy-diag.mjs [hours]
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const hours = Number(process.argv[2] || 24);
const cutoff = Date.now() - hours * 3600 * 1000;

const dir = path.join(process.cwd(), 'data', 'paper2');
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.startsWith('pt1-') && f.endsWith('.jsonl'))
  : [];

/** @type {Map<string, { evalPass: number; evalFail: number; skipOpen: Map<string, number>; lastOpenTs: number; opens: number }>} */
const by = new Map();

function bucket(sid) {
  if (!by.has(sid))
    by.set(sid, {
      evalPass: 0,
      evalFail: 0,
      skipOpen: new Map(),
      lastOpenTs: 0,
      opens: 0,
    });
  return by.get(sid);
}

async function scan(fp) {
  const st = fs.createReadStream(path.join(dir, fp), { encoding: 'utf8' });
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
    const sid = j.strategyId || fp.replace(/\.jsonl$/, '');
    const b = bucket(sid);

    if (j.kind === 'eval') {
      if (j.pass === true) b.evalPass += 1;
      else b.evalFail += 1;
    }
    if (j.kind === 'eval-skip-open' && typeof j.reason === 'string') {
      const k = j.reason;
      b.skipOpen.set(k, (b.skipOpen.get(k) || 0) + 1);
    }
    if (j.kind === 'open') {
      b.opens += 1;
      if (ts > b.lastOpenTs) b.lastOpenTs = ts;
    }
  }
}

for (const fp of files) await scan(fp);

const out = {};
for (const [sid, b] of [...by.entries()].sort()) {
  const skips = [...b.skipOpen.entries()].sort((a, c) => c[1] - a[1]);
  out[sid] = {
    evalPass: b.evalPass,
    evalFail: b.evalFail,
    passRate:
      b.evalPass + b.evalFail > 0
        ? +(b.evalPass / (b.evalPass + b.evalFail)).toFixed(4)
        : null,
    opens: b.opens,
    lastOpenIso: b.lastOpenTs ? new Date(b.lastOpenTs).toISOString() : null,
    skipOpenTop: skips.slice(0, 25),
    skipOpenDistinct: skips.length,
  };
}

console.log(
  JSON.stringify(
    {
      hours,
      cutoffIso: new Date(cutoff).toISOString(),
      strategies: out,
    },
    null,
    2,
  ),
);
