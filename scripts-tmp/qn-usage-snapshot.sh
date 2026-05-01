#!/usr/bin/env bash
set -euo pipefail
KEY_FILE="${1:-/opt/solana-alpha/data/qn-admin-api-key.secret}"
KEY="$(cat "$KEY_FILE")"
NOW="$(date -u +%s)"
# UTC midnight today (GNU date)
MIDNIGHT="$(date -u -d "$(date -u +%Y-%m-%d)" +%s)"
H10=$((NOW - 600))
H60=$((NOW - 3600))
BASE='https://api.quicknode.com/v0/usage/rpc'

qn() {
  local s="$1"
  local e="$2"
  curl -sS "${BASE}?start_time=${s}&end_time=${e}" \
    -H 'accept: application/json' \
    -H "x-api-key: ${KEY}"
}

echo "utc_now=$NOW ($(date -u -Iseconds))"
echo "seconds_since_utc_midnight=$((NOW - MIDNIGHT))"
echo "--- window last 600s (10 min) ---"
qn "$H10" "$NOW" | head -c 500
echo
echo "--- window last 3600s (1 h) ---"
qn "$H60" "$NOW" | head -c 500
echo
echo "--- window utc_midnight -> now ---"
qn "$MIDNIGHT" "$NOW" | head -c 500
echo
echo "--- billing period default (no range) ---"
curl -sS "$BASE" -H 'accept: application/json' -H "x-api-key: ${KEY}" | head -c 600
echo
