-- Product: dca_frontrun (paper). Tables prefixed dcabot_*.
-- Mirrors src/dcabot/db.ts ensureDcabotTables() (runtime also creates these idempotently).

CREATE TABLE IF NOT EXISTS dcabot_positions (
  id                 BIGSERIAL PRIMARY KEY,
  mint               TEXT NOT NULL,
  symbol             TEXT,
  operator_wallet    TEXT NOT NULL,
  buyer              TEXT NOT NULL DEFAULT '',
  vault              TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL,
  open_sig           TEXT,
  planned_cycles     INT NOT NULL DEFAULT 0,
  cycle_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
  cycle_freq_sec     INT NOT NULL DEFAULT 0,
  deposit_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
  open_ts            TIMESTAMPTZ,
  est_gain_pct       DOUBLE PRECISION,
  legit_score        DOUBLE PRECISION,
  state              TEXT NOT NULL DEFAULT 'scoring',
  qty_token          DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_usd           DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_entry_price    DOUBLE PRECISION NOT NULL DEFAULT 0,
  realized_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_capital_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  dd_steps_hit       INT NOT NULL DEFAULT 0,
  tp_steps_hit       INT NOT NULL DEFAULT 0,
  exit_first_done    BOOLEAN NOT NULL DEFAULT false,
  pending_sell_qty   DOUBLE PRECISION NOT NULL DEFAULT 0,
  pending_sell_at    TIMESTAMPTZ,
  close_reason       TEXT,
  entered_at         TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dcabot_positions_key ON dcabot_positions (vault, mint);
CREATE INDEX IF NOT EXISTS idx_dcabot_positions_state ON dcabot_positions (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS dcabot_fills (
  id            BIGSERIAL PRIMARY KEY,
  position_id   BIGINT NOT NULL REFERENCES dcabot_positions(id),
  side          TEXT NOT NULL,
  reason        TEXT NOT NULL,
  price_usd     DOUBLE PRECISION NOT NULL,
  qty_token     DOUBLE PRECISION NOT NULL,
  usd           DOUBLE PRECISION NOT NULL,
  cycle_index   INT,
  realized_usd  DOUBLE PRECISION,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dcabot_fills_pos ON dcabot_fills (position_id, ts);

CREATE TABLE IF NOT EXISTS dcabot_equity (
  id                  BIGSERIAL PRIMARY KEY,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cash_usd            DOUBLE PRECISION NOT NULL,
  positions_value_usd DOUBLE PRECISION NOT NULL,
  equity_usd          DOUBLE PRECISION NOT NULL,
  realized_usd        DOUBLE PRECISION NOT NULL,
  unrealized_usd      DOUBLE PRECISION NOT NULL,
  open_positions      INT NOT NULL,
  max_capital_usd     DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dcabot_equity_ts ON dcabot_equity (ts DESC);

CREATE TABLE IF NOT EXISTS dcabot_token_score (
  mint            TEXT PRIMARY KEY,
  symbol          TEXT,
  score           DOUBLE PRECISION,
  mint_renounced  BOOLEAN,
  freeze_renounced BOOLEAN,
  lp_locked       BOOLEAN,
  top10_pct       DOUBLE PRECISION,
  liquidity_usd   DOUBLE PRECISION,
  age_min         DOUBLE PRECISION,
  flags           JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
