#!/usr/bin/env bash
# scripts/platform/health-check.sh
#
# Per-product freshness monitor. Reads docs/platform/products.yaml and
# for each product with a `health` block, checks:
#   - file: mtime not older than max_age_min
#   - http: returns 2xx within 8 seconds
#
# Persists last-known state under /var/lib/platform-health/<key>.state
# (override with PLATFORM_HEALTH_STATE_DIR). Sends Telegram message
# on state transitions if PLATFORM_TG_BOT_TOKEN + PLATFORM_TG_CHAT_ID
# are set.
#
# Designed to be cron-safe: runs in seconds, never blocks, exits 0 even
# when individual products are down (so cron doesn't email about cron
# itself; the alerting is via Telegram).
#
# See docs/platform/HEALTH_CONTRACT.md for the contract.

set -uo pipefail

# ---- locate platform root -------------------------------------------------

find_platform_root() {
  local dir="$(pwd)"
  while [[ "$dir" != "/" && "$dir" != "" ]]; do
    if [[ -f "$dir/docs/platform/products.yaml" ]]; then
      echo "$dir"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  dir="$script_dir"
  while [[ "$dir" != "/" && "$dir" != "" ]]; do
    if [[ -f "$dir/docs/platform/products.yaml" ]]; then
      echo "$dir"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

PLATFORM_ROOT="$(find_platform_root || true)"
if [[ -z "$PLATFORM_ROOT" ]]; then
  echo "[health-check] products.yaml not found; exiting." >&2
  exit 0
fi
YAML="$PLATFORM_ROOT/docs/platform/products.yaml"

STATE_DIR="${PLATFORM_HEALTH_STATE_DIR:-/var/lib/platform-health}"
mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="$PLATFORM_ROOT/.platform-health-state"
mkdir -p "$STATE_DIR"

TG_TOKEN="${PLATFORM_TG_BOT_TOKEN:-}"
TG_CHAT="${PLATFORM_TG_CHAT_ID:-}"

# ---- parse health blocks from yaml ----------------------------------------
# Hand-rolled mini-parser, tailored to our products.yaml structure.

declare -A H_FILE=()
declare -A H_MAXMIN=()
declare -A H_HTTP=()
declare -A P_NAME=()
declare -A P_STATUS=()

current_key=""
in_health=0
while IFS= read -r line; do
  if [[ "$line" =~ ^\ \ -\ product_key:\ (.+)$ ]]; then
    current_key="${BASH_REMATCH[1]}"
    in_health=0
    continue
  fi
  if [[ -n "$current_key" && "$line" =~ ^\ \ \ \ product_name:\ (.+)$ ]]; then
    P_NAME["$current_key"]="${BASH_REMATCH[1]}"
  fi
  if [[ -n "$current_key" && "$line" =~ ^\ \ \ \ status:\ (.+)$ ]]; then
    P_STATUS["$current_key"]="${BASH_REMATCH[1]}"
  fi
  if [[ -n "$current_key" && "$line" =~ ^\ \ \ \ health:\ ?(.*)$ ]]; then
    rest="${BASH_REMATCH[1]}"
    if [[ "$rest" == "null" || "$rest" == "~" ]]; then
      in_health=0
    else
      in_health=1
    fi
    continue
  fi
  if [[ $in_health -eq 1 ]]; then
    if [[ "$line" =~ ^\ \ \ \ \ \ file:\ (.+)$ ]]; then
      H_FILE["$current_key"]="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^\ \ \ \ \ \ max_age_min:\ ([0-9]+)$ ]]; then
      H_MAXMIN["$current_key"]="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^\ \ \ \ \ \ http:\ (.+)$ ]]; then
      H_HTTP["$current_key"]="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^\ \ \ \ [a-z] ]]; then
      in_health=0
    fi
  fi
done < "$YAML"

# ---- helpers --------------------------------------------------------------

now_epoch() { date -u +%s; }

mtime_epoch() {
  local f="$1"
  if [[ -f "$f" ]]; then
    stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

http_ok() {
  local url="$1"
  local code
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  if [[ "$code" =~ ^2 ]]; then return 0; else return 1; fi
}

prev_state() {
  local key="$1"
  if [[ -f "$STATE_DIR/$key.state" ]]; then
    cat "$STATE_DIR/$key.state"
  else
    echo "INIT"
  fi
}

write_state() {
  local key="$1" st="$2"
  echo "$st" > "$STATE_DIR/$key.state"
}

tg_send() {
  local text="$1"
  if [[ -z "$TG_TOKEN" || -z "$TG_CHAT" ]]; then return 0; fi
  curl -s -m 6 -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" >/dev/null 2>&1 || true
}

ts_human() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }

# ---- run checks -----------------------------------------------------------

OVERALL_OK=1
NOW="$(now_epoch)"

for key in "${!P_NAME[@]}"; do
  status="${P_STATUS[$key]:-planned}"
  # only check products that should be running
  if [[ "$status" != "active" && "$status" != "in-development" ]]; then continue; fi
  if [[ -z "${H_FILE[$key]:-}" && -z "${H_HTTP[$key]:-}" ]]; then continue; fi

  reason=""
  current="OK"

  # file freshness check
  if [[ -n "${H_FILE[$key]:-}" ]]; then
    f="${H_FILE[$key]}"
    max="${H_MAXMIN[$key]:-60}"
    mt="$(mtime_epoch "$f")"
    if [[ "$mt" -eq 0 ]]; then
      current="STALE"; reason="file missing: $f"
    else
      age_sec=$(( NOW - mt ))
      max_sec=$(( max * 60 ))
      if [[ "$age_sec" -gt "$max_sec" ]]; then
        age_min=$(( age_sec / 60 ))
        current="STALE"; reason="file age ${age_min}m > ${max}m: $f"
      fi
    fi
  fi

  # http probe (only if file check passed; layered)
  if [[ "$current" == "OK" && -n "${H_HTTP[$key]:-}" ]]; then
    if ! http_ok "${H_HTTP[$key]}"; then
      current="DOWN"; reason="HTTP probe failed: ${H_HTTP[$key]}"
    fi
  fi

  prev="$(prev_state "$key")"
  write_state "$key" "$current"

  ts="$(ts_human)"
  if [[ "$current" == "OK" ]]; then
    echo "[$ts] $key OK"
  else
    echo "[$ts] $key $current — $reason"
    OVERALL_OK=0
  fi

  # alert on state change (skip first observation to avoid storm)
  if [[ "$prev" != "INIT" && "$prev" != "$current" ]]; then
    if [[ "$current" == "OK" ]]; then
      tg_send "✅ ${P_NAME[$key]} recovered ($prev -> OK) at $ts"
    else
      tg_send "🚨 ${P_NAME[$key]} $current ($prev -> $current) at $ts: $reason"
    fi
  fi
done

# always exit 0 — cron should not consider us failed because a product is down
exit 0
