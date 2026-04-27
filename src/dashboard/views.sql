-- Dashboard SQL views, intended for Grafana Cloud / Metabase / psql exploration.
-- Run once after `npm run db:migrate` to install.

-- Per-hypothesis cumulative P&L per day
CREATE OR REPLACE VIEW v_hypothesis_daily_pnl AS
SELECT
  hypothesis_id,
  mode,
  day::date AS day,
  realized_pnl_usd,
  trades_count,
  wins_count,
  CASE WHEN trades_count > 0 THEN wins_count::float / trades_count ELSE 0 END AS winrate,
  SUM(realized_pnl_usd) OVER (
    PARTITION BY hypothesis_id, mode ORDER BY day::date
  ) AS cumulative_pnl
FROM daily_pnl
ORDER BY hypothesis_id, mode, day;

-- Per-hypothesis lifetime stats (pass/fail vs. plan thresholds)
CREATE OR REPLACE VIEW v_hypothesis_lifetime AS
WITH closed AS (
  SELECT
    hypothesis_id,
    mode,
    realized_pnl_usd,
    size_usd,
    closed_at,
    base_mint,
    realized_pnl_usd / NULLIF(size_usd, 0) AS pct_return
  FROM positions
  WHERE status = 'closed'
)
SELECT
  hypothesis_id,
  mode,
  COUNT(*) AS trades,
  COUNT(*) FILTER (WHERE realized_pnl_usd > 0) AS wins,
  COUNT(DISTINCT base_mint) AS distinct_tokens,
  AVG(pct_return) AS avg_pct,
  STDDEV_POP(pct_return) AS stddev_pct,
  CASE WHEN STDDEV_POP(pct_return) > 0
    THEN AVG(pct_return) / STDDEV_POP(pct_return)
    ELSE 0 END AS sharpe_per_trade,
  SUM(realized_pnl_usd) AS total_pnl,
  AVG(realized_pnl_usd) AS expectancy_usd,
  AVG(pct_return) AS expectancy_pct
FROM closed
GROUP BY hypothesis_id, mode
ORDER BY hypothesis_id, mode;

-- Recent signals with their fate (accepted / rejected reason)
CREATE OR REPLACE VIEW v_recent_signals AS
SELECT
  s.id,
  s.hypothesis_id,
  s.ts,
  s.base_mint,
  t.symbol,
  s.size_usd,
  s.accepted,
  s.reject_reason,
  s.reason
FROM signals s
LEFT JOIN tokens t ON t.mint = s.base_mint
ORDER BY s.ts DESC;

-- Top wallets by composite score (used to seed H1 watchlist manually)
CREATE OR REPLACE VIEW v_top_wallets AS
SELECT
  ws.wallet,
  ws.realized_pnl_30d,
  ws.early_entry_score,
  ws.consistency_score,
  ws.holding_avg_minutes,
  ws.sell_in_tranches_ratio,
  ws.cluster_id,
  ws.trade_count_30d,
  ws.distinct_tokens_30d,
  ws.winrate_30d,
  -- composite score: weighted, monotonic in good signals
  (
    LEAST(ws.realized_pnl_30d / 5000.0, 5.0) +
    ws.early_entry_score * 2.0 +
    ws.consistency_score * 1.0 +
    ws.sell_in_tranches_ratio * 1.0
  ) AS composite_score
FROM wallet_scores ws
WHERE ws.trade_count_30d >= 5
  AND ws.distinct_tokens_30d >= 3
ORDER BY composite_score DESC;

-- Equity curve helper: per-trade running PnL per hypothesis (for time-series chart)
CREATE OR REPLACE VIEW v_equity_curve AS
SELECT
  p.hypothesis_id,
  p.mode,
  p.closed_at AS ts,
  p.realized_pnl_usd AS trade_pnl,
  SUM(p.realized_pnl_usd) OVER (
    PARTITION BY p.hypothesis_id, p.mode
    ORDER BY p.closed_at
  ) AS equity
FROM positions p
WHERE p.status = 'closed'
ORDER BY p.hypothesis_id, p.mode, p.closed_at;
