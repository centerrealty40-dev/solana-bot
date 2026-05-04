-- W6.12 S01 — единый дневной учёт QuickNode-кредитов для тяжёлых ingest-процессов.

CREATE TABLE IF NOT EXISTS "sa_qn_global_daily" (
  "usage_date" date PRIMARY KEY NOT NULL,
  "credits_used" bigint NOT NULL DEFAULT 0,
  "by_component" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sa_qn_global_daily_updated_idx"
  ON "sa_qn_global_daily" ("updated_at" DESC);
