-- W9.0 — dip_bot intelligence: observations from Live Oscar anchors + promotion to wallet_tags

CREATE TABLE IF NOT EXISTS "dip_bot_intel_state" (
  "id" smallint PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "last_jsonl_offset_bytes" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

INSERT INTO "dip_bot_intel_state" ("id", "last_jsonl_offset_bytes")
VALUES (1, 0)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "dip_bot_intel_anchors_processed" (
  "anchor_mint" varchar(64) NOT NULL,
  "anchor_entry_ts_ms" bigint NOT NULL,
  "processed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "buyer_rows" integer NOT NULL DEFAULT 0,
  "swaps_rows_used" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("anchor_mint", "anchor_entry_ts_ms")
);

CREATE INDEX IF NOT EXISTS "dip_bot_intel_anchors_processed_at_idx"
  ON "dip_bot_intel_anchors_processed" ("processed_at");

CREATE TABLE IF NOT EXISTS "dip_bot_intel_observations" (
  "wallet" varchar(64) NOT NULL,
  "anchor_mint" varchar(64) NOT NULL,
  "anchor_entry_ts_ms" bigint NOT NULL,
  "buy_usd" double precision NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("wallet", "anchor_mint", "anchor_entry_ts_ms")
);

CREATE INDEX IF NOT EXISTS "dip_bot_intel_observations_wallet_idx"
  ON "dip_bot_intel_observations" ("wallet");
