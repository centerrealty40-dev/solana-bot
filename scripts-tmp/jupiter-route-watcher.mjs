import 'dotenv/config';
import pg from 'pg';
import Decimal from 'decimal.js';

const { Pool } = pg;

const USDC_MINT = process.env.JUPITER_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_SKIP_MINTS = [
  USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4LkNX54nJeFf9HYZ8sY2',
  'So11111111111111111111111111111111111111112',
];

const INTERVAL_MS = Number(process.env.JUPITER_WATCHER_INTERVAL_MS || 60_000);
const LOOKBACK_HOURS = Number(process.env.JUPITER_WATCHER_LOOKBACK_HOURS || 2);
const MAX_MINTS = Number(process.env.JUPITER_WATCHER_MAX_MINTS || 20);
const MAX_RETRIES = Number(process.env.JUPITER_WATCHER_MAX_RETRIES || 3);
const REQUEST_TIMEOUT_MS = Number(process.env.JUPITER_WATCHER_TIMEOUT_MS || 12_000);
const REQUEST_DELAY_MS = Number(process.env.JUPITER_WATCHER_REQUEST_DELAY_MS || 1250);
const QUOTE_IN_USD = Number(process.env.JUPITER_WATCHER_QUOTE_IN_USD || 25);
const DEFAULT_DECIMALS = Number(process.env.JUPITER_WATCHER_DEFAULT_DECIMALS || 6);
const SLIPPAGE_BPS = Number(process.env.JUPITER_WATCHER_SLIPPAGE_BPS || 300);
const HIGH_ACTIVITY_SCORE = Number(process.env.JUPITER_HIGH_ACTIVITY_SCORE || 10);
const HIGH_ACTIVITY_VOLUME_USD = Number(process.env.JUPITER_HIGH_ACTIVITY_VOLUME_USD || 1_000);
const RPC_TASK_PRIORITY = Number(process.env.JUPITER_RPC_TASK_PRIORITY || 70);
const ENQUEUE_RPC = process.env.JUPITER_WATCHER_ENQUEUE_RPC !== '0';
const QUOTE_API_URL = process.env.JUPITER_QUOTE_API_URL || 'https://api.jup.ag/swap/v1/quote';
const ONCE = process.argv.includes('--once');

const RPC_FEATURES = ['holders', 'largest_accounts', 'authorities', 'tx_burst'];
const SKIP_MINTS = new Set(
  (process.env.JUPITER_WATCHER_SKIP_MINTS || DEFAULT_SKIP_MINTS.join(','))
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let isTickRunning = false;
let isShuttingDown = false;
let ticksTotal = 0;
let snapshotsTotal = 0;
let routeableTotal = 0;
let errorsTotal = 0;

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: 'jupiter-route-watcher',
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

function rawOneToken(decimals) {
  return new Decimal(10).pow(decimals).toFixed(0);
}

function isValidMint(mint) {
  return typeof mint === 'string' && mint.length >= 32 && mint.length <= 64 && !SKIP_MINTS.has(mint);
}

function isRateLimitError(error) {
  return String(error?.message || error).includes('status=429');
}

async function tableExists(tableName) {
  const res = await pool.query('SELECT to_regclass($1) AS table_name', [`public.${tableName}`]);
  return Boolean(res.rows[0]?.table_name);
}

async function buildCandidateSources() {
  const sources = [];

  if (await tableExists('tokens')) {
    sources.push(`
      SELECT
        mint,
        'tokens' AS source,
        first_seen_at,
        NULL::double precision AS price_usd,
        GREATEST(COALESCE(volume_24h_usd, 0) / 500.0, COALESCE(liquidity_usd, 0) / 5000.0) AS activity_score,
        COALESCE(volume_24h_usd, 0) AS volume_usd
      FROM tokens
      WHERE COALESCE(updated_at, first_seen_at) >= now() - ($1::int * interval '1 hour')
         OR first_seen_at >= now() - ($1::int * interval '1 hour')
    `);
  }

  if (await tableExists('swaps')) {
    sources.push(`
      SELECT
        base_mint AS mint,
        'swaps' AS source,
        MIN(block_time) AS first_seen_at,
        AVG(NULLIF(price_usd, 0)) AS price_usd,
        COUNT(*)::double precision + COALESCE(SUM(amount_usd), 0) / 100.0 AS activity_score,
        COALESCE(SUM(amount_usd), 0) AS volume_usd
      FROM swaps
      WHERE block_time >= now() - ($1::int * interval '1 hour')
      GROUP BY base_mint
    `);
  }

  for (const tableName of [
    'raydium_pair_snapshots',
    'meteora_pair_snapshots',
    'orca_pair_snapshots',
    'moonshot_pair_snapshots',
  ]) {
    if (!(await tableExists(tableName))) continue;
    const source = tableName.replace('_pair_snapshots', '');
    sources.push(`
      SELECT
        base_mint AS mint,
        '${source}' AS source,
        MIN(ts) AS first_seen_at,
        AVG(NULLIF(price_usd, 0)) AS price_usd,
        MAX(COALESCE(buys_5m, 0) + COALESCE(sells_5m, 0) + COALESCE(volume_5m, 0) / 100.0) AS activity_score,
        MAX(COALESCE(volume_5m, 0)) AS volume_usd
      FROM ${tableName}
      WHERE ts >= now() - ($1::int * interval '1 hour')
      GROUP BY base_mint
    `);
  }

  return sources;
}

async function loadShortlist() {
  const sources = await buildCandidateSources();
  if (sources.length === 0) return [];

  const sql = `
    WITH candidates AS (
      ${sources.join('\nUNION ALL\n')}
    ),
    ranked AS (
      SELECT
        mint,
        string_agg(DISTINCT source, '+') AS source,
        MAX(first_seen_at) AS first_seen_at,
        MAX(price_usd) FILTER (WHERE price_usd > 0) AS price_usd,
        MAX(activity_score) AS activity_score,
        MAX(volume_usd) AS volume_usd
      FROM candidates
      WHERE mint IS NOT NULL AND mint <> ''
      GROUP BY mint
    )
    SELECT mint, source, first_seen_at, price_usd, activity_score, volume_usd
    FROM ranked
    ORDER BY activity_score DESC NULLS LAST, first_seen_at DESC NULLS LAST
    LIMIT $2
  `;

  const res = await pool.query(sql, [LOOKBACK_HOURS, MAX_MINTS * 2]);
  return res.rows
    .filter((row) => isValidMint(row.mint))
    .slice(0, MAX_MINTS)
    .map((row) => ({
      mint: row.mint,
      source: row.source || 'unknown',
      firstSeenAt: row.first_seen_at,
      priceUsd: toNum(row.price_usd),
      activityScore: toNum(row.activity_score) ?? 0,
      volumeUsd: toNum(row.volume_usd) ?? 0,
    }));
}

async function loadDecimals(mints) {
  if (mints.length === 0 || !(await tableExists('tokens'))) return new Map();
  const res = await pool.query('SELECT mint, decimals FROM tokens WHERE mint = ANY($1)', [mints]);
  return new Map(res.rows.map((row) => [row.mint, Number(row.decimals)]));
}

function amountRawFromUsd(quoteInUsd, priceUsd, decimals) {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const raw = new Decimal(quoteInUsd)
    .div(priceUsd)
    .mul(new Decimal(10).pow(decimals))
    .floor();
  if (!raw.isFinite() || raw.lte(0)) return null;
  return raw.toFixed(0);
}

function quoteAmountForCandidate(candidate, decimals) {
  const amountRaw = amountRawFromUsd(QUOTE_IN_USD, candidate.priceUsd, decimals);
  if (amountRaw) return { amountRaw, quoteInUsd: QUOTE_IN_USD };
  return { amountRaw: rawOneToken(decimals), quoteInUsd: null };
}

async function fetchQuoteWithRetry(candidate, amountRaw) {
  const params = new URLSearchParams({
    inputMint: candidate.mint,
    outputMint: USDC_MINT,
    amount: amountRaw,
    slippageBps: String(SLIPPAGE_BPS),
    onlyDirectRoutes: 'false',
    restrictIntermediateTokens: 'true',
    instructionVersion: 'V2',
  });
  const url = `${QUOTE_API_URL}?${params.toString()}`;

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) return await res.json();

      const body = await res.text();
      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retryable) {
        log('info', 'quote not routeable', {
          mint: candidate.mint,
          status: res.status,
          body: body.slice(0, 180),
        });
        return null;
      }
      if (attempt === MAX_RETRIES) throw new Error(`jupiter status=${res.status} body=${body.slice(0, 180)}`);
    } catch (error) {
      clearTimeout(timeout);
      if (attempt === MAX_RETRIES) throw error;
      log('warn', 'quote request retry scheduled', {
        mint: candidate.mint,
        attempt,
        error: String(error),
      });
    }

    await sleep(Math.min(5_000, 500 * 2 ** attempt));
    attempt += 1;
  }

  return null;
}

function snapshotFromQuote(candidate, bucketTs, quote, quoteInUsd) {
  if (!quote) {
    return {
      ts: bucketTs,
      source: candidate.source,
      mint: candidate.mint,
      routeable: false,
      bestOutUsd: null,
      estimatedSlippageBps: null,
      quoteInUsd,
      hops: null,
      venue: null,
    };
  }

  const routePlan = Array.isArray(quote.routePlan) ? quote.routePlan : [];
  const firstSwap = routePlan[0]?.swapInfo ?? {};
  const priceImpactPct = toNum(quote.priceImpactPct);

  const bestOutUsd = new Decimal(quote.outAmount || 0).div(1_000_000).toNumber();

  return {
    ts: bucketTs,
    source: candidate.source,
    mint: candidate.mint,
    routeable: true,
    bestOutUsd,
    estimatedSlippageBps: priceImpactPct === null ? null : priceImpactPct * 10_000,
    quoteInUsd: quoteInUsd ?? bestOutUsd,
    hops: routePlan.length,
    venue: firstSwap.label || firstSwap.ammKey || null,
  };
}

async function upsertSnapshots(rows) {
  if (rows.length === 0) return 0;

  const values = [];
  const params = [];
  let idx = 1;
  for (const row of rows) {
    values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
    params.push(
      row.ts,
      row.source,
      row.mint,
      row.routeable,
      row.bestOutUsd,
      row.estimatedSlippageBps,
      row.quoteInUsd,
      row.hops,
      row.venue,
    );
  }

  await pool.query(
    `
      INSERT INTO jupiter_route_snapshots (
        ts, source, mint, routeable, best_out_usd, estimated_slippage_bps,
        quote_in_usd, hops, venue
      ) VALUES ${values.join(',')}
      ON CONFLICT (mint, ts) DO UPDATE
      SET
        source = EXCLUDED.source,
        routeable = EXCLUDED.routeable,
        best_out_usd = EXCLUDED.best_out_usd,
        estimated_slippage_bps = EXCLUDED.estimated_slippage_bps,
        quote_in_usd = EXCLUDED.quote_in_usd,
        hops = EXCLUDED.hops,
        venue = EXCLUDED.venue,
        created_at = now()
    `,
    params,
  );

  return rows.length;
}

function isHighActivity(candidate) {
  return candidate.activityScore >= HIGH_ACTIVITY_SCORE || candidate.volumeUsd >= HIGH_ACTIVITY_VOLUME_USD;
}

async function enqueueRpcTasks(candidatesByMint, snapshots) {
  if (!ENQUEUE_RPC) return 0;

  const mints = snapshots
    .filter((row) => row.routeable && isHighActivity(candidatesByMint.get(row.mint) ?? {}))
    .map((row) => row.mint);
  if (mints.length === 0) return 0;

  let enqueued = 0;
  for (const mint of new Set(mints)) {
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
  const startedAt = Date.now();
  const bucketTs = getMinuteBucketUtc();
  const candidates = await loadShortlist();
  const decimalsByMint = await loadDecimals(candidates.map((row) => row.mint));
  const snapshots = [];

  for (const candidate of candidates) {
    const decimals = decimalsByMint.get(candidate.mint) ?? DEFAULT_DECIMALS;
    const { amountRaw, quoteInUsd } = quoteAmountForCandidate(candidate, decimals);

    try {
      const quote = await fetchQuoteWithRetry(candidate, amountRaw);
      snapshots.push(snapshotFromQuote(candidate, bucketTs, quote, quoteInUsd));
    } catch (error) {
      errorsTotal += 1;
      if (isRateLimitError(error)) {
        log('warn', 'quote rate limited, skipping snapshot to avoid false non-routeable', {
          mint: candidate.mint,
          error: String(error),
        });
        await sleep(Math.max(REQUEST_DELAY_MS, 2_500));
        continue;
      }
      log('warn', 'quote failed after retries', { mint: candidate.mint, error: String(error) });
      snapshots.push(snapshotFromQuote(candidate, bucketTs, null, quoteInUsd));
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const written = await upsertSnapshots(snapshots);
  const candidatesByMint = new Map(candidates.map((row) => [row.mint, row]));
  const rpcTasksEnqueued = await enqueueRpcTasks(candidatesByMint, snapshots);

  ticksTotal += 1;
  snapshotsTotal += written;
  routeableTotal += snapshots.filter((row) => row.routeable).length;

  log('info', 'tick completed', {
    bucketTs: bucketTs.toISOString(),
    candidates: candidates.length,
    snapshots: written,
    routeable: snapshots.filter((row) => row.routeable).length,
    rpcTasksEnqueued,
    elapsedMs: Date.now() - startedAt,
    ticksTotal,
    snapshotsTotal,
    routeableTotal,
    errorsTotal,
  });
}

async function runTickGuarded() {
  if (isTickRunning) {
    log('warn', 'skipping tick, previous run still active');
    return;
  }
  isTickRunning = true;
  try {
    await collectOneTick();
  } catch (error) {
    errorsTotal += 1;
    log('error', 'tick failed', { error: String(error), ticksTotal, errorsTotal });
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
  log('info', 'watcher start', {
    intervalMs: INTERVAL_MS,
    lookbackHours: LOOKBACK_HOURS,
    maxMints: MAX_MINTS,
    quoteInUsd: QUOTE_IN_USD,
    slippageBps: SLIPPAGE_BPS,
    enqueueRpc: ENQUEUE_RPC,
    rpcTaskPriority: RPC_TASK_PRIORITY,
    quoteApiUrl: QUOTE_API_URL,
    once: ONCE,
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
