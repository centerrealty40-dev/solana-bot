import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const PAPER2_DIR = process.env.PAPER2_DIR || '/opt/solana-alpha/data/paper2';
const STORE_PATH = process.env.PAPER_TRADES_PATH || '/opt/solana-alpha/data/paper-trades.jsonl';
const ADVISOR_DIR = process.env.ADVISOR_DIR || '/opt/solana-alpha/data/advisor';
const ADVISOR_JOURNAL = path.join(ADVISOR_DIR, 'journal.jsonl');
const ADVISOR_BY_DAY_DIR = path.join(ADVISOR_DIR, 'by-day');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const POSITION_USD = Number(process.env.POSITION_USD || 100);
const WINDOW_HOURS = Number(process.env.ADVISOR_WINDOW_HOURS || 24);
const MIN_N = Number(process.env.ADVISOR_MIN_N || 5);
const MIN_N_BUCKET = Number(process.env.ADVISOR_MIN_N_BUCKET || 4);
const TOP_N = Number(process.env.ADVISOR_TOP_N || 5);
const SEND_TELEGRAM = process.env.ADVISOR_SEND_TELEGRAM === '1';
const SAVE_LATEST = process.env.ADVISOR_SAVE_LATEST !== '0';
const SAVE_JOURNAL = process.env.ADVISOR_SAVE_JOURNAL !== '0';

const now = Date.now();
const since = now - WINDOW_HOURS * 3600_000;

function fmtPct(v) { const x = Number(v ?? 0); return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`; }
function fmtUsd(v) { const x = Number(v ?? 0); return `${x >= 0 ? '+' : ''}$${x.toFixed(0)}`; }
function shortMint(m) { return !m || m.length < 10 ? (m || '-') : `${m.slice(0,4)}...${m.slice(-4)}`; }

function parseJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  for (const ln of lines) { try { out.push(JSON.parse(ln)); } catch {} }
  return out;
}

function listStores() {
  const stores = [];
  if (fs.existsSync(STORE_PATH)) stores.push({ strategyId: process.env.PAPER_STRATEGY_ID || 'paper_v1', file: STORE_PATH });
  if (fs.existsSync(PAPER2_DIR)) {
    for (const f of fs.readdirSync(PAPER2_DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
      stores.push({ strategyId: path.basename(f, '.jsonl'), file: path.join(PAPER2_DIR, f) });
    }
  }
  return stores;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
    process.exit(1);
  }
  const { sendTagged } = await import('../scripts/lib/telegram.mjs');
  await sendTagged('ADVICE', 'strategy', text);
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

function btcBucket(ret1h) {
  if (ret1h === null || ret1h === undefined) return 'btc_unknown';
  if (ret1h <= -1.5) return 'btc<-1.5%';
  if (ret1h <= -0.5) return 'btc[-1.5..-0.5]%';
  if (ret1h <  0.5) return 'btc[-0.5..0.5]%';
  if (ret1h <  1.5) return 'btc[0.5..1.5]%';
  return 'btc>1.5%';
}

function ageBucket(min) {
  const x = Number(min ?? 0);
  if (x < 10) return 'age<10m';
  if (x < 30) return 'age[10-30m]';
  if (x < 180) return 'age[30m-3h]';
  if (x < 720) return 'age[3-12h]';
  if (x < 1440) return 'age[12-24h]';
  return 'age>24h';
}

function dipBucket(p) {
  if (p === null || p === undefined) return 'dip_n/a';
  if (p <= -30) return 'dip[-45..-30]';
  if (p <= -20) return 'dip[-30..-20]';
  if (p <= -10) return 'dip[-20..-10]';
  if (p <= 0) return 'dip[-10..0]';
  return 'dip>0';
}

function laneOf(close) {
  return close.lane || close.entry_lane || 'unknown_lane';
}

function buildIndex(events) {
  const opens = new Map();
  for (const e of events) {
    if (e.kind === 'open') opens.set(e.mint, e);
  }
  return { opens };
}

function summarizeStrategy(strategyId, events) {
  const { opens } = buildIndex(events);
  const closes = [];
  for (const e of events) {
    if (e.kind !== 'close') continue;
    if ((e.ts || 0) < since) continue;
    const o = opens.get(e.mint) || {};
    const features = o.features || {};
    const btc = o.btc || {};
    closes.push({
      strategyId,
      mint: e.mint,
      symbol: e.symbol || '-',
      lane: laneOf(o) || laneOf(e),
      reason: e.exitReason || '-',
      pnlPct: Number(e.pnlPct || 0),
      pnlUsd: (POSITION_USD * Number(e.pnlPct || 0)) / 100,
      peakPnl: Number(e.peak_pnl_pct ?? o.peakPnlPct ?? 0),
      ageMin: Number(features.token_age_min ?? o.ageMin ?? 0),
      dipPct: features.dip_pct ?? null,
      btcRet1h: btc.ret1h_pct ?? null,
      durationMin: Number(e.durationMin || 0),
    });
  }

  const wins = closes.filter((c) => c.pnlPct > 0).length;
  const avgPnl = closes.length ? closes.reduce((s, c) => s + c.pnlPct, 0) / closes.length : 0;
  const sumUsd = closes.reduce((s, c) => s + c.pnlUsd, 0);
  const winRate = closes.length ? (wins / closes.length) * 100 : 0;
  const avgPeak = closes.length ? closes.reduce((s, c) => s + c.peakPnl, 0) / closes.length : 0;
  const expectancy = avgPnl;

  return { strategyId, closes, n: closes.length, wins, winRate, avgPnl, sumUsd, avgPeak, expectancy };
}

function bucketStats(closes, keyFn) {
  const map = new Map();
  for (const c of closes) {
    const k = keyFn(c);
    if (!k) continue;
    const cur = map.get(k) || { n: 0, wins: 0, sumPnl: 0, sumUsd: 0 };
    cur.n += 1;
    if (c.pnlPct > 0) cur.wins += 1;
    cur.sumPnl += c.pnlPct;
    cur.sumUsd += c.pnlUsd;
    map.set(k, cur);
  }
  const out = [];
  for (const [k, v] of map.entries()) {
    out.push({
      key: k,
      n: v.n,
      winRate: v.n ? (v.wins / v.n) * 100 : 0,
      avgPnl: v.n ? v.sumPnl / v.n : 0,
      sumUsd: v.sumUsd,
    });
  }
  return out.filter((x) => x.n >= MIN_N_BUCKET);
}

function recommendStrategies(strats) {
  const recs = [];
  const eligible = strats.filter((s) => s.n >= MIN_N);
  if (!eligible.length) return recs;
  const sorted = [...eligible].sort((a, b) => b.expectancy - a.expectancy);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (best && best.expectancy > 5) {
    recs.push({
      kind: 'raise_alloc',
      target_kind: 'strategy',
      target: best.strategyId,
      expectancy_pct: +best.expectancy.toFixed(2),
      win_rate_pct: +best.winRate.toFixed(2),
      n: best.n,
      text: `raise_alloc: ${best.strategyId} (E=${fmtPct(best.expectancy)}, win=${best.winRate.toFixed(0)}%, n=${best.n})`,
    });
  }
  if (worst && worst.expectancy < -5 && worst !== best) {
    recs.push({
      kind: 'pause_or_tune',
      target_kind: 'strategy',
      target: worst.strategyId,
      expectancy_pct: +worst.expectancy.toFixed(2),
      win_rate_pct: +worst.winRate.toFixed(2),
      n: worst.n,
      text: `pause_or_tune: ${worst.strategyId} (E=${fmtPct(worst.expectancy)}, win=${worst.winRate.toFixed(0)}%, n=${worst.n})`,
    });
  }
  return recs;
}

function recommendBucket(buckets, label, threshPos = 8, threshNeg = -8) {
  const recs = [];
  const significant = buckets.filter((b) => b.n >= MIN_N_BUCKET);
  if (!significant.length) return recs;
  const winners = significant.filter((b) => b.avgPnl >= threshPos).sort((a, b) => b.avgPnl - a.avgPnl).slice(0, 3);
  const losers = significant.filter((b) => b.avgPnl <= threshNeg).sort((a, b) => a.avgPnl - b.avgPnl).slice(0, 3);
  for (const w of winners) {
    recs.push({
      kind: 'bucket_good',
      target_kind: label,
      target: w.key,
      expectancy_pct: +w.avgPnl.toFixed(2),
      win_rate_pct: +w.winRate.toFixed(2),
      n: w.n,
      text: `good ${label}=${w.key}: E=${fmtPct(w.avgPnl)} win=${w.winRate.toFixed(0)}% n=${w.n}`,
    });
  }
  for (const l of losers) {
    recs.push({
      kind: 'bucket_bad',
      target_kind: label,
      target: l.key,
      expectancy_pct: +l.avgPnl.toFixed(2),
      win_rate_pct: +l.winRate.toFixed(2),
      n: l.n,
      text: `bad  ${label}=${l.key}: E=${fmtPct(l.avgPnl)} win=${l.winRate.toFixed(0)}% n=${l.n}`,
    });
  }
  return recs;
}

function fmtBucketsTop(buckets, take = 5) {
  const sorted = [...buckets].sort((a, b) => b.avgPnl - a.avgPnl);
  const lines = [];
  for (const b of sorted.slice(0, take)) {
    lines.push(`+ ${b.key}: E=${fmtPct(b.avgPnl)} win=${b.winRate.toFixed(0)}% n=${b.n}`);
  }
  for (const b of sorted.slice(-take).reverse()) {
    if (b.avgPnl >= 0) continue;
    lines.push(`- ${b.key}: E=${fmtPct(b.avgPnl)} win=${b.winRate.toFixed(0)}% n=${b.n}`);
  }
  return lines;
}

function buildReport(strats, allCloses) {
  const lines = [];
  lines.push(`Advisor · last ${WINDOW_HOURS}h · n_min=${MIN_N}`);
  lines.push(`Strategies: ${strats.length} | Closed: ${allCloses.length}`);
  lines.push('');

  lines.push('By strategy:');
  const ranked = [...strats].sort((a, b) => b.expectancy - a.expectancy);
  for (const s of ranked) {
    const tag = s.n >= MIN_N ? '' : ' (low_n)';
    lines.push(`- ${s.strategyId}: n=${s.n} win=${s.winRate.toFixed(0)}% E=${fmtPct(s.expectancy)} sum=${fmtUsd(s.sumUsd)}${tag}`);
  }
  lines.push('');

  const stratRecs = recommendStrategies(strats);
  if (stratRecs.length) {
    lines.push('Recommendations (strategies):');
    for (const r of stratRecs) lines.push(`- ${r.text}`);
    lines.push('');
  }

  const laneB = bucketStats(allCloses, (c) => c.lane);
  const ageB = bucketStats(allCloses, (c) => ageBucket(c.ageMin));
  const dipB = bucketStats(allCloses.filter((c) => c.dipPct !== null), (c) => dipBucket(c.dipPct));
  const btcB = bucketStats(allCloses, (c) => btcBucket(c.btcRet1h));

  lines.push('Lane edge:');
  for (const l of fmtBucketsTop(laneB, 4)) lines.push(l);
  lines.push('');

  lines.push('Age edge:');
  for (const l of fmtBucketsTop(ageB, 4)) lines.push(l);
  lines.push('');

  if (dipB.length) {
    lines.push('Dip edge:');
    for (const l of fmtBucketsTop(dipB, 4)) lines.push(l);
    lines.push('');
  }

  lines.push('BTC regime edge:');
  for (const l of fmtBucketsTop(btcB, 4)) lines.push(l);
  lines.push('');

  const bucketRecs = [
    ...recommendBucket(laneB, 'lane', 8, -8),
    ...recommendBucket(ageB, 'age', 8, -8),
    ...recommendBucket(dipB, 'dip', 8, -8),
    ...recommendBucket(btcB, 'btc', 8, -8),
  ];
  if (bucketRecs.length) {
    lines.push('Recommendations (buckets):');
    for (const r of bucketRecs.slice(0, TOP_N * 2)) lines.push(`- ${r.text}`);
  }

  const text = lines.join('\n').slice(0, 3900);

  const structured = {
    ts: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    n_min_strategy: MIN_N,
    n_min_bucket: MIN_N_BUCKET,
    strategies: ranked.map((s) => ({
      strategyId: s.strategyId,
      n: s.n,
      win_rate_pct: +s.winRate.toFixed(2),
      expectancy_pct: +s.expectancy.toFixed(2),
      sum_usd: +s.sumUsd.toFixed(2),
      avg_peak_pct: +s.avgPeak.toFixed(2),
      eligible: s.n >= MIN_N,
    })),
    buckets: {
      lane: laneB,
      age: ageB,
      dip: dipB,
      btc: btcB,
    },
    recommendations: {
      strategy: stratRecs,
      bucket: bucketRecs,
    },
    text,
  };

  return { text, structured };
}

async function main() {
  const stores = listStores();
  if (!stores.length) throw new Error('No paper stores found');

  const strats = stores.map((s) => summarizeStrategy(s.strategyId, parseJsonl(s.file)));
  const allCloses = strats.flatMap((s) => s.closes);

  const { text, structured } = buildReport(strats, allCloses);
  console.log(text);

  try {
    fs.mkdirSync(ADVISOR_DIR, { recursive: true });
    fs.mkdirSync(ADVISOR_BY_DAY_DIR, { recursive: true });
  } catch {}

  if (SAVE_LATEST) {
    try {
      fs.writeFileSync(path.join(ADVISOR_DIR, 'advisor-latest.json'), JSON.stringify(structured, null, 2));
      fs.writeFileSync(path.join(PAPER2_DIR, 'advisor-latest.json'), JSON.stringify(structured, null, 2));
    } catch (e) { console.warn('save advisor-latest failed:', e?.message || e); }
  }

  if (SAVE_JOURNAL) {
    try {
      fs.appendFileSync(ADVISOR_JOURNAL, JSON.stringify(structured) + '\n');
      const day = structured.ts.slice(0, 10);
      const dayPath = path.join(ADVISOR_BY_DAY_DIR, `${day}.jsonl`);
      fs.appendFileSync(dayPath, JSON.stringify(structured) + '\n');
    } catch (e) { console.warn('save advisor journal failed:', e?.message || e); }
  }

  if (SEND_TELEGRAM) await sendTelegram(text);
  console.log('done', {
    strategies: strats.length,
    closed: allCloses.length,
    sent: SEND_TELEGRAM,
    journal: SAVE_JOURNAL ? ADVISOR_JOURNAL : null,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
