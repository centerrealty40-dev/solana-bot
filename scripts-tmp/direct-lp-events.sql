-- Direct LP creation detector events (isolated scripts-tmp R&D track)
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/direct-lp-events.sql
--
-- Dedup contract:
--   - detector writes ts truncated to UTC minute
--   - one event per (base_mint, pair_address, minute bucket)

CREATE TABLE IF NOT EXISTS direct_lp_events (
  ts timestamptz,
  source text,
  pair_address text,
  base_mint text,
  quote_mint text,
  dex text,
  first_price_usd double precision,
  first_liquidity_usd double precision,
  launch_inferred_ts timestamptz,
  confidence double precision,
  reason text,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS direct_lp_events_base_pair_ts_uq
  ON direct_lp_events (base_mint, pair_address, ts);

CREATE INDEX IF NOT EXISTS direct_lp_events_ts_idx
  ON direct_lp_events (ts DESC);

CREATE INDEX IF NOT EXISTS direct_lp_events_base_mint_idx
  ON direct_lp_events (base_mint);

CREATE INDEX IF NOT EXISTS direct_lp_events_pair_address_idx
  ON direct_lp_events (pair_address);

CREATE INDEX IF NOT EXISTS direct_lp_events_dex_idx
  ON direct_lp_events (dex);
