-- Orca research snapshots (isolated scripts-tmp track)
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/orca-snapshots.sql
--
-- Dedup contract:
--   - collector passes ts truncated to UTC minute
--   - one row per (pair_address, ts)

CREATE TABLE IF NOT EXISTS orca_pair_snapshots (
  ts timestamptz NOT NULL,
  source text NOT NULL,
  pair_address text NOT NULL,
  base_mint text NOT NULL,
  quote_mint text NOT NULL,
  price_usd double precision,
  liquidity_usd double precision,
  volume_5m double precision,
  volume_1h double precision,
  buys_5m int,
  sells_5m int,
  fdv_usd double precision,
  market_cap_usd double precision,
  launch_ts timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orca_pair_snapshots_pair_ts_uq UNIQUE (pair_address, ts)
);

CREATE INDEX IF NOT EXISTS orca_pair_snapshots_ts_idx
  ON orca_pair_snapshots (ts DESC);

CREATE INDEX IF NOT EXISTS orca_pair_snapshots_pair_idx
  ON orca_pair_snapshots (pair_address);

CREATE INDEX IF NOT EXISTS orca_pair_snapshots_base_idx
  ON orca_pair_snapshots (base_mint);

CREATE INDEX IF NOT EXISTS orca_pair_snapshots_launch_idx
  ON orca_pair_snapshots (launch_ts DESC);
