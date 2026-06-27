#!/usr/bin/env bash
# Sync BasePulse journal from 72.62.152.201 to solana-alpha dashboard VPS.
# Invoked by PM2 `basepulse-journal-sync` every 30s (sudo as root for SSH key).
set -euo pipefail

SRC_HOST="${BPULSE_SRC_HOST:-72.62.152.201}"
SRC_PATH="${BPULSE_SRC_JOURNAL:-/opt/base-pulse/data/basepulse-journal.jsonl}"
DEST_DIR="${BPULSE_DEST_DIR:-/opt/solana-alpha/data/basepulse}"
DEST_FILE="$DEST_DIR/basepulse-journal.jsonl"
SSH_KEY="${BPULSE_SYNC_SSH_KEY:-/root/.ssh/solana_sniper_72}"

mkdir -p "$DEST_DIR"
rsync -az --partial --inplace \
  -e "ssh -F /dev/null -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15" \
  "root@${SRC_HOST}:${SRC_PATH}" \
  "$DEST_FILE.tmp"
mv "$DEST_FILE.tmp" "$DEST_FILE"
chown salpha:salpha "$DEST_FILE"
echo "synced $(stat -c '%s bytes %y' "$DEST_FILE")"
