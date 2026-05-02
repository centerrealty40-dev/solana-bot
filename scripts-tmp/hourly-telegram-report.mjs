import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const STORE_PATH = process.env.PAPER_TRADES_PATH || '/opt/solana-alpha/data/paper-trades.jsonl';
const PAPER2_DIR = process.env.PAPER2_DIR || '/opt/solana-alpha/data/paper2';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const POSITION_USD = Number(process.env.POSITION_USD || 100);
const COVERAGE_HOURS = Number(process.env.HOURLY_COVERAGE_HOURS || 1);
const TOP_N = Number(process.env.HOURLY_TOP_N || 4);
const DETAIL_MODE = process.env.HOURLY_DETAIL === '1';

const HOUR_MS = 60 * 60 * 1000;
const now = Date.now();
const since = now - HOUR_MS;

function shortMint(m) {
  if (!m || m.length < 10) return m || '-';
  return `${m.slice(0, 4)}...${m.slice(-4)}`;
}
function gmgnUrl(m) { return `https://gmgn.ai/sol/token/${m}`; }
function fmtPct(v) { const x = Number(v || 0); return `${x >= 0 ? '+' : ''}${x.toFixed(0)}%`; }
function fmtUsd(v) { const x = Number(v || 0); return `${x >= 0 ? '+' : ''}$${x.toFixed(0)}`; }

function parseJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const ln of lines) {
    try { out.push(JSON.parse(ln)); } catch {}
  }
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
  await sendTagged('REPORT', 'strategies', text);
  return;
  // eslint-disable-next-line no-unreachable
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Telegram ${r.status}: ${body.slice(0, 200)}`);
  }
}

function summarizeStrategy(events, strategyId) {
  const byMintOpen = new Map();
  let lastResetTs = 0;
  for (const e of events) if (e.kind === 'reset') lastResetTs = Math.max(lastResetTs, e.ts || 0);
  const scoped = events.filter((e) => (e.ts || 0) >= lastResetTs);

  for (const e of scoped) {
    if (e.kind === 'open') byMintOpen.set(e.mint, e);
    if (e.kind === 'close') byMintOpen.delete(e.mint);
  }

  const hourly = scoped.filter((e) => (e.ts || 0) >= since);
  const evals = hourly.filter((e) => e.kind === 'eval');
  const opens = hourly.filter((e) => e.kind === 'open');
  const closes = hourly.filter((e) => e.kind === 'close');
  const passed = evals.filter((e) => !!e.pass).length;
  const wins = closes.filter((e) => Number(e.pnlPct || 0) > 0).length;
  const realizedUsd = closes.reduce((s, e) => s + (POSITION_USD * Number(e.pnlPct || 0)) / 100, 0);

  return {
    strategyId,
    evals: evals.length,
    passed,
    opens: opens.length,
    closes: closes.length,
    wins,
    realizedUsd,
    openCount: byMintOpen.size,
    closesArr: closes.map((c) => ({
      symbol: c.symbol || '-',
      mint: c.mint,
      lane: c.lane || 'legacy',
      reason: c.exitReason || '-',
      pnlPct: Number(c.pnlPct || 0),
      pnlUsd: (POSITION_USD * Number(c.pnlPct || 0)) / 100,
      strategyId,
    })),
  };
}

const HEALTH_CHECKS = [
  { source: 'pump (tokens)', table: 'tokens', tsCol: 'first_seen_at', maxAgeMin: 5 },
  { source: 'swaps', table: 'swaps', tsCol: 'block_time', maxAgeMin: 5 },
  { source: 'raydium', table: 'raydium_pair_snapshots', tsCol: 'ts', maxAgeMin: 5 },
  { source: 'meteora', table: 'meteora_pair_snapshots', tsCol: 'ts', maxAgeMin: 5 },
  { source: 'orca', table: 'orca_pair_snapshots', tsCol: 'ts', maxAgeMin: 5 },
  { source: 'moonshot', table: 'moonshot_pair_snapshots', tsCol: 'ts', maxAgeMin: 5 },
  { source: 'pumpswap', table: 'pumpswap_pair_snapshots', tsCol: 'ts', maxAgeMin: 5 },
  { source: 'jupiter', table: 'jupiter_route_snapshots', tsCol: 'ts', maxAgeMin: 5 },
  { source: 'direct_lp', table: 'direct_lp_events', tsCol: 'ts', maxAgeMin: 240 },
];

async function fetchHealth(pool) {
  if (!pool) return [];
  const client = await pool.connect();
  try {
    const out = [];
    for (const h of HEALTH_CHECKS) {
      try {
        const r = await client.query(
          `SELECT MAX(${h.tsCol}) AS ts, EXTRACT(EPOCH FROM (now() - MAX(${h.tsCol})))::int AS age_sec FROM ${h.table}`
        );
        const ageSec = Number(r.rows[0]?.age_sec ?? 0);
        const ok = ageSec >= 0 && ageSec <= h.maxAgeMin * 60;
        out.push({ source: h.source, ageSec, maxAgeSec: h.maxAgeMin * 60, ok });
      } catch (err) {
        out.push({ source: h.source, ageSec: null, maxAgeSec: h.maxAgeMin * 60, ok: false, error: String(err?.message || err) });
      }
    }
    return out;
  } finally {
    client.release();
  }
}

async function fetchCoverage(pool) {
  const cov = {
    pump: 0,
    raydium: 0,
    meteora: 0,
    orca: 0,
    moonshot: 0,
    pumpswap: 0,
    jupiter: 0,
    total: 0,
  };
  if (!pool) return cov;
  const client = await pool.connect();
  try {
    async function tableExists(name) {
      const r = await client.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
      return Boolean(r.rows[0]?.t);
    }

    const checks = [
      'tokens',
      'raydium_pair_snapshots',
      'meteora_pair_snapshots',
      'orca_pair_snapshots',
      'moonshot_pair_snapshots',
      'pumpswap_pair_snapshots',
      'jupiter_route_snapshots',
    ];
    const exists = {};
    for (const t of checks) exists[t] = await tableExists(t);

    const unions = [];
    if (exists.tokens) {
      unions.push(`SELECT mint::text AS mint, 'pump'::text AS source FROM tokens WHERE first_seen_at >= now() - (${COVERAGE_HOURS}::int * interval '1 hour') AND metadata->>'source' IN ('pumpportal','moonshot','bonk')`);
    }
    if (exists.raydium_pair_snapshots) unions.push(`SELECT DISTINCT base_mint::text AS mint, 'raydium'::text AS source FROM raydium_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`);
    if (exists.meteora_pair_snapshots) unions.push(`SELECT DISTINCT base_mint::text AS mint, 'meteora'::text AS source FROM meteora_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`);
    if (exists.orca_pair_snapshots) unions.push(`SELECT DISTINCT base_mint::text AS mint, 'orca'::text AS source FROM orca_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`);
    if (exists.moonshot_pair_snapshots) unions.push(`SELECT DISTINCT base_mint::text AS mint, 'moonshot'::text AS source FROM moonshot_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`);
    if (exists.pumpswap_pair_snapshots) unions.push(`SELECT DISTINCT base_mint::text AS mint, 'pumpswap'::text AS source FROM pumpswap_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`);
    if (exists.jupiter_route_snapshots) unions.push(`SELECT DISTINCT mint::text AS mint, 'jupiter'::text AS source FROM jupiter_route_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`);
    if (!unions.length) return cov;

    const r = await client.query(`
      WITH src AS (${unions.join('\nUNION ALL\n')})
      SELECT source, COUNT(DISTINCT mint)::int AS cnt FROM src GROUP BY source
    `);
    for (const row of r.rows) {
      const k = String(row.source);
      if (cov[k] !== undefined) cov[k] = Number(row.cnt || 0);
    }
    const totalRow = await client.query(`
      WITH src AS (${unions.join('\nUNION ALL\n')})
      SELECT COUNT(DISTINCT mint)::int AS cnt FROM src
    `);
    cov.total = Number(totalRow.rows[0]?.cnt || 0);
    return cov;
  } finally {
    client.release();
  }
}

function fmtAge(sec) {
  const x = Number(sec ?? 0);
  if (!Number.isFinite(x)) return 'n/a';
  if (x < 60) return `${x}s`;
  const m = Math.round(x / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function compactReport(strats, coverage, health) {
  const totalEval = strats.reduce((s, x) => s + x.evals, 0);
  const totalPass = strats.reduce((s, x) => s + x.passed, 0);
  const totalOpens = strats.reduce((s, x) => s + x.opens, 0);
  const totalCloses = strats.reduce((s, x) => s + x.closes, 0);
  const totalWins = strats.reduce((s, x) => s + x.wins, 0);
  const totalReal = strats.reduce((s, x) => s + x.realizedUsd, 0);
  const totalOpen = strats.reduce((s, x) => s + x.openCount, 0);

  const allCloses = strats.flatMap((s) => s.closesArr);
  const winners = [...allCloses].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, TOP_N);
  const losers = [...allCloses].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, TOP_N);

  const lines = [];
  lines.push(`Hourly summary · last 60m`);
  lines.push(`Strategies: ${strats.length} | Eval: ${totalEval} (pass ${totalPass}) | Open: ${totalOpen}`);
  lines.push(`Closed: ${totalCloses} (wins ${totalWins}) | Real: ${fmtUsd(totalReal)}`);
  lines.push('');

  lines.push('By strategy (real $):');
  const sortedStrats = [...strats].sort((a, b) => b.realizedUsd - a.realizedUsd);
  for (const s of sortedStrats) {
    lines.push(`- ${s.strategyId}: ${fmtUsd(s.realizedUsd)} | open=${s.openCount} close=${s.closes} wins=${s.wins}`);
  }
  lines.push('');

  lines.push('Best closes (1h):');
  if (!winners.length) lines.push('- none');
  for (const w of winners) {
    lines.push(`- ${w.symbol} ${w.reason} ${fmtPct(w.pnlPct)} ${fmtUsd(w.pnlUsd)} [${w.strategyId}] ${gmgnUrl(w.mint)}`);
  }
  lines.push('');

  lines.push('Worst closes (1h):');
  if (!losers.length) lines.push('- none');
  for (const l of losers) {
    lines.push(`- ${l.symbol} ${l.reason} ${fmtPct(l.pnlPct)} ${fmtUsd(l.pnlUsd)} [${l.strategyId}] ${gmgnUrl(l.mint)}`);
  }
  lines.push('');

  lines.push(`Coverage (last ${COVERAGE_HOURS}h, unique mints):`);
  if (!coverage || !coverage.total) {
    lines.push('- no data');
  } else {
    lines.push(`- total: ${coverage.total}`);
    for (const k of ['pump', 'raydium', 'meteora', 'orca', 'moonshot', 'jupiter']) {
      lines.push(`- ${k}: ${coverage[k] || 0}`);
    }
  }

  if (health && health.length) {
    lines.push('');
    lines.push('Health (data freshness):');
    const stale = health.filter((h) => !h.ok);
    if (!stale.length) {
      lines.push('- all sources OK');
    }
    for (const h of health) {
      const tag = h.ok ? 'OK' : 'STALE';
      const ageStr = h.ageSec === null ? 'n/a' : fmtAge(h.ageSec);
      lines.push(`- ${h.source}: ${tag} ${ageStr} (max ${fmtAge(h.maxAgeSec)})`);
    }
  }

  return lines.join('\n').slice(0, 3900);
}

async function main() {
  const stores = listStores();
  if (!stores.length) throw new Error('No paper stores found');

  const strats = stores.map((s) => summarizeStrategy(parseJsonl(s.file), s.strategyId));

  let coverage = null;
  let health = [];
  let pool = null;
  const PG_URL = process.env.SA_PG_DSN || process.env.DATABASE_URL;
  if (PG_URL) {
    try {
      pool = new Pool({ connectionString: PG_URL });
      coverage = await fetchCoverage(pool);
      health = await fetchHealth(pool);
    } catch (e) {
      console.warn('coverage/health failed:', e?.message || e);
    } finally {
      try { await pool?.end(); } catch {}
    }
  }

  const text = compactReport(strats, coverage, health);
  await sendTelegram(text);
  console.log('sent', { strategies: strats.length, len: text.length });

  if (DETAIL_MODE) {
    const detailed = stores
      .map((s) => `- ${s.strategyId}: ${s.file}`)
      .join('\n');
    console.log('stores:\n' + detailed);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
