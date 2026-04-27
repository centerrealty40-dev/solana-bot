#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
export DATABASE_URL='postgresql://salpha:f5e4930e0586adf71ca193336415351a6f2ac0f6370c538d@localhost:5432/solana_alpha'
export PAPER_TRADES_PATH='/opt/solana-alpha/data/paper2/pt1_fresh_v1.jsonl'
export PAPER_STRATEGY_ID='pt1_fresh_v1'
export PAPER_STRATEGY_KIND='fresh'
export PAPER_ENABLE_LAUNCHPAD_LANE=1
export PAPER_ENABLE_MIGRATION_LANE=0
export PAPER_ENABLE_POST_LANE=0
export PAPER_TP_X=5.0
export PAPER_SL_X=0
export PAPER_TRAIL_DROP=0.5
export PAPER_TRAIL_TRIGGER_X=1.3
export PAPER_TIMEOUT_HOURS=12
exec npx tsx scripts-tmp/live-paper-trader.ts
