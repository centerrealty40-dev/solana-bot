#!/usr/bin/env node
/**
 * Reconcile realized PnL in a paper2 jsonl with dashboard logic (paper2Metrics).
 * Usage: node scripts-tmp/paper2-reconcile-pnl.mjs /path/to/pt1-diprunner.jsonl
 */
import fs from 'node:fs';

const POSITION_USD_DEFAULT = Number(process.env.POSITION_USD ?? process.env.PAPER_POSITION_USD ?? 100);
const path = process.argv[2];
if (!path) {
  console.error('Usage: node paper2-reconcile-pnl.mjs <strategy.jsonl>');
  process.exit(1);
}
if (!fs.existsSync(path)) {
  console.error('File not found:', path);
  process.exit(1);
}

let closed = 0;
let sumFromNet = 0;
let sumFromPctFallback = 0;
let wins = 0;
let missingNet = 0;

for (const line of fs.readFileSync(path, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.kind !== 'close') continue;
  closed++;
  const pnlPct = Number(e.pnlPct ?? 0);
  const netUsd = e.netPnlUsd;
  const pnlUsd =
    typeof netUsd === 'number' && Number.isFinite(netUsd)
      ? netUsd
      : (POSITION_USD_DEFAULT * pnlPct) / 100;
  if (typeof netUsd !== 'number' || !Number.isFinite(netUsd)) {
    missingNet++;
    sumFromPctFallback += pnlUsd;
  } else {
    sumFromNet += netUsd;
  }
  if (pnlPct > 0) wins++;
}

const totalUsd = sumFromNet + sumFromPctFallback;
const winRate = closed ? (wins / closed) * 100 : 0;

console.log(
  JSON.stringify(
    {
      file: path,
      closedTrades: closed,
      realizedPnlUsd_netSum: +sumFromNet.toFixed(4),
      realizedPnlUsd_pctFallbackSum: +sumFromPctFallback.toFixed(4),
      realizedPnlUsd_total: +totalUsd.toFixed(4),
      closesMissing_netPnlUsd_field: missingNet,
      winRatePct: +winRate.toFixed(2),
      note:
        'Dashboard strategy realizedPnlUsd uses the same formula as realizedPnlUsd_total (sum per close). Compare with /api/paper2 strategies[].realizedPnlUsd for the same basename.',
    },
    null,
    2,
  ),
);
