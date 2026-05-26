CREATE TABLE IF NOT EXISTS "stream_events" (
  "id"            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "signature"     varchar(96) NOT NULL,
  "slot"          bigint      NOT NULL,
  "program_id"    varchar(64) NOT NULL,
  "kind"          varchar(16) NOT NULL DEFAULT 'log',
  "err"           jsonb,
  "log_count"     integer     NOT NULL DEFAULT 0,
  "payload"       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "received_at"   timestamptz NOT NULL DEFAULT now(),
  "observed_slot" bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS "stream_events_sig_program_uq"
  ON "stream_events" ("signature", "program_id");

CREATE INDEX IF NOT EXISTS "stream_events_received_idx"
  ON "stream_events" ("received_at");

CREATE INDEX IF NOT EXISTS "stream_events_program_received_idx"
  ON "stream_events" ("program_id", "received_at");

CREATE INDEX IF NOT EXISTS "stream_events_slot_idx"
  ON "stream_events" ("slot");
