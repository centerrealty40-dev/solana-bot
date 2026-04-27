import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || '';
const GMGN_UNIVERSE_URL =
  process.env.GMGN_UNIVERSE_URL ||
  'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/24h?orderby=open_timestamp&direction=desc&filters[]=not_honeypot';
const GMGN_UNIVERSE_FILE = process.env.GMGN_UNIVERSE_FILE || '';
const LOOKBACK_HOURS = Number(process.env.GMGN_COVERAGE_LOOKBACK_HOURS || 24);
const TOP_MISSING = Number(process.env.GMGN_COVERAGE_TOP_MISSING || 30);
const FETCH_TIMEOUT_MS = Number(process.env.GMGN_FETCH_TIMEOUT_MS || 20000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEND_TELEGRAM = process.env.GMGN_COVERAGE_SEND_TELEGRAM === '1';
const EXTRA_HEADERS_JSON = process.env.GMGN_UNIVERSE_HEADERS_JSON || '';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function shortMint(mint) {
  if (!mint || mint.length < 10) return mint || '-';
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function gmgnTokenUrl(mint) {
  return `https://gmgn.ai/sol/token/${mint}`;
}

function isSolMint(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function parseTsMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (v > 10_000_000_000_000) return v;
    if (v > 1_000_000_000_000) return v;
    if (v > 1_000_000_000) return v * 1000;
    return null;
  }
  if (typeof v === 'string') {
    const asNum = Number(v);
    if (Number.isFinite(asNum)) return parseTsMillis(asNum);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function extractTokenLike(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const mint =
    obj.mint ||
    obj.address ||
    obj.token_address ||
    obj.base_mint ||
    obj.baseMint ||
    obj.ca ||
    obj.contract_address ||
    obj.tokenAddress;
  if (!isSolMint(mint)) return null;
  return {
    mint: String(mint),
    symbol: String(obj.symbol || obj.ticker || obj.name || '?'),
    openTs:
      parseTsMillis(obj.open_timestamp) ||
      parseTsMillis(obj.launch_ts) ||
      parseTsMillis(obj.created_at) ||
      parseTsMillis(obj.createdAt) ||
      parseTsMillis(obj.first_seen_at),
  };
}

function flattenObjects(root, out = []) {
  if (Array.isArray(root)) {
    for (const v of root) flattenObjects(v, out);
    return out;
  }
  if (!root || typeof root !== 'object') return out;
  out.push(root);
  for (const v of Object.values(root)) flattenObjects(v, out);
  return out;
}

async function fetchJson(url, headers) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

function buildHeaders() {
  const h = {
    accept: 'application/json,text/plain,*/*',
    'user-agent': 'Mozilla/5.0 gmgn-coverage-report',
  };
  if (!EXTRA_HEADERS_JSON) return h;
  try {
    const extra = JSON.parse(EXTRA_HEADERS_JSON);
    if (extra && typeof extra === 'object') return { ...h, ...extra };
  } catch (e) {
    console.warn(`failed to parse GMGN_UNIVERSE_HEADERS_JSON: ${e}`);
  }
  return h;
}

async function fetchGmgnUniverse() {
  let raw;
  if (GMGN_UNIVERSE_FILE && fs.existsSync(GMGN_UNIVERSE_FILE)) {
    raw = JSON.parse(fs.readFileSync(GMGN_UNIVERSE_FILE, 'utf8'));
  } else {
    raw = await fetchJson(GMGN_UNIVERSE_URL, buildHeaders());
  }
  const objects = flattenObjects(raw);
  const byMint = new Map();
  for (const o of objects) {
    const token = extractTokenLike(o);
    if (!token) continue;
    const prev = byMint.get(token.mint);
    if (!prev) byMint.set(token.mint, token);
    else if (!prev.openTs && token.openTs) byMint.set(token.mint, token);
  }

  const minTs = Date.now() - LOOKBACK_HOURS * 3600_000;
  const rows = [...byMint.values()].filter((r) => !r.openTs || r.openTs >= minTs);
  return { rows, raw };
}

async function tableExists(client, tableName) {
  const r = await client.query('SELECT to_regclass($1) AS t', [`public.${tableName}`]);
  return Boolean(r.rows[0]?.t);
}

async function loadSourceCoverage(client, lookbackHours) {
  const exists = {};
  for (const t of [
    'tokens',
    'swaps',
    'raydium_pair_snapshots',
    'meteora_pair_snapshots',
    'orca_pair_snapshots',
    'moonshot_pair_snapshots',
    'jupiter_route_snapshots',
    'coverage_events',
  ]) {
    exists[t] = await tableExists(client, t);
  }

  if (exists.coverage_events) {
    const r = await client.query(
      `
      SELECT
        mint,
        (first_seen_pump IS NOT NULL) AS in_pump,
        (first_seen_raydium IS NOT NULL) AS in_raydium,
        (first_seen_meteora IS NOT NULL) AS in_meteora,
        (first_seen_orca IS NOT NULL) AS in_orca,
        (first_seen_moonshot IS NOT NULL) AS in_moonshot,
        (first_seen_jupiter IS NOT NULL) AS in_jupiter
      FROM coverage_events
      WHERE LEAST(
        COALESCE(first_seen_pump, 'infinity'::timestamptz),
        COALESCE(first_seen_raydium, 'infinity'::timestamptz),
        COALESCE(first_seen_meteora, 'infinity'::timestamptz),
        COALESCE(first_seen_orca, 'infinity'::timestamptz),
        COALESCE(first_seen_moonshot, 'infinity'::timestamptz),
        COALESCE(first_seen_jupiter, 'infinity'::timestamptz)
      ) >= now() - ($1::int * interval '1 hour')
      `,
      [lookbackHours],
    );
    return r.rows;
  }

  const unions = [];
  if (exists.tokens) {
    unions.push(`
      SELECT mint::text AS mint, 'tokens'::text AS source
      FROM tokens
      WHERE first_seen_at >= now() - (${lookbackHours}::int * interval '1 hour')
    `);
    unions.push(`
      SELECT mint::text AS mint, 'pump'::text AS source
      FROM tokens
      WHERE first_seen_at >= now() - (${lookbackHours}::int * interval '1 hour')
        AND metadata->>'source' IN ('pumpportal','moonshot','bonk')
    `);
  }
  if (exists.swaps) {
    unions.push(`
      SELECT DISTINCT base_mint::text AS mint, 'swaps'::text AS source
      FROM swaps
      WHERE block_time >= now() - (${lookbackHours}::int * interval '1 hour')
    `);
  }
  if (exists.raydium_pair_snapshots) {
    unions.push(`
      SELECT DISTINCT base_mint::text AS mint, 'raydium'::text AS source
      FROM raydium_pair_snapshots
      WHERE ts >= now() - (${lookbackHours}::int * interval '1 hour')
    `);
  }
  if (exists.meteora_pair_snapshots) {
    unions.push(`
      SELECT DISTINCT base_mint::text AS mint, 'meteora'::text AS source
      FROM meteora_pair_snapshots
      WHERE ts >= now() - (${lookbackHours}::int * interval '1 hour')
    `);
  }
  if (exists.orca_pair_snapshots) {
    unions.push(`
      SELECT DISTINCT base_mint::text AS mint, 'orca'::text AS source
      FROM orca_pair_snapshots
      WHERE ts >= now() - (${lookbackHours}::int * interval '1 hour')
    `);
  }
  if (exists.moonshot_pair_snapshots) {
    unions.push(`
      SELECT DISTINCT base_mint::text AS mint, 'moonshot'::text AS source
      FROM moonshot_pair_snapshots
      WHERE ts >= now() - (${lookbackHours}::int * interval '1 hour')
    `);
  }
  if (exists.jupiter_route_snapshots) {
    unions.push(`
      SELECT DISTINCT mint::text AS mint, 'jupiter'::text AS source
      FROM jupiter_route_snapshots
      WHERE ts >= now() - (${lookbackHours}::int * interval '1 hour')
    `);
  }
  if (!unions.length) return [];

  const r = await client.query(`
    WITH src AS (
      ${unions.join('\nUNION ALL\n')}
    )
    SELECT
      mint,
      BOOL_OR(source = 'pump') AS in_pump,
      BOOL_OR(source = 'raydium') AS in_raydium,
      BOOL_OR(source = 'meteora') AS in_meteora,
      BOOL_OR(source = 'orca') AS in_orca,
      BOOL_OR(source = 'moonshot') AS in_moonshot,
      BOOL_OR(source = 'jupiter') AS in_jupiter
    FROM src
    GROUP BY mint
  `);
  return r.rows;
}

function summarize(gmgnRows, sourceRows) {
  const byMint = new Map(sourceRows.map((r) => [r.mint, r]));
  const missing = [];
  const seen = [];
  const sources = { pump: 0, raydium: 0, meteora: 0, orca: 0, moonshot: 0, jupiter: 0 };

  for (const t of gmgnRows) {
    const s = byMint.get(t.mint);
    if (!s) {
      missing.push(t);
      continue;
    }
    seen.push(t);
    if (s.in_pump) sources.pump++;
    if (s.in_raydium) sources.raydium++;
    if (s.in_meteora) sources.meteora++;
    if (s.in_orca) sources.orca++;
    if (s.in_moonshot) sources.moonshot++;
    if (s.in_jupiter) sources.jupiter++;
  }

  const coveragePct = gmgnRows.length ? (seen.length / gmgnRows.length) * 100 : 0;
  return { coveragePct, seen, missing, sources };
}

function renderReport(stats) {
  const lines = [];
  lines.push(`GMGN coverage report (${LOOKBACK_HOURS}h)`);
  lines.push(`GMGN universe: ${stats.gmgnTotal}`);
  lines.push(`Seen by us: ${stats.seenTotal} (${stats.coveragePct.toFixed(2)}%)`);
  lines.push(`Missing: ${stats.missingTotal}`);
  lines.push('');
  lines.push('Seen source hit map (inside GMGN universe):');
  lines.push(`- pump: ${stats.sources.pump}`);
  lines.push(`- raydium: ${stats.sources.raydium}`);
  lines.push(`- meteora: ${stats.sources.meteora}`);
  lines.push(`- orca: ${stats.sources.orca}`);
  lines.push(`- moonshot: ${stats.sources.moonshot}`);
  lines.push(`- jupiter: ${stats.sources.jupiter}`);
  lines.push('');
  lines.push(`Top missing (${Math.min(TOP_MISSING, stats.missing.length)}):`);
  if (!stats.missing.length) lines.push('- none');
  for (const m of stats.missing.slice(0, TOP_MISSING)) {
    lines.push(`- ${m.symbol || '?'} ${shortMint(m.mint)} ${gmgnTokenUrl(m.mint)}`);
  }
  return lines.join('\n').slice(0, 3900);
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
  }
  const { sendTagged } = await import('../scripts/lib/telegram.mjs');
  await sendTagged('REPORT', 'coverage-gmgn', text);
  return;
  // eslint-disable-next-line no-unreachable
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Telegram ${r.status}: ${body.slice(0, 300)}`);
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: gmgnRows } = await fetchGmgnUniverse();
    const sourceRows = await loadSourceCoverage(client, LOOKBACK_HOURS);
    const summary = summarize(gmgnRows, sourceRows);
    const stats = {
      gmgnTotal: gmgnRows.length,
      seenTotal: summary.seen.length,
      missingTotal: summary.missing.length,
      coveragePct: summary.coveragePct,
      sources: summary.sources,
      missing: summary.missing,
    };
    const report = renderReport(stats);
    console.log(report);
    console.log(
      JSON.stringify({
        kind: 'gmgn_coverage',
        ts: new Date().toISOString(),
        lookbackHours: LOOKBACK_HOURS,
        ...stats,
      }),
    );
    if (SEND_TELEGRAM) await sendTelegram(report);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
