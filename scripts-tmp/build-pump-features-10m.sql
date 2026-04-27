WITH launches AS (
  SELECT base_mint AS mint, MIN(block_time) AS launch_ts
  FROM swaps
  WHERE source='pumpportal'
    AND base_mint NOT LIKE 'So111%'
    AND block_time >= NOW() - INTERVAL '7 days'
  GROUP BY base_mint
),
w AS (
  SELECT
    l.mint,
    l.launch_ts,
    COUNT(DISTINCT s.wallet) FILTER (
      WHERE s.side='buy'
        AND s.block_time BETWEEN l.launch_ts + INTERVAL '2 min' AND l.launch_ts + INTERVAL '7 min'
    ) AS buyers_2_7,
    COUNT(DISTINCT s.wallet) FILTER (
      WHERE s.side='sell'
        AND s.block_time BETWEEN l.launch_ts + INTERVAL '2 min' AND l.launch_ts + INTERVAL '7 min'
    ) AS sellers_2_7,
    COALESCE(SUM(s.amount_usd) FILTER (
      WHERE s.side='buy'
        AND s.block_time BETWEEN l.launch_ts + INTERVAL '2 min' AND l.launch_ts + INTERVAL '7 min'
    ),0) AS buy_usd_2_7,
    COALESCE(SUM(s.amount_usd) FILTER (
      WHERE s.side='sell'
        AND s.block_time BETWEEN l.launch_ts + INTERVAL '2 min' AND l.launch_ts + INTERVAL '7 min'
    ),0) AS sell_usd_2_7
  FROM launches l
  LEFT JOIN swaps s ON s.base_mint=l.mint
  GROUP BY l.mint, l.launch_ts
),
tops AS (
  SELECT
    l.mint,
    COALESCE(MAX(x.w_usd),0) AS top_buyer_usd
  FROM launches l
  LEFT JOIN LATERAL (
    SELECT s.wallet, SUM(s.amount_usd) AS w_usd
    FROM swaps s
    WHERE s.base_mint=l.mint
      AND s.side='buy'
      AND s.block_time BETWEEN l.launch_ts + INTERVAL '2 min' AND l.launch_ts + INTERVAL '7 min'
    GROUP BY s.wallet
  ) x ON TRUE
  GROUP BY l.mint
),
entry AS (
  SELECT
    l.mint,
    (SELECT s.block_time
     FROM swaps s
     WHERE s.base_mint=l.mint
       AND s.block_time >= l.launch_ts + INTERVAL '10 min'
       AND s.price_usd > 0
     ORDER BY s.block_time
     LIMIT 1) AS entry_ts,
    (SELECT s.price_usd
     FROM swaps s
     WHERE s.base_mint=l.mint
       AND s.block_time >= l.launch_ts + INTERVAL '10 min'
       AND s.price_usd > 0
     ORDER BY s.block_time
     LIMIT 1) AS entry_price_usd
  FROM launches l
),
fut AS (
  SELECT
    l.mint,
    (SELECT MAX(s.price_usd) FROM swaps s WHERE s.base_mint=l.mint AND s.block_time > l.launch_ts + INTERVAL '10 min' AND s.block_time <= l.launch_ts + INTERVAL '60 min' AND s.price_usd>0) AS peak_60m,
    (SELECT MAX(s.price_usd) FROM swaps s WHERE s.base_mint=l.mint AND s.block_time > l.launch_ts + INTERVAL '10 min' AND s.block_time <= l.launch_ts + INTERVAL '12 hours' AND s.price_usd>0) AS peak_12h,
    (SELECT MIN(s.price_usd) FROM swaps s WHERE s.base_mint=l.mint AND s.block_time > l.launch_ts + INTERVAL '10 min' AND s.block_time <= l.launch_ts + INTERVAL '60 min' AND s.price_usd>0) AS min_60m
  FROM launches l
),
final AS (
  SELECT
    w.mint,
    w.launch_ts,
    e.entry_ts,
    e.entry_price_usd,
    w.buyers_2_7::int,
    w.sellers_2_7::int,
    w.buy_usd_2_7,
    w.sell_usd_2_7,
    w.buy_usd_2_7/85.0 AS buy_sol_2_7,
    w.sell_usd_2_7/85.0 AS sell_sol_2_7,
    CASE WHEN w.sell_usd_2_7>0 THEN w.buy_usd_2_7/w.sell_usd_2_7 ELSE 999 END AS bs_ratio,
    CASE WHEN w.buy_usd_2_7>0 THEN w.sell_usd_2_7/w.buy_usd_2_7 ELSE 0 END AS sell_buy_ratio,
    CASE WHEN w.buy_usd_2_7>0 THEN t.top_buyer_usd/w.buy_usd_2_7 ELSE 0 END AS top_buyer_share,
    GREATEST(0, LEAST(1, ((w.buy_usd_2_7/85.0)-(w.sell_usd_2_7/85.0))/85.0)) AS bc_progress,
    CASE WHEN e.entry_price_usd>0 AND f.peak_60m IS NOT NULL THEN f.peak_60m/e.entry_price_usd END AS peak_x_60m,
    CASE WHEN e.entry_price_usd>0 AND f.peak_12h IS NOT NULL THEN f.peak_12h/e.entry_price_usd END AS peak_x_12h,
    CASE WHEN e.entry_price_usd>0 AND f.min_60m IS NOT NULL THEN f.min_60m/e.entry_price_usd END AS min_x_60m
  FROM w
  JOIN tops t ON t.mint=w.mint
  JOIN entry e ON e.mint=w.mint
  JOIN fut f ON f.mint=w.mint
  WHERE e.entry_price_usd IS NOT NULL
)
INSERT INTO pump_features_10m (
  mint, launch_ts, entry_ts, entry_price_usd,
  buyers_2_7, sellers_2_7, buy_usd_2_7, sell_usd_2_7,
  buy_sol_2_7, sell_sol_2_7, bs_ratio, sell_buy_ratio,
  top_buyer_share, bc_progress, peak_x_60m, peak_x_12h, min_x_60m,
  runner_x3_12h, runner_x5_12h, rug_50_60m, updated_at
)
SELECT
  mint, launch_ts, entry_ts, entry_price_usd,
  buyers_2_7, sellers_2_7, buy_usd_2_7, sell_usd_2_7,
  buy_sol_2_7, sell_sol_2_7, bs_ratio, sell_buy_ratio,
  top_buyer_share, bc_progress, peak_x_60m, peak_x_12h, min_x_60m,
  (peak_x_12h >= 3), (peak_x_12h >= 5), (min_x_60m <= 0.5), NOW()
FROM final
ON CONFLICT (mint) DO UPDATE SET
  launch_ts=EXCLUDED.launch_ts,
  entry_ts=EXCLUDED.entry_ts,
  entry_price_usd=EXCLUDED.entry_price_usd,
  buyers_2_7=EXCLUDED.buyers_2_7,
  sellers_2_7=EXCLUDED.sellers_2_7,
  buy_usd_2_7=EXCLUDED.buy_usd_2_7,
  sell_usd_2_7=EXCLUDED.sell_usd_2_7,
  buy_sol_2_7=EXCLUDED.buy_sol_2_7,
  sell_sol_2_7=EXCLUDED.sell_sol_2_7,
  bs_ratio=EXCLUDED.bs_ratio,
  sell_buy_ratio=EXCLUDED.sell_buy_ratio,
  top_buyer_share=EXCLUDED.top_buyer_share,
  bc_progress=EXCLUDED.bc_progress,
  peak_x_60m=EXCLUDED.peak_x_60m,
  peak_x_12h=EXCLUDED.peak_x_12h,
  min_x_60m=EXCLUDED.min_x_60m,
  runner_x3_12h=EXCLUDED.runner_x3_12h,
  runner_x5_12h=EXCLUDED.runner_x5_12h,
  rug_50_60m=EXCLUDED.rug_50_60m,
  updated_at=NOW();
