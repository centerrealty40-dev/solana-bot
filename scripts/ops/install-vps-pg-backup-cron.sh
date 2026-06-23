#!/usr/bin/env bash
# Install daily Postgres → Cloudflare R2 backup cron for salpha (idempotent).
#
# Usage (VPS, once after git pull):
#   sudo -u salpha bash /opt/solana-alpha/scripts/ops/install-vps-pg-backup-cron.sh
#
# Schedule override:
#   PG_BACKUP_CRON_SCHEDULE='10 3 * * *' sudo -u salpha bash …/install-vps-pg-backup-cron.sh
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/solana-alpha}"
SCHEDULE="${PG_BACKUP_CRON_SCHEDULE:-10 3 * * *}"
MARK_BEGIN="# VPS_PG_BACKUP_R2_BEGIN"
MARK_END="# VPS_PG_BACKUP_R2_END"
CRON_LINE="${SCHEDULE} bash ${APP_DIR}/scripts/ops/backup-db-r2-api.sh >> ${APP_DIR}/data/logs/db-backup.log 2>&1"

mkdir -p "${APP_DIR}/data/logs" "/home/salpha/backups/postgres"
chmod +x "${APP_DIR}/scripts/ops/backup-db-r2-api.sh" 2>/dev/null || true
chmod +x "${APP_DIR}/scripts/ops/_backup-common.sh" 2>/dev/null || true

tmp="$(mktemp)"
crontab -l 2>/dev/null | sed "/${MARK_BEGIN}/,/${MARK_END}/d" >"$tmp" || true
{
  cat "$tmp"
  echo "$MARK_BEGIN"
  echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  echo "SHELL=/bin/bash"
  echo "$CRON_LINE"
  echo "$MARK_END"
} | crontab -
rm -f "$tmp"
echo "Installed PG→R2 backup cron (${SCHEDULE} UTC daily)"
crontab -l | sed -n "/${MARK_BEGIN}/,/${MARK_END}/p"
