-- Orca collector validation queries
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/orca-checks.sql

-- 1) snapshots freshness and volume (last 1h / 24h)
SELECT
  CASE
    WHEN ts >= now() - interval '1 hour' THEN 'last_1h'
    ELSE 'last_24h'
  END AS window,
  COUNT(*) AS snapshots,
  COUNT(DISTINCT pair_address) AS unique_pairs,
  COUNT(DISTINCT base_mint) AS unique_base_mints,
  MIN(ts) AS oldest_ts,
  MAX(ts) AS newest_ts
FROM orca_pair_snapshots
WHERE ts >= now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;

-- 2) unique pairs/mints in last 24h
SELECT
  COUNT(DISTINCT pair_address) AS unique_pairs_last_24h,
  COUNT(DISTINCT base_mint) AS unique_base_mints_last_24h,
  COUNT(DISTINCT quote_mint) AS unique_quote_mints_last_24h
FROM orca_pair_snapshots
WHERE ts >= now() - interval '24 hours';

-- 3) top active pairs in last 1h
SELECT
  pair_address,
  base_mint,
  MIN(ts) AS first_seen_1h,
  MAX(ts) AS last_seen_1h,
  COUNT(*) AS snapshots_1h,
  MAX(liquidity_usd) AS max_liquidity_usd,
  MAX(volume_5m) AS max_volume_5m
FROM orca_pair_snapshots
WHERE ts >= now() - interval '1 hour'
GROUP BY pair_address, base_mint
ORDER BY snapshots_1h DESC, max_volume_5m DESC NULLS LAST, last_seen_1h DESC
LIMIT 100;

-- 4) stale/null field quality checks (last 24h)
SELECT
  COUNT(*) AS rows_last_24h,
  COUNT(*) FILTER (WHERE pair_address IS NULL OR pair_address = '') AS bad_pair_address,
  COUNT(*) FILTER (WHERE base_mint IS NULL OR base_mint = '') AS bad_base_mint,
  COUNT(*) FILTER (WHERE quote_mint IS NULL OR quote_mint = '') AS bad_quote_mint,
  COUNT(*) FILTER (WHERE price_usd IS NULL OR price_usd <= 0) AS bad_price_usd,
  COUNT(*) FILTER (WHERE liquidity_usd IS NULL OR liquidity_usd < 0) AS bad_liquidity_usd,
  COUNT(*) FILTER (WHERE launch_ts IS NULL) AS null_launch_ts
FROM orca_pair_snapshots
WHERE ts >= now() - interval '24 hours';

-- 5) freshness lag (global + stale pairs)
SELECT
  now() - MAX(ts) AS global_freshness_lag,
  MAX(ts) AS latest_snapshot_ts
FROM orca_pair_snapshots;

SELECT
  pair_address,
  MAX(ts) AS last_ts,
  now() - MAX(ts) AS lag
FROM orca_pair_snapshots
GROUP BY pair_address
HAVING MAX(ts) < now() - interval '2 hours'
ORDER BY lag DESC
LIMIT 100;

-- 6) duplicate guard: must be zero with (pair_address, ts) unique
SELECT
  pair_address,
  ts,
  COUNT(*) AS duplicate_rows
FROM orca_pair_snapshots
GROUP BY pair_address, ts
HAVING COUNT(*) > 1
ORDER BY duplicate_rows DESC, ts DESC;

-- 7) rpc feature coverage for Orca shortlist mints (last 3h)
WITH shortlist AS (
  SELECT DISTINCT base_mint AS mint
  FROM orca_pair_snapshots
  WHERE ts >= now() - interval '3 hours'
    AND liquidity_usd >= 20000
    AND volume_5m >= 2000
),
tasks AS (
  SELECT
    mint,
    feature_type,
    status
  FROM rpc_tasks
  WHERE mint IN (SELECT mint FROM shortlist)
    AND feature_type IN ('holders', 'largest_accounts', 'authorities', 'tx_burst')
),
features AS (
  SELECT DISTINCT
    mint,
    feature_type
  FROM rpc_features
  WHERE mint IN (SELECT mint FROM shortlist)
    AND feature_type IN ('holders', 'largest_accounts', 'authorities', 'tx_burst')
)
SELECT
  (SELECT COUNT(*) FROM shortlist) AS shortlisted_mints_3h,
  COUNT(*) FILTER (WHERE t.status = 'queued') AS rpc_tasks_queued,
  COUNT(*) FILTER (WHERE t.status = 'processing') AS rpc_tasks_processing,
  COUNT(*) FILTER (WHERE t.status = 'done') AS rpc_tasks_done,
  COUNT(*) FILTER (WHERE t.status = 'failed') AS rpc_tasks_failed,
  (SELECT COUNT(*) FROM features) AS rpc_feature_rows,
  (SELECT COUNT(DISTINCT mint) FROM features) AS rpc_featured_mints
FROM tasks t;
