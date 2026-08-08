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
export VOL_GREEN_MAX_OPEN_POSITIONS="${VOL_GREEN_MAX_OPEN_POSITIONS:-0}"
export VOL_GREEN_JOURNAL_PATH="${VOL_GREEN_JOURNAL_PATH:-$ROOT/data/volgreen/journal.jsonl}"
export VOL_GREEN_STATE_PATH="${VOL_GREEN_STATE_PATH:-$ROOT/data/volgreen/state.json}"
export VOL_GREEN_HOT_MINTS_PATH="${VOL_GREEN_HOT_MINTS_PATH:-$ROOT/data/volgreen/hot-mints.json}"
export VOL_GREEN_PRICE_RING_PATH="${VOL_GREEN_PRICE_RING_PATH:-$ROOT/data/volgreen/price-ring.json}"
# HARD-SET exit widths — hold more drawdown; peel 50% on first stale/giveback.
export VOL_GREEN_EXIT_ARM_PCT=5
export VOL_GREEN_EXIT_GIVEBACK_PCT=5
export VOL_GREEN_EXIT_PARTIAL_SELL_FRACTION=0.5
export VOL_GREEN_EXIT_SECOND_GIVEBACK_PCT=8
export MILD_DIP_EXIT_ARM_PCT=5
export MILD_DIP_EXIT_GIVEBACK_PCT=5
export MILD_DIP_EXIT_PARTIAL_SELL_FRACTION=0.5
export MILD_DIP_EXIT_SECOND_GIVEBACK_PCT=8
# Trail unlock after MFE≥8% (was 12 — too late vs never_arm_stale).
export MILD_DIP_EXIT_MIN_MFE_BEFORE_TRAIL_PCT=8
export VOL_GREEN_EXIT_MIN_MFE_BEFORE_TRAIL_PCT=8
# Stale: wait 150s (was 75); first hit = 50% peel, 2× window dumps rest.
export MILD_DIP_EXIT_NEVER_ARM_STALE_MIN_MS=150000
export MILD_DIP_EXIT_NEVER_ARM_STALE_MAX_MFE_PCT=5
export VOL_GREEN_EXIT_NEVER_ARM_PATIENCE_MS="${VOL_GREEN_EXIT_NEVER_ARM_PATIENCE_MS:-0}"
export VOL_GREEN_EXIT_NEVER_ARM_DEAD_MIN_MS="${VOL_GREEN_EXIT_NEVER_ARM_DEAD_MIN_MS:-900000}"
export VOL_GREEN_EXIT_NEVER_ARM_DEAD_PNL_PCT="${VOL_GREEN_EXIT_NEVER_ARM_DEAD_PNL_PCT:-15}"
export VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_MIN_MS="${VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_MIN_MS:-600000}"
export VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_RATIO="${VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_RATIO:-0.35}"
export VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD="${VOL_GREEN_EXIT_NEVER_ARM_VOL_FADE_FLOOR_USD:-500}"
# HARD-SET 10m absolute hold — spike book must not sit for hours (armed or not).
export VOL_GREEN_EXIT_NEVER_ARM_MAX_HOLD_MS=600000
export MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS=600000
export VOL_GREEN_EXIT_MAX_HOLD_MS=600000
export MILD_DIP_EXIT_MAX_HOLD_MS=600000
export VOL_GREEN_SLIPPAGE_BPS="${VOL_GREEN_SLIPPAGE_BPS:-500}"
export VOL_GREEN_ALLOWED_DEX_IDS="${VOL_GREEN_ALLOWED_DEX_IDS:-pumpswap,pumpfun,raydium}"
export VOL_GREEN_DISCOVER_SOURCES="${VOL_GREEN_DISCOVER_SOURCES:-stream}"
export VOL_GREEN_STREAM="${VOL_GREEN_STREAM:-1}"
export VOL_GREEN_MIN_FEE_SOL_RESERVE="${VOL_GREEN_MIN_FEE_SOL_RESERVE:-0.02}"
export MILD_DIP_DISCOVER_SOURCES="${MILD_DIP_DISCOVER_SOURCES:-$VOL_GREEN_DISCOVER_SOURCES}"
# Fast enrich — HARD-SET (ignore sticky .env). Old 4/48/40s/5s caused +45s leader lag.
# At 120 RPM (2/s), probe 28 needs ≥14s — budget must finish or race returns 0 candidates.
export MILD_DIP_ENRICH_CONCURRENCY=10
export MILD_DIP_PROBE_ENRICH_MAX=20
export MILD_DIP_MAX_ENRICH=14
# HARD-SET 22s — 15s was always overrun once buyForce inflated probe (SPEC RCA).
export MILD_DIP_ENRICH_BUDGET_MS=22000
export MILD_DIP_SCAN_INTERVAL_MS=2000
export MILD_DIP_FORCE_ENRICH_FIRST_SEEN_PER_MIN=6
# HARD-SET: resolve mint via getTransaction when Buy/Sell logs omit it (AGbfomct miss).
export MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN=40
export MILD_DIP_BUY_MINT_RESOLVE_CONCURRENCY=3
export MILD_DIP_GREEN_SHORT_RED_WINDOW_MS=60000
export MILD_DIP_JOURNAL_ENTRY_SKIPS="${MILD_DIP_JOURNAL_ENTRY_SKIPS:-1}"
# Structural floors (triple_green still needs a real book).
export MILD_DIP_GREEN_MIN_LIQUIDITY_USD=8000
export MILD_DIP_GREEN_MIN_MCAP_USD=18000
# HARD-SET: no 2-minute newborns (0.5h = 30m).
export MILD_DIP_GREEN_MIN_PAIR_AGE_HOURS=0.5
export MILD_DIP_GREEN_MAX_PAIR_AGE_HOURS=0
# HARD-SET: ONLY 1m small→small→huge (Prometheus / 8zkg). All other paths OFF.
export MILD_DIP_GREEN_TRIPLE_ONLY=1
export MILD_DIP_GREEN_TRIPLE_SMALL_MIN_PC=2
export MILD_DIP_GREEN_TRIPLE_SMALL_MAX_PC=12
export MILD_DIP_GREEN_TRIPLE_HUGE_MIN_PC=20
export MILD_DIP_GREEN_TRIPLE_HUGE_MIN_VOL_USD=200
export MILD_DIP_GREEN_TRIPLE_MAX_AGE_AFTER_HUGE_MS=180000
export MILD_DIP_GREEN_IMPULSE_MIN_PC5M_PCT=0
export MILD_DIP_GREEN_LIQUID_MIN_PC5M_PCT=0
export MILD_DIP_GREEN_EARLY_MIN_PC5M_PCT=0
export MILD_DIP_GREEN_ROCKET_MIN_PC5M_PCT=0
export MILD_DIP_GREEN_LIQUID_TAPE_MIN_LIQUIDITY_USD=0
# Chase allow up to 5%; still block Jupiter routes with hops≥3.
export VOL_GREEN_MAX_CHASE_PCT="${VOL_GREEN_MAX_CHASE_PCT:-5}"
export MILD_DIP_MAX_CHASE_PCT="${MILD_DIP_MAX_CHASE_PCT:-5}"
export LIVE_BUY_MAX_CHASE_PCT="${LIVE_BUY_MAX_CHASE_PCT:-5}"
export LIVE_BUY_MAX_ROUTE_HOPS="${LIVE_BUY_MAX_ROUTE_HOPS:-3}"
# Sole Dex consumer on LERA — skip cross-process quote-cache file locks.
export DEX_QUOTE_CACHE_ENABLED="${DEX_QUOTE_CACHE_ENABLED:-0}"
# Quote-cache gate reads GLOBAL_* names (not DEXSCREENER_MAX_RPM).
# Sole Dex consumer on LERA — raise RPM so probe 20 finishes in ~7s (was 120→14s for 28).
export DEXSCREENER_GLOBAL_RATE_LIMIT=1
export DEXSCREENER_GLOBAL_MAX_RPM=180
export DEXSCREENER_GATE_ENABLED=1
export DEXSCREENER_MAX_RPM=180
export JUPITER_GLOBAL_MAX_RPS="${JUPITER_GLOBAL_MAX_RPS:-9}"
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
