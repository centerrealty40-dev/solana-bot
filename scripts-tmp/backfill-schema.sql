-- 60d public RPC backfill state.
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/backfill-schema.sql

CREATE TABLE IF NOT EXISTS backfill_runs (
  id bigserial PRIMARY KEY,
  name text,
  target_days int,
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  status text,
  meta jsonb
);

CREATE TABLE IF NOT EXISTS backfill_signatures (
  signature text PRIMARY KEY,
  program text,
  slot bigint,
  block_time timestamptz,
  status text DEFAULT 'queued',
  attempts int DEFAULT 0,
  last_error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backfill_signatures_status_block_time_idx
  ON backfill_signatures (status, block_time);

CREATE INDEX IF NOT EXISTS backfill_signatures_program_block_time_idx
  ON backfill_signatures (program, block_time);
