#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
export DATABASE_URL='postgresql://salpha:f5e4930e0586adf71ca193336415351a6f2ac0f6370c538d@localhost:5432/solana_alpha'
export PAPER_TRADES_PATH='/opt/solana-alpha/data/paper2/pt1_smart_lottery.jsonl'
export PAPER_STRATEGY_ID='pt1_smart_lottery'
export PAPER_STRATEGY_KIND='smart_lottery'
export PAPER_POSITION_USD=100

# Smart-lottery: only enter when atlas finds a smart-tagged buyer in the early window
# AND there is no scam tag in the same early buyers.
# Расширяем early-окно с 5 до 15 мин и ловим до 100 первых покупателей (вместо 30),
# чтобы повысить шанс встретить known smart-wallet (атлас пока маленький).
export PAPER_SMART_WINDOW_MIN=15
export PAPER_SMART_MIN_AGE_MIN=3
export PAPER_SMART_MAX_AGE_MIN=45
export PAPER_SMART_EARLY_LIMIT=100
export PAPER_SMART_MIN_AMOUNT_USD=1

# Источники свежих токенов: pumpfun + post-mig DEX-ы + dexscreener_seed + direct_lp,
# а также токены без явного source (некоторые pumpswap-мынты ещё не размечены).
# Чтобы отключить фильтр совсем — установить PAPER_SMART_SOURCE_FILTER=0.
export PAPER_SMART_SOURCES='pumpportal,moonshot,bonk,pumpswap,raydium,meteora,orca,dexscreener_seed,direct_lp'

# Tags taken from our wallet atlas. As atlas grows (more smart_money / smart_trader),
# this strategy will see more candidates.
export PAPER_SMART_TAGS='smart_money,smart_trader,whale,sniper,meme_flipper,rotation_node'
export PAPER_SCAM_TAGS='scam_operator,scam_proxy,scam_treasury,scam_payout,bot_farm_distributor,bot_farm_boss,gas_distributor,terminal_distributor,insider'

# Lottery exits — give it room
export PAPER_TP_X=20.0          # +1900%, real moonshot
export PAPER_SL_X=0             # no hard SL
export PAPER_TRAIL_DROP=0.5     # -50% from peak
export PAPER_TRAIL_TRIGGER_X=5.0 # arm trailing only AFTER 5x
export PAPER_TIMEOUT_HOURS=48
export PAPER_PEAK_LOG_STEP_PCT=1

# Trading costs (pump.fun bonding curve: 1% pool fee + ~2% slippage on early swaps)
export PAPER_FEE_BPS_PER_SIDE=100
export PAPER_SLIPPAGE_BPS_PER_SIDE=200
export PAPER_CONTEXT_SWAPS=1
export PAPER_CONTEXT_SWAPS_LIMIT=5

exec npx tsx scripts-tmp/live-paper-trader.ts
