#!/usr/bin/env node
/**
 * Dump all execution_attempt ↔ execution_result pairs from LIVE_TRADES_PATH JSONL.
 * Usage: LIVE_TRADES_PATH=/path/to.jsonl node scripts-tmp/live-journal-exec-dump.mjs
 */
import fs from 'node:fs';

const path = process.env.LIVE_TRADES_PATH || process.argv[2] || 'data/live/pt1-oscar-live.jsonl';
const strategyId = process.env.LIVE_STRATEGY_ID || 'live-oscar';

if (!fs.existsSync(path)) {
  console.error(`missing file: ${path}`);
  process.exit(1);
}

const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
const byIntent = new Map();

for (const ln of lines) {
  let r;
  try {
    r = JSON.parse(ln);
  } catch {
    continue;
  }
  if (String(r.strategyId ?? '') !== strategyId) continue;
  if (r.channel != null && r.channel !== 'live') continue;
  const id = r.intentId;
  if (!id) continue;
  const cur = byIntent.get(id) ?? {};
  if (r.kind === 'execution_attempt') cur.attempt = r;
  if (r.kind === 'execution_result') cur.result = r;
  byIntent.set(id, cur);
}

const rows = [];
for (const [intentId, v] of byIntent) {
  if (!v.attempt || !v.result) continue;
  const a = v.attempt;
  const res = v.result;
  rows.push({
    intentId,
    ts: a.ts,
    side: a.side,
    mint: String(a.mint ?? '').slice(0, 44),
    intendedUsd: a.intendedUsd ?? null,
    status: res.status,
    tx: typeof res.txSignature === 'string' ? res.txSignature : null,
    hasQuoteOut: Boolean(a.quoteSnapshot?.quoteOutAmount),
  });
}

rows.sort((x, y) => x.ts - y.ts);

console.log(JSON.stringify({ path, strategyId, pairedRows: rows.length, rows }, null, 2));

const byStatus = {};
for (const x of rows) {
  byStatus[x.status] = (byStatus[x.status] ?? 0) + 1;
}
console.error('\nby status:', byStatus);
