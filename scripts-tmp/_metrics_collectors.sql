\set ON_ERROR_STOP on
\pset footer off

SELECT '--- Meteora (sa-meteora → meteora_pair_snapshots) ---' AS section;
SELECT
  count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS rows_inserted_1h,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS rows_inserted_24h,
  count(DISTINCT base_mint) FILTER (WHERE created_at > now() - interval '1 hour') AS distinct_base_mints_1h,
  max(ts) AS last_pair_ts,
  max(created_at) AS last_row_created_at
FROM meteora_pair_snapshots;

SELECT '--- Raydium (sa-raydium; часто миграции с pump) ---' AS section;
SELECT
  count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS rows_inserted_1h,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS rows_inserted_24h,
  max(created_at) AS last_row_created_at
FROM raydium_pair_snapshots;

SELECT '--- PumpSwap (sa-pumpswap → pumpswap_pair_snapshots) ---' AS section;
SELECT
  count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS rows_inserted_1h,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS rows_inserted_24h,
  count(DISTINCT base_mint) FILTER (WHERE created_at > now() - interval '1 hour') AS distinct_base_mints_1h,
  max(ts) AS last_pair_ts,
  max(created_at) AS last_row_created_at
FROM pumpswap_pair_snapshots;

SELECT '--- Pump bonding curve / swap (sa-stream → sa-parser → swaps) ---' AS section;
SELECT
  dex,
  count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS swap_rows_1h,
  count(DISTINCT wallet) FILTER (WHERE created_at > now() - interval '1 hour') AS distinct_wallets_active_1h,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS swap_rows_24h,
  count(DISTINCT wallet) FILTER (WHERE created_at > now() - interval '24 hours') AS distinct_wallets_active_24h
FROM swaps
WHERE dex IN ('pumpfun', 'pumpswap')
GROUP BY dex
ORDER BY dex;

SELECT '--- Кошельки (новые адреса при первом swap в parser) ---' AS section;
SELECT
  count(*) FILTER (WHERE first_seen_at > now() - interval '1 hour') AS new_wallet_rows_1h,
  count(*) FILTER (WHERE first_seen_at > now() - interval '24 hours') AS new_wallet_rows_24h,
  count(*) AS wallets_total
FROM wallets;

SELECT '--- Общий поток swaps (все dex) ---' AS section;
SELECT
  count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS swaps_rows_1h,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS swaps_rows_24h,
  max(created_at) AS last_swap_created_at
FROM swaps;
