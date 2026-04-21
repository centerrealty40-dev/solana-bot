-- Solana Alpha Research Platform — copy-trader (paper) state
--
-- Stores "first time we saw this mint touched by ANY watchlist wallet" so the
-- copy-trader can implement First-N attribution: only the FIRST watchlist
-- wallet to buy a brand new mint actually opens a paper position. Subsequent
-- buys by other watchlist wallets are treated as follow-the-leader noise.
--
-- The mirror exit logic does NOT need a separate table: it joins back to
-- positions where signal_meta->>'triggerWallet' = wallet of the sell swap.

CREATE TABLE IF NOT EXISTS "copy_seen_mints" (
  "mint" varchar(64) PRIMARY KEY,
  "first_wallet" varchar(64) NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "first_signature" varchar(96)
);

CREATE INDEX IF NOT EXISTS "copy_seen_mints_first_wallet_idx"
  ON "copy_seen_mints" ("first_wallet");
CREATE INDEX IF NOT EXISTS "copy_seen_mints_first_seen_idx"
  ON "copy_seen_mints" ("first_seen_at");

-- Helps the mirror-exit lookup: "find open paper position for this mint
-- opened by hypothesis 'copy_h8' whose triggerWallet matches the seller".
-- We index on (hypothesis_id, status, base_mint) which is already covered by
-- positions_hypo_status_idx + positions_mint_idx; nothing extra needed.
