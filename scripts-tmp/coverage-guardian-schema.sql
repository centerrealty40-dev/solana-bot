-- Coverage Guardian tables.
-- Usage:
--   psql "$DATABASE_URL" -f scripts-tmp/coverage-guardian-schema.sql

CREATE TABLE IF NOT EXISTS coverage_events (
  mint text PRIMARY KEY,
  first_seen_pump timestamptz,
  first_seen_raydium timestamptz,
  first_seen_meteora timestamptz,
  first_seen_orca timestamptz,
  first_seen_moonshot timestamptz,
  first_seen_jupiter timestamptz,
  last_seen timestamptz,
  lifecycle_stage text,
  confidence double precision,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coverage_gaps (
  ts timestamptz NOT NULL,
  mint text NOT NULL,
  gap_type text NOT NULL,
  severity text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS coverage_events_updated_idx
  ON coverage_events (updated_at DESC);

CREATE INDEX IF NOT EXISTS coverage_events_stage_idx
  ON coverage_events (lifecycle_stage);

CREATE INDEX IF NOT EXISTS coverage_events_last_seen_idx
  ON coverage_events (last_seen DESC);

CREATE INDEX IF NOT EXISTS coverage_gaps_ts_idx
  ON coverage_gaps (ts DESC);

CREATE INDEX IF NOT EXISTS coverage_gaps_mint_idx
  ON coverage_gaps (mint);

CREATE INDEX IF NOT EXISTS coverage_gaps_type_idx
  ON coverage_gaps (gap_type);
