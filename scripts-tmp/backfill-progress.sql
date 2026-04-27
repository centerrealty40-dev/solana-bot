-- 60d RPC backfill progress snapshot.
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/backfill-progress.sql

\pset pager off

\echo '== backfill_signatures status =='
SELECT
  status,
  count(*) AS signatures,
  min(block_time) AS earliest_block_time,
  max(block_time) AS latest_block_time,
  round(100.0 * count(*) / nullif(sum(count(*)) OVER (), 0), 2) AS pct
FROM backfill_signatures
GROUP BY status
ORDER BY status;

\echo '== swaps rpc_backfill coverage =='
SELECT
  count(*) AS swaps,
  min(block_time) AS earliest_block_time,
  max(block_time) AS latest_block_time,
  count(DISTINCT wallet) AS unique_wallets,
  count(DISTINCT base_mint) AS unique_base_mints
FROM swaps
WHERE source = 'rpc_backfill'
  AND block_time >= now() - interval '60 days';

\echo '== swaps rpc_backfill by day =='
SELECT
  date_trunc('day', block_time)::date AS day,
  count(*) AS rows_day,
  count(DISTINCT wallet) AS unique_wallets_day,
  min(block_time) AS earliest,
  max(block_time) AS latest
FROM swaps
WHERE source = 'rpc_backfill'
  AND block_time >= now() - interval '60 days'
GROUP BY 1
ORDER BY 1 DESC;

\echo '== failed ratio =='
SELECT
  count(*) FILTER (WHERE status = 'failed') AS failed,
  count(*) AS total,
  round(100.0 * count(*) FILTER (WHERE status = 'failed') / nullif(count(*), 0), 2) AS failed_pct
FROM backfill_signatures;

\echo '== ETA from last 60 minutes =='
WITH rate AS (
  SELECT
    count(*) FILTER (WHERE status IN ('done', 'failed') AND updated_at >= now() - interval '60 minutes') AS completed_60m,
    count(*) FILTER (WHERE status = 'queued') AS queued,
    count(*) FILTER (WHERE status = 'processing') AS processing
  FROM backfill_signatures
)
SELECT
  completed_60m,
  queued,
  processing,
  round(completed_60m / 60.0, 2) AS completed_per_min,
  CASE
    WHEN completed_60m > 0 THEN
      now() + ((queued + processing) / (completed_60m / 60.0)) * interval '1 minute'
  END AS eta_at_current_60m_rate
FROM rate;

\echo '== crawler oldest per program =='
SELECT
  program,
  count(*) AS signatures,
  min(block_time) AS oldest_signature_time,
  max(block_time) AS newest_signature_time,
  count(*) FILTER (WHERE status = 'queued') AS queued,
  count(*) FILTER (WHERE status = 'done') AS done,
  count(*) FILTER (WHERE status = 'failed') AS failed
FROM backfill_signatures
GROUP BY program
ORDER BY oldest_signature_time NULLS LAST;
