#!/usr/bin/env bash
# PumpSwap Combo — code deploy only (no PM2 start). Run go-live when ready to trade.
# sudo bash /opt/solana-alpha/scripts/ops/pumpswap-combo-deploy.sh
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
USER="${PM2_USER:-salpha}"
GIT_TAG="${GIT_TAG:-sa-alpha-1.11.364}"

echo "=== PumpSwap Combo deploy (no start) tag=$GIT_TAG ==="
cd "$ROOT"

sudo -u "$USER" -H bash -c "
  set -e
  cd '$ROOT'
  git fetch origin --tags
  git checkout '$GIT_TAG'
  npm install
  npm run typecheck
"

echo "OK: code at \$(sudo -u '$USER' git -C '$ROOT' rev-parse --short HEAD). Bot NOT started."
echo "Tomorrow: sudo bash $ROOT/scripts/ops/pumpswap-combo-go-live.sh"
