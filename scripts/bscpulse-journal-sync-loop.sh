#!/usr/bin/env bash
# PM2 loop: sync BscPulse journal every 30s (sudo as root for SSH key).
set -uo pipefail
ROOT="${BSCPULSE_REPO_ROOT:-/opt/solana-alpha}"
SCRIPT="${BSCPULSE_SYNC_SCRIPT:-}"
if [ -z "$SCRIPT" ]; then
  if [ -f "$ROOT/scripts/ops/sync-bscpulse-journal.sh" ]; then
    SCRIPT="$ROOT/scripts/ops/sync-bscpulse-journal.sh"
  else
    SCRIPT="$ROOT/scripts/sync-bscpulse-journal.sh"
  fi
fi
INTERVAL="${BSCPULSE_SYNC_INTERVAL_SEC:-30}"
run_sync() {
  if [ "$(id -u)" -eq 0 ]; then
    bash "$SCRIPT"
  else
    # sudoers NOPASSWD lists exact script paths — must be executable (+x).
    sudo -n "$SCRIPT"
  fi
}
while true; do
  if run_sync; then
    echo "$(date -Is) sync ok"
  else
    echo "$(date -Is) sync FAILED" >&2
  fi
  sleep "$INTERVAL"
done
