-- Moonshot collector validation queries
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/moonshot-checks.sql

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
FROM moonshot_pair_snapshots
WHERE ts >= now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;

-- 2) top active pairs in last 1h
SELECT
  pair_address,
  MIN(ts) AS first_seen_1h,
  MAX(ts) AS last_seen_1h,
  COUNT(*) AS snapshots_1h
FROM moonshot_pair_snapshots
WHERE ts >= now() - interval '1 hour'
GROUP BY pair_address
ORDER BY snapshots_1h DESC, last_seen_1h DESC
LIMIT 100;

-- 3) stale/null field quality checks (last 24h)
SELECT
  COUNT(*) AS rows_last_24h,
  COUNT(*) FILTER (WHERE pair_address IS NULL OR pair_address = '') AS bad_pair_address,
  COUNT(*) FILTER (WHERE base_mint IS NULL OR base_mint = '') AS bad_base_mint,
  COUNT(*) FILTER (WHERE quote_mint IS NULL OR quote_mint = '') AS bad_quote_mint,
  COUNT(*) FILTER (WHERE price_usd IS NULL OR price_usd <= 0) AS bad_price_usd,
  COUNT(*) FILTER (WHERE liquidity_usd IS NULL OR liquidity_usd < 0) AS bad_liquidity_usd,
  COUNT(*) FILTER (WHERE launch_ts IS NULL) AS null_launch_ts
FROM moonshot_pair_snapshots
WHERE ts >= now() - interval '24 hours';

-- 4) freshness lag (global + per pair)
SELECT
  now() - MAX(ts) AS global_freshness_lag,
  MAX(ts) AS latest_snapshot_ts
FROM moonshot_pair_snapshots;

SELECT
  pair_address,
  MAX(ts) AS last_ts,
  now() - MAX(ts) AS lag
FROM moonshot_pair_snapshots
GROUP BY pair_address
HAVING MAX(ts) < now() - interval '2 hours'
ORDER BY lag DESC
LIMIT 100;

-- 5) duplicate guard: must be zero with (pair_address, ts) unique
SELECT
  pair_address,
  ts,
  COUNT(*) AS duplicate_rows
FROM moonshot_pair_snapshots
GROUP BY pair_address, ts
HAVING COUNT(*) > 1
ORDER BY duplicate_rows DESC, ts DESC;

-- 6) rpc feature coverage for Moonshot shortlist mints (last 3h)
WITH shortlist AS (
  SELECT DISTINCT base_mint AS mint
  FROM moonshot_pair_snapshots
  WHERE ts >= now() - interval '3 hours'
),
features AS (
  SELECT
    mint,
    feature_type,
    MAX(feature_ts) AS latest_feature_ts
  FROM rpc_features
  WHERE mint IN (SELECT mint FROM shortlist)
    AND feature_type IN ('holders', 'largest_accounts', 'authorities', 'tx_burst')
  GROUP BY mint, feature_type
),
feature_counts AS (
  SELECT
    mint,
    COUNT(*) AS features_present
  FROM features
  GROUP BY mint
)
SELECT
  (SELECT COUNT(*) FROM shortlist) AS shortlisted_mints_3h,
  (SELECT COUNT(*) FROM features) AS rpc_feature_rows_3h,
  (SELECT COUNT(DISTINCT mint) FROM features) AS rpc_featured_mints_3h,
  COUNT(*) FILTER (WHERE features_present >= 1) AS mints_with_any_feature,
  COUNT(*) FILTER (WHERE features_present = 4) AS mints_with_full_feature_set
FROM feature_counts;
