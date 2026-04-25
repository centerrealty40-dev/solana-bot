-- Pump.fun launches + decision-window aggregates за последние 24 часа
-- (с буфером 6h чтобы токены успели "вырасти")
WITH
swaps AS (
  SELECT
    -- mint торгуемого токена (тот что не SOL)
    CASE
      WHEN token_bought_mint_address = 'So11111111111111111111111111111111111111112'
        THEN token_sold_mint_address
      ELSE token_bought_mint_address
    END AS token_mint,
    -- side с точки зрения токена
    CASE
      WHEN token_bought_mint_address = 'So11111111111111111111111111111111111111112'
        THEN 'sell'
      ELSE 'buy'
    END AS side,
    block_time AS ts,
    amount_usd,
    trader_id,
    -- price_usd за 1 токен
    CASE
      WHEN token_bought_mint_address = 'So11111111111111111111111111111111111111112'
        THEN amount_usd / NULLIF(token_sold_amount, 0)
      ELSE amount_usd / NULLIF(token_bought_amount, 0)
    END AS price_usd
  FROM dex_solana.trades
  WHERE project = 'pumpdotfun'
    AND block_time > NOW() - INTERVAL '30' HOUR
    AND block_time < NOW() - INTERVAL '6' HOUR
    AND amount_usd > 0
),
launches AS (
  SELECT
    token_mint,
    MIN(ts) AS launch_ts,
    MAX(price_usd) * 1e9 AS peak_mc_usd,
    COUNT(*) AS total_swaps
  FROM swaps
  GROUP BY token_mint
),
window_swaps AS (
  SELECT
    s.token_mint, s.side, s.amount_usd, s.trader_id
  FROM swaps s
  JOIN launches l ON s.token_mint = l.token_mint
  WHERE s.ts >= l.launch_ts + INTERVAL '2' MINUTE
    AND s.ts <= l.launch_ts + INTERVAL '7' MINUTE
),
agg AS (
  SELECT
    token_mint,
    COUNT(DISTINCT CASE WHEN side='buy' THEN trader_id END) AS unique_buyers,
    SUM(CASE WHEN side='buy' THEN amount_usd ELSE 0 END) AS buy_usd,
    SUM(CASE WHEN side='sell' THEN amount_usd ELSE 0 END) AS sell_usd,
    MAX(CASE WHEN side='buy' THEN amount_usd END) AS top_buy_usd,
    COUNT(*) AS window_swaps
  FROM window_swaps
  GROUP BY token_mint
)
SELECT
  l.token_mint AS mint,
  l.launch_ts,
  l.peak_mc_usd,
  l.total_swaps,
  COALESCE(a.unique_buyers, 0) AS unique_buyers,
  COALESCE(a.buy_usd, 0)       AS buy_usd,
  COALESCE(a.sell_usd, 0)      AS sell_usd,
  COALESCE(a.top_buy_usd, 0)   AS top_buy_usd,
  COALESCE(a.window_swaps, 0)  AS window_swaps
FROM launches l
LEFT JOIN agg a ON a.token_mint = l.token_mint
WHERE l.peak_mc_usd > 30000  -- отрезаем мусор (peak < $30k)
ORDER BY l.peak_mc_usd DESC
