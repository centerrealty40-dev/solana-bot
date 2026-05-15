-- Audit trail for market-spike-telegram-watch (optional; script also CREATE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS market_spike_events (
  id              BIGSERIAL PRIMARY KEY,
  ts_event        TIMESTAMPTZ NOT NULL DEFAULT now(),
  mint            TEXT NOT NULL,
  pair_address    TEXT NOT NULL,
  dex             TEXT NOT NULL,
  pct             DOUBLE PRECISION NOT NULL,
  signal_kind     TEXT NOT NULL,
  rolling_span_minutes SMALLINT,
  anchor_px       DOUBLE PRECISION NOT NULL,
  now_px          DOUBLE PRECISION NOT NULL,
  anchor_ts       TIMESTAMPTZ NOT NULL,
  ts_new          TIMESTAMPTZ NOT NULL,
  anchor_mcap_usd DOUBLE PRECISION,
  now_mcap_usd    DOUBLE PRECISION,
  ref_mcap_usd    DOUBLE PRECISION,
  tier_name       TEXT,
  liq_usd         DOUBLE PRECISION,
  symbol          TEXT,
  token_name      TEXT,
  status          TEXT NOT NULL,
  skip_reason     TEXT,
  prev_pct        DOUBLE PRECISION,
  prev_sent_at    TIMESTAMPTZ,
  telegram_msg_id BIGINT
);

CREATE INDEX IF NOT EXISTS idx_market_spike_events_mint_ts ON market_spike_events (mint, ts_event DESC);
CREATE INDEX IF NOT EXISTS idx_market_spike_events_ts ON market_spike_events (ts_event DESC);
CREATE INDEX IF NOT EXISTS idx_market_spike_events_status_ts ON market_spike_events (status, ts_event DESC);
