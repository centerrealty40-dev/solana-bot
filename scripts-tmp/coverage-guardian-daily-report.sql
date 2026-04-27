-- Coverage Guardian daily report.
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/coverage-guardian-daily-report.sql

\echo '== Coverage KPI: full lifecycle =='
WITH recent AS (
  SELECT *
  FROM coverage_events
  WHERE updated_at >= now() - interval '24 hours'
)
SELECT
  COUNT(*) AS mints_24h,
  COUNT(*) FILTER (WHERE lifecycle_stage = 'full_lifecycle') AS full_lifecycle_mints,
  ROUND(
    100.0 * (COUNT(*) FILTER (WHERE lifecycle_stage = 'full_lifecycle'))::numeric
    / NULLIF(COUNT(*), 0),
    2
  ) AS full_lifecycle_pct,
  ROUND(AVG(confidence)::numeric, 4) AS avg_confidence
FROM recent;

\echo '== Coverage KPI: gap pct by lifecycle stage =='
WITH recent_events AS (
  SELECT *
  FROM coverage_events
  WHERE updated_at >= now() - interval '24 hours'
),
recent_gaps AS (
  SELECT DISTINCT mint, gap_type
  FROM coverage_gaps
  WHERE ts >= now() - interval '24 hours'
)
SELECT
  COALESCE(e.lifecycle_stage, 'unknown') AS lifecycle_stage,
  COUNT(DISTINCT e.mint) AS stage_mints,
  COUNT(DISTINCT e.mint) FILTER (WHERE g.mint IS NOT NULL) AS gap_mints,
  ROUND(
    100.0 * (COUNT(DISTINCT e.mint) FILTER (WHERE g.mint IS NOT NULL))::numeric
    / NULLIF(COUNT(DISTINCT e.mint), 0),
    2
  ) AS gap_pct
FROM recent_events e
LEFT JOIN recent_gaps g ON g.mint = e.mint
GROUP BY COALESCE(e.lifecycle_stage, 'unknown')
ORDER BY gap_pct DESC NULLS LAST, stage_mints DESC;

\echo '== Coverage KPI: top-5 gap types by impact =='
SELECT
  gap_type,
  COUNT(*) AS gap_events,
  COUNT(DISTINCT mint) AS impacted_mints,
  SUM(CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS impact_score,
  ROUND(
    AVG(CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)::numeric,
    2
  ) AS avg_severity_weight
FROM coverage_gaps
WHERE ts >= now() - interval '24 hours'
GROUP BY gap_type
ORDER BY impact_score DESC, impacted_mints DESC, gap_events DESC
LIMIT 5;

\echo '== Coverage gaps: latest actionable samples =='
SELECT
  ts,
  severity,
  gap_type,
  mint,
  details_json
FROM coverage_gaps
WHERE ts >= now() - interval '24 hours'
ORDER BY
  CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
  ts DESC
LIMIT 50;

\echo '== Coverage events: stale or incomplete lifecycle =='
SELECT
  mint,
  lifecycle_stage,
  confidence,
  first_seen_pump,
  first_seen_raydium,
  first_seen_meteora,
  first_seen_orca,
  first_seen_moonshot,
  first_seen_jupiter,
  last_seen,
  updated_at
FROM coverage_events
WHERE updated_at >= now() - interval '24 hours'
  AND lifecycle_stage <> 'full_lifecycle'
ORDER BY confidence ASC, last_seen DESC NULLS LAST
LIMIT 50;
