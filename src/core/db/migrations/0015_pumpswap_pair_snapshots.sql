CREATE TABLE IF NOT EXISTS "pumpswap_pair_snapshots" (
  "ts"               timestamptz NOT NULL,
  "source"           text NOT NULL,
  "pair_address"     text NOT NULL,
  "base_mint"        text NOT NULL,
  "quote_mint"       text NOT NULL,
  "price_usd"        double precision,
  "liquidity_usd"    double precision,
  "volume_5m"        double precision,
  "volume_1h"        double precision,
  "buys_5m"          integer,
  "sells_5m"         integer,
  "fdv_usd"          double precision,
  "market_cap_usd"   double precision,
  "launch_ts"        timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pumpswap_pair_snapshots_pair_ts_uq" UNIQUE ("pair_address", "ts")
);
CREATE INDEX IF NOT EXISTS "pumpswap_pair_snapshots_base_ts_idx" ON "pumpswap_pair_snapshots" ("base_mint", "ts");
CREATE INDEX IF NOT EXISTS "pumpswap_pair_snapshots_ts_idx"      ON "pumpswap_pair_snapshots" ("ts");
