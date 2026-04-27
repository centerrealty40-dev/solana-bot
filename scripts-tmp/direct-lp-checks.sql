-- Direct LP detector validation and mini-analytics.
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/direct-lp-checks.sql

-- 1) events last 1h / 24h
SELECT
  window,
  events,
  unique_mints,
  unique_pairs,
  AVG(confidence) AS avg_confidence,
  MAX(ts) AS latest_event_ts
FROM (
  SELECT
    'last_1h' AS window,
    COUNT(*) AS events,
    COUNT(DISTINCT base_mint) AS unique_mints,
    COUNT(DISTINCT pair_address) AS unique_pairs,
    AVG(confidence) AS confidence,
    MAX(ts) AS ts
  FROM direct_lp_events
  WHERE ts >= now() - interval '1 hour'
  UNION ALL
  SELECT
    'last_24h' AS window,
    COUNT(*) AS events,
    COUNT(DISTINCT base_mint) AS unique_mints,
    COUNT(DISTINCT pair_address) AS unique_pairs,
    AVG(confidence) AS confidence,
    MAX(ts) AS ts
  FROM direct_lp_events
  WHERE ts >= now() - interval '24 hours'
) x
GROUP BY window, events, unique_mints, unique_pairs
ORDER BY window;

-- 2) unique direct_lp mints by dex
SELECT
  dex,
  COUNT(DISTINCT base_mint) AS unique_direct_lp_mints,
  COUNT(DISTINCT pair_address) AS unique_pairs,
  MIN(launch_inferred_ts) AS first_launch_inferred_ts,
  MAX(launch_inferred_ts) AS latest_launch_inferred_ts
FROM direct_lp_events
WHERE ts >= now() - interval '24 hours'
GROUP BY dex
ORDER BY unique_direct_lp_mints DESC, dex;

-- 3) overlap with pumpportal tokens / swaps
WITH direct_mints AS (
  SELECT DISTINCT base_mint
  FROM direct_lp_events
  WHERE ts >= now() - interval '24 hours'
),
pumpportal_mints AS (
  SELECT mint AS base_mint
  FROM tokens
  WHERE metadata->>'source' = 'pumpportal'
  UNION
  SELECT base_mint
  FROM swaps
  WHERE source = 'pumpportal'
    AND block_time >= now() - interval '7 days'
)
SELECT
  COUNT(*) AS direct_lp_mints_24h,
  COUNT(*) FILTER (WHERE p.base_mint IS NOT NULL) AS overlap_with_pumpportal,
  ROUND(
    COUNT(*) FILTER (WHERE p.base_mint IS NOT NULL)::numeric / NULLIF(COUNT(*), 0),
    4
  ) AS overlap_ratio
FROM direct_mints d
LEFT JOIN pumpportal_mints p ON p.base_mint = d.base_mint;

-- 4) top events by liquidity/confidence
SELECT
  ts,
  dex,
  base_mint,
  quote_mint,
  pair_address,
  first_price_usd,
  first_liquidity_usd,
  confidence,
  reason
FROM direct_lp_events
WHERE ts >= now() - interval '24 hours'
ORDER BY first_liquidity_usd DESC NULLS LAST, confidence DESC NULLS LAST, ts DESC
LIMIT 25;

-- 5) RPC task coverage for new direct_lp mints
WITH direct_mints AS (
  SELECT DISTINCT base_mint AS mint
  FROM direct_lp_events
  WHERE ts >= now() - interval '24 hours'
),
tasks AS (
  SELECT mint, feature_type, status
  FROM rpc_tasks
  WHERE mint IN (SELECT mint FROM direct_mints)
    AND created_at >= now() - interval '24 hours'
),
features AS (
  SELECT mint, feature_type, MAX(feature_ts) AS latest_feature_ts
  FROM rpc_features
  WHERE mint IN (SELECT mint FROM direct_mints)
    AND feature_ts >= now() - interval '24 hours'
  GROUP BY mint, feature_type
)
SELECT
  (SELECT COUNT(*) FROM direct_mints) AS direct_lp_mints_24h,
  (SELECT COUNT(*) FROM tasks) AS rpc_tasks_24h,
  (SELECT COUNT(*) FROM tasks WHERE status = 'queued') AS rpc_tasks_queued_24h,
  (SELECT COUNT(*) FROM tasks WHERE status = 'processing') AS rpc_tasks_processing_24h,
  (SELECT COUNT(*) FROM tasks WHERE status = 'done') AS rpc_tasks_done_24h,
  (SELECT COUNT(*) FROM tasks WHERE status = 'failed') AS rpc_tasks_failed_24h,
  (SELECT COUNT(*) FROM features) AS rpc_features_24h,
  (SELECT COUNT(DISTINCT mint) FROM features) AS rpc_featured_mints_24h;

-- 6) mini-analytics: how many direct_lp mints later became routeable_strict
-- routeable_strict proxy: routeable=true, non-empty route, and estimated price impact <= 300 bps when present.
WITH first_direct AS (
  SELECT base_mint, MIN(launch_inferred_ts) AS launch_ts
  FROM direct_lp_events
  GROUP BY base_mint
),
first_strict AS (
  SELECT
    j.mint AS base_mint,
    MIN(j.ts) AS first_routeable_strict_ts
  FROM jupiter_route_snapshots j
  JOIN first_direct d ON d.base_mint = j.mint
  WHERE j.ts >= d.launch_ts
    AND j.routeable
    AND COALESCE(j.hops, 0) > 0
    AND COALESCE(j.estimated_slippage_bps, 0) <= 300
  GROUP BY j.mint
)
SELECT
  COUNT(*) AS direct_lp_mints_total,
  COUNT(*) FILTER (WHERE s.first_routeable_strict_ts IS NOT NULL) AS later_routeable_strict_mints,
  ROUND(
    COUNT(*) FILTER (WHERE s.first_routeable_strict_ts IS NOT NULL)::numeric / NULLIF(COUNT(*), 0),
    4
  ) AS later_routeable_strict_ratio,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (s.first_routeable_strict_ts - d.launch_ts)) / 60.0
  ) FILTER (WHERE s.first_routeable_strict_ts IS NOT NULL) AS p50_minutes_to_routeable_strict,
  percentile_cont(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (s.first_routeable_strict_ts - d.launch_ts)) / 60.0
  ) FILTER (WHERE s.first_routeable_strict_ts IS NOT NULL) AS p90_minutes_to_routeable_strict
FROM first_direct d
LEFT JOIN first_strict s ON s.base_mint = d.base_mint;

-- 7) rug-like / runner-like proxy over first 6 hours.
WITH params AS (
  SELECT 6 AS hours_n
),
all_snapshots AS (
  SELECT ts, base_mint, liquidity_usd, volume_5m, buys_5m, sells_5m FROM raydium_pair_snapshots
  UNION ALL
  SELECT ts, base_mint, liquidity_usd, volume_5m, buys_5m, sells_5m FROM meteora_pair_snapshots
  UNION ALL
  SELECT ts, base_mint, liquidity_usd, volume_5m, buys_5m, sells_5m FROM orca_pair_snapshots
),
first_direct AS (
  SELECT
    base_mint,
    MIN(launch_inferred_ts) AS launch_ts,
    MAX(first_liquidity_usd) FILTER (WHERE first_liquidity_usd IS NOT NULL) AS first_liquidity_usd
  FROM direct_lp_events
  GROUP BY base_mint
),
window_metrics AS (
  SELECT
    d.base_mint,
    d.launch_ts,
    d.first_liquidity_usd,
    MAX(s.liquidity_usd) AS max_liquidity_usd_nh,
    MAX(s.volume_5m) AS max_volume_5m_nh,
    MAX(COALESCE(s.buys_5m, 0) + COALESCE(s.sells_5m, 0)) AS max_tx_5m_nh,
    MAX(s.ts) AS last_snapshot_ts
  FROM first_direct d
  CROSS JOIN params p
  LEFT JOIN all_snapshots s
    ON s.base_mint = d.base_mint
   AND s.ts >= d.launch_ts
   AND s.ts <= d.launch_ts + (p.hours_n * interval '1 hour')
  GROUP BY d.base_mint, d.launch_ts, d.first_liquidity_usd
)
SELECT
  (SELECT hours_n FROM params) AS first_n_hours,
  COUNT(*) AS direct_lp_mints,
  COUNT(*) FILTER (
    WHERE COALESCE(max_liquidity_usd_nh, 0) <= GREATEST(COALESCE(first_liquidity_usd, 0) * 0.2, 5000)
  ) AS rug_like_proxy_mints,
  COUNT(*) FILTER (
    WHERE COALESCE(max_liquidity_usd_nh, 0) >= GREATEST(COALESCE(first_liquidity_usd, 0) * 2.0, 50000)
       OR COALESCE(max_volume_5m_nh, 0) >= 10000
       OR COALESCE(max_tx_5m_nh, 0) >= 50
  ) AS runner_like_proxy_mints,
  ROUND(
    COUNT(*) FILTER (
      WHERE COALESCE(max_liquidity_usd_nh, 0) <= GREATEST(COALESCE(first_liquidity_usd, 0) * 0.2, 5000)
    )::numeric / NULLIF(COUNT(*), 0),
    4
  ) AS rug_like_proxy_rate,
  ROUND(
    COUNT(*) FILTER (
      WHERE COALESCE(max_liquidity_usd_nh, 0) >= GREATEST(COALESCE(first_liquidity_usd, 0) * 2.0, 50000)
         OR COALESCE(max_volume_5m_nh, 0) >= 10000
         OR COALESCE(max_tx_5m_nh, 0) >= 50
    )::numeric / NULLIF(COUNT(*), 0),
    4
  ) AS runner_like_proxy_rate
FROM window_metrics;
