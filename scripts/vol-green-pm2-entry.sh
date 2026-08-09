#!/usr/bin/env bash
# PM2 6 does not parse ecosystem.vol-green.cjs as an ecosystem file — use this entry.
#   pm2 start scripts/vol-green-pm2-entry.sh --name vol-green-bot --interpreter bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Manual kill-switch — do not trade while this file exists (user liquidating).
if [[ -f "$ROOT/data/volgreen/DISABLED" ]]; then
  echo "[vol-green-pm2-entry] REFUSING START: $ROOT/data/volgreen/DISABLED" >&2
  cat "$ROOT/data/volgreen/DISABLED" >&2 || true
  exit 78
fi

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
export VOL_GREEN_APP_NAME="${VOL_GREEN_APP_NAME:-vol-green-bot}"
export VOL_GREEN_ENTRY_MODE="${VOL_GREEN_ENTRY_MODE:-green_tape}"
export MILD_DIP_ENTRY_MODE="${MILD_DIP_ENTRY_MODE:-$VOL_GREEN_ENTRY_MODE}"
export VOL_GREEN_EXECUTION_MODE="${VOL_GREEN_EXECUTION_MODE:-live}"
export VOL_GREEN_WALLET_SECRET="${VOL_GREEN_WALLET_SECRET:-$ROOT/data/live/copy-8zkg.keypair.json}"
export VOL_GREEN_WALLET_PUBKEY="${VOL_GREEN_WALLET_PUBKEY:-FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX}"
export VOL_GREEN_POSITION_USD="${VOL_GREEN_POSITION_USD:-5}"
# Trackable concurrency — max 10 opens; free slot after each full exit.
export VOL_GREEN_MAX_OPEN_POSITIONS=10
export MILD_DIP_MAX_OPEN_POSITIONS=10
export VOL_GREEN_JOURNAL_PATH="${VOL_GREEN_JOURNAL_PATH:-$ROOT/data/volgreen/journal.jsonl}"
export VOL_GREEN_STATE_PATH="${VOL_GREEN_STATE_PATH:-$ROOT/data/volgreen/state.json}"
export VOL_GREEN_HOT_MINTS_PATH="${VOL_GREEN_HOT_MINTS_PATH:-$ROOT/data/volgreen/hot-mints.json}"
export VOL_GREEN_PRICE_RING_PATH="${VOL_GREEN_PRICE_RING_PATH:-$ROOT/data/volgreen/price-ring.json}"
# HARD-SET Oscar exit stack (CF: −$20 vs prior −$60 on green trades).
# Armed: mfeBank +8%×40% / +15%×40% / sleeve −12%. Never-arm: bounce + time_red 15m/−5%.
# Stale/dead/vol_fade/maxHold OFF (stale was the green-bot profit killer).
export MILD_DIP_EXIT_ARM_PCT=5
export MILD_DIP_EXIT_MFE_BANK=1
export MILD_DIP_EXIT_MFE_BANK1_PCT=8
export MILD_DIP_EXIT_MFE_BANK1_FRACTION=0.4
export MILD_DIP_EXIT_MFE_BANK2_PCT=15
export MILD_DIP_EXIT_MFE_BANK2_FRACTION=0.4
export MILD_DIP_EXIT_MFE_BANK_SLEEVE_GIVEBACK_PCT=12
export MILD_DIP_EXIT_PARTIAL_GIVEBACK_PCT=3
export MILD_DIP_EXIT_SCALE_OUT_FRACTION=0.5
export MILD_DIP_EXIT_GIVEBACK_PCT=8
# Hard SL −15% from entry (point of no return in stable-window CF backtest).
export MILD_DIP_EXIT_CLIFF_DUMP_PNL_PCT=15
export MILD_DIP_EXIT_NEVER_ARM_PATIENCE_MS=0
export MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS=0
export MILD_DIP_EXIT_NEVER_ARM_DEAD_MIN_MS=0
export MILD_DIP_EXIT_NEVER_ARM_VOL_FADE_MIN_MS=0
# Hold blend of leaders (~10m / ~30m) if never armed — see leader-tape gate.
export MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS=1200000
# Hard ceiling for ALL opens (armed too) — kill zombie bags at 30m.
export MILD_DIP_EXIT_HARD_MAX_HOLD_MS=1800000
export MILD_DIP_EXIT_NEVER_ARM_FREEFALL_PNL_PCT=0
export MILD_DIP_EXIT_NEVER_ARM_FREEFALL_MIN_MS=0
export MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_DUMP_PCT=8
export MILD_DIP_EXIT_NEVER_ARM_BOUNCE_PCT=8
export MILD_DIP_EXIT_NEVER_ARM_BOUNCE_MIN_TROUGH_AGE_MS=60000
export MILD_DIP_EXIT_NEVER_ARM_BOUNCE_REQUIRE_RED_PCT=3
export MILD_DIP_EXIT_NEVER_ARM_TIME_RED_MIN_MS=900000
export MILD_DIP_EXIT_NEVER_ARM_TIME_RED_PNL_PCT=5
export VOL_GREEN_EXIT_ARM_PCT=5
export VOL_GREEN_EXIT_MFE_BANK=1
export VOL_GREEN_SLIPPAGE_BPS="${VOL_GREEN_SLIPPAGE_BPS:-500}"
export VOL_GREEN_ALLOWED_DEX_IDS="${VOL_GREEN_ALLOWED_DEX_IDS:-pumpswap,pumpfun,raydium}"
export VOL_GREEN_MIN_FEE_SOL_RESERVE="${VOL_GREEN_MIN_FEE_SOL_RESERVE:-0.02}"
# Stream → local 1m impulse → buy. No Dex/Gecko enrich. No leader-follow.
export VOL_GREEN_STREAM=1
export MILD_DIP_STREAM=1
export MILD_DIP_STREAM_IMPULSE_ONLY=1
export VOL_GREEN_STREAM_IMPULSE_ONLY=1
export MILD_DIP_STREAM_PROGRAM_IDS=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
export VOL_GREEN_DISCOVER_SOURCES=stream
export MILD_DIP_DISCOVER_SOURCES=stream
export MILD_DIP_STREAM_PRICE_SAMPLE=1
export MILD_DIP_STREAM_PRICE_CONCURRENCY=5
export MILD_DIP_STREAM_PRICE_MIN_GAP_MS=500
# Resolve headroom — queue48@100/min was blind (250k+ droppedOverflow).
export MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN=250
export MILD_DIP_BUY_MINT_RESOLVE_CONCURRENCY=8
export MILD_DIP_BUY_MINT_RESOLVE_QUEUE_MAX=250
export MILD_DIP_MINT_PRICE_REFRESH=1
# Mark fat stream buys for priority only — ENTRY on notional is OFF (rug magnet).
export MILD_DIP_VOLUME_IMPULSE_MIN_SOL=2
export MILD_DIP_VOLUME_IMPULSE_ENTRY=0
export VOL_GREEN_VOLUME_IMPULSE_ENTRY=0
# Scam ladder: late monotonic grind → never enter (see src/volgreen/scam-ladder.ts).
export MILD_DIP_SCAM_LADDER=1
export MILD_DIP_SCAM_LADDER_MIN_AGE_MIN=25
export MILD_DIP_SCAM_LADDER_MAX_STEP_PC=4
export MILD_DIP_SCAM_LADDER_MIN_CUM_PC=12
export MILD_DIP_SCAM_LADDER_MAX_BAR_PC=10
export MILD_DIP_PRICE_RING_TTL_MS=5400000
export MILD_DIP_PRICE_RING_MAX_SAMPLES=360
# Leader-like tape: real 1m history + maxG/runup band (reject thin-ring fakes).
export MILD_DIP_LEADER_TAPE=1
export VOL_GREEN_LEADER_TAPE=1
export MILD_DIP_LEADER_TAPE_MAX_G_PC=8
export MILD_DIP_LEADER_TAPE_RUNUP_PC=10
export MILD_DIP_LEADER_TAPE_MAX_G_BARS=5
export MILD_DIP_LEADER_TAPE_RUNUP_MS=1500000
export MILD_DIP_LEADER_TAPE_MIN_BARS=4
export MILD_DIP_LEADER_TAPE_MIN_SAMPLES=8
export MILD_DIP_LEADER_TAPE_MIN_SPAN_MS=180000
export MILD_DIP_LEADER_TAPE_MAX_G_MAX_PC=40
export MILD_DIP_LEADER_TAPE_RUNUP_MAX_PC=80
export MILD_DIP_FORCE_ENRICH_FIRST_SEEN_PER_MIN=0
# Leaders are for offline pattern research only — do NOT follow/copy in live.
export VOL_GREEN_LEADER_WATCH=0
export VOL_GREEN_LEADER_WATCH_WALLETS=7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5,8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ
export MILD_DIP_LEADER_WATCH_WALLETS=7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5,8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ
export MILD_DIP_LEADER_RESOLVE_MAX_PER_MIN=0
# Independent entry — patterns from leaders are encoded in tape/poison gates, not copy.
export VOL_GREEN_REQUIRE_LEADER_HIGHLIGHT=0
export MILD_DIP_REQUIRE_LEADER_HIGHLIGHT=0
# Don't chase already-vertical 5m prints (CXaS scam: entry pc5m 54%).
export MILD_DIP_ENTRY_MAX_PC5M_PCT=40
export VOL_GREEN_ENTRY_MAX_PC5M_PCT=40
# Poison window: ban after nuke/crash tape (tuned so memes still trade).
export VOL_GREEN_POISON_TAPE=1
export MILD_DIP_POISON_TAPE=1
export MILD_DIP_POISON_TAPE_BAN_MS=900000
export MILD_DIP_POISON_TAPE_ABS_BAR_PC=60
export MILD_DIP_POISON_TAPE_MAX_G_PC=60
export MILD_DIP_POISON_TAPE_RUNUP_PC=100
export MILD_DIP_STREAM_HEALTH_ALERT=1
export MILD_DIP_STREAM_HEALTH_ALERT_COOLDOWN_MS=600000
# Enrich unused when streamImpulseOnly — keep tiny values if flag flipped off.
export MILD_DIP_ENRICH_CONCURRENCY=1
export MILD_DIP_PROBE_ENRICH_MAX=1
export MILD_DIP_MAX_ENRICH=1
export MILD_DIP_ENRICH_BUDGET_MS=3000
export MILD_DIP_SCAN_INTERVAL_MS=1000
export VOL_GREEN_MAX_CHASE_PCT=12
export MILD_DIP_MAX_CHASE_PCT=12
export LIVE_BUY_MAX_CHASE_PCT=12
export MILD_DIP_GREEN_SHORT_RED_WINDOW_MS=60000
export MILD_DIP_JOURNAL_ENTRY_SKIPS="${MILD_DIP_JOURNAL_ENTRY_SKIPS:-1}"
export MILD_DIP_GREEN_MIN_LIQUIDITY_USD=8000
export MILD_DIP_GREEN_MIN_MCAP_USD=12000
# Soft age 9m; activity-aged (vol5m≥20k + liq/mcap floors) may enter earlier.
export MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS=0.15
export MILD_DIP_GREEN_MAX_PAIR_AGE_HOURS=0
export MILD_DIP_GREEN_TRIPLE_ONLY=1
export MILD_DIP_GREEN_TRIPLE_SMALL_MIN_PC=1
export MILD_DIP_GREEN_TRIPLE_SMALL_MAX_PC=18
export MILD_DIP_GREEN_TRIPLE_HUGE_MIN_PC=10
export MILD_DIP_GREEN_TRIPLE_HUGE_MIN_VOL_USD=100
export MILD_DIP_GREEN_TRIPLE_MAX_AGE_AFTER_HUGE_MS=240000
# First-strong aligns with leader maxG (≥8%), not tip-chase +20%.
export MILD_DIP_GREEN_FIRST_STRONG_MIN_PC=8
export MILD_DIP_GREEN_FIRST_STRONG_MAX_PRIOR_PC=18
export MILD_DIP_GREEN_IMPULSE_MIN_PC5M_PCT=0
export MILD_DIP_GREEN_LIQUID_MIN_PC5M_PCT=0
export MILD_DIP_GREEN_EARLY_MIN_PC5M_PCT=0
export MILD_DIP_GREEN_ROCKET_MIN_PC5M_PCT=0
export MILD_DIP_GREEN_LIQUID_TAPE_MIN_LIQUIDITY_USD=0
export LIVE_BUY_MAX_ROUTE_HOPS="${LIVE_BUY_MAX_ROUTE_HOPS:-3}"
export DEX_QUOTE_CACHE_ENABLED=0
export DEXSCREENER_GLOBAL_RATE_LIMIT=1
export DEXSCREENER_GLOBAL_MAX_RPM=90
export DEXSCREENER_GATE_ENABLED=1
export DEXSCREENER_MAX_RPM=90
export JUPITER_GLOBAL_MAX_RPS="${JUPITER_GLOBAL_MAX_RPS:-6}"
# Jupiter buy: impact 2% (was 1% — blocked ~62% of impact rejects at ≤2%).
export LIVE_BUY_MAX_PRICE_IMPACT_PCT="${LIVE_BUY_MAX_PRICE_IMPACT_PCT:-2}"
# Quote premium vs signal — looser than chase (chase stays 5% on prebuy mark).
export MILD_DIP_QUOTE_PREMIUM_GUARD_PCT="${MILD_DIP_QUOTE_PREMIUM_GUARD_PCT:-12}"
export VOL_GREEN_QUOTE_PREMIUM_GUARD_PCT="${VOL_GREEN_QUOTE_PREMIUM_GUARD_PCT:-$MILD_DIP_QUOTE_PREMIUM_GUARD_PCT}"
export LIVE_JUPITER_SWAP_PRIORITY_LEVEL="${LIVE_JUPITER_SWAP_PRIORITY_LEVEL:-medium}"
export LIVE_JUPITER_PRIORITY_MAX_SOL="${LIVE_JUPITER_PRIORITY_MAX_SOL:-0.00005}"
# Sell: rebuild quote+blockhash on sim/rpc fails (BlockhashNotFound must not wait for next mark).
export LIVE_SELL_SIM_RETRY_ATTEMPTS="${LIVE_SELL_SIM_RETRY_ATTEMPTS:-15}"
export LIVE_SELL_SIM_RETRY_DELAY_MS="${LIVE_SELL_SIM_RETRY_DELAY_MS:-150}"
export LIVE_SIM_REPLACE_RECENT_BLOCKHASH="${LIVE_SIM_REPLACE_RECENT_BLOCKHASH:-1}"
export SOLANA_RPC_HELIUS_PREFER="${SOLANA_RPC_HELIUS_PREFER:-1}"

if [[ -n "${HELIUS_RPC_URL:-}" ]]; then
  export VOL_GREEN_RPC_URL="${VOL_GREEN_RPC_URL:-$HELIUS_RPC_URL}"
  export MILD_DIP_RPC_URL="${MILD_DIP_RPC_URL:-$HELIUS_RPC_URL}"
  export SA_RPC_HTTP_URL="${SA_RPC_HTTP_URL:-$HELIUS_RPC_URL}"
  export SOLANA_RPC_HTTP_URL="${SOLANA_RPC_HTTP_URL:-$HELIUS_RPC_URL}"
fi

mkdir -p "$(dirname "$VOL_GREEN_JOURNAL_PATH")" "$(dirname "$VOL_GREEN_STATE_PATH")" data/ops-heartbeats

# Reproducible undici check — do NOT --no-save band-aid. Prefer full npm ci.
# Code also falls back to globalThis.fetch if undici is broken mid-tick.
if [[ ! -f "$ROOT/node_modules/undici/index.js" ]]; then
  echo "[vol-green-pm2-entry] FATAL: node_modules/undici/index.js missing — run: npm ci" >&2
  exit 1
fi

exec npm run --silent vol-green-bot
