-- Rough health checks for discover-smart-money (not exact pipeline).
SELECT 'swaps_90d' AS k, count(*)::text AS v FROM swaps WHERE block_time >= now() - interval '90 days'
UNION ALL
SELECT 'mint_t0_having' AS k, count(*)::text AS v
FROM (SELECT base_mint FROM swaps GROUP BY base_mint
      HAVING min(block_time) >= now() - interval '90 days') x
UNION ALL
SELECT 'runners_mcap' AS k, count(*)::text AS v
FROM (SELECT s.base_mint
      FROM (SELECT base_mint, market_cap_usd::double precision AS mx FROM raydium_pair_snapshots WHERE market_cap_usd IS NOT NULL
            UNION ALL
            SELECT base_mint, market_cap_usd::double precision AS mx FROM meteora_pair_snapshots WHERE market_cap_usd IS NOT NULL) s
      GROUP BY s.base_mint
      HAVING max(s.mx) >= 200000) y;
