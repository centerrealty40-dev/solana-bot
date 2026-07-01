#!/usr/bin/env bash
# PM2 loop: sync BasePulse journal every 30s (sudo as root for SSH key).
set -uo pipefail
SCRIPT="/opt/solana-alpha/scripts/ops/sync-basepulse-journal.sh"
INTERVAL="${BPULSE_SYNC_INTERVAL_SEC:-30}"
run_sync() {
  if [ "$(id -u)" -eq 0 ]; then
    "$SCRIPT"
  else
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
