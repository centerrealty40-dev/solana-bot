#!/usr/bin/env bash
# Turn off legacy wallet-intel pipeline on production VPS.
# Safe for live-oscar + copy-trader (they do not depend on orchestrator/backfill/sigseed).
#
#   sudo bash /opt/solana-alpha/scripts/ops/disable-detective-production-salpha.sh
#
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
U="${PM2_USER:-salpha}"

if [[ ! -d "$ROOT" ]]; then
  echo "[fatal] directory not found: $ROOT"
  exit 1
fi

echo "[1/4] remove detective cron (if any)"
bash "$ROOT/scripts/cron/uninstall-detective-data-plane-salpha.sh"

echo "[2/4] stop and delete sa-wallet-orchestrator from PM2"
sudo -u "$U" -H bash -lc "
  export HOME=/home/salpha
  cd '$ROOT'
  pm2 delete sa-wallet-orchestrator 2>/dev/null || true
  pm2 save
"

echo "[3/4] reload PM2 from ecosystem (orchestrator must be absent from config)"
sudo -u "$U" -H bash -lc "
  export HOME=/home/salpha
  cd '$ROOT'
  if grep -q \"name: 'sa-wallet-orchestrator'\" ecosystem.config.cjs 2>/dev/null; then
    echo '[fatal] sa-wallet-orchestrator still in ecosystem.config.cjs — git pull / deploy first'
    exit 1
  fi
  pm2 reload ecosystem.config.cjs --update-env
  pm2 save
"

echo "[4/4] verify"
sudo -u "$U" -H bash -lc "
  export HOME=/home/salpha
  pm2 describe sa-wallet-orchestrator >/dev/null 2>&1 && { echo '[fail] orchestrator still in pm2'; exit 1; } || true
  pm2 list | grep -E 'live-oscar|copy-trader' || true
"

echo "[ok] detective pipeline disabled; live-oscar + copy-trader unchanged"
