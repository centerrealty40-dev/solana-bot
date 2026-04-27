import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const INTERVAL_MS = Number(process.env.METEORA_COLLECTOR_INTERVAL_MS || 60_000);
const MAX_RETRIES = Number(process.env.METEORA_COLLECTOR_MAX_RETRIES || 4);
const REQUEST_TIMEOUT_MS = Number(process.env.METEORA_COLLECTOR_TIMEOUT_MS || 15_000);
const DEX_SEARCH_TERMS = (process.env.METEORA_DEX_SEARCH_TERMS || 'meteora,dlmm,solana')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const GECKO_TRENDING_PAGES = Number(process.env.METEORA_GECKO_TRENDING_PAGES || 2);
const SHORTLIST_MIN_LIQ_USD = Number(process.env.METEORA_SHORTLIST_MIN_LIQ_USD || 20_000);
const SHORTLIST_MIN_VOL5M_USD = Number(process.env.METEORA_SHORTLIST_MIN_VOL5M_USD || 2_000);
const RPC_TASK_PRIORITY = Number(process.env.METEORA_RPC_TASK_PRIORITY || 50);
const RPC_FEATURES = ['holders', 'largest_accounts', 'authorities', 'tx_burst'];
const ONCE = process.argv.includes('--once');

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let isTickRunning = false;
let isShuttingDown = false;
let ticksTotal = 0;
let rowsUpsertedTotal = 0;
let rowsCollectedTotal = 0;
let errorsTotal = 0;

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: 'meteora-collector',
    msg: message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMinuteBucketUtc(ts = Date.now()) {
  return new Date(Math.floor(ts / 60_000) * 60_000);
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

async function fetchJsonWithRetry(url, options = {}, retryTag = 'http') {
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          accept: 'application/json',
          ...(options.headers ?? {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        return await res.json();
      }

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retryable || attempt === MAX_RETRIES) {
        throw new Error(`${retryTag} non-retryable status=${res.status}`);
      }

      const retryAfterHeader = Number(res.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : 0;
      const backoffMs = retryAfterMs || Math.min(10_000, 500 * 2 ** attempt);
      log('warn', 'request retry scheduled', {
        retryTag,
        url,
        status: res.status,
        attempt,
        backoffMs,
        elapsedMs: Date.now() - startedAt,
      });
      attempt += 1;
      await sleep(backoffMs);
    } catch (error) {
      clearTimeout(timeout);
      if (attempt === MAX_RETRIES) throw error;
      const backoffMs = Math.min(10_000, 500 * 2 ** attempt);
      log('warn', 'request failed, retrying', {
        retryTag,
        url,
        attempt,
        backoffMs,
        error: String(error),
      });
      attempt += 1;
      await sleep(backoffMs);
    }
  }
  throw new Error(`${retryTag} failed after retries`);
}

function normalizeDexScreenerPair(pair, bucketTs) {
  const pairAddress = pair?.pairAddress ?? null;
  const baseMint = pair?.baseToken?.address ?? null;
  const quoteMint = pair?.quoteToken?.address ?? null;
  if (!pairAddress || !baseMint || !quoteMint) return null;

  const dexId = String(pair?.dexId || '').toLowerCase();
  if (!dexId.includes('meteora')) return null;
  if (pair?.chainId !== 'solana') return null;

  const txnsM5 = pair?.txns?.m5 ?? {};
  return {
    ts: bucketTs,
    source: 'meteora',
    pair_address: pairAddress,
    base_mint: baseMint,
    quote_mint: quoteMint,
    price_usd: toNum(pair?.priceUsd),
    liquidity_usd: toNum(pair?.liquidity?.usd),
    volume_5m: toNum(pair?.volume?.m5),
    volume_1h: toNum(pair?.volume?.h1),
    buys_5m: toInt(txnsM5?.buys),
    sells_5m: toInt(txnsM5?.sells),
    fdv_usd: toNum(pair?.fdv),
    market_cap_usd: toNum(pair?.marketCap),
    base_symbol: pair?.baseToken?.symbol ?? null,
    base_name: pair?.baseToken?.name ?? null,
  };
}

async function upsertTokensMeta(rows, pool) {
  const seen = new Map();
  for (const r of rows) {
    if (!r?.base_mint) continue;
    if (!r.base_symbol && !r.base_name) continue;
    if (!seen.has(r.base_mint)) seen.set(r.base_mint, { symbol: r.base_symbol, name: r.base_name });
  }
  if (seen.size === 0) return 0;
  let touched = 0;
  for (const [mint, meta] of seen) {
    try {
      const res = await pool.query(
        `INSERT INTO tokens (mint, symbol, name, metadata)
         VALUES ($1, $2, $3, jsonb_build_object('source','meteora'))
         ON CONFLICT (mint) DO UPDATE SET
           symbol = COALESCE(NULLIF(tokens.symbol, ''), EXCLUDED.symbol),
           name   = COALESCE(NULLIF(tokens.name,   ''), EXCLUDED.name),
           metadata = CASE
             WHEN COALESCE(tokens.metadata->>'source','') = ''
             THEN COALESCE(tokens.metadata, '{}'::jsonb) || jsonb_build_object('source','meteora')
             ELSE tokens.metadata
           END`,
        [mint, meta.symbol, meta.name],
      );
      touched += Number(res.rowCount ?? 0);
    } catch { /* per-mint best-effort */ }
  }
  return touched;
}

function normalizeGeckoPool(poolData, bucketTs) {
  const attrs = poolData?.attributes ?? {};
  const rel = poolData?.relationships ?? {};
  const dexName = String(attrs?.dex_name ?? attrs?.dex ?? '').toLowerCase();
  if (!dexName.includes('meteora')) return null;

  const pairAddress = attrs?.address ?? attrs?.pool_address ?? poolData?.id ?? null;
  const baseMint = rel?.base_token?.data?.id?.split('_').pop() ?? null;
  const quoteMint = rel?.quote_token?.data?.id?.split('_').pop() ?? null;
  if (!pairAddress || !baseMint || !quoteMint) return null;

  const tx5m = attrs?.transactions?.m5 ?? {};
  return {
    ts: bucketTs,
    source: 'meteora',
    pair_address: pairAddress,
    base_mint: baseMint,
    quote_mint: quoteMint,
    price_usd: toNum(attrs?.base_token_price_usd ?? attrs?.price_in_usd),
    liquidity_usd: toNum(attrs?.reserve_in_usd),
    volume_5m: toNum(attrs?.volume_usd?.m5 ?? attrs?.volume_usd?.h1),
    volume_1h: toNum(attrs?.volume_usd?.h1),
    buys_5m: toInt(tx5m?.buys),
    sells_5m: toInt(tx5m?.sells),
    fdv_usd: toNum(attrs?.fdv_usd),
    market_cap_usd: toNum(attrs?.market_cap_usd),
  };
}

function dedupByPairAddress(rows) {
  const map = new Map();
  for (const row of rows) {
    const current = map.get(row.pair_address);
    if (!current) {
      map.set(row.pair_address, row);
      continue;
    }
    const currentLiquidity = current.liquidity_usd ?? -1;
    const nextLiquidity = row.liquidity_usd ?? -1;
    if (nextLiquidity > currentLiquidity) map.set(row.pair_address, row);
  }
  return [...map.values()];
}

async function fetchFromDexScreener(bucketTs) {
  const allRows = [];
  for (const term of DEX_SEARCH_TERMS) {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`;
    const json = await fetchJsonWithRetry(url, {}, 'dexscreener');
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    for (const pair of pairs) {
      const row = normalizeDexScreenerPair(pair, bucketTs);
      if (row) allRows.push(row);
    }
    await sleep(250);
  }
  return dedupByPairAddress(allRows);
}

async function fetchFromGeckoTrending(bucketTs) {
  const allRows = [];
  for (let page = 1; page <= GECKO_TRENDING_PAGES; page += 1) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`;
    const json = await fetchJsonWithRetry(url, {}, 'geckoterminal');
    const pools = Array.isArray(json?.data) ? json.data : [];
    for (const poolData of pools) {
      const row = normalizeGeckoPool(poolData, bucketTs);
      if (row) allRows.push(row);
    }
    await sleep(250);
  }
  return dedupByPairAddress(allRows);
}

async function upsertSnapshots(rows) {
  if (rows.length === 0) return 0;

  const values = [];
  const params = [];
  let idx = 1;
  for (const row of rows) {
    values.push(
      `($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`,
    );
    params.push(
      row.ts,
      row.source,
      row.pair_address,
      row.base_mint,
      row.quote_mint,
      row.price_usd,
      row.liquidity_usd,
      row.volume_5m,
      row.volume_1h,
      row.buys_5m,
      row.sells_5m,
      row.fdv_usd,
      row.market_cap_usd,
    );
  }

  const sql = `
    INSERT INTO meteora_pair_snapshots (
      ts, source, pair_address, base_mint, quote_mint, price_usd, liquidity_usd,
      volume_5m, volume_1h, buys_5m, sells_5m, fdv_usd, market_cap_usd
    ) VALUES ${values.join(',')}
    ON CONFLICT (pair_address, ts) DO UPDATE
    SET
      source = EXCLUDED.source,
      base_mint = EXCLUDED.base_mint,
      quote_mint = EXCLUDED.quote_mint,
      price_usd = EXCLUDED.price_usd,
      liquidity_usd = EXCLUDED.liquidity_usd,
      volume_5m = EXCLUDED.volume_5m,
      volume_1h = EXCLUDED.volume_1h,
      buys_5m = EXCLUDED.buys_5m,
      sells_5m = EXCLUDED.sells_5m,
      fdv_usd = EXCLUDED.fdv_usd,
      market_cap_usd = EXCLUDED.market_cap_usd
  `;

  await pool.query(sql, params);
  return rows.length;
}

function shortlistMints(rows) {
  const mints = new Set();
  for (const row of rows) {
    const liq = Number(row.liquidity_usd ?? 0);
    const vol5m = Number(row.volume_5m ?? 0);
    if (liq >= SHORTLIST_MIN_LIQ_USD && vol5m >= SHORTLIST_MIN_VOL5M_USD) {
      mints.add(row.base_mint);
    }
  }
  return [...mints];
}

async function enqueueRpcTasks(shortlistedMints) {
  if (shortlistedMints.length === 0) return 0;
  let enqueued = 0;
  for (const mint of shortlistedMints) {
    for (const feature of RPC_FEATURES) {
      const res = await pool.query(
        `INSERT INTO rpc_tasks (mint, feature_type, priority, not_before)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [mint, feature, RPC_TASK_PRIORITY],
      );
      enqueued += Number(res.rowCount ?? 0);
    }
  }
  return enqueued;
}

async function collectOneTick() {
  const tickStartedAt = Date.now();
  const bucketTs = getMinuteBucketUtc();
  let rows = [];
  let sourceUsed = 'dexscreener';

  try {
    rows = await fetchFromDexScreener(bucketTs);
    if (rows.length === 0) {
      sourceUsed = 'geckoterminal';
      rows = await fetchFromGeckoTrending(bucketTs);
    }

    const written = await upsertSnapshots(rows);
    await upsertTokensMeta(rows, pool).catch(() => {});
    const shortlistedMints = shortlistMints(rows);
    const rpcTasksEnqueued = await enqueueRpcTasks(shortlistedMints);
    ticksTotal += 1;
    rowsCollectedTotal += rows.length;
    rowsUpsertedTotal += written;

    log('info', 'tick completed', {
      sourceUsed,
      bucketTs: bucketTs.toISOString(),
      collected: rows.length,
      upserted: written,
      shortlistedMints: shortlistedMints.length,
      rpcTasksEnqueued,
      elapsedMs: Date.now() - tickStartedAt,
      ticksTotal,
      rowsCollectedTotal,
      rowsUpsertedTotal,
      errorsTotal,
    });
  } catch (error) {
    errorsTotal += 1;
    log('error', 'tick failed', {
      error: String(error),
      elapsedMs: Date.now() - tickStartedAt,
      ticksTotal,
      errorsTotal,
    });
  }
}

async function runTickGuarded() {
  if (isTickRunning) {
    log('warn', 'skipping tick, previous run still active');
    return;
  }
  isTickRunning = true;
  try {
    await collectOneTick();
  } finally {
    isTickRunning = false;
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('info', 'shutdown requested', { signal });
  try {
    await pool.end();
  } catch (error) {
    log('warn', 'pool shutdown warning', { error: String(error) });
  } finally {
    process.exit(0);
  }
}

async function main() {
  log('info', 'collector start', {
    intervalMs: INTERVAL_MS,
    maxRetries: MAX_RETRIES,
    timeoutMs: REQUEST_TIMEOUT_MS,
    once: ONCE,
    searchTerms: DEX_SEARCH_TERMS,
    geckoTrendingPages: GECKO_TRENDING_PAGES,
    shortlistMinLiqUsd: SHORTLIST_MIN_LIQ_USD,
    shortlistMinVol5mUsd: SHORTLIST_MIN_VOL5M_USD,
    rpcTaskPriority: RPC_TASK_PRIORITY,
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runTickGuarded();

  if (ONCE) {
    await shutdown('ONCE');
    return;
  }

  setInterval(() => void runTickGuarded(), INTERVAL_MS);
}

main().catch((error) => {
  log('error', 'fatal error', { error: String(error) });
  process.exit(1);
});
