import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const INTERVAL_MS = Number(process.env.MOONSHOT_COLLECTOR_INTERVAL_MS || 60_000);
const MAX_RETRIES = Number(process.env.MOONSHOT_COLLECTOR_MAX_RETRIES || 4);
const REQUEST_TIMEOUT_MS = Number(process.env.MOONSHOT_COLLECTOR_TIMEOUT_MS || 15_000);
const DEX_SEARCH_TERMS = (process.env.MOONSHOT_DEX_SEARCH_TERMS || 'moonshot,moonshot solana,moonshot token')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const GECKO_TRENDING_PAGES = Number(process.env.MOONSHOT_GECKO_TRENDING_PAGES || 2);
const GECKO_NEW_POOLS_PAGES = Number(process.env.MOONSHOT_GECKO_NEW_POOLS_PAGES || 2);
const SHORTLIST_MIN_LIQ_USD = Number(process.env.MOONSHOT_SHORTLIST_MIN_LIQ_USD || 20_000);
const SHORTLIST_MIN_VOL5M_USD = Number(process.env.MOONSHOT_SHORTLIST_MIN_VOL5M_USD || 2_000);
const ONCE = process.argv.includes('--once');

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
    component: 'moonshot-collector',
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

function toTs(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    return new Date(n);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function looksLikeMoonshotDexEntry(raw) {
  const text = [
    raw?.dexId,
    raw?.labels?.join?.(' '),
    raw?.url,
    raw?.pairAddress,
    raw?.baseToken?.name,
    raw?.baseToken?.symbol,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return text.includes('moonshot');
}

function normalizeDexScreenerPair(pair, bucketTs) {
  if (!pair || pair?.chainId !== 'solana') return null;
  if (!looksLikeMoonshotDexEntry(pair)) return null;

  const pairAddress = pair?.pairAddress ?? null;
  const baseMint = pair?.baseToken?.address ?? null;
  const quoteMint = pair?.quoteToken?.address ?? null;
  if (!pairAddress || !baseMint || !quoteMint) return null;

  const txnsM5 = pair?.txns?.m5 ?? {};
  return {
    ts: bucketTs,
    source: 'moonshot',
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
    launch_ts: toTs(pair?.pairCreatedAt),
  };
}

function normalizeGeckoPool(poolData, bucketTs) {
  const attrs = poolData?.attributes ?? {};
  const rel = poolData?.relationships ?? {};
  const searchBlob = [
    attrs?.dex_name,
    attrs?.name,
    attrs?.address,
    attrs?.base_token_price_usd,
    attrs?.pool_created_at,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!searchBlob.includes('moonshot')) return null;

  const pairAddress = attrs?.address ?? attrs?.pool_address ?? poolData?.id ?? null;
  const baseMint = rel?.base_token?.data?.id?.split('_').pop() ?? null;
  const quoteMint = rel?.quote_token?.data?.id?.split('_').pop() ?? null;
  if (!pairAddress || !baseMint || !quoteMint) return null;

  const tx5m = attrs?.transactions?.m5 ?? {};
  return {
    ts: bucketTs,
    source: 'moonshot',
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
    launch_ts: toTs(attrs?.pool_created_at),
  };
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
    if (nextLiquidity > currentLiquidity) {
      map.set(row.pair_address, row);
    }
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

async function fetchFromGecko(bucketTs, endpoint, retryTag) {
  const allRows = [];
  for (let page = 1; page <= endpoint.pages; page += 1) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/${endpoint.path}?page=${page}`;
    const json = await fetchJsonWithRetry(url, {}, retryTag);
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
      `($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`,
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
      row.launch_ts,
    );
  }

  const sql = `
    INSERT INTO moonshot_pair_snapshots (
      ts, source, pair_address, base_mint, quote_mint, price_usd, liquidity_usd,
      volume_5m, volume_1h, buys_5m, sells_5m, fdv_usd, market_cap_usd, launch_ts
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
      market_cap_usd = EXCLUDED.market_cap_usd,
      launch_ts = EXCLUDED.launch_ts
  `;

  await pool.query(sql, params);
  return rows.length;
}

async function collectOneTick() {
  const tickStartedAt = Date.now();
  const bucketTs = getMinuteBucketUtc();
  let rows = [];
  let sourceUsed = 'dexscreener';

  try {
    rows = await fetchFromDexScreener(bucketTs);
    if (rows.length === 0) {
      sourceUsed = 'geckoterminal-trending';
      rows = await fetchFromGecko(
        bucketTs,
        { path: 'trending_pools', pages: GECKO_TRENDING_PAGES },
        'geckoterminal-trending',
      );
    }
    if (rows.length === 0) {
      sourceUsed = 'geckoterminal-new-pools';
      rows = await fetchFromGecko(
        bucketTs,
        { path: 'new_pools', pages: GECKO_NEW_POOLS_PAGES },
        'geckoterminal-new',
      );
    }

    const written = await upsertSnapshots(rows);
    ticksTotal += 1;
    rowsCollectedTotal += rows.length;
    rowsUpsertedTotal += written;

    log('info', 'tick completed', {
      sourceUsed,
      bucketTs: bucketTs.toISOString(),
      collected: rows.length,
      upserted: written,
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
    geckoNewPoolsPages: GECKO_NEW_POOLS_PAGES,
    shortlistMinLiqUsd: SHORTLIST_MIN_LIQ_USD,
    shortlistMinVol5mUsd: SHORTLIST_MIN_VOL5M_USD,
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
