-- Drop legacy hypothesis / runner / scoring / paper-trader tables (W2 slim schema).
-- Idempotent; CASCADE clears FK from trades -> positions.

DROP TABLE IF EXISTS "trades" CASCADE;
DROP TABLE IF EXISTS "positions" CASCADE;
DROP TABLE IF EXISTS "signals" CASCADE;
DROP TABLE IF EXISTS "wallet_scores" CASCADE;
DROP TABLE IF EXISTS "holder_snapshots" CASCADE;
DROP TABLE IF EXISTS "price_samples" CASCADE;
DROP TABLE IF EXISTS "watchlist_wallets" CASCADE;
DROP TABLE IF EXISTS "helius_usage" CASCADE;
DROP TABLE IF EXISTS "copy_seen_mints" CASCADE;
DROP TABLE IF EXISTS "daily_pnl" CASCADE;
DROP TABLE IF EXISTS "paper_trades" CASCADE;
DROP TABLE IF EXISTS "sanctum_snapshots" CASCADE;
