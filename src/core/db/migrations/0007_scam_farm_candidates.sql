-- Scam-farm detective: persistent review queue + optional Wallet Atlas auto-tagging.

CREATE TABLE IF NOT EXISTS "scam_farm_candidates" (
  "candidate_id" varchar(64) PRIMARY KEY,
  "status" varchar(24) NOT NULL DEFAULT 'open',
  "score" double precision NOT NULL DEFAULT 0,
  "rule_ids" jsonb NOT NULL DEFAULT '[]',
  "funder" varchar(64),
  "participant_wallets" jsonb NOT NULL DEFAULT '[]',
  "anchor_mints" jsonb NOT NULL DEFAULT '[]',
  "artifacts" jsonb NOT NULL DEFAULT '{}',
  "reverted" boolean NOT NULL DEFAULT false,
  "wrote_to_atlas" boolean NOT NULL DEFAULT false,
  "last_run_at" timestamp with time zone,
  "dismissed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "scam_farm_candidates_status_idx" ON "scam_farm_candidates" ("status");
CREATE INDEX IF NOT EXISTS "scam_farm_candidates_last_run_idx" ON "scam_farm_candidates" ("last_run_at");

-- Speed funder+time window scans (pair with existing source_idx on source_wallet).
CREATE INDEX IF NOT EXISTS "money_flows_source_time_idx" ON "money_flows" ("source_wallet", "tx_time");
