-- W6.12 S03 — mint-scoped sigseed queue (getSignaturesForAddress(mint) → swaps).

CREATE TABLE IF NOT EXISTS "signatures_seed_queue" (
  "mint" varchar(64) PRIMARY KEY NOT NULL,
  "priority" integer NOT NULL DEFAULT 0,
  "last_run_at" timestamp with time zone,
  "sig_cursor" text,
  "runs_count" integer NOT NULL DEFAULT 0,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "error_message" text,
  "enqueued_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "signatures_seed_queue_status_prio_idx"
  ON "signatures_seed_queue" ("status", "priority" DESC, "last_run_at" ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS "signatures_seed_queue_enqueued_at_idx"
  ON "signatures_seed_queue" ("enqueued_at");
