#!/usr/bin/env node
/**
 * Compare pt1-oscar | pt1-diprunner | pt1-dno closes in the last N hours from JSONL.
 * Window anchored to the newest timestamp seen across the three files.
 *
 * Usage:
 *   node scripts-tmp/paper-triad-last24h.mjs path1.jsonl path2.jsonl path3.jsonl [--hours 24]
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const argv = process.argv.slice(2);
let windowHours = 24;
const paths = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--hours' && argv[i + 1]) {
    windowHours = Number(argv[++i]);
    continue;
  }
  if (a.startsWith('--hours=')) {
    windowHours = Number(a.slice('--hours='.length));
    continue;
  }
  paths.push(a);
}
const WINDOW_MS = Math.round(windowHours * 3600000);

const STRATS = ['pt1-oscar', 'pt1-diprunner', 'pt1-dno'];

async function scanMaxTs(file) {
  if (!fs.existsSync(file)) return 0;
  const st = fs.statSync(file);
  if (st.size === 0) return 0;
  const fd = fs.openSync(file, 'r');
  const chunk = Math.min(st.size, 65536);
  const buf = Buffer.alloc(chunk);
  fs.readSync(fd, buf, 0, chunk, st.size - chunk);
  fs.closeSync(fd);
  const tail = buf.toString('utf8');
  const lines = tail.split(/\r?\n/).filter(Boolean);
  let max = 0;
  for (const line of lines.slice(-50)) {
    try {
      const j = JSON.parse(line);
      const t = Number(j.ts);
      if (Number.isFinite(t)) max = Math.max(max, t);
    } catch {
      /* skip */
    }
  }
  return max;
}

async function loadCloses(file, cutoffTs, label) {
  const closes = [];
  const opens = new Map();
  if (!fs.existsSync(file)) {
    console.warn(`missing file: ${file} (${label})`);
    return { closes, opens };
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const kind = e.kind;
    const mint = e.mint;
    if (!mint) continue;
    if (kind === 'open') {
      opens.set(mint, { entryTs: Number(e.entryTs), symbol: e.symbol });
      continue;
    }
    if (kind !== 'close') continue;
    const ts = Number(e.ts);
    if (!Number.isFinite(ts) || ts < cutoffTs) continue;
    const net = Number(e.netPnlUsd ?? 0);
    const sym = e.symbol ?? mint.slice(0, 8);
    closes.push({
      mint,
      symbol: sym,
      ts,
      netPnlUsd: net,
      exitReason: String(e.exitReason ?? ''),
      durationMin: Number(e.durationMin ?? 0),
      entryTs: Number(e.entryTs ?? 0),
      partialCount: Array.isArray(e.partialSells) ? e.partialSells.length : 0,
      invested: Number(e.totalInvestedUsd ?? 100),
      strategyId: String(e.strategyId ?? label),
    });
  }
  return { closes, opens };
}

function summarize(name, rows) {
  const sum = rows.reduce((s, r) => s + r.netPnlUsd, 0);
  const wins = rows.filter((r) => r.netPnlUsd > 0).length;
  const losses = rows.filter((r) => r.netPnlUsd < 0).length;
  const flat = rows.filter((r) => r.netPnlUsd === 0).length;
  const byExit = {};
  for (const r of rows) {
    byExit[r.exitReason] = (byExit[r.exitReason] ?? 0) + 1;
  }
  const avgDur = rows.length ? rows.reduce((s, r) => s + r.durationMin, 0) / rows.length : 0;
  return { name, n: rows.length, sum, wins, losses, flat, winRate: rows.length ? wins / rows.length : 0, byExit, avgDurMin: avgDur };
}

async function main() {
  const files = paths.length >= 3 ? paths : STRATS.map((s) => `data/paper2/${s}.jsonl`);
  const labels = ['oscar', 'diprunner', 'dno'];

  let anchor = 0;
  for (const f of files) {
    anchor = Math.max(anchor, await scanMaxTs(f));
  }
  if (!anchor) {
    console.error('No timestamps found.');
    process.exit(1);
  }
  const cutoff = anchor - WINDOW_MS;

  console.log(`Anchor ts (max in files): ${anchor}  (${new Date(anchor).toISOString()})`);
  console.log(`Window: last ${windowHours}h  cutoff >= ${cutoff}\n`);

  const all = [];
  const byStrat = {};
  for (let i = 0; i < files.length; i++) {
    const { closes } = await loadCloses(files[i], cutoff, labels[i]);
    byStrat[labels[i]] = closes;
    all.push(...closes.map((c) => ({ ...c, fileLabel: labels[i] })));
  }

  for (const lab of labels) {
    const s = summarize(lab, byStrat[lab] ?? []);
    console.log(`=== ${lab} ===`);
    console.log(`  closes: ${s.n}  sum netPnlUsd: ${s.sum.toFixed(2)}`);
    console.log(`  win/loss/flat: ${s.wins}/${s.losses}/${s.flat}  winRate: ${(100 * s.winRate).toFixed(1)}%`);
    console.log(`  avg duration min: ${s.avgDurMin.toFixed(1)}`);
    console.log(`  exitReason counts: ${JSON.stringify(s.byExit)}`);
    console.log('');
  }

  /** Mint-level overlap (same coin traded by multiple strategies) */
  const mintTo = new Map();
  for (const lab of labels) {
    for (const c of byStrat[lab] ?? []) {
      if (!mintTo.has(c.mint)) mintTo.set(c.mint, {});
      mintTo.get(c.mint)[lab] = c;
    }
  }
  const triple = [];
  const pair = [];
  for (const [mint, o] of mintTo) {
    const keys = Object.keys(o);
    if (keys.length >= 3) triple.push({ mint, o });
    else if (keys.length === 2) pair.push({ mint, o });
  }

  console.log(`=== Overlap (closed in window) ===`);
  console.log(`  mints with 3 strategies: ${triple.length}`);
  console.log(`  mints with 2 strategies: ${pair.length}`);

  function cmpOverlay(rows, title) {
    let oscarWins = 0;
    let dipWins = 0;
    let dnoWins = 0;
    let sumDeltaOscarMinusDip = 0;
    let sumDeltaOscarMinusDno = 0;
    let sumDeltaDipMinusDno = 0;
    const samples = [];
    for (const { mint, o } of rows) {
      const bo = o.oscar?.netPnlUsd ?? null;
      const bd = o.diprunner?.netPnlUsd ?? null;
      const bn = o.dno?.netPnlUsd ?? null;
      const vals = [
        ['oscar', bo],
        ['diprunner', bd],
        ['dno', bn],
      ].filter((x) => x[1] != null);
      if (vals.length < 2) continue;
      vals.sort((a, b) => b[1] - a[1]);
      const best = vals[0][0];
      if (best === 'oscar') oscarWins++;
      if (best === 'diprunner') dipWins++;
      if (best === 'dno') dnoWins++;
      if (bo != null && bd != null) sumDeltaOscarMinusDip += bo - bd;
      if (bo != null && bn != null) sumDeltaOscarMinusDno += bo - bn;
      if (bd != null && bn != null) sumDeltaDipMinusDno += bd - bn;
      if (samples.length < 12 && vals.length === 3) {
        samples.push({
          mint: mint.slice(0, 12),
          sym: o.oscar?.symbol ?? o.diprunner?.symbol ?? o.dno?.symbol,
          oscar: bo?.toFixed(2),
          dip: bd?.toFixed(2),
          dno: bn?.toFixed(2),
          best,
        });
      }
    }
    console.log(`\n--- ${title} (n=${rows.length}) ---`);
    console.log(`  best PnL count: oscar=${oscarWins} diprunner=${dipWins} dno=${dnoWins}`);
    if (rows.length) {
      console.log(`  sum(oscar - diprunner) USD: ${sumDeltaOscarMinusDip.toFixed(2)}`);
      console.log(`  sum(oscar - dno) USD: ${sumDeltaOscarMinusDno.toFixed(2)}`);
      console.log(`  sum(diprunner - dno) USD: ${sumDeltaDipMinusDno.toFixed(2)}`);
    }
    if (samples.length) {
      console.log(`  sample triples (mint, net USD):`);
      for (const s of samples) console.log(`    ${s.sym} ${s.mint}… oscar=${s.oscar} dip=${s.dip} dno=${s.dno} → ${s.best}`);
    }
  }

  cmpOverlay(triple, 'All three strategies');
  cmpOverlay(pair, 'Pairs only');

  /** Simple meta: equal-weight portfolio of strategies */
  console.log(`\n=== Combined (sum of three strategy totals in window) ===`);
  const totalSum = labels.reduce((s, lab) => s + summarize(lab, byStrat[lab]).sum, 0);
  console.log(`  sum of per-strategy netPnlUsd: ${totalSum.toFixed(2)} (not deduped by mint — independent books)`);

  console.log(`\n=== Config reminder (from ecosystem — exit mechanics differ) ===`);
  console.log(`  oscar: DCA -7% +30%; kill -14%; TP grid +5% steps sell 20% remainder; trail 10% after 1.1x; timeout 12h`);
  console.log(`  diprunner: DCA -10/-20% +30% each; kill -40%; TP ladder 10/20/30/40% PnL sells 40/50/80/100%; trail 10%/1.1x; timeout 24h`);
  console.log(`  dno: DCA -10% +30%; kill -25%; TP ladder 5/10/15/20% PnL 30/50/80/100%; trail 10%/1.1x; timeout 2h`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
