SELECT 'raydium' AS dex, COUNT(*)::bigint AS rows_1h
FROM raydium_pair_snapshots WHERE ts > now() - interval '1 hour'
UNION ALL
SELECT 'meteora', COUNT(*)::bigint
FROM meteora_pair_snapshots WHERE ts > now() - interval '1 hour'
UNION ALL
SELECT 'orca', COUNT(*)::bigint
FROM orca_pair_snapshots WHERE ts > now() - interval '1 hour'
UNION ALL
SELECT 'moonshot', COUNT(*)::bigint
FROM moonshot_pair_snapshots WHERE ts > now() - interval '1 hour'
UNION ALL
SELECT 'pumpswap', COUNT(*)::bigint
FROM pumpswap_pair_snapshots WHERE ts > now() - interval '1 hour';
