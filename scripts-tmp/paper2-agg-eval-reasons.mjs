import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.PAPER2_DIR || path.join(process.cwd(), 'data/paper2');
const windows = [
  ['1h', 3600_000],
  ['24h', 86400_000],
  ['7d', 7 * 86400_000],
];

function sortMap(m) {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function agg(ms) {
  const since = Date.now() - ms;
  const totals = new Map();
  const byFile = {};
  let evalPass = 0;
  let evalFail = 0;
  let evalTotal = 0;

  if (!fs.existsSync(dir)) {
    return { error: `dir_missing:${dir}`, sinceIso: new Date(since).toISOString() };
  }

  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const sid = f.replace(/\.jsonl$/, '');
    byFile[sid] = { pass: 0, fail: 0, reasons: new Map() };
    const fp = path.join(dir, f);
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    for (const ln of lines) {
      let e;
      try {
        e = JSON.parse(ln);
      } catch {
        continue;
      }
      if (e.kind !== 'eval' || (e.ts || 0) < since) continue;
      evalTotal++;
      if (e.pass) {
        evalPass++;
        byFile[sid].pass++;
      } else {
        evalFail++;
        byFile[sid].fail++;
        for (const r of Array.isArray(e.reasons) ? e.reasons : []) {
          totals.set(r, (totals.get(r) || 0) + 1);
          const m = byFile[sid].reasons;
          m.set(r, (m.get(r) || 0) + 1);
        }
      }
    }
  }

  return {
    paper2Dir: dir,
    windowStartIso: new Date(since).toISOString(),
    evalTotal,
    evalPass,
    evalFail,
    topReasons: sortMap(totals).slice(0, 40),
    byStrategy: Object.fromEntries(
      Object.entries(byFile).map(([k, v]) => [
        k,
        { evalPass: v.pass, evalFail: v.fail, topReasons: sortMap(v.reasons).slice(20) },
      ]),
    ),
  };
}

for (const [label, ms] of windows) {
  console.log(`\n######## ${label} ########`);
  console.log(JSON.stringify(agg(ms), null, 2));
}
