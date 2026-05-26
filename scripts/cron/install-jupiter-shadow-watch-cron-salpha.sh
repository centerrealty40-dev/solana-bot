#!/usr/bin/env bash
# Jupiter shadow-watch: каждые 10 мин — разбор signal-lab / mtm-shadow JSONL; Telegram ALERT при всплеске ошибок lite-api.
#
# Установка (VPS, один раз после git pull):
#   sudo bash /opt/solana-alpha/scripts/cron/install-jupiter-shadow-watch-cron-salpha.sh
#
# Расписание override:
#   JUPITER_SHADOW_WATCH_SCHEDULE='*/15 * * * *' sudo bash …/install-jupiter-shadow-watch-cron-salpha.sh
#
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
U="${CRON_USER:-salpha}"
SCHEDULE="${JUPITER_SHADOW_WATCH_SCHEDULE:-*/10 * * * *}"

if [[ ! -d "$ROOT" ]]; then
  echo "[fatal] directory not found: $ROOT"
  exit 1
fi

mkdir -p "$ROOT/data/logs"

sudo -u "$U" env ROOT="$ROOT" SCHEDULE="$SCHEDULE" bash <<'EOSCRIPT'
set -euo pipefail
TMP="$(mktemp)"
chmod 600 "$TMP"
(crontab -l 2>/dev/null || true) | awk '
/^# JUPITER_SHADOW_WATCH_CRON_BEGIN$/ {skip=1; next}
/^# JUPITER_SHADOW_WATCH_CRON_END$/ {skip=0; next}
!skip {print}
' >"$TMP"

cat >>"$TMP" <<EOF
# JUPITER_SHADOW_WATCH_CRON_BEGIN
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SHELL=/bin/bash
$SCHEDULE cd $ROOT && SOLANA_ALPHA_ROOT=$ROOT SHADOW_WATCH_TELEGRAM=1 node scripts-tmp/jupiter-shadow-watch.mjs >> $ROOT/data/logs/jupiter-shadow-watch.log 2>&1
# JUPITER_SHADOW_WATCH_CRON_END
EOF

crontab "$TMP"
rm -f "$TMP"
EOSCRIPT

echo "[ok] jupiter-shadow-watch cron installed for user $U (schedule: $SCHEDULE UTC → $ROOT/data/logs/jupiter-shadow-watch.log)"
echo "     Убедитесь, что в $ROOT/.env заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID."
