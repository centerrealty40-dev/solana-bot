import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const ADVISOR_DIR = process.env.ADVISOR_DIR || '/opt/solana-alpha/data/advisor';
const ADVISOR_JOURNAL = path.join(ADVISOR_DIR, 'journal.jsonl');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const WINDOW_HOURS = Number(process.env.DIGEST_WINDOW_HOURS || 24);
const TOP_N = Number(process.env.DIGEST_TOP_N || 6);
const SEND_TELEGRAM = process.env.DIGEST_SEND_TELEGRAM === '1';

const cutoff = Date.now() - WINDOW_HOURS * 3600_000;

function fmtPct(v) { const x = Number(v ?? 0); return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; }

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const ln of lines) { try { out.push(JSON.parse(ln)); } catch {} }
  return out;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
    process.exit(1);
  }
  const { sendTagged } = await import('../scripts/lib/telegram.mjs');
  await sendTagged('ADVICE', 'digest', text);
  return;
  // eslint-disable-next-line no-unreachable
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Telegram ${r.status}: ${body.slice(0, 200)}`);
  }
}

function key(rec) {
  return `${rec.kind}|${rec.target_kind}|${rec.target}`;
}

function aggregateRecs(runs) {
  const map = new Map();
  for (const run of runs) {
    const all = [
      ...(run.recommendations?.strategy || []),
      ...(run.recommendations?.bucket || []),
    ];
    for (const rec of all) {
      const k = key(rec);
      const cur = map.get(k) || {
        kind: rec.kind,
        target_kind: rec.target_kind,
        target: rec.target,
        appearances: 0,
        sum_E: 0,
        sum_n: 0,
        sum_win: 0,
        last_text: rec.text,
        first_seen: run.ts,
        last_seen: run.ts,
      };
      cur.appearances += 1;
      cur.sum_E += Number(rec.expectancy_pct || 0);
      cur.sum_n += Number(rec.n || 0);
      cur.sum_win += Number(rec.win_rate_pct || 0);
      cur.last_text = rec.text;
      if (run.ts < cur.first_seen) cur.first_seen = run.ts;
      if (run.ts > cur.last_seen) cur.last_seen = run.ts;
      map.set(k, cur);
    }
  }
  const out = [];
  for (const v of map.values()) {
    out.push({
      ...v,
      avg_E: v.appearances ? v.sum_E / v.appearances : 0,
      avg_win: v.appearances ? v.sum_win / v.appearances : 0,
    });
  }
  return out;
}

function summarizeStrategies(runs) {
  const map = new Map();
  for (const run of runs) {
    for (const s of run.strategies || []) {
      const cur = map.get(s.strategyId) || {
        strategyId: s.strategyId,
        appearances: 0,
        sum_E: 0,
        sum_n: 0,
        sum_win: 0,
        sum_usd: 0,
        last_n: 0,
        last_E: 0,
      };
      cur.appearances += 1;
      cur.sum_E += Number(s.expectancy_pct || 0);
      cur.sum_n += Number(s.n || 0);
      cur.sum_win += Number(s.win_rate_pct || 0);
      cur.sum_usd += Number(s.sum_usd || 0);
      cur.last_n = Number(s.n || 0);
      cur.last_E = Number(s.expectancy_pct || 0);
      map.set(s.strategyId, cur);
    }
  }
  const out = [];
  for (const v of map.values()) {
    out.push({
      ...v,
      avg_E: v.appearances ? v.sum_E / v.appearances : 0,
      avg_win: v.appearances ? v.sum_win / v.appearances : 0,
    });
  }
  out.sort((a, b) => b.last_E - a.last_E);
  return out;
}

function buildDigest(runs) {
  const lines = [];
  lines.push(`Advisor digest · last ${WINDOW_HOURS}h`);
  lines.push(`Runs in window: ${runs.length}`);
  if (!runs.length) {
    lines.push('No advisor runs in window.');
    return lines.join('\n');
  }
  lines.push('');

  const stratSummary = summarizeStrategies(runs);
  lines.push('Strategy trend (last_E):');
  for (const s of stratSummary.slice(0, TOP_N)) {
    lines.push(`- ${s.strategyId}: last_E=${fmtPct(s.last_E)} avg_E=${fmtPct(s.avg_E)} last_n=${s.last_n} runs=${s.appearances}`);
  }
  lines.push('');

  const recs = aggregateRecs(runs);
  const persistent = recs
    .filter((r) => r.appearances >= Math.max(2, Math.floor(runs.length / 2)))
    .sort((a, b) => b.appearances - a.appearances || Math.abs(b.avg_E) - Math.abs(a.avg_E));

  lines.push(`Persistent ideas (>= ${Math.max(2, Math.floor(runs.length / 2))} runs):`);
  if (!persistent.length) lines.push('- none');
  for (const r of persistent.slice(0, TOP_N * 2)) {
    lines.push(`- [${r.appearances}x] ${r.last_text} avg_E=${fmtPct(r.avg_E)}`);
  }

  const oneOff = recs
    .filter((r) => r.appearances === 1)
    .sort((a, b) => Math.abs(b.avg_E) - Math.abs(a.avg_E))
    .slice(0, TOP_N);
  if (oneOff.length) {
    lines.push('');
    lines.push('One-off signals (single run):');
    for (const r of oneOff) {
      lines.push(`- ${r.last_text}`);
    }
  }

  return lines.join('\n').slice(0, 3900);
}

async function main() {
  const all = readJsonl(ADVISOR_JOURNAL);
  const runs = all.filter((r) => Date.parse(r.ts || '') >= cutoff);
  const text = buildDigest(runs);
  console.log(text);
  if (SEND_TELEGRAM) await sendTelegram(text);
  console.log('done', { runs: runs.length, sent: SEND_TELEGRAM });
}

main().catch((e) => { console.error(e); process.exit(1); });
