-- Sanctum LST arbitrage observation log.
--
-- Purpose:
--   Strategy B Edge #1 — Sanctum LST arb. We sample (every N seconds) the
--   true par-value of each LST from Sanctum's free extra-api endpoint AND
--   the actual market price on Jupiter. The delta is the arb opportunity.
--
-- Each row = one (timestamp, LST, sample-size) observation.
-- After 2-7 days of accumulation we can answer:
--   - How often does any LST trade at <-0.5% to par?
--   - Which LSTs have the most frequent / largest discounts?
--   - At what sizes does arb collapse due to Jupiter slippage?
--   - Time-of-day / epoch-boundary patterns?

CREATE TABLE IF NOT EXISTS "sanctum_snapshots" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "ts" timestamp with time zone NOT NULL DEFAULT now(),

  "lst_symbol" varchar(16) NOT NULL,
  "lst_mint" varchar(64) NOT NULL,

  /** Sample size in SOL-equivalent (e.g., 10, 100, 1000). */
  "size_sol" double precision NOT NULL,

  /** True par-value: 1 LST = X SOL (from Sanctum extra-api /v1/sol-value/current). */
  "sanctum_sol_value" double precision NOT NULL,
  /** Market value: 1 LST = X SOL on Jupiter (best route, includes all hop fees). */
  "jupiter_sol_per_lst" double precision NOT NULL,
  /** Jupiter's reported price impact pct for this size. */
  "jupiter_price_impact_pct" double precision,

  /** ((jupiter / sanctum) - 1) * 100 — negative means LST trades below par (arb!). */
  "arb_pct" double precision NOT NULL,
  /** Gross profit in SOL terms if we executed at this snapshot (no fees). */
  "arb_sol_gross" double precision NOT NULL,

  "meta" jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "sanctum_snapshots_ts_idx"  ON "sanctum_snapshots" ("ts");
CREATE INDEX IF NOT EXISTS "sanctum_snapshots_lst_idx" ON "sanctum_snapshots" ("lst_mint");
CREATE INDEX IF NOT EXISTS "sanctum_snapshots_arb_idx" ON "sanctum_snapshots" ("arb_pct");
