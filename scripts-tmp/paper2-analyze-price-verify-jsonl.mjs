#!/usr/bin/env node
/**
 * Aggregate priceVerify on `open` lines in paper JSONL.
 * Usage: node scripts-tmp/paper2-analyze-price-verify-jsonl.mjs file1.jsonl [file2.jsonl ...]
 */
import fs from 'node:fs';

const transient = new Set(['timeout', 'http-error', 'fetch-fail']);

for (const p of process.argv.slice(2)) {
  const s = {
    path: p,
    openTotal: 0,
    openWithPriceVerify: 0,
    pvOk: 0,
    pvBlocked: 0,
    pvSkippedTransient: 0,
    pvSkippedOther: 0,
    skippedReasons: {},
  };
  let txt;
  try {
    txt = fs.readFileSync(p, 'utf8');
  } catch (e) {
    console.log(JSON.stringify({ path: p, error: String(e.message) }, null, 2));
    continue;
  }
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.kind !== 'open') continue;
    s.openTotal++;
    const pv = j.priceVerify;
    if (pv == null) continue;
    s.openWithPriceVerify++;
    if (pv.kind === 'ok') s.pvOk++;
    else if (pv.kind === 'blocked') s.pvBlocked++;
    else if (pv.kind === 'skipped') {
      const r = pv.reason || 'unknown';
      s.skippedReasons[r] = (s.skippedReasons[r] || 0) + 1;
      if (transient.has(r)) s.pvSkippedTransient++;
      else s.pvSkippedOther++;
    }
  }
  const denom = s.openWithPriceVerify || 1;
  s.pctTransientOfPv = `${((100 * s.pvSkippedTransient) / denom).toFixed(3)}%`;
  s.pctOkOfPv = `${((100 * s.pvOk) / denom).toFixed(3)}%`;
  s.pctBlockedOfPv = `${((100 * s.pvBlocked) / denom).toFixed(3)}%`;
  s.pctSkippedOtherOfPv = `${((100 * s.pvSkippedOther) / denom).toFixed(3)}%`;
  console.log(JSON.stringify(s, null, 2));
}
