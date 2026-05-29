-- DCA operator honesty tracking (dca-telegram-watch).

CREATE TABLE IF NOT EXISTS dca_operators (
  wallet                TEXT PRIMARY KEY,
  opens_total           INT NOT NULL DEFAULT 0,
  closes_total          INT NOT NULL DEFAULT 0,
  fills_total           BIGINT NOT NULL DEFAULT 0,
  planned_cycles_total  BIGINT NOT NULL DEFAULT 0,
  completed_cycles_total BIGINT NOT NULL DEFAULT 0,
  early_close_count     INT NOT NULL DEFAULT 0,
  honesty_score_pct     DOUBLE PRECISION,
  avg_completion_pct    DOUBLE PRECISION,
  first_seen_ts         TIMESTAMPTZ,
  last_event_ts         TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dca_operator_orders (
  id                    BIGSERIAL PRIMARY KEY,
  operator_wallet       TEXT NOT NULL,
  order_id              TEXT,
  series_key            TEXT,
  mint                  TEXT NOT NULL,
  source                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',
  planned_cycles        INT NOT NULL,
  planned_cycle_usd     DOUBLE PRECISION,
  planned_total_usd     DOUBLE PRECISION,
  cycle_freq_sec        INT,
  observed_fills        INT NOT NULL DEFAULT 0,
  observed_spend_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  completion_ratio      DOUBLE PRECISION,
  early_close           BOOLEAN NOT NULL DEFAULT false,
  open_sig              TEXT NOT NULL,
  close_sig             TEXT,
  open_ts               TIMESTAMPTZ NOT NULL,
  close_ts              TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dca_operator_orders_order_id
  ON dca_operator_orders (order_id)
  WHERE order_id IS NOT NULL AND order_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_dca_operator_orders_series_key
  ON dca_operator_orders (series_key)
  WHERE series_key IS NOT NULL AND series_key <> '';

CREATE INDEX IF NOT EXISTS idx_dca_operator_orders_wallet_open
  ON dca_operator_orders (operator_wallet, open_ts DESC);

CREATE INDEX IF NOT EXISTS idx_dca_operator_orders_mint_status
  ON dca_operator_orders (mint, status, open_ts DESC);

CREATE INDEX IF NOT EXISTS idx_dca_operators_honesty
  ON dca_operators (honesty_score_pct DESC NULLS LAST);
