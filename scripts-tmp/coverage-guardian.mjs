import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const COMPONENT = 'coverage-guardian';
const ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run') || process.env.COVERAGE_GUARDIAN_DRY_RUN === '1';
const INTERVAL_MS = Number(process.env.COVERAGE_GUARDIAN_INTERVAL_MS || 60 * 60 * 1000);
const LOOKBACK_HOURS = Number(process.env.COVERAGE_GUARDIAN_LOOKBACK_HOURS || 24);
const NO_DATA_GRACE_MINUTES = Number(process.env.COVERAGE_NO_DATA_GRACE_MINUTES || 5);
const HANDOFF_GRACE_MINUTES = Number(process.env.COVERAGE_HANDOFF_GRACE_MINUTES || 20);
const FOLLOWUP_GRACE_MINUTES = Number(process.env.COVERAGE_FOLLOWUP_GRACE_MINUTES || 15);
const TRADEABLE_GRACE_MINUTES = Number(process.env.COVERAGE_TRADEABLE_GRACE_MINUTES || 5);
const ENRICHMENT_GRACE_MINUTES = Number(process.env.COVERAGE_ENRICHMENT_GRACE_MINUTES || 10);
const MIN_LIQUIDITY_USD = Number(process.env.COVERAGE_MIN_LIQUIDITY_USD || 10_000);
const RPC_TASK_PRIORITY = Number(process.env.COVERAGE_RPC_TASK_PRIORITY || 40);
const RPC_FEATURES = ['holders', 'largest_accounts', 'authorities', 'tx_burst'];

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let isTickRunning = false;
let isShuttingDown = false;
let ticksTotal = 0;
let errorsTotal = 0;

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: COMPONENT,
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

async function tableExists(tableName) {
  const res = await pool.query('SELECT to_regclass($1) AS table_name', [`public.${tableName}`]);
  return Boolean(res.rows[0]?.table_name);
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coverage_events (
      mint text PRIMARY KEY,
      first_seen_pump timestamptz,
      first_seen_raydium timestamptz,
      first_seen_meteora timestamptz,
      first_seen_orca timestamptz,
      first_seen_moonshot timestamptz,
      first_seen_jupiter timestamptz,
      last_seen timestamptz,
      lifecycle_stage text,
      confidence double precision,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS coverage_gaps (
      ts timestamptz NOT NULL,
      mint text NOT NULL,
      gap_type text NOT NULL,
      severity text NOT NULL,
      details_json jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS coverage_events_updated_idx
      ON coverage_events (updated_at DESC);
    CREATE INDEX IF NOT EXISTS coverage_events_stage_idx
      ON coverage_events (lifecycle_stage);
    CREATE INDEX IF NOT EXISTS coverage_events_last_seen_idx
      ON coverage_events (last_seen DESC);
    CREATE INDEX IF NOT EXISTS coverage_gaps_ts_idx
      ON coverage_gaps (ts DESC);
    CREATE INDEX IF NOT EXISTS coverage_gaps_mint_idx
      ON coverage_gaps (mint);
    CREATE INDEX IF NOT EXISTS coverage_gaps_type_idx
      ON coverage_gaps (gap_type);
  `);
}

function sourceSelects(existing) {
  const selects = [];

  if (existing.tokens) {
    selects.push(`
      SELECT
        mint::text AS mint,
        'pump'::text AS source,
        first_seen_at AS first_seen,
        updated_at AS last_seen,
        NULL::boolean AS routeable,
        0::double precision AS activity_usd,
        COALESCE(liquidity_usd, 0)::double precision AS liquidity_usd
      FROM tokens
      WHERE metadata->>'source' = 'pumpportal'
         OR metadata ? 'pumpportal'
         OR metadata ? 'pump'
    `);
    selects.push(`
      SELECT
        mint::text AS mint,
        'tokens'::text AS source,
        first_seen_at AS first_seen,
        updated_at AS last_seen,
        NULL::boolean AS routeable,
        COALESCE(volume_24h_usd, 0)::double precision AS activity_usd,
        COALESCE(liquidity_usd, 0)::double precision AS liquidity_usd
      FROM tokens
    `);
  }

  if (existing.swaps) {
    selects.push(`
      SELECT
        base_mint::text AS mint,
        CASE WHEN source = 'pumpportal' THEN 'pump' ELSE 'swaps' END::text AS source,
        MIN(block_time) AS first_seen,
        MAX(block_time) AS last_seen,
        NULL::boolean AS routeable,
        COALESCE(SUM(amount_usd), 0)::double precision AS activity_usd,
        0::double precision AS liquidity_usd
      FROM swaps
      GROUP BY base_mint, CASE WHEN source = 'pumpportal' THEN 'pump' ELSE 'swaps' END
    `);
  }

  for (const source of ['raydium', 'meteora', 'orca', 'moonshot']) {
    const tableName = `${source}_pair_snapshots`;
    if (!existing[tableName]) continue;
    const firstSeenExpr = source === 'orca' || source === 'moonshot' ? 'COALESCE(launch_ts, ts)' : 'ts';
    selects.push(`
      SELECT
        base_mint::text AS mint,
        '${source}'::text AS source,
        MIN(${firstSeenExpr}) AS first_seen,
        MAX(ts) AS last_seen,
        NULL::boolean AS routeable,
        MAX(COALESCE(volume_5m, 0))::double precision AS activity_usd,
        MAX(COALESCE(liquidity_usd, 0))::double precision AS liquidity_usd
      FROM ${tableName}
      GROUP BY base_mint
    `);
  }

  if (existing.jupiter_route_snapshots) {
    selects.push(`
      SELECT
        mint::text AS mint,
        'jupiter'::text AS source,
        MIN(ts) AS first_seen,
        MAX(ts) AS last_seen,
        BOOL_OR(routeable) AS routeable,
        MAX(COALESCE(best_out_usd, quote_in_usd, 0))::double precision AS activity_usd,
        0::double precision AS liquidity_usd
      FROM jupiter_route_snapshots
      GROUP BY mint
    `);
  }

  if (existing.direct_lp_events) {
    selects.push(`
      SELECT
        base_mint::text AS mint,
        COALESCE(dex, 'direct_lp')::text AS source,
        MIN(COALESCE(launch_inferred_ts, ts)) AS first_seen,
        MAX(ts) AS last_seen,
        NULL::boolean AS routeable,
        MAX(COALESCE(first_liquidity_usd, 0))::double precision AS activity_usd,
        MAX(COALESCE(first_liquidity_usd, 0))::double precision AS liquidity_usd
      FROM direct_lp_events
      GROUP BY base_mint, COALESCE(dex, 'direct_lp')
    `);
  }

  return selects;
}

function eventUpsertSql(existing) {
  const selects = sourceSelects(existing);
  if (selects.length === 0) return null;

  const featureJoin = existing.rpc_features
    ? `
      LEFT JOIN (
        SELECT
          mint,
          COUNT(DISTINCT feature_type) FILTER (WHERE feature_type = ANY($2)) AS rpc_feature_count,
          MAX(feature_ts) AS last_rpc_feature_ts
        FROM rpc_features
        GROUP BY mint
      ) rf ON rf.mint = r.mint
    `
    : `
      LEFT JOIN (
        SELECT NULL::text AS mint, 0::int AS rpc_feature_count, NULL::timestamptz AS last_rpc_feature_ts
        WHERE false
      ) rf ON false
    `;

  return `
    WITH raw_sources AS (
      ${selects.join('\nUNION ALL\n')}
    ),
    rollup AS (
      SELECT
        mint,
        MIN(first_seen) FILTER (WHERE source = 'pump') AS first_seen_pump,
        MIN(first_seen) FILTER (WHERE source = 'raydium') AS first_seen_raydium,
        MIN(first_seen) FILTER (WHERE source = 'meteora') AS first_seen_meteora,
        MIN(first_seen) FILTER (WHERE source = 'orca') AS first_seen_orca,
        MIN(first_seen) FILTER (WHERE source = 'moonshot') AS first_seen_moonshot,
        MIN(first_seen) FILTER (WHERE source = 'jupiter') AS first_seen_jupiter,
        MAX(last_seen) AS last_seen,
        BOOL_OR(source IN ('raydium', 'meteora', 'orca', 'moonshot')) AS has_dex,
        BOOL_OR(source = 'jupiter' AND routeable IS TRUE) AS has_routeable,
        BOOL_OR(source = 'swaps') AS has_tradeable_swaps,
        MAX(activity_usd) AS max_activity_usd,
        MAX(liquidity_usd) AS max_liquidity_usd,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT source), NULL) AS sources
      FROM raw_sources
      WHERE mint IS NOT NULL AND mint <> ''
      GROUP BY mint
    ),
    recent AS (
      SELECT *
      FROM rollup
      WHERE LEAST(
        COALESCE(first_seen_pump, 'infinity'::timestamptz),
        COALESCE(first_seen_raydium, 'infinity'::timestamptz),
        COALESCE(first_seen_meteora, 'infinity'::timestamptz),
        COALESCE(first_seen_orca, 'infinity'::timestamptz),
        COALESCE(first_seen_moonshot, 'infinity'::timestamptz),
        COALESCE(first_seen_jupiter, 'infinity'::timestamptz)
      ) >= now() - ($1::int * interval '1 hour')
    ),
    scored AS (
      SELECT
        r.*,
        COALESCE(rf.rpc_feature_count, 0) AS rpc_feature_count,
        rf.last_rpc_feature_ts,
        CASE
          WHEN r.first_seen_pump IS NOT NULL
           AND r.has_dex
           AND r.has_routeable
           AND COALESCE(rf.rpc_feature_count, 0) >= cardinality($2::text[])
            THEN 'full_lifecycle'
          WHEN r.has_routeable AND (r.has_tradeable_swaps OR r.max_liquidity_usd >= $3)
            THEN 'routeable_tradeable'
          WHEN r.has_routeable
            THEN 'routeable'
          WHEN r.first_seen_pump IS NOT NULL AND r.has_dex
            THEN 'dex_handoff'
          WHEN r.first_seen_pump IS NOT NULL
            THEN 'pump_only'
          WHEN r.has_dex
            THEN 'dex_direct'
          ELSE 'observed'
        END AS lifecycle_stage,
        LEAST(
          1.0,
          0.15
          + CASE WHEN r.first_seen_pump IS NOT NULL THEN 0.15 ELSE 0 END
          + CASE WHEN r.has_dex THEN 0.25 ELSE 0 END
          + CASE WHEN r.has_routeable THEN 0.20 ELSE 0 END
          + CASE WHEN r.has_tradeable_swaps OR r.max_liquidity_usd >= $3 THEN 0.10 ELSE 0 END
          + LEAST(0.15, 0.15 * COALESCE(rf.rpc_feature_count, 0)::double precision / cardinality($2::text[]))
        ) AS confidence
      FROM recent r
      ${featureJoin}
    )
    INSERT INTO coverage_events (
      mint,
      first_seen_pump,
      first_seen_raydium,
      first_seen_meteora,
      first_seen_orca,
      first_seen_moonshot,
      first_seen_jupiter,
      last_seen,
      lifecycle_stage,
      confidence,
      updated_at
    )
    SELECT
      mint,
      first_seen_pump,
      first_seen_raydium,
      first_seen_meteora,
      first_seen_orca,
      first_seen_moonshot,
      first_seen_jupiter,
      last_seen,
      lifecycle_stage,
      confidence,
      now()
    FROM scored
    ON CONFLICT (mint) DO UPDATE
    SET
      first_seen_pump = CASE
        WHEN coverage_events.first_seen_pump IS NULL THEN EXCLUDED.first_seen_pump
        WHEN EXCLUDED.first_seen_pump IS NULL THEN coverage_events.first_seen_pump
        ELSE LEAST(coverage_events.first_seen_pump, EXCLUDED.first_seen_pump)
      END,
      first_seen_raydium = CASE
        WHEN coverage_events.first_seen_raydium IS NULL THEN EXCLUDED.first_seen_raydium
        WHEN EXCLUDED.first_seen_raydium IS NULL THEN coverage_events.first_seen_raydium
        ELSE LEAST(coverage_events.first_seen_raydium, EXCLUDED.first_seen_raydium)
      END,
      first_seen_meteora = CASE
        WHEN coverage_events.first_seen_meteora IS NULL THEN EXCLUDED.first_seen_meteora
        WHEN EXCLUDED.first_seen_meteora IS NULL THEN coverage_events.first_seen_meteora
        ELSE LEAST(coverage_events.first_seen_meteora, EXCLUDED.first_seen_meteora)
      END,
      first_seen_orca = CASE
        WHEN coverage_events.first_seen_orca IS NULL THEN EXCLUDED.first_seen_orca
        WHEN EXCLUDED.first_seen_orca IS NULL THEN coverage_events.first_seen_orca
        ELSE LEAST(coverage_events.first_seen_orca, EXCLUDED.first_seen_orca)
      END,
      first_seen_moonshot = CASE
        WHEN coverage_events.first_seen_moonshot IS NULL THEN EXCLUDED.first_seen_moonshot
        WHEN EXCLUDED.first_seen_moonshot IS NULL THEN coverage_events.first_seen_moonshot
        ELSE LEAST(coverage_events.first_seen_moonshot, EXCLUDED.first_seen_moonshot)
      END,
      first_seen_jupiter = CASE
        WHEN coverage_events.first_seen_jupiter IS NULL THEN EXCLUDED.first_seen_jupiter
        WHEN EXCLUDED.first_seen_jupiter IS NULL THEN coverage_events.first_seen_jupiter
        ELSE LEAST(coverage_events.first_seen_jupiter, EXCLUDED.first_seen_jupiter)
      END,
      last_seen = GREATEST(COALESCE(coverage_events.last_seen, '-infinity'::timestamptz), COALESCE(EXCLUDED.last_seen, '-infinity'::timestamptz)),
      lifecycle_stage = EXCLUDED.lifecycle_stage,
      confidence = EXCLUDED.confidence,
      updated_at = now()
    RETURNING mint, lifecycle_stage, confidence
  `;
}

async function loadExistingTables() {
  const names = [
    'tokens',
    'swaps',
    'raydium_pair_snapshots',
    'meteora_pair_snapshots',
    'orca_pair_snapshots',
    'moonshot_pair_snapshots',
    'jupiter_route_snapshots',
    'direct_lp_events',
    'rpc_tasks',
    'rpc_features',
  ];
  const entries = await Promise.all(names.map(async (name) => [name, await tableExists(name)]));
  return Object.fromEntries(entries);
}

async function upsertCoverageEvents(existing) {
  const sql = eventUpsertSql(existing);
  if (!sql) {
    log('warn', 'no source tables available for coverage scan');
    return 0;
  }

  if (DRY_RUN) {
    log('info', 'dry run: skipping coverage_events upsert');
    return 0;
  }

  const res = await pool.query(sql, [LOOKBACK_HOURS, RPC_FEATURES, MIN_LIQUIDITY_USD]);
  return Number(res.rowCount ?? 0);
}

function gapsSql(existing) {
  const rpcFeatureJoin = existing.rpc_features
    ? `
      LEFT JOIN (
        SELECT mint, ARRAY_AGG(DISTINCT feature_type) AS available_features
        FROM rpc_features
        WHERE feature_type = ANY($2)
        GROUP BY mint
      ) rf ON rf.mint = b.mint
    `
    : `
      LEFT JOIN (
        SELECT NULL::text AS mint, ARRAY[]::text[] AS available_features
        WHERE false
      ) rf ON false
    `;

  const tradeableJoin = existing.swaps
    ? `
      LEFT JOIN (
        SELECT base_mint AS mint, MIN(block_time) AS first_trade_ts, COUNT(*) AS trade_rows
        FROM swaps
        WHERE block_time >= now() - ($1::int * interval '1 hour')
        GROUP BY base_mint
      ) tr ON tr.mint = b.mint
    `
    : `
      LEFT JOIN (
        SELECT NULL::text AS mint, NULL::timestamptz AS first_trade_ts, 0::bigint AS trade_rows
        WHERE false
      ) tr ON false
    `;

  const routeJoin = existing.jupiter_route_snapshots
    ? `
      LEFT JOIN (
        SELECT mint, MIN(ts) FILTER (WHERE routeable) AS first_routeable_ts
        FROM jupiter_route_snapshots
        WHERE ts >= now() - ($1::int * interval '1 hour')
        GROUP BY mint
      ) jr ON jr.mint = b.mint
    `
    : `
      LEFT JOIN (
        SELECT NULL::text AS mint, NULL::timestamptz AS first_routeable_ts
        WHERE false
      ) jr ON false
    `;

  return `
    WITH base AS (
      SELECT
        ce.*,
        LEAST(
          COALESCE(first_seen_pump, 'infinity'::timestamptz),
          COALESCE(first_seen_raydium, 'infinity'::timestamptz),
          COALESCE(first_seen_meteora, 'infinity'::timestamptz),
          COALESCE(first_seen_orca, 'infinity'::timestamptz),
          COALESCE(first_seen_moonshot, 'infinity'::timestamptz),
          COALESCE(first_seen_jupiter, 'infinity'::timestamptz)
        ) AS first_seen_any,
        LEAST(
          COALESCE(first_seen_raydium, 'infinity'::timestamptz),
          COALESCE(first_seen_meteora, 'infinity'::timestamptz),
          COALESCE(first_seen_orca, 'infinity'::timestamptz),
          COALESCE(first_seen_moonshot, 'infinity'::timestamptz)
        ) AS first_seen_dex,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN first_seen_pump IS NOT NULL THEN 'pump' END,
          CASE WHEN first_seen_raydium IS NOT NULL THEN 'raydium' END,
          CASE WHEN first_seen_meteora IS NOT NULL THEN 'meteora' END,
          CASE WHEN first_seen_orca IS NOT NULL THEN 'orca' END,
          CASE WHEN first_seen_moonshot IS NOT NULL THEN 'moonshot' END,
          CASE WHEN first_seen_jupiter IS NOT NULL THEN 'jupiter' END
        ], NULL) AS sources
      FROM coverage_events ce
      WHERE ce.updated_at >= now() - ($1::int * interval '1 hour')
    ),
    enriched AS (
      SELECT
        b.*,
        COALESCE(rf.available_features, ARRAY[]::text[]) AS available_features,
        (
          SELECT ARRAY_AGG(f)
          FROM UNNEST($2::text[]) f
          WHERE NOT f = ANY(COALESCE(rf.available_features, ARRAY[]::text[]))
        ) AS missing_features,
        jr.first_routeable_ts,
        tr.first_trade_ts,
        COALESCE(tr.trade_rows, 0) AS trade_rows
      FROM base b
      ${rpcFeatureJoin}
      ${routeJoin}
      ${tradeableJoin}
    ),
    gaps AS (
      SELECT
        $3::timestamptz AS ts,
        mint,
        'no_data_0_2m'::text AS gap_type,
        'critical'::text AS severity,
        jsonb_build_object(
          'first_seen_pump', first_seen_pump,
          'age_minutes', EXTRACT(EPOCH FROM (now() - first_seen_pump)) / 60.0,
          'sources', sources
        ) AS details_json
      FROM enriched
      WHERE first_seen_pump IS NOT NULL
        AND first_seen_pump <= now() - ($4::int * interval '1 minute')
        AND first_seen_dex = 'infinity'::timestamptz
        AND first_seen_jupiter IS NULL
        AND COALESCE(array_length(available_features, 1), 0) = 0

      UNION ALL
      SELECT
        $3::timestamptz,
        mint,
        'pump_only_no_handoff',
        'high',
        jsonb_build_object(
          'first_seen_pump', first_seen_pump,
          'minutes_without_handoff', EXTRACT(EPOCH FROM (now() - first_seen_pump)) / 60.0,
          'sources', sources
        )
      FROM enriched
      WHERE first_seen_pump IS NOT NULL
        AND first_seen_pump <= now() - ($5::int * interval '1 minute')
        AND first_seen_dex = 'infinity'::timestamptz

      UNION ALL
      SELECT
        $3::timestamptz,
        mint,
        'source_switch_without_followup',
        'high',
        jsonb_build_object(
          'first_seen_pump', first_seen_pump,
          'first_seen_dex', first_seen_dex,
          'first_seen_jupiter', first_seen_jupiter,
          'available_features', available_features,
          'missing_features', COALESCE(missing_features, ARRAY[]::text[]),
          'sources', sources
        )
      FROM enriched
      WHERE first_seen_pump IS NOT NULL
        AND first_seen_dex <> 'infinity'::timestamptz
        AND first_seen_dex <= now() - ($6::int * interval '1 minute')
        AND (first_seen_jupiter IS NULL OR first_seen_jupiter < first_seen_dex)
        AND COALESCE(array_length(available_features, 1), 0) = 0

      UNION ALL
      SELECT
        $3::timestamptz,
        mint,
        'routeable_but_not_tradeable',
        'medium',
        jsonb_build_object(
          'first_routeable_ts', first_routeable_ts,
          'first_trade_ts', first_trade_ts,
          'trade_rows', trade_rows,
          'sources', sources
        )
      FROM enriched
      WHERE first_routeable_ts IS NOT NULL
        AND first_routeable_ts <= now() - ($7::int * interval '1 minute')
        AND trade_rows = 0

      UNION ALL
      SELECT
        $3::timestamptz,
        mint,
        'no_wallet_enrichment',
        'high',
        jsonb_build_object(
          'available_features', available_features,
          'missing_features', COALESCE(missing_features, ARRAY[]::text[]),
          'lifecycle_stage', lifecycle_stage,
          'sources', sources
        )
      FROM enriched
      WHERE first_seen_any <= now() - ($8::int * interval '1 minute')
        AND (
          lifecycle_stage IN ('dex_handoff', 'routeable', 'routeable_tradeable', 'full_lifecycle')
          OR first_seen_dex <> 'infinity'::timestamptz
          OR first_seen_jupiter IS NOT NULL
        )
        AND COALESCE(array_length(missing_features, 1), 0) > 0
    )
    INSERT INTO coverage_gaps (ts, mint, gap_type, severity, details_json)
    SELECT ts, mint, gap_type, severity, details_json
    FROM gaps
ON CONFLICT (ts, mint, gap_type) DO NOTHING
    RETURNING mint, gap_type, severity, details_json
  `;
}

async function insertGaps(existing, bucketTs) {
  if (DRY_RUN) {
    log('info', 'dry run: skipping coverage_gaps insert');
    return [];
  }

  const res = await pool.query(gapsSql(existing), [
    LOOKBACK_HOURS,
    RPC_FEATURES,
    bucketTs,
    NO_DATA_GRACE_MINUTES,
    HANDOFF_GRACE_MINUTES,
    FOLLOWUP_GRACE_MINUTES,
    TRADEABLE_GRACE_MINUTES,
    ENRICHMENT_GRACE_MINUTES,
  ]);
  return res.rows;
}

function missingFeaturesFromGap(gap) {
  const details = gap.details_json ?? {};
  if (Array.isArray(details.missing_features) && details.missing_features.length > 0) {
    return details.missing_features.filter((feature) => RPC_FEATURES.includes(feature));
  }
  if (
    gap.gap_type === 'no_wallet_enrichment' ||
    gap.gap_type === 'source_switch_without_followup' ||
    gap.gap_type === 'routeable_but_not_tradeable'
  ) {
    return RPC_FEATURES;
  }
  return [];
}

async function enqueueMissingRpcFeatures(existing, gaps) {
  if (!existing.rpc_tasks || gaps.length === 0) return 0;
  if (DRY_RUN) {
    log('info', 'dry run: skipping rpc_tasks enqueue');
    return 0;
  }

  let enqueued = 0;
  const seen = new Set();
  for (const gap of gaps) {
    for (const feature of missingFeaturesFromGap(gap)) {
      const key = `${gap.mint}:${feature}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const res = await pool.query(
        `INSERT INTO rpc_tasks (mint, feature_type, priority, not_before)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [gap.mint, feature, RPC_TASK_PRIORITY],
      );
      enqueued += Number(res.rowCount ?? 0);
    }
  }
  return enqueued;
}

async function loadKpi(bucketTs) {
  const { rows } = await pool.query(
    `
      WITH recent_events AS (
        SELECT *
        FROM coverage_events
        WHERE updated_at >= now() - ($1::int * interval '1 hour')
      ),
      recent_gaps AS (
        SELECT *
        FROM coverage_gaps
        WHERE ts = $2
      ),
      totals AS (
        SELECT
          COUNT(*) AS mints,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'full_lifecycle') AS full_lifecycle_mints
        FROM recent_events
      ),
      stage_gaps AS (
        SELECT
          ce.lifecycle_stage,
          COUNT(DISTINCT ce.mint) AS stage_mints,
          COUNT(DISTINCT ce.mint) FILTER (WHERE rg.mint IS NOT NULL) AS gap_mints
        FROM recent_events ce
        LEFT JOIN recent_gaps rg ON rg.mint = ce.mint
        GROUP BY ce.lifecycle_stage
      ),
      top_gaps AS (
        SELECT
          gap_type,
          COUNT(DISTINCT mint) AS impacted_mints,
          SUM(CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS impact
        FROM recent_gaps
        GROUP BY gap_type
        ORDER BY impact DESC, impacted_mints DESC
        LIMIT 5
      )
      SELECT jsonb_build_object(
        'window_hours', $1,
        'mint_count', COALESCE((SELECT mints FROM totals), 0),
        'full_lifecycle_pct', ROUND(
          100.0 * COALESCE((SELECT full_lifecycle_mints FROM totals), 0)::numeric
          / NULLIF((SELECT mints FROM totals), 0),
          2
        ),
        'gap_pct_by_stage', COALESCE((
          SELECT jsonb_object_agg(
            lifecycle_stage,
            jsonb_build_object(
              'stage_mints', stage_mints,
              'gap_mints', gap_mints,
              'gap_pct', ROUND(100.0 * gap_mints::numeric / NULLIF(stage_mints, 0), 2)
            )
          )
          FROM stage_gaps
        ), '{}'::jsonb),
        'top_gap_types_by_impact', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('gap_type', gap_type, 'impacted_mints', impacted_mints, 'impact', impact)
            ORDER BY impact DESC, impacted_mints DESC
          )
          FROM top_gaps
        ), '[]'::jsonb)
      ) AS kpi
    `,
    [LOOKBACK_HOURS, bucketTs],
  );
  return rows[0]?.kpi ?? {};
}

async function runTickGuarded() {
  if (isTickRunning) {
    log('warn', 'skipping tick, previous scan still active');
    return;
  }

  isTickRunning = true;
  const startedAt = Date.now();
  const bucketTs = getMinuteBucketUtc();

  try {
    await ensureSchema();
    const existing = await loadExistingTables();
    const coverageRows = await upsertCoverageEvents(existing);
    const gaps = await insertGaps(existing, bucketTs);
    const rpcTasksEnqueued = await enqueueMissingRpcFeatures(existing, gaps);
    const kpi = await loadKpi(bucketTs);

    ticksTotal += 1;
    log('info', 'coverage scan completed', {
      bucketTs: bucketTs.toISOString(),
      coverageRows,
      gapsInserted: gaps.length,
      rpcTasksEnqueued,
      kpi,
      dryRun: DRY_RUN,
      elapsedMs: Date.now() - startedAt,
      ticksTotal,
      errorsTotal,
    });
  } catch (error) {
    errorsTotal += 1;
    log('error', 'coverage scan failed', {
      error: String(error?.stack || error),
      elapsedMs: Date.now() - startedAt,
      ticksTotal,
      errorsTotal,
    });
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
  log('info', 'guardian start', {
    lookbackHours: LOOKBACK_HOURS,
    intervalMs: INTERVAL_MS,
    once: ONCE,
    dryRun: DRY_RUN,
    rpcTaskPriority: RPC_TASK_PRIORITY,
    rpcFeatures: RPC_FEATURES,
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
  log('error', 'fatal error', { error: String(error?.stack || error) });
  process.exit(1);
});
