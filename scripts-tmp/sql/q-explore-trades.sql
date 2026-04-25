-- Explore: какие колонки есть в dex_solana.trades для pumpdotfun
SELECT *
FROM dex_solana.trades
WHERE project = 'pumpdotfun'
  AND block_time > NOW() - INTERVAL '1' HOUR
LIMIT 1
