/**
 * Сравнение закрытий нескольких paper-журналов по mint (без БД).
 *
 *   node scripts-tmp/post-trade-compare-strategies.mjs
 *   node scripts-tmp/post-trade-compare-strategies.mjs path/a.jsonl path/b.jsonl
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_FILES = [
  path.join(root, 'data/paper2/pt1-dno.jsonl'),
  path.join(root, 'data/paper2/pt1-diprunner.jsonl'),
  path.join(root, 'data/paper2/pt1-oscar.jsonl'),
];

async function loadCloses(filePath) {
  const strategyIdGuess = path.basename(filePath, '.jsonl');
  const closes = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.kind !== 'close') continue;
    const legs = Array.isArray(o.legs) ? o.legs : [];
    const dcaLegs = legs.filter((l) => l.reason === 'dca').length;
    closes.push({
      strategyId: String(o.strategyId ?? strategyIdGuess),
      mint: o.mint,
      symbol: String(o.symbol ?? ''),
      netUsd: Number(o.netPnlUsd ?? 0),
      pnlPct: Number(o.pnlPct ?? 0),
      reason: String(o.exitReason ?? ''),
      exitTs: Number(o.exitTs ?? o.ts ?? 0),
      invested: Number(o.totalInvestedUsd ?? 0),
      dcaLegs,
      totalLegs: legs.length,
      journal: path.basename(filePath),
    });
  }
  return closes;
}

function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}
function mean(xs) {
  return xs.length ? sum(xs) / xs.length : 0;
}

function byReason(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.reason)) m.set(r.reason, []);
    m.get(r.reason).push(r);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

function bestSid(rowsBySid, mint) {
  let best = null;
  let bestNet = -Infinity;
  for (const [sid, map] of rowsBySid) {
    const r = map.get(mint);
    if (!r) continue;
    if (r.netUsd > bestNet) {
      bestNet = r.netUsd;
      best = sid;
    }
  }
  return best;
}

async function main() {
  const files =
    process.argv.length > 2 ? process.argv.slice(2).map((p) => path.resolve(p)) : DEFAULT_FILES;

  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error('Missing files:', missing.join(', '));
    process.exit(1);
  }

  const data = [];
  for (const f of files) {
    data.push({ path: f, label: path.basename(f, '.jsonl'), closes: await loadCloses(f) });
  }

  console.log('=== Per-journal summary ===\n');
  for (const { label, closes } of data) {
    const nets = closes.map((r) => r.netUsd);
    const wins = nets.filter((x) => x > 0).length;
    const sid = closes[0]?.strategyId ?? label;
    console.log(`— ${label} (${sid}) — ${closes.length} closes`);
    console.log(
      `  winRate=${((100 * wins) / Math.max(1, closes.length)).toFixed(0)}% sumNet=$${sum(nets).toFixed(2)} avgNet=$${mean(nets).toFixed(2)}`,
    );
    for (const [reason, rs] of byReason(closes)) {
      const ns = rs.map((x) => x.netUsd);
      console.log(`  ${reason}: n=${rs.length} sum=$${sum(ns).toFixed(2)} avg=$${mean(ns).toFixed(2)}`);
    }
    console.log('');
  }

  const rowsBySid = new Map();
  for (const { label, closes } of data) {
    const sid = closes[0]?.strategyId ?? label;
    const m = new Map();
    for (const r of closes) {
      m.set(r.mint, r);
    }
    rowsBySid.set(sid, m);
  }
  const sids = [...rowsBySid.keys()];

  const mintSets = sids.map((sid) => new Set(rowsBySid.get(sid).keys()));
  function intersectAll() {
    let acc = mintSets[0] ? new Set(mintSets[0]) : new Set();
    for (let i = 1; i < mintSets.length; i++) {
      const next = mintSets[i];
      acc = new Set([...acc].filter((m) => next.has(m)));
    }
    return acc;
  }

  const triple = intersectAll();
  console.log(`=== Mint overlap ===`);
  console.log(`  All ${sids.length} strategies: ${triple.size} mints`);

  for (let i = 0; i < sids.length; i++) {
    for (let j = i + 1; j < sids.length; j++) {
      const a = mintSets[i];
      const b = mintSets[j];
      let n = 0;
      for (const m of a) {
        if (b.has(m)) n++;
      }
      console.log(`  ${sids[i]} ∩ ${sids[j]}: ${n}`);
    }
  }

  const rankedTriple = [...triple].map((mint) => {
    let combined = 0;
    const parts = {};
    for (const sid of sids) {
      const r = rowsBySid.get(sid).get(mint);
      combined += r.netUsd;
      parts[sid] = r;
    }
    return { mint, combined, parts };
  });
  rankedTriple.sort((x, y) => x.combined - y.combined);

  console.log(`\n=== Worst combined net (all tracked strategies, same mint) ===`);
  for (const row of rankedTriple.slice(0, 15)) {
    const sym = row.parts[sids[0]]?.symbol ?? '?';
    const bits = sids.map((sid) => {
      const r = row.parts[sid];
      return `${sid} $${r.netUsd.toFixed(2)} (${r.reason}) inv$${r.invested}`;
    });
    console.log(`  ${sym} ${String(row.mint).slice(0, 8)}… Σ=$${row.combined.toFixed(2)}  |  ${bits.join('  ·  ')}`);
  }

  console.log(`\n=== Head-to-head winner count (same mint; higher netUsd wins) ===`);
  for (let i = 0; i < sids.length; i++) {
    for (let j = i + 1; j < sids.length; j++) {
      const si = sids[i];
      const sj = sids[j];
      const mi = rowsBySid.get(si);
      const mj = rowsBySid.get(sj);
      let wi = 0;
      let wj = 0;
      let ties = 0;
      for (const mint of mi.keys()) {
        if (!mj.has(mint)) continue;
        const a = mi.get(mint).netUsd;
        const b = mj.get(mint).netUsd;
        if (a > b) wi++;
        else if (b > a) wj++;
        else ties++;
      }
      console.log(`  ${si} vs ${sj}: ${si} wins ${wi}, ${sj} wins ${wj}, ties ${ties} (shared mints only)`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
