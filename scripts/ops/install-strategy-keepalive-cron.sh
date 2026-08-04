#!/usr/bin/env bash
# Install minute cron for strategy-keepalive (survives PM2 wipe).
set -euo pipefail
ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
MARKER_BEGIN="# STRATEGY_KEEPALIVE_CRON_BEGIN"
MARKER_END="# STRATEGY_KEEPALIVE_CRON_END"
LOG_DIR="$ROOT/data/logs"
mkdir -p "$LOG_DIR"

BLOCK=$(cat <<EOF
$MARKER_BEGIN
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SHELL=/bin/bash
* * * * * cd $ROOT && SOLANA_ALPHA_ROOT=$ROOT STRATEGY_KEEPALIVE_TELEGRAM=1 /usr/bin/node scripts-tmp/strategy-keepalive-cron.mjs >> $LOG_DIR/strategy-keepalive.log 2>&1
$MARKER_END
EOF
)

TMP=$(mktemp)
crontab -l 2>/dev/null | sed "/$MARKER_BEGIN/,/$MARKER_END/d" >"$TMP" || true
printf '%s\n' "$BLOCK" >>"$TMP"
crontab "$TMP"
rm -f "$TMP"
echo "installed strategy-keepalive cron (every minute)"
crontab -l | sed -n "/$MARKER_BEGIN/,/$MARKER_END/p"
