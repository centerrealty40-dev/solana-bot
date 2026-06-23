#!/usr/bin/env bash
# Install daily Postgres → Cloudflare R2 backup cron for salpha (idempotent).
# Delegates to install-backup-cron.sh (full DR set: PG, secrets, live data).
#
# Usage (VPS, once after git pull):
#   sudo -u salpha bash /opt/solana-alpha/scripts/ops/install-vps-pg-backup-cron.sh
exec bash "$(dirname "$0")/install-backup-cron.sh"
