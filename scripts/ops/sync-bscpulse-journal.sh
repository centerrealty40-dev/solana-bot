#!/usr/bin/env bash
# Sync BscPulse journal from 72.62.152.201 to solana-alpha dashboard VPS.
# Invoked by PM2 `bscpulse-journal-sync` every 30s (sudo as root for SSH key).
#
# Manual: BSCPULSE_SRC_HOST=72.62.152.201 bash scripts/ops/sync-bscpulse-journal.sh
# Cron alternative (root, every minute):
#   * * * * * /opt/solana-alpha/scripts/ops/sync-bscpulse-journal.sh >> /var/log/bscpulse-sync.log 2>&1
set -euo pipefail

SRC_HOST="${BSCPULSE_SRC_HOST:-72.62.152.201}"
SRC_PATH="${BSCPULSE_SRC_JOURNAL:-/opt/bsc-pulse/data/bscpulse-journal.jsonl}"
DEST_DIR="${BSCPULSE_DEST_DIR:-/opt/solana-alpha/data/bscpulse}"
DEST_FILE="$DEST_DIR/bscpulse-journal.jsonl"
SSH_KEY="${BSCPULSE_SYNC_SSH_KEY:-/root/.ssh/solana_sniper_72}"

mkdir -p "$DEST_DIR"
rsync -az --partial --inplace \
  -e "ssh -F /dev/null -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15" \
  "root@${SRC_HOST}:${SRC_PATH}" \
  "$DEST_FILE.tmp"
mv "$DEST_FILE.tmp" "$DEST_FILE"
chown salpha:salpha "$DEST_FILE"
echo "synced $(stat -c '%s bytes %y' "$DEST_FILE")"
