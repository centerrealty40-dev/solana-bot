-- Wallet Atlas: persistent intel layer for operator graph + auto-tagging.

CREATE TABLE IF NOT EXISTS "entity_wallets" (
  "wallet" varchar(64) PRIMARY KEY,
  "first_tx_at" timestamp with time zone,
  "last_tx_at" timestamp with time zone,
  "profile_created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "profile_updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "tx_count" integer NOT NULL DEFAULT 0,
  "distinct_mints" integer NOT NULL DEFAULT 0,
  "distinct_counterparties" integer NOT NULL DEFAULT 0,
  "total_funded_sol" double precision NOT NULL DEFAULT 0,
  "total_fee_spent_sol" double precision NOT NULL DEFAULT 0,
  "cluster_id" bigint,
  "primary_tag" varchar(32),
  "note" text
);

CREATE INDEX IF NOT EXISTS "entity_wallets_cluster_idx" ON "entity_wallets" ("cluster_id");
CREATE INDEX IF NOT EXISTS "entity_wallets_primary_tag_idx" ON "entity_wallets" ("primary_tag");
CREATE INDEX IF NOT EXISTS "entity_wallets_last_tx_idx" ON "entity_wallets" ("last_tx_at");

CREATE TABLE IF NOT EXISTS "money_flows" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "source_wallet" varchar(64) NOT NULL,
  "target_wallet" varchar(64) NOT NULL,
  "asset" varchar(64) NOT NULL,
  "amount" double precision NOT NULL,
  "tx_time" timestamp with time zone NOT NULL,
  "signature" varchar(96) NOT NULL,
  "observed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "money_flows_source_idx" ON "money_flows" ("source_wallet");
CREATE INDEX IF NOT EXISTS "money_flows_target_idx" ON "money_flows" ("target_wallet");
CREATE INDEX IF NOT EXISTS "money_flows_time_idx" ON "money_flows" ("tx_time");
CREATE UNIQUE INDEX IF NOT EXISTS "money_flows_unique_leg" ON "money_flows" ("signature","source_wallet","target_wallet","asset");

CREATE TABLE IF NOT EXISTS "wallet_tags" (
  "wallet" varchar(64) NOT NULL,
  "tag" varchar(32) NOT NULL,
  "confidence" integer NOT NULL DEFAULT 50,
  "source" varchar(32) NOT NULL,
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  "context" text,
  PRIMARY KEY ("wallet","tag","source")
);

CREATE INDEX IF NOT EXISTS "wallet_tags_wallet_idx" ON "wallet_tags" ("wallet");
CREATE INDEX IF NOT EXISTS "wallet_tags_tag_idx" ON "wallet_tags" ("tag");

CREATE TABLE IF NOT EXISTS "wallet_clusters" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "label" text,
  "kind" varchar(24) NOT NULL DEFAULT 'unknown',
  "confidence" integer NOT NULL DEFAULT 50,
  "wallet_count" integer NOT NULL DEFAULT 0,
  "first_activity_at" timestamp with time zone,
  "last_activity_at" timestamp with time zone,
  "total_inflow_sol" double precision NOT NULL DEFAULT 0,
  "touched_mints" jsonb,
  "merged_into_id" bigint,
  "detected_by" varchar(32) NOT NULL,
  "detected_at" timestamp with time zone NOT NULL DEFAULT now(),
  "note" text
);

CREATE INDEX IF NOT EXISTS "wallet_clusters_kind_idx" ON "wallet_clusters" ("kind");
CREATE INDEX IF NOT EXISTS "wallet_clusters_detected_idx" ON "wallet_clusters" ("detected_at");
