import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const INTERVAL_MS = Number(process.env.DIRECT_LP_DETECTOR_INTERVAL_MS || 60_000);
const FRESH_LOOKBACK_MINUTES = Number(process.env.DIRECT_LP_FRESH_LOOKBACK_MINUTES || 10);
const HISTORY_LOOKBACK_HOURS = Number(process.env.DIRECT_LP_HISTORY_LOOKBACK_HOURS || 168);
const MIN_LIQUIDITY_USD = Number(process.env.DIRECT_LP_MIN_LIQUIDITY_USD || 0);
const RPC_TASK_PRIORITY = Number(process.env.DIRECT_LP_RPC_TASK_PRIORITY || 45);
const SOURCE = process.env.DIRECT_LP_SOURCE || 'direct-lp-detector';
const ONCE = process.argv.includes('--once');
const ENQUEUE_RPC = process.env.DIRECT_LP_ENQUEUE_RPC !== '0';
const UPSERT_TOKENS = process.env.DIRECT_LP_UPSERT_TOKENS !== '0';

const RPC_FEATURES = ['holders', 'largest_accounts', 'authorities', 'tx_burst'];
const DEFAULT_SKIP_MINTS = [
  process.env.DIRECT_LP_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4LkNX54nJeFf9HYZ8sY2',
  'So11111111111111111111111111111111111111112',
  '11111111111111111111111111111111',
];
const SKIP_MINTS = new Set(
  (process.env.DIRECT_LP_SKIP_MINTS || DEFAULT_SKIP_MINTS.join(','))
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
let candidatesTotal = 0;
let eventsUpsertedTotal = 0;
let rpcTasksEnqueuedTotal = 0;
let errorsTotal = 0;

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: 'direct-lp-detector',
    msg: message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function getMinuteBucketUtc(ts = Date.now()) {
  return new Date(Math.floor(ts / 60_000) * 60_000);
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isValidMint(mint) {
  return typeof mint === 'string' && mint.length >= 32 && mint.length <= 64 && !SKIP_MINTS.has(mint);
}

function isPlausibleMint(mint) {
  return typeof mint === 'string' && mint.length >= 32 && mint.length <= 64;
}

async function tableExists(tableName) {
  const res = await pool.query('SELECT to_regclass($1) AS table_name', [`public.${tableName}`]);
  return Boolean(res.rows[0]?.table_name);
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_lp_events (
      ts timestamptz,
      source text,
      pair_address text,
      base_mint text,
      quote_mint text,
      dex text,
      first_price_usd double precision,
      first_liquidity_usd double precision,
      launch_inferred_ts timestamptz,
      confidence double precision,
      reason text,
      created_at timestamptz DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS direct_lp_events_base_pair_ts_uq
      ON direct_lp_events (base_mint, pair_address, ts);
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS direct_lp_events_ts_idx ON direct_lp_events (ts DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS direct_lp_events_base_mint_idx ON direct_lp_events (base_mint)');
  await pool.query('CREATE INDEX IF NOT EXISTS direct_lp_events_pair_address_idx ON direct_lp_events (pair_address)');
  await pool.query('CREATE INDEX IF NOT EXISTS direct_lp_events_dex_idx ON direct_lp_events (dex)');
}

function snapshotSelect(tableName, dex, hasLaunchTs) {
  return `
    SELECT
      ts,
      source,
      pair_address,
      base_mint,
      quote_mint,
      '${dex}'::text AS dex,
      price_usd,
      liquidity_usd,
      volume_5m,
      buys_5m,
      sells_5m,
      ${hasLaunchTs ? 'launch_ts' : 'NULL::timestamptz'} AS launch_ts
    FROM ${tableName}
    WHERE ts >= now() - ($3::int * interval '1 hour')
  `;
}

async function buildCandidateSql() {
  const snapshotSources = [];
  if (await tableExists('raydium_pair_snapshots')) {
    snapshotSources.push(snapshotSelect('raydium_pair_snapshots', 'raydium', false));
  }
  if (await tableExists('meteora_pair_snapshots')) {
    snapshotSources.push(snapshotSelect('meteora_pair_snapshots', 'meteora', false));
  }
  if (await tableExists('orca_pair_snapshots')) {
    snapshotSources.push(snapshotSelect('orca_pair_snapshots', 'orca', true));
  }
  if (snapshotSources.length === 0) return null;

  const hasTokens = await tableExists('tokens');
  const hasSwaps = await tableExists('swaps');

  const knownTokensSql = hasTokens
    ? `
      SELECT
        mint AS base_mint,
        first_seen_at AS token_first_seen_at,
        metadata->>'source' AS token_source
      FROM tokens
    `
    : `
      SELECT
        NULL::text AS base_mint,
        NULL::timestamptz AS token_first_seen_at,
        NULL::text AS token_source
      WHERE false
    `;

  const launchSources = [];
  if (hasTokens) {
    launchSources.push(`
      SELECT mint AS base_mint, MIN(first_seen_at) AS launch_ts, 'tokens:pumpportal' AS launch_source
      FROM tokens
      WHERE metadata->>'source' = 'pumpportal'
      GROUP BY mint
    `);
  }
  if (hasSwaps) {
    launchSources.push(`
      SELECT base_mint, MIN(block_time) AS launch_ts, 'swaps:pumpportal' AS launch_source
      FROM swaps
      WHERE source = 'pumpportal'
      GROUP BY base_mint
    `);
  }
  const knownLaunchesSql = launchSources.length > 0
    ? launchSources.join('\nUNION ALL\n')
    : `
      SELECT NULL::text AS base_mint, NULL::timestamptz AS launch_ts, NULL::text AS launch_source
      WHERE false
    `;

  return `
    WITH all_snapshots AS (
      ${snapshotSources.join('\nUNION ALL\n')}
    ),
    base_first_seen AS (
      SELECT base_mint, MIN(ts) AS first_base_snapshot_ts
      FROM all_snapshots
      GROUP BY base_mint
    ),
    pair_first_seen AS (
      SELECT
        base_mint,
        pair_address,
        MIN(ts) AS first_pair_snapshot_ts,
        MIN(launch_ts) FILTER (WHERE launch_ts IS NOT NULL) AS first_pool_launch_ts
      FROM all_snapshots
      GROUP BY base_mint, pair_address
    ),
    latest_pair AS (
      SELECT DISTINCT ON (base_mint, pair_address)
        base_mint,
        pair_address,
        quote_mint,
        dex,
        price_usd,
        liquidity_usd,
        volume_5m,
        buys_5m,
        sells_5m,
        ts AS latest_snapshot_ts
      FROM all_snapshots
      ORDER BY base_mint, pair_address, ts DESC, liquidity_usd DESC NULLS LAST
    ),
    known_tokens AS (
      ${knownTokensSql}
    ),
    known_launches AS (
      ${knownLaunchesSql}
    ),
    candidates AS (
      SELECT
        lp.dex,
        lp.pair_address,
        lp.base_mint,
        lp.quote_mint,
        lp.price_usd AS first_price_usd,
        lp.liquidity_usd AS first_liquidity_usd,
        COALESCE(pf.first_pool_launch_ts, pf.first_pair_snapshot_ts) AS launch_inferred_ts,
        pf.first_pair_snapshot_ts,
        bf.first_base_snapshot_ts,
        kt.token_first_seen_at,
        kt.token_source,
        lp.volume_5m,
        lp.buys_5m,
        lp.sells_5m
      FROM latest_pair lp
      JOIN pair_first_seen pf
        ON pf.base_mint = lp.base_mint
       AND pf.pair_address = lp.pair_address
      JOIN base_first_seen bf ON bf.base_mint = lp.base_mint
      LEFT JOIN known_tokens kt ON kt.base_mint = lp.base_mint
      LEFT JOIN known_launches kl ON kl.base_mint = lp.base_mint
      WHERE pf.first_pair_snapshot_ts >= now() - ($1::int * interval '1 minute')
        AND lp.liquidity_usd >= $2
        AND kl.base_mint IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM direct_lp_events e
          WHERE e.base_mint = lp.base_mint
            AND e.pair_address = lp.pair_address
        )
    )
    SELECT
      dex,
      pair_address,
      base_mint,
      quote_mint,
      first_price_usd,
      first_liquidity_usd,
      launch_inferred_ts,
      LEAST(
        0.98,
        GREATEST(
          0.05,
          0.55
          + CASE WHEN token_first_seen_at IS NULL THEN 0.10 ELSE 0 END
          + CASE WHEN ABS(EXTRACT(EPOCH FROM (first_pair_snapshot_ts - first_base_snapshot_ts))) <= 120 THEN 0.15 ELSE 0 END
          + CASE WHEN COALESCE(first_liquidity_usd, 0) >= 10000 THEN 0.10 ELSE 0 END
          + CASE WHEN COALESCE(volume_5m, 0) >= 1000 OR COALESCE(buys_5m, 0) + COALESCE(sells_5m, 0) >= 10 THEN 0.10 ELSE 0 END
          - CASE WHEN token_first_seen_at IS NOT NULL AND token_first_seen_at < first_base_snapshot_ts - interval '1 day' THEN 0.20 ELSE 0 END
        )
      ) AS confidence,
      concat_ws(
        '; ',
        'new dex pair without pumpportal launch evidence',
        CASE WHEN token_first_seen_at IS NULL THEN 'mint absent from tokens before detector' ELSE 'mint already in tokens from non-pumpportal source' END,
        CASE WHEN ABS(EXTRACT(EPOCH FROM (first_pair_snapshot_ts - first_base_snapshot_ts))) <= 120 THEN 'base mint first appeared in snapshots with this pair' ELSE NULL END,
        'first_pair_snapshot_ts=' || first_pair_snapshot_ts::text,
        'first_base_snapshot_ts=' || first_base_snapshot_ts::text
      ) AS reason
    FROM candidates
    ORDER BY confidence DESC, first_liquidity_usd DESC NULLS LAST, launch_inferred_ts DESC
  `;
}

async function loadCandidates() {
  const sql = await buildCandidateSql();
  if (!sql) return [];

  const res = await pool.query(sql, [FRESH_LOOKBACK_MINUTES, MIN_LIQUIDITY_USD, HISTORY_LOOKBACK_HOURS]);
  return res.rows
    .filter((row) => isValidMint(row.base_mint) && isPlausibleMint(row.quote_mint))
    .map((row) => ({
      dex: row.dex,
      pairAddress: row.pair_address,
      baseMint: row.base_mint,
      quoteMint: row.quote_mint,
      firstPriceUsd: toNum(row.first_price_usd),
      firstLiquidityUsd: toNum(row.first_liquidity_usd),
      launchInferredTs: row.launch_inferred_ts,
      confidence: toNum(row.confidence) ?? 0,
      reason: row.reason,
    }));
}

async function upsertEvents(candidates, bucketTs) {
  if (candidates.length === 0) return [];

  const values = [];
  const params = [];
  let idx = 1;
  for (const row of candidates) {
    values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
    params.push(
      bucketTs,
      SOURCE,
      row.pairAddress,
      row.baseMint,
      row.quoteMint,
      row.dex,
      row.firstPriceUsd,
      row.firstLiquidityUsd,
      row.launchInferredTs,
      row.confidence,
      row.reason,
    );
  }

  const res = await pool.query(
    `
      INSERT INTO direct_lp_events (
        ts, source, pair_address, base_mint, quote_mint, dex, first_price_usd,
        first_liquidity_usd, launch_inferred_ts, confidence, reason
      ) VALUES ${values.join(',')}
      ON CONFLICT (base_mint, pair_address, ts) DO UPDATE
      SET
        source = EXCLUDED.source,
        quote_mint = EXCLUDED.quote_mint,
        dex = EXCLUDED.dex,
        first_price_usd = EXCLUDED.first_price_usd,
        first_liquidity_usd = EXCLUDED.first_liquidity_usd,
        launch_inferred_ts = EXCLUDED.launch_inferred_ts,
        confidence = EXCLUDED.confidence,
        reason = EXCLUDED.reason
      RETURNING *
    `,
    params,
  );

  return res.rows;
}

async function upsertTokens(events) {
  if (!UPSERT_TOKENS || events.length === 0 || !(await tableExists('tokens'))) return 0;

  let upserted = 0;
  for (const event of events) {
    const metadata = {
      source: 'direct_lp',
      direct_lp: {
        detectorSource: event.source,
        dex: event.dex,
        pairAddress: event.pair_address,
        quoteMint: event.quote_mint,
        firstPriceUsd: event.first_price_usd,
        firstLiquidityUsd: event.first_liquidity_usd,
        launchInferredTs: event.launch_inferred_ts,
        confidence: event.confidence,
        reason: event.reason,
      },
    };
    const res = await pool.query(
      `
        INSERT INTO tokens (
          mint, decimals, first_seen_at, liquidity_usd, primary_pair, metadata, updated_at
        )
        VALUES ($1, 0, COALESCE($2::timestamptz, $3::timestamptz), $4, $5, $6::jsonb, now())
        ON CONFLICT (mint) DO UPDATE
        SET
          liquidity_usd = COALESCE(tokens.liquidity_usd, EXCLUDED.liquidity_usd),
          primary_pair = COALESCE(tokens.primary_pair, EXCLUDED.primary_pair),
          metadata = COALESCE(tokens.metadata, '{}'::jsonb)
            || jsonb_build_object('direct_lp', EXCLUDED.metadata->'direct_lp'),
          updated_at = now()
      `,
      [
        event.base_mint,
        event.launch_inferred_ts,
        event.ts,
        event.first_liquidity_usd,
        event.pair_address,
        JSON.stringify(metadata),
      ],
    );
    upserted += Number(res.rowCount ?? 0);
  }
  return upserted;
}

async function enqueueRpcTasks(events) {
  if (!ENQUEUE_RPC || events.length === 0 || !(await tableExists('rpc_tasks'))) return 0;

  let enqueued = 0;
  const mints = new Set(events.map((row) => row.base_mint).filter(isValidMint));
  for (const mint of mints) {
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
  const candidates = await loadCandidates();
  const events = await upsertEvents(candidates, bucketTs);
  const tokensUpserted = await upsertTokens(events);
  const rpcTasksEnqueued = await enqueueRpcTasks(events);

  ticksTotal += 1;
  candidatesTotal += candidates.length;
  eventsUpsertedTotal += events.length;
  rpcTasksEnqueuedTotal += rpcTasksEnqueued;

  log('info', 'tick completed', {
    bucketTs: bucketTs.toISOString(),
    candidates: candidates.length,
    eventsUpserted: events.length,
    tokensUpserted,
    rpcTasksEnqueued,
    elapsedMs: Date.now() - startedAt,
    ticksTotal,
    candidatesTotal,
    eventsUpsertedTotal,
    rpcTasksEnqueuedTotal,
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
  await ensureSchema();
  log('info', 'detector start', {
    intervalMs: INTERVAL_MS,
    freshLookbackMinutes: FRESH_LOOKBACK_MINUTES,
    historyLookbackHours: HISTORY_LOOKBACK_HOURS,
    minLiquidityUsd: MIN_LIQUIDITY_USD,
    enqueueRpc: ENQUEUE_RPC,
    upsertTokens: UPSERT_TOKENS,
    rpcTaskPriority: RPC_TASK_PRIORITY,
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
