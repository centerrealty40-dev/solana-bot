-- Raydium research snapshots (isolated scripts-tmp track)
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/raydium-snapshots.sql
--
-- Dedup contract:
--   - collector must pass ts truncated to minute UTC bucket
--   - one row per (pair_address, ts)

CREATE TABLE IF NOT EXISTS meteora_pair_snapshots (
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
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meteora_pair_snapshots_pair_ts_uq UNIQUE (pair_address, ts)
);

CREATE INDEX IF NOT EXISTS meteora_pair_snapshots_ts_idx
  ON meteora_pair_snapshots (ts DESC);

CREATE INDEX IF NOT EXISTS meteora_pair_snapshots_pair_idx
  ON meteora_pair_snapshots (pair_address);

CREATE INDEX IF NOT EXISTS meteora_pair_snapshots_base_idx
  ON meteora_pair_snapshots (base_mint);

-- Optional smoke upsert template (safe no-op example values).
-- Uncomment and adjust as needed:
--
-- INSERT INTO meteora_pair_snapshots (
--   ts, source, pair_address, base_mint, quote_mint, price_usd, liquidity_usd,
--   volume_5m, volume_1h, buys_5m, sells_5m, fdv_usd, market_cap_usd
-- ) VALUES (
--   date_trunc('minute', now()),
--   'dexscreener',
--   'example_pair',
--   'example_base',
--   'example_quote',
--   0, 0, 0, 0, 0, 0, 0, 0
-- )
-- ON CONFLICT (pair_address, ts) DO UPDATE
-- SET
--   source = EXCLUDED.source,
--   base_mint = EXCLUDED.base_mint,
--   quote_mint = EXCLUDED.quote_mint,
--   price_usd = EXCLUDED.price_usd,
--   liquidity_usd = EXCLUDED.liquidity_usd,
--   volume_5m = EXCLUDED.volume_5m,
--   volume_1h = EXCLUDED.volume_1h,
--   buys_5m = EXCLUDED.buys_5m,
--   sells_5m = EXCLUDED.sells_5m,
--   fdv_usd = EXCLUDED.fdv_usd,
--   market_cap_usd = EXCLUDED.market_cap_usd;
