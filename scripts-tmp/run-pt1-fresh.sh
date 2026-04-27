#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
export DATABASE_URL='postgresql://salpha:f5e4930e0586adf71ca193336415351a6f2ac0f6370c538d@localhost:5432/solana_alpha'
export PAPER_TRADES_PATH='/opt/solana-alpha/data/paper2/pt1_fresh.jsonl'
export PAPER_STRATEGY_ID='pt1_fresh'
export PAPER_STRATEGY_KIND='fresh'
export PAPER_ENABLE_LAUNCHPAD_LANE=1
export PAPER_ENABLE_MIGRATION_LANE=0
export PAPER_ENABLE_POST_LANE=0
exec npx tsx scripts-tmp/live-paper-trader.ts
