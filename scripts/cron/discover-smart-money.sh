#!/usr/bin/env bash
# Daily discover-smart-money: load .env from repo root, log under data/logs.
# Install (salpha user, example 03:15 UTC):
#   (crontab -l 2>/dev/null; echo '15 3 * * * /opt/solana-alpha/scripts/cron/discover-smart-money.sh') | crontab -
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
LOG_DIR="${ROOT}/data/logs"
mkdir -p "$LOG_DIR"
LOG="${LOG_DIR}/discover-smart-money.log"
# Optional: override in crontab, e.g. MAX_CANDIDATES=30 DRY_RUN=0
export NODE_ENV="${NODE_ENV:-production}"

# Понижаем пороги, иначе на нашей небольшой БД свопов скрипт находит 0 wallets.
# Цель — пополнять атлас smart_money тегами для smart-lottery / fresh_validated.
export LOOKBACK_DAYS="${LOOKBACK_DAYS:-30}"
export MIN_GOOD_HITS="${MIN_GOOD_HITS:-2}"
export MIN_RUNNER_MCAP_USD="${MIN_RUNNER_MCAP_USD:-50000}"
export EARLY_WINDOW_MIN="${EARLY_WINDOW_MIN:-15}"
export MAX_CANDIDATES="${MAX_CANDIDATES:-200}"
export DRY_RUN="${DRY_RUN:-0}"

# DB and tuning come from .env in repo root; loaded by `dotenv` in the TS entrypoint (do not `source` .env here — some lines can break `bash`).
{
  echo "=== $(date -Iseconds) ==="
  ./node_modules/.bin/tsx src/scripts/discover-smart-money.ts
} >>"$LOG" 2>&1
