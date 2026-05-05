-- W6.14 — scam-farm graph phase B: meta-clusters + treasury/sink linkage (Atlas tags separate).

CREATE TABLE IF NOT EXISTS "scam_farm_meta_clusters" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "fingerprint" varchar(64) NOT NULL,
  "label" text,
  "confidence" integer NOT NULL DEFAULT 50,
  "detection_reason" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "scam_farm_meta_clusters_fingerprint_uq" UNIQUE ("fingerprint")
);

CREATE INDEX IF NOT EXISTS "scam_farm_meta_clusters_updated_idx"
  ON "scam_farm_meta_clusters" ("updated_at");

CREATE TABLE IF NOT EXISTS "scam_farm_meta_cluster_members" (
  "meta_cluster_id" bigint NOT NULL REFERENCES "scam_farm_meta_clusters" ("id") ON DELETE CASCADE,
  "wallet" varchar(64) NOT NULL,
  "role" varchar(24) NOT NULL DEFAULT 'unknown',
  PRIMARY KEY ("meta_cluster_id", "wallet")
);

CREATE INDEX IF NOT EXISTS "scam_farm_meta_cluster_members_wallet_idx"
  ON "scam_farm_meta_cluster_members" ("wallet");

CREATE TABLE IF NOT EXISTS "scam_farm_meta_cluster_candidates" (
  "meta_cluster_id" bigint NOT NULL REFERENCES "scam_farm_meta_clusters" ("id") ON DELETE CASCADE,
  "candidate_id" varchar(64) NOT NULL,
  PRIMARY KEY ("meta_cluster_id", "candidate_id")
);

CREATE INDEX IF NOT EXISTS "scam_farm_meta_cluster_candidates_cand_idx"
  ON "scam_farm_meta_cluster_candidates" ("candidate_id");
