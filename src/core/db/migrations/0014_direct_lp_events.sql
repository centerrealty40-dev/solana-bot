-- Direct-LP launch detector events (mints with LP added directly bypassing pump.fun BC).
-- Used by: direct-lp-detector (writer), paper-trader (optional MIGRATION-lane source).

CREATE TABLE IF NOT EXISTS "direct_lp_events" (
  "ts"                    timestamptz NOT NULL,
  "source"                text NOT NULL,
  "pair_address"          text NOT NULL,
  "base_mint"             text NOT NULL,
  "quote_mint"            text NOT NULL,
  "dex"                   text NOT NULL,
  "first_price_usd"       double precision,
  "first_liquidity_usd"   double precision,
  "launch_inferred_ts"    timestamptz,
  "confidence"            double precision,
  "reason"                text,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "direct_lp_events_uq" UNIQUE ("base_mint", "pair_address", "ts")
);
CREATE INDEX IF NOT EXISTS "direct_lp_events_base_idx" ON "direct_lp_events" ("base_mint");
CREATE INDEX IF NOT EXISTS "direct_lp_events_ts_idx"   ON "direct_lp_events" ("ts");
