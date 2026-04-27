-- Solana Alpha Research Platform — add helius_usage ledger
-- Added 2026-04-19 after the program-subscription credit burn incident.

CREATE TABLE IF NOT EXISTS "helius_usage" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "ts" timestamp with time zone NOT NULL DEFAULT now(),
  "kind" varchar(32) NOT NULL,
  "credits_estimate" integer NOT NULL DEFAULT 1,
  "status_code" integer NOT NULL DEFAULT 0,
  "note" text
);
CREATE INDEX IF NOT EXISTS "helius_usage_ts_idx" ON "helius_usage" ("ts");
CREATE INDEX IF NOT EXISTS "helius_usage_kind_ts_idx" ON "helius_usage" ("kind", "ts");
