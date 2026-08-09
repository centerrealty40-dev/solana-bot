/**
 * Counterfactual filter search on vol-green closed trades (journal.jsonl).
 * Usage (on LERA):
 *   node scripts-tmp/volgreen-cf-filter-search.mjs [path/to/journal.jsonl]
 */
import fs from 'node:fs';

const journalPath = process.argv[2] || 'data/volgreen/journal.jsonl';
const raw = fs.readFileSync(journalPath);
// last 100MB
const text = raw.subarray(Math.max(0, raw.length - 100_000_000)).toString('utf8');
const lines = text.split('\n');

const buys = [];
const sells = [];
const marks = new Map();

for (const line of lines) {
  if (!line) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const k = e.kind;
  const mint = e.mint;
  const ts = e.ts || 0;
  if ((k === 'copy_buy' || k === 'mild_dip_buy_attempt') && e.ok === true && mint) {
    const ev = e.eval || {};
    const rs = Array.isArray(ev.reasons) ? ev.reasons : [];
    let path = 'unknown';
    for (const r of rs) {
      if (typeof r === 'string' && r.includes('green_tape')) {
        path = r.replace('green_tape_green_tape_', '');
        break;
      }
    }
    buys.push({
      ts,
      mint,
      pc5m: e.pc5m ?? e.signalPc5m ?? null,
      path,
    });
  }
  if (k === 'mild_dip_sell' && e.ok === true && mint) sells.push(e);
  if (k === 'mild_dip_mark' && mint) {
    if (!marks.has(mint)) marks.set(mint, []);
    marks.get(mint).push(e);
  }
}

sells.sort((a, b) => (a.ts || 0) - (b.ts || 0));
const used = new Set();
const trades = [];
for (const b of buys.sort((a, b) => a.ts - b.ts)) {
  for (let i = 0; i < sells.length; i++) {
    if (used.has(i)) continue;
    const s = sells[i];
    if (s.mint !== b.mint || (s.ts || 0) < b.ts) continue;
    let r = s.realizedPct;
    if (typeof r !== 'number' || !Number.isFinite(r)) {
      used.add(i);
      continue;
    }
    r = Math.max(-100, Math.min(100, r));
    const mlist = (marks.get(b.mint) || []).filter(
      (m) => b.ts <= (m.ts || 0) && (m.ts || 0) <= (s.ts || 0),
    );
    const pnls = mlist.map((m) => m.pnlPct).filter((x) => typeof x === 'number');
    trades.push({
      realized: r,
      reason: s.reason || '?',
      holdSec: ((s.ts || 0) - b.ts) / 1000,
      mae: pnls.length ? Math.min(...pnls) : null,
      mfe: pnls.length ? Math.max(...pnls) : typeof s.mfePct === 'number' ? s.mfePct : null,
      pc5m: typeof b.pc5m === 'number' ? b.pc5m : null,
      path: b.path,
    });
    used.add(i);
    break;
  }
}

const usd = (xs) => (xs.reduce((a, b) => a + b, 0) * 5) / 100;
const base = trades.map((t) => t.realized);
console.log(
  JSON.stringify(
    {
      n: trades.length,
      base_usd: usd(base),
      win_pct: (100 * base.filter((x) => x > 0).length) / base.length,
      recipes: {
        only_bank_giveback: summarize(
          trades.filter((t) =>
            ['mfe_bank_1', 'mfe_bank_2', 'peak_giveback', 'peak_giveback_partial'].includes(
              t.reason,
            ),
          ),
        ),
        bank_giveback_mfe8: summarize(
          trades.filter(
            (t) =>
              ['mfe_bank_1', 'mfe_bank_2', 'peak_giveback', 'peak_giveback_partial'].includes(
                t.reason,
              ) &&
              t.mfe != null &&
              t.mfe >= 8,
          ),
        ),
        drop_never_arm_and_cliff: summarize(
          trades.filter((t) => !t.reason.startsWith('never_arm') && t.reason !== 'cliff_dump'),
        ),
        pc5m_15_80: summarize(
          trades.filter((t) => t.pc5m != null && t.pc5m >= 15 && t.pc5m <= 80),
        ),
      },
    },
    null,
    2,
  ),
);

function summarize(rows) {
  if (!rows.length) return { n: 0, usd: 0, win: 0 };
  const rs = rows.map((t) => t.realized);
  return {
    n: rows.length,
    usd: usd(rs),
    win: (100 * rs.filter((x) => x > 0).length) / rs.length,
    avg_pct: rs.reduce((a, b) => a + b, 0) / rs.length,
  };
}
