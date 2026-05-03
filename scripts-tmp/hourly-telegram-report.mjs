import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const ROOT = process.env.SOLANA_ALPHA_ROOT || '/opt/solana-alpha';
const PAPER2_DIR = process.env.PAPER2_DIR || path.join(ROOT, 'data/paper2');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const COVERAGE_HOURS = Number(process.env.HOURLY_COVERAGE_HOURS || 1);
const DETAIL_MODE = process.env.HOURLY_DETAIL === '1';

const LIVE_JSONL =
  process.env.HOURLY_LIVE_JSONL ||
  process.env.LIVE_TRADES_PATH ||
  path.join(ROOT, 'data/live/pt1-oscar-live.jsonl');
const OSCAR_EVAL_JSONL =
  process.env.HOURLY_OSCAR_EVAL_JSONL || path.join(PAPER2_DIR, 'pt1-oscar.jsonl');
const LIVE_STRATEGY_ID = process.env.HOURLY_LIVE_STRATEGY_ID || 'live-oscar';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const HOUR_MS = 60 * 60 * 1000;
const now = Date.now();
const since = now - HOUR_MS;

const POSITION_KINDS = new Set([
  'live_position_open',
  'live_position_dca',
  'live_position_partial_sell',
  'live_position_close',
]);

function lineMatchesLiveChannel(row) {
  const ch = row.channel;
  return ch === undefined || ch === null || ch === 'live';
}

function strategyMatches(row) {
  const sid = row.strategyId != null ? String(row.strategyId) : '';
  return sid === '' || sid === LIVE_STRATEGY_ID;
}

/** Replay live_position_* state + PnL aggregates (aligned with live replay semantics). */
function summarizeLiveOscarFromJournal(events) {
  const batch = [];
  for (let lineIdx = 0; lineIdx < events.length; lineIdx++) {
    const row = events[lineIdx];
    if (!row || typeof row !== 'object') continue;
    const kind = row.kind != null ? String(row.kind) : '';
    if (!POSITION_KINDS.has(kind)) continue;
    if (!strategyMatches(row)) continue;
    if (!lineMatchesLiveChannel(row)) continue;
    const mint = row.mint != null ? String(row.mint) : '';
    if (!mint) continue;
    const tsRaw = row.ts;
    const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw) ? tsRaw : 0;
    batch.push({ ts, lineIdx, kind, mint, row });
  }
  batch.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.lineIdx - b.lineIdx));

  const openByMint = new Map();
  let realizedClosedUsd = 0;
  let opensLastHour = 0;

  for (const { ts, kind, mint, row } of batch) {
    if (ts >= since && kind === 'live_position_open') opensLastHour += 1;

    if (kind === 'live_position_open' || kind === 'live_position_dca' || kind === 'live_position_partial_sell') {
      const ot = row.openTrade;
      if (typeof ot === 'object' && ot !== null) openByMint.set(mint, ot);
      continue;
    }
    if (kind === 'live_position_close') {
      const ct = row.closedTrade;
      realizedClosedUsd += Number(ct?.netPnlUsd ?? 0);
      openByMint.delete(mint);
    }
  }

  let realizedPartialsOpenUsd = 0;
  let unrealizedUsd = 0;
  for (const ot of openByMint.values()) {
    const partials = Array.isArray(ot.partialSells) ? ot.partialSells : [];
    for (const p of partials) {
      realizedPartialsOpenUsd += Number(p?.pnlUsd ?? 0);
    }
    const inv = Number(ot.totalInvestedUsd ?? 0) * Number(ot.remainingFraction ?? 1);
    const px = Number(ot.lastObservedPriceUsd ?? 0);
    const avg = Number(ot.avgEntry ?? 0);
    if (inv > 0 && px > 0 && avg > 0) {
      const markVal = inv * (px / avg);
      unrealizedUsd += markVal - inv;
    }
  }

  const realizedTotalUsd = realizedClosedUsd + realizedPartialsOpenUsd;
  const totalPnlUsd = realizedTotalUsd + unrealizedUsd;

  return {
    openNow: openByMint.size,
    opensLastHour,
    realizedTotalUsd,
    unrealizedUsd,
    totalPnlUsd,
  };
}

function parseJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const ln of lines) {
    try {
      out.push(JSON.parse(ln));
    } catch {
      /* skip */
    }
  }
  return out;
}

function countEvalPassPaper(events, sinceMs) {
  let lastResetTs = 0;
  for (const e of events) {
    if (e.kind === 'reset') lastResetTs = Math.max(lastResetTs, e.ts || 0);
  }
  const scoped = events.filter((e) => (e.ts || 0) >= lastResetTs);
  const hourly = scoped.filter((e) => (e.ts || 0) >= sinceMs && e.kind === 'eval');
  const passed = hourly.filter((e) => !!e.pass).length;
  return { evals: hourly.length, passed };
}

function aggregateExecutionFailures(events, sinceMs) {
  const buckets = new Map();
  for (const e of events) {
    if (e.kind !== 'execution_result') continue;
    if ((e.ts || 0) < sinceMs) continue;
    const st = String(e.status || '');
    if (st !== 'failed' && st !== 'sim_err') continue;
    const msg =
      st === 'sim_err'
        ? String(e.error?.message || e.detail || 'sim_err').trim() || 'sim_err'
        : String(e.error?.message || e.message || 'failed').trim() || 'failed';
    const key = `${st}: ${msg.slice(0, 140)}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return buckets;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
    process.exit(1);
  }
  const { sendTagged } = await import('../scripts/lib/telegram.mjs');
  await sendTagged('REPORT', 'strategies', text);
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
          `SELECT MAX(${h.tsCol}) AS ts, EXTRACT(EPOCH FROM (now() - MAX(${h.tsCol})))::int AS age_sec FROM ${h.table}`,
        );
        const ageSec = Number(r.rows[0]?.age_sec ?? 0);
        const ok = ageSec >= 0 && ageSec <= h.maxAgeMin * 60;
        out.push({ source: h.source, ageSec, maxAgeSec: h.maxAgeMin * 60, ok });
      } catch (err) {
        out.push({
          source: h.source,
          ageSec: null,
          maxAgeSec: h.maxAgeMin * 60,
          ok: false,
          error: String(err?.message || err),
        });
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
      unions.push(
        `SELECT mint::text AS mint, 'pump'::text AS source FROM tokens WHERE first_seen_at >= now() - (${COVERAGE_HOURS}::int * interval '1 hour') AND metadata->>'source' IN ('pumpportal','moonshot','bonk')`,
      );
    }
    if (exists.raydium_pair_snapshots)
      unions.push(
        `SELECT DISTINCT base_mint::text AS mint, 'raydium'::text AS source FROM raydium_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`,
      );
    if (exists.meteora_pair_snapshots)
      unions.push(
        `SELECT DISTINCT base_mint::text AS mint, 'meteora'::text AS source FROM meteora_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`,
      );
    if (exists.orca_pair_snapshots)
      unions.push(
        `SELECT DISTINCT base_mint::text AS mint, 'orca'::text AS source FROM orca_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`,
      );
    if (exists.moonshot_pair_snapshots)
      unions.push(
        `SELECT DISTINCT base_mint::text AS mint, 'moonshot'::text AS source FROM moonshot_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`,
      );
    if (exists.pumpswap_pair_snapshots)
      unions.push(
        `SELECT DISTINCT base_mint::text AS mint, 'pumpswap'::text AS source FROM pumpswap_pair_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`,
      );
    if (exists.jupiter_route_snapshots)
      unions.push(
        `SELECT DISTINCT mint::text AS mint, 'jupiter'::text AS source FROM jupiter_route_snapshots WHERE ts >= now() - (${COVERAGE_HOURS}::int * interval '1 hour')`,
      );
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
  if (m < 120) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

/** Human-readable max staleness label, e.g. max 5m / max 4h */
function fmtMaxAgeLabel(maxAgeSec) {
  const m = maxAgeSec / 60;
  if (m >= 60 && m % 60 === 0) return `max ${m / 60}h`;
  return `max ${Math.round(m)}m`;
}

function fmtUsdSigned(v) {
  const x = Number(v || 0);
  const sign = x >= 0 ? '+' : '';
  return `${sign}$${x.toFixed(2)}`;
}

async function rpcJson(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error.message || String(j.error));
  return j.result;
}

/** QuickNode / Solana JSON-RPC: legacy flat lamports or `{ context, value }`. */
function lamportsFromGetBalanceResult(result) {
  if (typeof result === 'number' && Number.isFinite(result)) return result;
  if (typeof result === 'string' && /^\d+$/.test(result)) return Number(result);
  if (result && typeof result === 'object' && 'value' in result) {
    return lamportsFromGetBalanceResult(result.value);
  }
  return NaN;
}

async function fetchWalletBalances(rpcUrl, ownerPubkey) {
  const raw = await rpcJson(rpcUrl, 'getBalance', [ownerPubkey]);
  const lamports = lamportsFromGetBalanceResult(raw);
  const sol = Number.isFinite(lamports) ? lamports / 1e9 : NaN;
  let usdc = null;
  try {
    const tok = await rpcJson(rpcUrl, 'getTokenAccountsByOwner', [
      ownerPubkey,
      { mint: USDC_MINT },
      { encoding: 'jsonParsed' },
    ]);
    let sum = 0;
    for (const { account } of tok.value || []) {
      const ui = account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof ui === 'number' && Number.isFinite(ui)) sum += ui;
    }
    usdc = sum;
  } catch {
    usdc = null;
  }
  return { sol, usdc };
}

function buildHourlyReport({
  coverage,
  health,
  live,
  evalAgg,
  failBuckets,
  wallet,
  walletNote,
}) {
  const lines = [];
  lines.push(`Hourly report · UTC ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);

  lines.push('');
  lines.push(`Coverage (last ${COVERAGE_HOURS}h, unique mints):`);
  if (!coverage || !coverage.total) {
    lines.push('- total: 0 (no DB / no data)');
  } else {
    lines.push(`- total: ${coverage.total}`);
    for (const k of ['pump', 'raydium', 'meteora', 'orca', 'moonshot', 'jupiter']) {
      lines.push(`- ${k}: ${coverage[k] || 0}`);
    }
  }

  lines.push('');
  lines.push('Health (data freshness):');
  if (!health || !health.length) {
    lines.push('- (no DB connection)');
  } else {
    for (const h of health) {
      const tag = h.ok ? 'OK' : 'STALE';
      const ageStr = h.ageSec === null ? 'n/a' : fmtAge(h.ageSec);
      const maxL = fmtMaxAgeLabel(h.maxAgeSec);
      const err = h.error ? ` err=${h.error.slice(0, 80)}` : '';
      lines.push(`- ${h.source}: ${tag} ${ageStr} (${maxL})${err}`);
    }
  }

  lines.push('');
  lines.push('Live Oscar');
  lines.push(`- Открытых позиций (сейчас): ${live.openNow}`);
  lines.push(`- Новых открытий за час: ${live.opensLastHour}`);
  lines.push(`- Реализованный PnL (кумулятивно): ${fmtUsdSigned(live.realizedTotalUsd)}`);
  lines.push(
    `- Нереализованный PnL (mark, lastObservedPriceUsd): ${fmtUsdSigned(live.unrealizedUsd)}`,
  );
  lines.push(`- Суммарный PnL: ${fmtUsdSigned(live.totalPnlUsd)}`);

  lines.push('');
  lines.push(`Eval: ${evalAgg.evals} pass ${evalAgg.passed}`);

  lines.push('');
  lines.push('Кошелёк');
  if (walletNote) lines.push(`- ${walletNote}`);
  if (wallet) {
    const solLine =
      typeof wallet.sol === 'number' && Number.isFinite(wallet.sol)
        ? wallet.sol.toFixed(4)
        : 'n/a';
    lines.push(`- SOL: ${solLine}`);
    lines.push(`- USDC: ${wallet.usdc != null ? wallet.usdc.toFixed(2) : 'n/a'}`);
  }

  lines.push('');
  const failTotal = [...failBuckets.values()].reduce((a, b) => a + b, 0);
  lines.push(`Неуспешные исполнения (за час, failed + sim_err): ${failTotal}`);
  if (!failBuckets.size) {
    lines.push('- нет');
  } else {
    const sorted = [...failBuckets.entries()].sort((a, b) => b[1] - a[1]);
    for (const [reason, n] of sorted) {
      lines.push(`- ${reason} — ${n}`);
    }
  }

  return lines.join('\n').slice(0, 3900);
}

function listStoresDebug() {
  const STORE_PATH = process.env.PAPER_TRADES_PATH || path.join(ROOT, 'data/paper-trades.jsonl');
  const stores = [];
  if (fs.existsSync(STORE_PATH))
    stores.push({ strategyId: process.env.PAPER_STRATEGY_ID || 'paper_v1', file: STORE_PATH });
  if (fs.existsSync(PAPER2_DIR)) {
    for (const f of fs.readdirSync(PAPER2_DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
      stores.push({ strategyId: path.basename(f, '.jsonl'), file: path.join(PAPER2_DIR, f) });
    }
  }
  return stores;
}

async function main() {
  const liveEvents = parseJsonl(LIVE_JSONL);
  const live = summarizeLiveOscarFromJournal(liveEvents);
  const failBuckets = aggregateExecutionFailures(liveEvents, since);

  const evalEvents = fs.existsSync(OSCAR_EVAL_JSONL) ? parseJsonl(OSCAR_EVAL_JSONL) : [];
  const evalAgg = countEvalPassPaper(evalEvents, since);

  const rpcUrl =
    process.env.HOURLY_RPC_URL ||
    process.env.SA_RPC_HTTP_URL ||
    process.env.SA_RPC_URL ||
    process.env.QUICKNODE_HTTP_URL ||
    process.env.HELIUS_RPC_URL ||
    '';
  const walletPk = process.env.HOURLY_WALLET_PUBKEY || process.env.LIVE_WALLET_PUBKEY || '';

  let wallet = null;
  let walletNote = '';
  if (!rpcUrl) {
    walletNote =
      'RPC не задан (HOURLY_RPC_URL / SA_RPC_HTTP_URL / SA_RPC_URL / QUICKNODE_HTTP_URL)';
  } else if (!walletPk) {
    walletNote = 'Публичный ключ не задан (LIVE_WALLET_PUBKEY / HOURLY_WALLET_PUBKEY)';
  } else {
    try {
      wallet = await fetchWalletBalances(rpcUrl, walletPk);
    } catch (e) {
      walletNote = `RPC ошибка: ${(e && e.message) || e}`;
    }
  }

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
      try {
        await pool?.end();
      } catch {
        /* noop */
      }
    }
  }

  const text = buildHourlyReport({
    coverage,
    health,
    live,
    evalAgg,
    failBuckets,
    wallet,
    walletNote,
  });

  await sendTelegram(text);
  console.log('sent', { len: text.length, liveJsonl: LIVE_JSONL });

  if (DETAIL_MODE) {
    const detailed = listStoresDebug()
      .map((s) => `- ${s.strategyId}: ${s.file}`)
      .join('\n');
    console.log('paper stores (debug):\n' + detailed);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
