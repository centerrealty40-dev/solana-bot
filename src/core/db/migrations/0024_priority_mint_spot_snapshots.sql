-- Sub-minute spot snapshots for priority mints (Jupiter / DexScreener fast path).
-- Complements 1-minute DEX pair_snapshots for spike/dips and discovery audit.

CREATE TABLE IF NOT EXISTS "priority_mint_spot_snapshots" (
  "ts"               timestamptz NOT NULL,
  "base_mint"        text NOT NULL,
  "pair_address"     text,
  "price_usd"        double precision NOT NULL,
  "market_cap_usd"   double precision,
  "liquidity_usd"    double precision,
  "source"           text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "priority_mint_spot_snapshots_mint_ts_uq" UNIQUE ("base_mint", "ts")
);

CREATE INDEX IF NOT EXISTS "priority_mint_spot_snapshots_base_ts_idx"
  ON "priority_mint_spot_snapshots" ("base_mint", "ts" DESC);

CREATE INDEX IF NOT EXISTS "priority_mint_spot_snapshots_ts_idx"
  ON "priority_mint_spot_snapshots" ("ts" DESC);
