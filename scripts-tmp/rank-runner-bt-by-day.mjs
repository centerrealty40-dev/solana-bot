#!/usr/bin/env node
/* Парсит RUNNER_BT_B_DEFAULT_19D.txt, разбивает per-trade detail (with A+) по дням, считает PnL. */
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.argv[2] || 'docs/strategy/refactor/RUNNER_BT_B_DEFAULT_19D.txt';
const ROOT = process.cwd();
const txt = fs.readFileSync(path.resolve(ROOT, FILE), 'utf8');

// Per-trade detail (with A+) — последний блок до конца файла
const m = txt.split('## Per-trade detail (with A+)');
if (m.length < 2) {
  console.error('No "Per-trade detail (with A+)" section found');
  process.exit(1);
}
const block = m[1];
const lines = block.split('\n').filter(l => l.trim().length > 0);

// Format: 2026-05-19 23:31  raydium   <mint>  <hold>  <peak%>  <pnl%>  $<usd>  <dca>  <reason>
const re = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\S+)\s+(\S+)\s+(\d+)\s+([+-]?[\d.]+)%\s+([+-]?[\d.]+)%\s+\$(-?[\d.]+)\s+(\S+)\s+(\S+)/;

const byDay = new Map();
const overall = { count: 0, pnl: 0, win: 0, loss: 0 };

for (const line of lines) {
  const mm = line.match(re);
  if (!mm) continue;
  const [, day, , dex, mint, hold, peakPct, pnlPct, pnlUsd, dca, reason] = mm;
  const usd = Number(pnlUsd);
  if (!Number.isFinite(usd)) continue;
  const d = byDay.get(day) || { count: 0, pnl: 0, win: 0, loss: 0, top: [], bot: [] };
  d.count += 1;
  d.pnl += usd;
  if (usd > 0) d.win += 1;
  else d.loss += 1;
  d.top.push({ mint, dex, hold, peakPct, pnlPct, usd, reason });
  byDay.set(day, d);
  overall.count += 1;
  overall.pnl += usd;
  if (usd > 0) overall.win += 1;
  else overall.loss += 1;
}

console.log(`### PnL by day (runner + Policy A+, 19d window)\n`);
console.log('| date       | trades | wins | losses | win-rate | total PnL $ | avg/trade $ |');
console.log('|------------|--------|------|--------|----------|-------------|-------------|');

const sortedDays = [...byDay.keys()].sort();
let cumul = 0;
for (const day of sortedDays) {
  const d = byDay.get(day);
  cumul += d.pnl;
  const wr = ((d.win / d.count) * 100).toFixed(0);
  const avg = (d.pnl / d.count).toFixed(2);
  console.log(`| ${day} | ${String(d.count).padStart(6)} | ${String(d.win).padStart(4)} | ${String(d.loss).padStart(6)} | ${(wr+'%').padStart(8)} | ${d.pnl.toFixed(2).padStart(11)} | ${String(avg).padStart(11)} |`);
}

console.log(`\n### Overall (with A+)`);
console.log(`- trades: ${overall.count}`);
console.log(`- PnL: $${overall.pnl.toFixed(2)}`);
console.log(`- win-rate: ${((overall.win/overall.count)*100).toFixed(1)}%`);
console.log(`- avg/trade: $${(overall.pnl/overall.count).toFixed(2)}`);

console.log(`\n### Cumulative PnL trajectory`);
let c = 0;
for (const day of sortedDays) {
  c += byDay.get(day).pnl;
  console.log(`  ${day}: cum $${c.toFixed(2)}`);
}

// Last 7 vs prev 7 vs early 5
const last7 = sortedDays.slice(-7);
const prev7 = sortedDays.slice(-14, -7);
const early = sortedDays.slice(0, sortedDays.length - 14);

const sumDays = (days) => days.reduce((a, d) => {
  const x = byDay.get(d);
  return { count: a.count + x.count, pnl: a.pnl + x.pnl };
}, { count: 0, pnl: 0 });

const l = sumDays(last7), p = sumDays(prev7), e = sumDays(early);
console.log(`\n### Stability analysis`);
console.log(`- Early days (${early[0]} … ${early[early.length-1]||'none'}): ${e.count} trades, $${e.pnl.toFixed(2)}, ROI ${e.count?((e.pnl/(e.count*500))*100).toFixed(2):'n/a'}%`);
console.log(`- Mid 7d (${prev7[0]} … ${prev7[prev7.length-1]}): ${p.count} trades, $${p.pnl.toFixed(2)}, ROI ${(p.pnl/(p.count*500)*100).toFixed(2)}%`);
console.log(`- Last 7d (${last7[0]} … ${last7[last7.length-1]}): ${l.count} trades, $${l.pnl.toFixed(2)}, ROI ${(l.pnl/(l.count*500)*100).toFixed(2)}%`);
