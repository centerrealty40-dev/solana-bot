-- Dip-reversal wallet backfill/profile tables.
-- Safe to run repeatedly:
--   psql "$DATABASE_URL" -f scripts-tmp/dip-tables.sql

CREATE TABLE IF NOT EXISTS wallet_trades_raw (
  id bigserial PRIMARY KEY,
  wallet text NOT NULL,
  signature text NOT NULL,
  slot bigint,
  block_time timestamptz NOT NULL,
  mint text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  token_amount double precision,
  quote_mint text,
  quote_amount double precision,
  amount_usd double precision,
  price_usd double precision,
  source text NOT NULL DEFAULT 'rpc_wallet_backfill',
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_trades_raw_wallet_sig_mint_side_uq
    UNIQUE (wallet, signature, mint, side)
);

CREATE INDEX IF NOT EXISTS wallet_trades_raw_wallet_time_idx
  ON wallet_trades_raw (wallet, block_time DESC);

CREATE INDEX IF NOT EXISTS wallet_trades_raw_mint_time_idx
  ON wallet_trades_raw (mint, block_time DESC);

CREATE INDEX IF NOT EXISTS wallet_trades_raw_side_idx
  ON wallet_trades_raw (side);
