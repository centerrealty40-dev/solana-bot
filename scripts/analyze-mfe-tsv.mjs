#!/usr/bin/env node
/**
 * Агрегаты по TSV из `live-oscar-closed-mfe-audit.ts` (таб-разделитель).
 * Usage: node scripts/analyze-mfe-tsv.mjs path/to/report.tsv
 */
import fs from 'node:fs';
import readline from 'node:readline';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/analyze-mfe-tsv.mjs <report.tsv>');
  process.exit(1);
}

const by = new Map();
function bucket(r) {
  let b = by.get(r);
  if (!b) {
    b = {
      n: 0,
      sumNet: 0,
      trailArmed1: 0,
      sumTrailDrop: 0,
      nTrailDrop: 0,
      robustDiffs: [],
      rawDiffs: [],
      postExit: [],
    };
    by.set(r, b);
  }
  return b;
}

function med(a) {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const rl = readline.createInterface({ input: fs.createReadStream(path, 'utf8'), crlfDelay: Infinity });
let header = null;
let cols = null;
for await (const line of rl) {
  if (!line.trim()) continue;
  const parts = line.split('\t');
  if (!header) {
    header = parts;
    cols = Object.fromEntries(header.map((h, i) => [h, i]));
    continue;
  }
  const reason = parts[cols.exitReason];
  const b = bucket(reason);
  b.n += 1;
  b.sumNet += Number(parts[cols.netPnlUsd] || 0);
  if (parts[cols.trailingArmed] === '1') b.trailArmed1 += 1;
  const td = Number(parts[cols.trailDrop]);
  if (Number.isFinite(td)) {
    b.sumTrailDrop += td;
    b.nTrailDrop += 1;
  }
  const d = Number(parts[cols.mfeMinusClose_pg]);
  if (Number.isFinite(d)) b.rawDiffs.push(d);
  const s = Number(parts[cols.pg_samples_hold]);
  if (Number.isFinite(d) && Math.abs(d) <= 300 && Number.isFinite(s) && s >= 3) b.robustDiffs.push(d);
  const pe = Number(parts[cols.postExitMaxPct_pg]);
  if (Number.isFinite(pe)) b.postExit.push(pe);
}

let totalNet = 0;
let totalN = 0;
for (const [, b] of by) {
  totalNet += b.sumNet;
  totalN += b.n;
}

const rows = [];
for (const [reason, b] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const avgRob = b.robustDiffs.length ? b.robustDiffs.reduce((s, x) => s + x, 0) / b.robustDiffs.length : null;
  const medRob = med(b.robustDiffs);
  const avgPost = b.postExit.length ? b.postExit.reduce((s, x) => s + x, 0) / b.postExit.length : null;
  rows.push({
    exitReason: reason,
    count: b.n,
    sumNetPnlUsd: +b.sumNet.toFixed(2),
    avgTrailDrop: b.nTrailDrop ? +(b.sumTrailDrop / b.nTrailDrop).toFixed(4) : null,
    trailingArmed1: b.trailArmed1,
    robustN: b.robustDiffs.length,
    avgMfeMinusClose_robust: avgRob != null ? +avgRob.toFixed(4) : null,
    medianMfeMinusClose_robust: medRob != null ? +medRob.toFixed(4) : null,
    avgPostExitMaxPct_pg: avgPost != null ? +avgPost.toFixed(2) : null,
  });
}

console.log(
  JSON.stringify(
    {
      file: path,
      totalCloses: totalN,
      sumNetPnlUsdAll: +totalNet.toFixed(2),
      byExitReason: rows,
    },
    null,
    2,
  ),
);
