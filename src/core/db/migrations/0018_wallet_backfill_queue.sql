-- W6.12 S02 — очередь wallet-centric backfill (swaps / money_flows).

CREATE TABLE IF NOT EXISTS "wallet_backfill_queue" (
  "address" varchar(64) PRIMARY KEY NOT NULL,
  "priority" integer NOT NULL DEFAULT 0,
  "last_run_at" timestamp with time zone,
  "sig_cursor" text,
  "runs_count" integer NOT NULL DEFAULT 0,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "error_message" text
);

CREATE INDEX IF NOT EXISTS "wallet_backfill_queue_status_prio_idx"
  ON "wallet_backfill_queue" ("status", "priority" DESC, "last_run_at" ASC NULLS FIRST);
