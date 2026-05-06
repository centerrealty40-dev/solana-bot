#!/usr/bin/env node
/**
 * Compare mints from live JSONL `live_position_close` events vs `live-oscar-mint-whitelist.txt`.
 *
 * Usage:
 *   node scripts/compare-live-closes-whitelist.mjs <live.jsonl> [whitelist.txt]
 *
 * Defaults (relative to cwd): data/live/pt1-oscar-live.jsonl and data/live/live-oscar-mint-whitelist.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

function loadWhitelist(file) {
  const body = fs.readFileSync(file, 'utf8');
  const set = new Set();
  for (const line of body.split(/\r?\n/)) {
    const cut = line.split('#')[0]?.trim();
    if (cut) set.add(cut);
  }
  return set;
}

async function loadCloseMints(jsonlPath) {
  const mintToSymbol = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let j;
    try {
      j = JSON.parse(t);
    } catch {
      continue;
    }
    if (j?.kind !== 'live_position_close' || typeof j.mint !== 'string') continue;
    const sym =
      j.closedTrade && typeof j.closedTrade.symbol === 'string' ? j.closedTrade.symbol : '';
    mintToSymbol.set(j.mint, sym);
  }
  return mintToSymbol;
}

const jsonl = path.resolve(process.argv[2] || path.join('data', 'live', 'pt1-oscar-live.jsonl'));
const wlPath = path.resolve(process.argv[3] || path.join('data', 'live', 'live-oscar-mint-whitelist.txt'));

if (!fs.existsSync(jsonl)) {
  console.error(`Live JSONL not found: ${jsonl}`);
  console.error('Pass path as argv[1] or copy pt1-oscar-live.jsonl locally.');
  process.exit(2);
}
if (!fs.existsSync(wlPath)) {
  console.error(`Whitelist not found: ${wlPath}`);
  process.exit(2);
}

const whitelist = loadWhitelist(wlPath);
const closes = await loadCloseMints(jsonl);

const closedMints = new Set(closes.keys());

const inCloseNotWhitelist = [...closedMints].filter((m) => !whitelist.has(m));
const inWhitelistNotClosed = [...whitelist].filter((m) => !closedMints.has(m));

console.log(`live_jsonl=${jsonl}`);
console.log(`whitelist=${wlPath}`);
console.log(`unique_live_position_close_mints=${closedMints.size}`);
console.log(`whitelist_entries=${whitelist.size}`);
console.log('');
console.log('--- Closed (live_position_close) but NOT in whitelist (consider adding) ---');
if (inCloseNotWhitelist.length === 0) {
  console.log('(none)');
} else {
  for (const m of inCloseNotWhitelist.sort()) {
    const s = closes.get(m);
    console.log(`${m}${s ? `\t${s}` : ''}`);
  }
}
console.log('');
console.log('--- In whitelist but no live_position_close in this journal (informational) ---');
if (inWhitelistNotClosed.length === 0) {
  console.log('(none)');
} else {
  for (const m of inWhitelistNotClosed.sort()) console.log(m);
}
