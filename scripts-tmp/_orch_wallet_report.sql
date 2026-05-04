-- one-off report: wallet orchestrator rows in wallets
SELECT COALESCE(metadata->>'seed_lane', '?') AS lane,
       COALESCE(metadata->>'job_type', '?') AS job_type,
       COUNT(*) AS wallet_rows,
       COUNT(DISTINCT address) AS distinct_wallets
FROM wallets
WHERE metadata->>'collector_id' = 'sa-wallet-orch'
   OR (metadata->>'gecko_multi_seed') = 'true'
GROUP BY 1, 2
ORDER BY wallet_rows DESC;

-- pools: how many wallet rows tied to each seed_pool (top 30)
SELECT COALESCE(metadata->>'seed_lane', '?') AS lane,
       COALESCE(metadata->>'job_type', '?') AS job_type,
       metadata->>'seed_pool' AS seed_pool,
       COUNT(*) AS wallet_rows
FROM wallets
WHERE (metadata->>'collector_id' = 'sa-wallet-orch' OR (metadata->>'gecko_multi_seed') = 'true')
  AND metadata ? 'seed_pool'
GROUP BY 1, 2, 3
ORDER BY wallet_rows DESC
LIMIT 30;
