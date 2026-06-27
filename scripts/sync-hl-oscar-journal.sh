#!/usr/bin/env bash
# Sync HL Oscar perp journal from solana-alpha VPS to local dashboard data dir.
# On VPS the journal lives beside the bot — no sync needed there.
set -euo pipefail

SRC_HOST="${HL_OSCAR_SRC_HOST:-100.82.221.89}"
SRC_PATH="${HL_OSCAR_SRC_JOURNAL:-/opt/solana-alpha/data/hl-oscar-perp/live.jsonl}"
DEST_DIR="${HL_OSCAR_DEST_DIR:-./data/hl-oscar-perp}"
DEST_FILE="$DEST_DIR/live.jsonl"
SSH_KEY="${HL_OSCAR_SYNC_SSH_KEY:-$HOME/.ssh/botadmin_187_auto}"

mkdir -p "$DEST_DIR"
rsync -az --partial --inplace \
  -e "ssh -F /dev/null -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15" \
  "root@${SRC_HOST}:${SRC_PATH}" \
  "$DEST_FILE.tmp"
mv "$DEST_FILE.tmp" "$DEST_FILE"
echo "synced $(wc -c < "$DEST_FILE") bytes -> $DEST_FILE"
