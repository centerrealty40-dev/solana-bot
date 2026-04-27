#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
export DATABASE_URL='postgresql://salpha:f5e4930e0586adf71ca193336415351a6f2ac0f6370c538d@localhost:5432/solana_alpha'
export PAPER_TRADES_PATH='/opt/solana-alpha/data/paper2/pt1_dip_runners.jsonl'
export PAPER_STRATEGY_ID='pt1_dip_runners'
export PAPER_STRATEGY_KIND='dip'
export PAPER_POSITION_USD=100

export PAPER_ENABLE_LAUNCHPAD_LANE=0
export PAPER_ENABLE_MIGRATION_LANE=0
export PAPER_ENABLE_POST_LANE=1

# Mature, liquid coins (post-migration runners) — softened to actually find candidates in current market
export PAPER_POST_MIN_AGE_MIN=0
export PAPER_POST_MAX_AGE_MIN=0
export PAPER_POST_MIN_LIQ_USD=8000        # was 20k
export PAPER_POST_MIN_VOL_5M_USD=500      # was 2k
export PAPER_POST_MIN_BUYS_5M=4           # was 10
export PAPER_POST_MIN_SELLS_5M=3          # was 6
# Min ratio buy/sell *count* in 5m (DEX snapshot). Slight 0.98 vs 1.0: allow a hair more 5m sells (micro-soften, not 0.9)
export PAPER_POST_MIN_BS=0.98

# Dip gate: min 5% от 120m high; not-as-deep max; impulse floor
export PAPER_DIP_LOOKBACK_MIN=120
export PAPER_DIP_MIN_DROP_PCT=-5
export PAPER_DIP_MAX_DROP_PCT=-28
export PAPER_DIP_MIN_IMPULSE_PCT=12
export PAPER_DIP_MIN_AGE_MIN=0

# DCA: 2 уровня (от первой цены входа), killstop -22% от средней
export PAPER_DCA_LEVELS='-7:0.5,-15:0.5'  # -7% +50% базы, -15% ещё +50%
export PAPER_DCA_KILLSTOP=-0.22           # final stop: -22% от avg entry
export PAPER_DCA_REQUIRE_ALIVE=1

# TP ladder относительно avg entry: 30% по +5%, 35% по +10%, 25% по +15%, остаток — trailing
export PAPER_TP_LADDER='0.05:0.30,0.10:0.35,0.15:0.25'

# Final exit guards (на остаток после ladder + страховки)
export PAPER_TP_X=2.0                     # +100% — если вдруг улетела (страховка)
export PAPER_SL_X=0                       # killstop уже выше; жёсткого % SL нет
export PAPER_TRAIL_DROP=0.10              # -10% от пика на остаток
export PAPER_TRAIL_TRIGGER_X=1.10         # arm trail с +10% от avg
export PAPER_TIMEOUT_HOURS=1.5            # 90 мин на весь scalp
export PAPER_PEAK_LOG_STEP_PCT=1

# Trading costs (Raydium/Meteora: 0.3% LP fee + ~1.2% slippage on dip entry)
export PAPER_FEE_BPS_PER_SIDE=30
export PAPER_SLIPPAGE_BPS_PER_SIDE=120
export PAPER_CONTEXT_SWAPS=1
export PAPER_CONTEXT_SWAPS_LIMIT=5

# Whale analysis (etap 5) — soft thresholds, log everything, REQUIRE_TRIGGER blocks entries without a whale signal
export PAPER_DIP_WHALE_ANALYSIS_ENABLED=1
export PAPER_DIP_REQUIRE_WHALE_TRIGGER=0
export PAPER_DIP_LARGE_SELL_USD=3000
export PAPER_DIP_RECENT_LOOKBACK_MIN=10
export PAPER_DIP_CAPITULATION_PCT=0.7
export PAPER_DIP_GROUP_SELL_USD=5000
export PAPER_DIP_GROUP_MIN_SELLERS=2
export PAPER_DIP_GROUP_DUMP_PCT=0.4
export PAPER_DIP_BLOCK_CREATOR_DUMP=1
export PAPER_DIP_CREATOR_DUMP_LOOKBACK_MIN=20
export PAPER_DIP_CREATOR_DUMP_MIN_PCT=0.05
export PAPER_DIP_CREATOR_DUMP_MAX_PCT=0.6
export PAPER_DIP_DCA_PRED_MIN_SELLS_24H=4
export PAPER_DIP_DCA_PRED_MIN_INTERVAL_MIN=30
export PAPER_DIP_DCA_PRED_MIN_CHUNK_USD=3000
export PAPER_DIP_DCA_AGGR_MIN_SELLS_24H=6
export PAPER_DIP_DCA_AGGR_MAX_INTERVAL_MIN=15

# Per-mint cooldown
export PAPER_DIP_COOLDOWN_MIN=120
export PAPER_DIP_COOLDOWN_MIN_SCALP=20

# Faster discovery — try to react inside 10s of red candle
export PAPER_DISCOVERY_INTERVAL_MS=10000

exec npx tsx scripts-tmp/live-paper-trader.ts
