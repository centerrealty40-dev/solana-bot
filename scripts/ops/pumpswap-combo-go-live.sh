#!/usr/bin/env bash
# PumpSwap Combo — isolated go-live (never reload live-oscar / copy-trader).
# sudo bash /opt/solana-alpha/scripts/ops/pumpswap-combo-go-live.sh
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
USER="${PM2_USER:-salpha}"
WALLET="${PUMPSWAP_COMBO_WALLET:-$ROOT/data/pumpswap-combo/wallet.keypair.json}"
DIP_WALLET="$ROOT/data/pumpswap-dip/wallet.keypair.json"

echo "=== PumpSwap Combo go-live ==="
cd "$ROOT"
mkdir -p data/pumpswap-combo
chown -R "$USER:$USER" data/pumpswap-combo 2>/dev/null || true
chmod 700 data/pumpswap-combo 2>/dev/null || true
touch data/pumpswap-combo/journal.jsonl data/pumpswap-combo/state.json 2>/dev/null || true
chown "$USER:$USER" data/pumpswap-combo/* 2>/dev/null || true

if [[ ! -f "$WALLET" && -f "$DIP_WALLET" ]]; then
  cp "$DIP_WALLET" "$WALLET"
  chmod 600 "$WALLET"
  chown "$USER:$USER" "$WALLET" 2>/dev/null || true
  echo "Copied wallet from pumpswap-dip"
fi

if [[ ! -f "$WALLET" ]]; then
  echo "ERROR: wallet missing at $WALLET"
  exit 1
fi

sudo -u "$USER" -H bash -c "
  set -e
  cd '$ROOT'
  npm run typecheck
"

sudo -u "$USER" env PM2_HOME=/home/salpha/.pm2 HOME=/home/salpha bash -c "
  set -e
  cd '$ROOT'
  pm2 delete pumpswap-dip-bot 2>/dev/null || true
  pm2 startOrReload '$ROOT/ecosystem.config.cjs' --only pumpswap-combo-bot --update-env
  pm2 save
  pm2 describe pumpswap-combo-bot | head -20
"

echo "OK: pumpswap-combo-bot live. Logs: pm2 logs pumpswap-combo-bot --lines 40"
