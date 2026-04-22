-- Programs registry: catalog of on-chain programs/protocols on Solana.
--
-- Purpose:
--   Strategy B (Infrastructure Frontrunner) needs to know which programs are
--   young, growing, and have predictable on-chain intents (DCA orders, vault
--   unlocks, liquidations, etc.). This table is our working catalog.
--
-- Side-benefit (Strategy A — Data API):
--   Long-term the same table becomes part of a sellable risk-intel product,
--   especially the columns review_status / notes / our_priority that capture
--   our manual research.
--
-- Sources:
--   - 'defillama'  — pulled from api.llama.fi/protocols
--   - 'discovered' — found via on-chain analysis of our wallets
--   - 'manual'     — added by us during deep-dives

CREATE TABLE IF NOT EXISTS "programs" (
  "program_id" varchar(64) PRIMARY KEY,
  "name" varchar(128),
  "slug" varchar(128),
  "category" varchar(64),
  "chain" varchar(16) NOT NULL DEFAULT 'solana',
  "source" varchar(32) NOT NULL,
  "url" text,
  "twitter" varchar(64),
  "listed_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_checked_at" timestamp with time zone NOT NULL DEFAULT now(),

  "tvl_usd" double precision,
  "change_1d" double precision,
  "change_7d" double precision,
  "change_1m" double precision,

  "review_status" varchar(32) NOT NULL DEFAULT 'pending',
  "our_priority" varchar(16) NOT NULL DEFAULT 'medium',
  "edge_type" varchar(64),
  "notes" text,

  "metadata" jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "programs_category_idx"  ON "programs" ("category");
CREATE INDEX IF NOT EXISTS "programs_priority_idx"  ON "programs" ("our_priority");
CREATE INDEX IF NOT EXISTS "programs_status_idx"    ON "programs" ("review_status");
CREATE INDEX IF NOT EXISTS "programs_listed_idx"    ON "programs" ("listed_at");
