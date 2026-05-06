#!/usr/bin/env bash
# Удаляет блок DIP_BOT из crontab пользователя salpha (джоба npm run dip-bot-intel:run).
# Запуск на VPS: sudo bash /opt/solana-alpha/scripts/cron/uninstall-dip-bot-cron-salpha.sh
set -euo pipefail

RUN_AS="${DIP_BOT_CRON_USER:-salpha}"
BACKUP="/tmp/cron.${RUN_AS}.bak.before-dip-remove.$(date +%s)"

sudo -u "$RUN_AS" crontab -l >"$BACKUP" 2>/dev/null || true

if ! sudo -u "$RUN_AS" crontab -l 2>/dev/null | grep -q '^# DIP_BOT_CRON_BEGIN'; then
  echo '[uninstall-dip-bot-cron] no DIP_BOT block in crontab — nothing to do'
  exit 0
fi

sudo -u "$RUN_AS" sh -c 'crontab -l | sed "/^# DIP_BOT_CRON_BEGIN\$/,/^# DIP_BOT_CRON_END\$/d" | crontab -'

echo "[uninstall-dip-bot-cron] removed DIP_BOT block; backup: $BACKUP"
