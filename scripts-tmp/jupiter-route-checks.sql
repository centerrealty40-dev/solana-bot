-- Jupiter route watcher validation and mini-analytics.
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/jupiter-route-checks.sql

-- 1) routeable ratio last 1h / 24h
SELECT
  window,
  snapshots,
  unique_mints,
  routeable_snapshots,
  ROUND(routeable_snapshots::numeric / NULLIF(snapshots, 0), 4) AS routeable_ratio
FROM (
  SELECT
    'last_1h' AS window,
    COUNT(*) AS snapshots,
    COUNT(DISTINCT mint) AS unique_mints,
    COUNT(*) FILTER (WHERE routeable) AS routeable_snapshots
  FROM jupiter_route_snapshots
  WHERE ts >= now() - interval '1 hour'
  UNION ALL
  SELECT
    'last_24h' AS window,
    COUNT(*) AS snapshots,
    COUNT(DISTINCT mint) AS unique_mints,
    COUNT(*) FILTER (WHERE routeable) AS routeable_snapshots
  FROM jupiter_route_snapshots
  WHERE ts >= now() - interval '24 hours'
) x
ORDER BY window;

-- 2) unique mints checked
SELECT
  COUNT(DISTINCT mint) FILTER (WHERE ts >= now() - interval '1 hour') AS unique_mints_1h,
  COUNT(DISTINCT mint) FILTER (WHERE ts >= now() - interval '24 hours') AS unique_mints_24h,
  MIN(ts) AS first_snapshot_ts,
  MAX(ts) AS latest_snapshot_ts
FROM jupiter_route_snapshots;

-- 3) top mints by best_out_usd
SELECT
  mint,
  MAX(best_out_usd) AS max_best_out_usd_24h,
  AVG(best_out_usd) FILTER (WHERE routeable) AS avg_best_out_usd_when_routeable,
  COUNT(*) FILTER (WHERE routeable) AS routeable_snapshots_24h,
  MAX(ts) AS latest_ts
FROM jupiter_route_snapshots
WHERE ts >= now() - interval '24 hours'
GROUP BY mint
ORDER BY max_best_out_usd_24h DESC NULLS LAST
LIMIT 25;

-- 4a) stale/null checks
SELECT
  COUNT(*) AS rows_24h,
  COUNT(*) FILTER (WHERE mint IS NULL OR mint = '') AS bad_mint,
  COUNT(*) FILTER (WHERE routeable AND (best_out_usd IS NULL OR best_out_usd <= 0)) AS routeable_without_out_usd,
  COUNT(*) FILTER (WHERE quote_in_usd IS NULL OR quote_in_usd <= 0) AS bad_quote_in_usd,
  COUNT(*) FILTER (WHERE hops IS NOT NULL AND hops < 0) AS bad_hops,
  MAX(ts) AS latest_ts,
  now() - MAX(ts) AS latest_lag
FROM jupiter_route_snapshots
WHERE ts >= now() - interval '24 hours';

-- 4b) duplicate rows by mint/minute bucket; should be zero due to unique index
SELECT
  mint,
  ts,
  COUNT(*) AS duplicate_rows
FROM jupiter_route_snapshots
GROUP BY mint, ts
HAVING COUNT(*) > 1
ORDER BY duplicate_rows DESC, ts DESC;

-- 5) routeable vs non-routeable rug-like proxy
-- Proxy: token first seen > 30m ago, checked at least twice in 24h, never routeable.
WITH per_mint AS (
  SELECT
    j.mint,
    MIN(j.ts) AS first_checked_at,
    MAX(j.ts) AS last_checked_at,
    COUNT(*) AS checks_24h,
    BOOL_OR(j.routeable) AS ever_routeable_24h,
    MAX(j.best_out_usd) AS max_best_out_usd_24h,
    MIN(t.first_seen_at) AS first_seen_at
  FROM jupiter_route_snapshots j
  LEFT JOIN tokens t ON t.mint = j.mint
  WHERE j.ts >= now() - interval '24 hours'
  GROUP BY j.mint
)
SELECT
  ever_routeable_24h,
  COUNT(*) AS mints,
  COUNT(*) FILTER (
    WHERE checks_24h >= 2
      AND COALESCE(first_seen_at, first_checked_at) <= now() - interval '30 minutes'
      AND NOT ever_routeable_24h
  ) AS rug_like_proxy_mints,
  ROUND(
    COUNT(*) FILTER (
      WHERE checks_24h >= 2
        AND COALESCE(first_seen_at, first_checked_at) <= now() - interval '30 minutes'
        AND NOT ever_routeable_24h
    )::numeric / NULLIF(COUNT(*), 0),
    4
  ) AS rug_like_proxy_rate
FROM per_mint
GROUP BY ever_routeable_24h
ORDER BY ever_routeable_24h DESC;

-- 6) routeability lag after first_seen
WITH first_routeable AS (
  SELECT
    mint,
    MIN(ts) AS first_routeable_ts
  FROM jupiter_route_snapshots
  WHERE routeable
  GROUP BY mint
),
first_seen AS (
  SELECT mint, first_seen_at FROM tokens
  UNION
  SELECT base_mint AS mint, MIN(block_time) AS first_seen_at
  FROM swaps
  GROUP BY base_mint
)
SELECT
  COUNT(*) AS routeable_mints_with_first_seen,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (fr.first_routeable_ts - fs.first_seen_at)) / 60.0
  ) AS p50_minutes_to_routeable,
  percentile_cont(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (fr.first_routeable_ts - fs.first_seen_at)) / 60.0
  ) AS p90_minutes_to_routeable,
  AVG(EXTRACT(EPOCH FROM (fr.first_routeable_ts - fs.first_seen_at)) / 60.0) AS avg_minutes_to_routeable
FROM first_routeable fr
JOIN first_seen fs ON fs.mint = fr.mint
WHERE fs.first_seen_at <= fr.first_routeable_ts;
