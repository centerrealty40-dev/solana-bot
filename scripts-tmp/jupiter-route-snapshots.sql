-- Jupiter routeability snapshot store.
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/jupiter-route-snapshots.sql

CREATE TABLE IF NOT EXISTS jupiter_route_snapshots (
  ts timestamptz NOT NULL,
  source text NOT NULL,
  mint text NOT NULL,
  routeable boolean NOT NULL,
  best_out_usd double precision,
  estimated_slippage_bps double precision,
  quote_in_usd double precision,
  hops int,
  venue text,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jupiter_route_snapshots_mint_ts_uq
  ON jupiter_route_snapshots (mint, ts);

CREATE INDEX IF NOT EXISTS jupiter_route_snapshots_ts_idx
  ON jupiter_route_snapshots (ts);

CREATE INDEX IF NOT EXISTS jupiter_route_snapshots_mint_idx
  ON jupiter_route_snapshots (mint);

CREATE INDEX IF NOT EXISTS jupiter_route_snapshots_routeable_idx
  ON jupiter_route_snapshots (routeable);
