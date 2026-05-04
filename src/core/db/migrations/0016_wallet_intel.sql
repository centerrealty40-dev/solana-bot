-- Wallet Intel Detective v1: materialized policy outcomes (W6.9 / W6.11).

CREATE TABLE IF NOT EXISTS "wallet_intel_decisions" (
  "wallet_address" varchar(64) NOT NULL,
  "rule_set_version" text NOT NULL,
  "decision" varchar(32) NOT NULL,
  "score" double precision NOT NULL DEFAULT 0,
  "reasons" jsonb NOT NULL DEFAULT '[]',
  "sources" jsonb NOT NULL DEFAULT '{}',
  "computed_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("wallet_address", "rule_set_version")
);

CREATE INDEX IF NOT EXISTS "wallet_intel_decisions_decision_version_idx"
  ON "wallet_intel_decisions" ("decision", "rule_set_version");
CREATE INDEX IF NOT EXISTS "wallet_intel_decisions_computed_at_idx"
  ON "wallet_intel_decisions" ("computed_at" DESC);

CREATE TABLE IF NOT EXISTS "wallet_intel_runs" (
  "id" bigserial PRIMARY KEY,
  "rule_set_version" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  "metrics" jsonb NOT NULL DEFAULT '{}',
  "status" varchar(16) NOT NULL DEFAULT 'ok',
  "error" text
);

CREATE INDEX IF NOT EXISTS "wallet_intel_runs_started_idx"
  ON "wallet_intel_runs" ("started_at" DESC);
