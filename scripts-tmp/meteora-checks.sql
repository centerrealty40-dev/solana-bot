-- Meteora collector validation queries
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/Meteora-checks.sql

-- 1) pairs discovered last 1h
SELECT
  pair_address,
  MIN(ts) AS first_seen_1h,
  MAX(ts) AS last_seen_1h,
  COUNT(*) AS snapshots_1h
FROM meteora_pair_snapshots
WHERE ts >= now() - interval '1 hour'
GROUP BY pair_address
ORDER BY last_seen_1h DESC, snapshots_1h DESC;

-- 2) snapshots last 1h
SELECT
  COUNT(*) AS snapshots_last_1h,
  COUNT(DISTINCT pair_address) AS unique_pairs_last_1h,
  MIN(ts) AS oldest_ts_1h,
  MAX(ts) AS newest_ts_1h
FROM meteora_pair_snapshots
WHERE ts >= now() - interval '1 hour';

-- 3) unique base_mints last 24h
SELECT
  COUNT(DISTINCT base_mint) AS unique_base_mints_last_24h
FROM meteora_pair_snapshots
WHERE ts >= now() - interval '24 hours';

-- 4a) quality check: key fields null-rates for last 24h
SELECT
  COUNT(*) AS rows_last_24h,
  COUNT(*) FILTER (WHERE pair_address IS NULL OR pair_address = '') AS bad_pair_address,
  COUNT(*) FILTER (WHERE base_mint IS NULL OR base_mint = '') AS bad_base_mint,
  COUNT(*) FILTER (WHERE quote_mint IS NULL OR quote_mint = '') AS bad_quote_mint,
  COUNT(*) FILTER (WHERE price_usd IS NULL OR price_usd <= 0) AS bad_price_usd,
  COUNT(*) FILTER (WHERE liquidity_usd IS NULL OR liquidity_usd < 0) AS bad_liquidity_usd
FROM meteora_pair_snapshots
WHERE ts >= now() - interval '24 hours';

-- 4b) quality check: stale pairs (no update in 2h)
SELECT
  pair_address,
  MAX(ts) AS last_ts,
  now() - MAX(ts) AS lag
FROM meteora_pair_snapshots
GROUP BY pair_address
HAVING MAX(ts) < now() - interval '2 hours'
ORDER BY last_ts DESC;

-- 4c) quality check: duplicate rows by pair/minute (should be zero due to unique key)
SELECT
  pair_address,
  ts,
  COUNT(*) AS duplicate_rows
FROM meteora_pair_snapshots
GROUP BY pair_address, ts
HAVING COUNT(*) > 1
ORDER BY duplicate_rows DESC, ts DESC;
