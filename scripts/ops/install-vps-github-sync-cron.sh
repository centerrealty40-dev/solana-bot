#!/usr/bin/env bash
# Install daily VPS vs GitHub drift audit cron for salpha (idempotent).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/solana-alpha}"
MARK_BEGIN="# VPS_GITHUB_SYNC_AUDIT_BEGIN"
MARK_END="# VPS_GITHUB_SYNC_AUDIT_END"
CRON_LINE="15 4 * * * bash ${APP_DIR}/scripts/ops/vps-github-sync-audit.sh >> ${APP_DIR}/data/logs/git-sync-audit.log 2>&1"

mkdir -p "${APP_DIR}/data/logs"
chmod +x "${APP_DIR}/scripts/ops/vps-github-sync-audit.sh" 2>/dev/null || true

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
echo "Installed git sync audit cron (04:15 UTC daily)"
crontab -l | sed -n "/${MARK_BEGIN}/,/${MARK_END}/p"
