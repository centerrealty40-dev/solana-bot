-- Run on VPS: psql "$SA_PG_DSN" -f scripts/diag/swaps-pipeline-diagnostics.sql
-- Explains why bot-bucket "last 24h" windows look empty: swap rows by writer + queue depth.

SELECT coalesce(source, '(null)') AS source,
       count(*) FILTER (WHERE block_time > now() - interval '24 hours') AS rows_24h,
       count(*) FILTER (WHERE block_time > now() - interval '7 days') AS rows_7d,
       max(block_time) AS newest_swap_chain_time
FROM swaps
GROUP BY source
ORDER BY rows_7d DESC;

SELECT status, count(*) AS n FROM wallet_backfill_queue GROUP BY status ORDER BY n DESC;
