-- Jupiter routeable check snapshots.
-- Used by: paper-trader (pre-entry routeable filter for FV/dip lanes),
--          direct-lp-checks (cross-validation).

CREATE TABLE IF NOT EXISTS "jupiter_route_snapshots" (
  "ts"                       timestamptz NOT NULL,
  "source"                   text NOT NULL,
  "mint"                     text NOT NULL,
  "routeable"                boolean NOT NULL,
  "best_out_usd"             double precision,
  "estimated_slippage_bps"   double precision,
  "quote_in_usd"             double precision,
  "hops"                     integer,
  "venue"                    text,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "jupiter_route_snapshots_mint_ts_uq" UNIQUE ("mint", "ts")
);
CREATE INDEX IF NOT EXISTS "jupiter_route_snapshots_ts_idx"   ON "jupiter_route_snapshots" ("ts");
CREATE INDEX IF NOT EXISTS "jupiter_route_snapshots_mint_idx" ON "jupiter_route_snapshots" ("mint");
