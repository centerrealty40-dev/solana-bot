#!/usr/bin/env bash
# Sync LERA live journal from 72.62.152.201 to solana-alpha dashboard VPS.
set -euo pipefail

SRC_HOST="${LERA_SRC_HOST:-72.62.152.201}"
SRC_PATH="${LERA_SRC_JOURNAL:-/opt/lera/data/live/pt1-lera-live.jsonl}"
DEST_DIR="${LERA_DEST_DIR:-/opt/solana-alpha/data/lera}"
DEST_FILE="$DEST_DIR/pt1-lera-live.jsonl"
SSH_KEY="${LERA_SYNC_SSH_KEY:-/root/.ssh/solana_sniper_72}"

mkdir -p "$DEST_DIR"
rsync -az --partial --inplace \
  -e "ssh -F /dev/null -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15" \
  "root@${SRC_HOST}:${SRC_PATH}" \
  "$DEST_FILE.tmp"
mv "$DEST_FILE.tmp" "$DEST_FILE"
chown salpha:salpha "$DEST_FILE"
echo "synced $(stat -c '%s bytes %y' "$DEST_FILE")"
