-- Solana Alpha Research Platform — initial schema
-- Generated from src/core/db/schema.ts (Stage 0 baseline)

CREATE TABLE IF NOT EXISTS "tokens" (
  "mint" varchar(64) PRIMARY KEY NOT NULL,
  "symbol" text,
  "name" text,
  "decimals" integer NOT NULL DEFAULT 0,
  "dev_wallet" varchar(64),
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "holder_count" integer,
  "fdv_usd" double precision,
  "liquidity_usd" double precision,
  "volume_24h_usd" double precision,
  "primary_pair" varchar(64),
  "blacklisted" boolean NOT NULL DEFAULT false,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tokens_dev_idx" ON "tokens" ("dev_wallet");
CREATE INDEX IF NOT EXISTS "tokens_first_seen_idx" ON "tokens" ("first_seen_at");

CREATE TABLE IF NOT EXISTS "wallets" (
  "address" varchar(64) PRIMARY KEY NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "funding_source" varchar(64),
  "funding_ts" timestamp with time zone,
  "is_cex_hot_wallet" boolean NOT NULL DEFAULT false,
  "label" text,
  "cluster_id" varchar(64),
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "wallets_funding_idx" ON "wallets" ("funding_source");
CREATE INDEX IF NOT EXISTS "wallets_cluster_idx" ON "wallets" ("cluster_id");
CREATE INDEX IF NOT EXISTS "wallets_first_seen_idx" ON "wallets" ("first_seen_at");

CREATE TABLE IF NOT EXISTS "swaps" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "signature" varchar(96) NOT NULL,
  "slot" bigint NOT NULL,
  "block_time" timestamp with time zone NOT NULL,
  "wallet" varchar(64) NOT NULL,
  "base_mint" varchar(64) NOT NULL,
  "quote_mint" varchar(64) NOT NULL,
  "side" varchar(4) NOT NULL,
  "base_amount_raw" bigint NOT NULL,
  "quote_amount_raw" bigint NOT NULL,
  "price_usd" double precision NOT NULL,
  "amount_usd" double precision NOT NULL,
  "dex" varchar(16) NOT NULL,
  "source" varchar(24) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "swaps_sig_wallet_base_uq" ON "swaps" ("signature", "wallet", "base_mint");
CREATE INDEX IF NOT EXISTS "swaps_wallet_time_idx" ON "swaps" ("wallet", "block_time");
CREATE INDEX IF NOT EXISTS "swaps_base_time_idx" ON "swaps" ("base_mint", "block_time");
CREATE INDEX IF NOT EXISTS "swaps_time_idx" ON "swaps" ("block_time");

CREATE TABLE IF NOT EXISTS "price_samples" (
  "mint" varchar(64) NOT NULL,
  "ts" timestamp with time zone NOT NULL,
  "price_usd" double precision NOT NULL,
  "volume_usd_5m" double precision NOT NULL,
  PRIMARY KEY ("mint", "ts")
);
CREATE INDEX IF NOT EXISTS "price_samples_time_idx" ON "price_samples" ("ts");

CREATE TABLE IF NOT EXISTS "holder_snapshots" (
  "mint" varchar(64) NOT NULL,
  "ts" timestamp with time zone NOT NULL,
  "holder_count" integer NOT NULL,
  "new_buyers_1h" integer,
  PRIMARY KEY ("mint", "ts")
);

CREATE TABLE IF NOT EXISTS "wallet_scores" (
  "wallet" varchar(64) PRIMARY KEY NOT NULL,
  "early_entry_score" double precision NOT NULL DEFAULT 0,
  "realized_pnl_30d" double precision NOT NULL DEFAULT 0,
  "unrealized_pnl" double precision NOT NULL DEFAULT 0,
  "holding_avg_minutes" double precision NOT NULL DEFAULT 0,
  "sell_in_tranches_ratio" double precision NOT NULL DEFAULT 0,
  "funding_origin_age_days" double precision NOT NULL DEFAULT 0,
  "cluster_id" varchar(64),
  "consistency_score" double precision NOT NULL DEFAULT 0,
  "trade_count_30d" integer NOT NULL DEFAULT 0,
  "distinct_tokens_30d" integer NOT NULL DEFAULT 0,
  "winrate_30d" double precision NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "wallet_scores_pnl_idx" ON "wallet_scores" ("realized_pnl_30d");
CREATE INDEX IF NOT EXISTS "wallet_scores_ee_idx" ON "wallet_scores" ("early_entry_score");
CREATE INDEX IF NOT EXISTS "wallet_scores_cluster_idx" ON "wallet_scores" ("cluster_id");

CREATE TABLE IF NOT EXISTS "signals" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "hypothesis_id" varchar(32) NOT NULL,
  "ts" timestamp with time zone NOT NULL DEFAULT now(),
  "base_mint" varchar(64) NOT NULL,
  "side" varchar(4) NOT NULL,
  "size_usd" double precision NOT NULL,
  "reason" text NOT NULL,
  "meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "accepted" boolean NOT NULL DEFAULT false,
  "reject_reason" text
);
CREATE INDEX IF NOT EXISTS "signals_hypo_ts_idx" ON "signals" ("hypothesis_id", "ts");
CREATE INDEX IF NOT EXISTS "signals_mint_idx" ON "signals" ("base_mint");

CREATE TABLE IF NOT EXISTS "positions" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "hypothesis_id" varchar(32) NOT NULL,
  "mode" varchar(8) NOT NULL,
  "base_mint" varchar(64) NOT NULL,
  "quote_mint" varchar(64) NOT NULL,
  "opened_at" timestamp with time zone NOT NULL DEFAULT now(),
  "closed_at" timestamp with time zone,
  "size_usd" double precision NOT NULL,
  "entry_price_usd" double precision NOT NULL,
  "exit_price_usd" double precision,
  "base_amount_raw" bigint NOT NULL DEFAULT 0,
  "realized_pnl_usd" double precision NOT NULL DEFAULT 0,
  "cost_usd" double precision NOT NULL DEFAULT 0,
  "status" varchar(12) NOT NULL DEFAULT 'open',
  "close_reason" text,
  "signal_meta" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "positions_hypo_status_idx" ON "positions" ("hypothesis_id", "status");
CREATE INDEX IF NOT EXISTS "positions_opened_idx" ON "positions" ("opened_at");
CREATE INDEX IF NOT EXISTS "positions_mint_idx" ON "positions" ("base_mint");

CREATE TABLE IF NOT EXISTS "trades" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "position_id" bigint NOT NULL REFERENCES "positions"("id") ON DELETE CASCADE,
  "ts" timestamp with time zone NOT NULL DEFAULT now(),
  "side" varchar(4) NOT NULL,
  "base_amount_raw" bigint NOT NULL,
  "quote_amount_raw" bigint NOT NULL,
  "price_usd" double precision NOT NULL,
  "slippage_bps" double precision NOT NULL DEFAULT 0,
  "fee_usd" double precision NOT NULL DEFAULT 0,
  "signature" varchar(96)
);
CREATE INDEX IF NOT EXISTS "trades_pos_idx" ON "trades" ("position_id");
CREATE INDEX IF NOT EXISTS "trades_ts_idx" ON "trades" ("ts");

CREATE TABLE IF NOT EXISTS "watchlist_wallets" (
  "wallet" varchar(64) PRIMARY KEY NOT NULL,
  "source" varchar(24) NOT NULL,
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  "removed_at" timestamp with time zone,
  "note" text
);

CREATE TABLE IF NOT EXISTS "daily_pnl" (
  "hypothesis_id" varchar(32) NOT NULL,
  "day" varchar(10) NOT NULL,
  "mode" varchar(8) NOT NULL,
  "realized_pnl_usd" double precision NOT NULL DEFAULT 0,
  "trades_count" integer NOT NULL DEFAULT 0,
  "wins_count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("hypothesis_id", "day", "mode")
);
