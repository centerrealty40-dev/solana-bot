CREATE TABLE IF NOT EXISTS "parser_cursor" (
  "program_id"        varchar(64) PRIMARY KEY,
  "last_event_id"     bigint     NOT NULL DEFAULT 0,
  "last_signature"    varchar(96),
  "last_slot"         bigint,
  "last_processed_at" timestamptz NOT NULL DEFAULT now(),
  "stats"             jsonb       NOT NULL DEFAULT '{}'::jsonb
);
