#!/usr/bin/env bash
# Install all disaster-recovery backup cron entries for salpha (idempotent).
# Replaces legacy VPS_PG_BACKUP_R2 block when present.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/solana-alpha}"
MARK_BEGIN="# SA_BACKUP_CRON_BEGIN"
MARK_END="# SA_BACKUP_CRON_END"
LEGACY_BEGIN="# VPS_PG_BACKUP_R2_BEGIN"
LEGACY_END="# VPS_PG_BACKUP_R2_END"

chmod +x "${APP_DIR}/scripts/ops/_backup-common.sh" 2>/dev/null || true
chmod +x "${APP_DIR}/scripts/ops/backup-db-r2-api.sh" 2>/dev/null || true
chmod +x "${APP_DIR}/scripts/ops/backup-live-data.sh" 2>/dev/null || true
chmod +x "${APP_DIR}/scripts/ops/backup-secrets-encrypted.sh" 2>/dev/null || true
chmod +x "${APP_DIR}/scripts/ops/restore-from-r2-chunks.sh" 2>/dev/null || true

mkdir -p "${APP_DIR}/data/logs" /home/salpha/backups/postgres /home/salpha/backups/live /home/salpha/backups/encrypted

tmp="$(mktemp)"
crontab -l 2>/dev/null \
  | sed "/${MARK_BEGIN}/,/${MARK_END}/d" \
  | sed "/${LEGACY_BEGIN}/,/${LEGACY_END}/d" >"$tmp" || true
{
  cat "$tmp"
  echo "$MARK_BEGIN"
  echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  echo "SHELL=/bin/bash"
  echo "10 3 * * * bash ${APP_DIR}/scripts/ops/backup-db-r2-api.sh >> ${APP_DIR}/data/logs/db-backup.log 2>&1"
  echo "20 3 * * * bash ${APP_DIR}/scripts/ops/backup-secrets-encrypted.sh >> ${APP_DIR}/data/logs/secrets-backup.log 2>&1"
  echo "30 3 * * * bash ${APP_DIR}/scripts/ops/backup-live-data.sh >> ${APP_DIR}/data/logs/live-backup.log 2>&1"
  echo "0 4 * * 0 bash ${APP_DIR}/scripts/ops/backup-live-data.sh --r2-full-journals >> ${APP_DIR}/data/logs/live-backup.log 2>&1"
  echo "$MARK_END"
} | crontab -
rm -f "$tmp"

echo "Installed backup cron (03:10/03:20/03:30 UTC daily; 04:00 UTC Sun weekly journals R2)"
crontab -l | sed -n "/${MARK_BEGIN}/,/${MARK_END}/p"
