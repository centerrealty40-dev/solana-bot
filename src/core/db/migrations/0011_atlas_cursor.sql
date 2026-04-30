CREATE TABLE IF NOT EXISTS "atlas_cursor" (
  "name"              varchar(48) PRIMARY KEY,
  "last_swap_id"      bigint     NOT NULL DEFAULT 0,
  "last_processed_at" timestamptz NOT NULL DEFAULT now(),
  "stats"             jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "swaps_created_at_idx" ON "swaps" ("created_at");
