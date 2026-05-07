#!/usr/bin/env bash
# Jupiter shadow — почасовая сводка в Telegram (REPORT/ALERT по jupiter-shadow). Источник: signal-lab.jsonl + mtm-shadow.jsonl.
#
# Установка: sudo bash /opt/solana-alpha/scripts/cron/install-jupiter-shadow-hourly-cron-salpha.sh
# Override: JUPITER_SHADOW_HOURLY_SCHEDULE='15 * * * *' sudo bash …
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
U="${CRON_USER:-salpha}"
SCHEDULE="${JUPITER_SHADOW_HOURLY_SCHEDULE:-0 * * * *}"

if [[ ! -d "$ROOT" ]]; then
  echo "[fatal] directory not found: $ROOT"; exit 1
fi
mkdir -p "$ROOT/data/logs"

sudo -u "$U" env ROOT="$ROOT" SCHEDULE="$SCHEDULE" bash <<'EOSCRIPT'
set -euo pipefail
TMP="$(mktemp)"; chmod 600 "$TMP"
(crontab -l 2>/dev/null || true) | awk '
/^# JUPITER_SHADOW_HOURLY_BEGIN$/ {skip=1; next}
/^# JUPITER_SHADOW_HOURLY_END$/ {skip=0; next}
!skip {print}
' >"$TMP"

cat >>"$TMP" <<EOF
# JUPITER_SHADOW_HOURLY_BEGIN
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SHELL=/bin/bash
$SCHEDULE cd $ROOT && SOLANA_ALPHA_ROOT=$ROOT node scripts-tmp/jupiter-shadow-hourly.mjs >> $ROOT/data/logs/jupiter-shadow-hourly.log 2>&1
# JUPITER_SHADOW_HOURLY_END
EOF

crontab "$TMP"; rm -f "$TMP"
EOSCRIPT

echo "[ok] jupiter-shadow hourly cron installed (user $U, schedule '$SCHEDULE' UTC, log $ROOT/data/logs/jupiter-shadow-hourly.log)"
