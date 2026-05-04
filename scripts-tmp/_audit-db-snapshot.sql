SELECT 'swaps_total', count(*)::text FROM swaps;
SELECT 'swaps_24h', count(*)::text FROM swaps WHERE block_time > now() - interval '24 hours';
SELECT 'swaps_max_bt', coalesce(max(block_time)::text, 'null') FROM swaps;
SELECT 'flows_total', count(*)::text FROM money_flows;
SELECT 'flows_24h', count(*)::text FROM money_flows WHERE tx_time > now() - interval '24 hours';
SELECT 'flows_max_tt', coalesce(max(tx_time)::text, 'null') FROM money_flows;
SELECT 'wallets_orch_1h', count(*)::text FROM wallets
  WHERE first_seen_at >= now() - interval '1 hour'
    AND (metadata->>'collector_id' = 'sa-wallet-orch' OR COALESCE(metadata->>'gecko_multi_seed','') IN ('true','1'));
SELECT lane, cnt::text FROM (
  SELECT COALESCE(metadata->>'seed_lane','(unknown)') AS lane, count(*)::int AS cnt
  FROM wallets
  WHERE first_seen_at >= now() - interval '1 hour'
    AND (metadata->>'collector_id' = 'sa-wallet-orch' OR COALESCE(metadata->>'gecko_multi_seed','') IN ('true','1'))
  GROUP BY 1 ORDER BY cnt DESC
) t;
