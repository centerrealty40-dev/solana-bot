#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
export DATABASE_URL='postgresql://salpha:f5e4930e0586adf71ca193336415351a6f2ac0f6370c538d@localhost:5432/solana_alpha'
export PAPER_TRADES_PATH='/opt/solana-alpha/data/paper2/pt1_fresh_validated.jsonl'
export PAPER_STRATEGY_ID='pt1_fresh_validated'
export PAPER_STRATEGY_KIND='fresh_validated'
export PAPER_POSITION_USD=100

# === Lane 1: launchpad_early (pumpfan/pumpportal pre-migration) ===
# Token age window: skip first 30 min ("snipers/launch noise"), drop after 3h
export PAPER_FV_MIN_AGE_MIN=30
export PAPER_FV_MAX_AGE_MIN=180

# Quality gates (расширены — больше мусора, больше базы для анализа)
export PAPER_FV_MIN_HOLDERS=80
export PAPER_FV_MIN_LIQ_USD_PROXY=5000
export PAPER_FV_MIN_VOL5M_USD=800
export PAPER_FV_MIN_BS_5M=1.15
export PAPER_FV_MAX_TOP_SHARE=0.30

# Dynamics: must be growing vs early window (+30% от цены 10-15 мин назад)
export PAPER_FV_MIN_GROWTH=0.30
export PAPER_FV_EARLY_FROM_MIN=10
export PAPER_FV_EARLY_TO_MIN=15

# === Lane 2: post_migration (raydium/meteora/pumpswap) — новый поток ===
# Использует data из *_pair_snapshots (DexScreener), не жжёт QuickNode.
export PAPER_FV_POSTMIG_ENABLED=1
export PAPER_FV_POSTMIG_MIN_AGE_MIN=30
export PAPER_FV_POSTMIG_MAX_AGE_MIN=360
export PAPER_FV_POSTMIG_MIN_LIQ_USD=15000
export PAPER_FV_POSTMIG_MIN_VOL5M_USD=3000
export PAPER_FV_POSTMIG_MIN_BUYS_5M=8
export PAPER_FV_POSTMIG_MIN_BS=1.2
export PAPER_FV_POSTMIG_MIN_MC_USD=100000
export PAPER_FV_POSTMIG_MAX_MC_USD=20000000

# Anti-scam tags from our atlas
export PAPER_SCAM_TAGS='scam_operator,scam_proxy,scam_treasury,scam_payout,bot_farm_distributor,bot_farm_boss,gas_distributor,terminal_distributor,insider'

# Exits: small/frequent TP, real SL, modest trail
export PAPER_TP_X=1.5             # +50%
export PAPER_SL_X=0.75            # -25%
export PAPER_TRAIL_DROP=0.20      # -20% from peak
export PAPER_TRAIL_TRIGGER_X=1.30 # arm trail after +30%
export PAPER_TIMEOUT_HOURS=4
export PAPER_PEAK_LOG_STEP_PCT=1

# Trading costs (pump.fun / amm)
export PAPER_FEE_BPS_PER_SIDE=100
export PAPER_SLIPPAGE_BPS_PER_SIDE=200
export PAPER_CONTEXT_SWAPS=1
export PAPER_CONTEXT_SWAPS_LIMIT=5

exec npx tsx scripts-tmp/live-paper-trader.ts
