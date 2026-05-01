-- Per-DEX pair snapshots (1-minute buckets).
-- Schema is identical across DEXes for uniform UNION queries downstream.
-- Used by: paper-trader (POST_LANE / MIGRATION_LANE discovery, dip context, latest price),
--          direct-lp-detector (UNION).

CREATE TABLE IF NOT EXISTS "raydium_pair_snapshots" (
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
  CONSTRAINT "raydium_pair_snapshots_pair_ts_uq" UNIQUE ("pair_address", "ts")
);
CREATE INDEX IF NOT EXISTS "raydium_pair_snapshots_base_ts_idx" ON "raydium_pair_snapshots" ("base_mint", "ts");
CREATE INDEX IF NOT EXISTS "raydium_pair_snapshots_ts_idx"      ON "raydium_pair_snapshots" ("ts");

CREATE TABLE IF NOT EXISTS "meteora_pair_snapshots" (
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
  CONSTRAINT "meteora_pair_snapshots_pair_ts_uq" UNIQUE ("pair_address", "ts")
);
CREATE INDEX IF NOT EXISTS "meteora_pair_snapshots_base_ts_idx" ON "meteora_pair_snapshots" ("base_mint", "ts");
CREATE INDEX IF NOT EXISTS "meteora_pair_snapshots_ts_idx"      ON "meteora_pair_snapshots" ("ts");

CREATE TABLE IF NOT EXISTS "orca_pair_snapshots" (
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
  CONSTRAINT "orca_pair_snapshots_pair_ts_uq" UNIQUE ("pair_address", "ts")
);
CREATE INDEX IF NOT EXISTS "orca_pair_snapshots_base_ts_idx" ON "orca_pair_snapshots" ("base_mint", "ts");
CREATE INDEX IF NOT EXISTS "orca_pair_snapshots_ts_idx"      ON "orca_pair_snapshots" ("ts");

CREATE TABLE IF NOT EXISTS "moonshot_pair_snapshots" (
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
  CONSTRAINT "moonshot_pair_snapshots_pair_ts_uq" UNIQUE ("pair_address", "ts")
);
CREATE INDEX IF NOT EXISTS "moonshot_pair_snapshots_base_ts_idx" ON "moonshot_pair_snapshots" ("base_mint", "ts");
CREATE INDEX IF NOT EXISTS "moonshot_pair_snapshots_ts_idx"      ON "moonshot_pair_snapshots" ("ts");
