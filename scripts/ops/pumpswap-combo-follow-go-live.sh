#!/usr/bin/env bash
# Combo #2 follow hnu5 — isolated live go-live (separate wallet from combo #1).
# sudo bash /opt/solana-alpha/scripts/ops/pumpswap-combo-follow-go-live.sh
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
USER="${PM2_USER:-salpha}"
WALLET="${PUMPSWAP_COMBO_FOLLOW_WALLET:-$ROOT/data/pumpswap-combo-follow/wallet.keypair.json}"
B58_FILE="${WALLET_B58_FILE:-}"

echo "=== PumpSwap Combo Follow live ==="
cd "$ROOT"
mkdir -p data/pumpswap-combo-follow
chown -R "$USER:$USER" data/pumpswap-combo-follow 2>/dev/null || true
chmod 700 data/pumpswap-combo-follow 2>/dev/null || true
touch data/pumpswap-combo-follow/journal.jsonl data/pumpswap-combo-follow/state.json 2>/dev/null || true
chown "$USER:$USER" data/pumpswap-combo-follow/* 2>/dev/null || true

if [[ -n "$B58_FILE" && -f "$B58_FILE" ]]; then
  sudo -u "$USER" node "$ROOT/scripts/ops/import-wallet-base58.mjs" --in "$B58_FILE" --out "$WALLET"
  rm -f "$B58_FILE"
fi

if [[ ! -f "$WALLET" ]]; then
  echo "ERROR: wallet missing at $WALLET (set WALLET_B58_FILE or place keypair manually)"
  exit 1
fi

PUBKEY="$(sudo -u "$USER" node -e "
const fs=require('fs');
const {Keypair}=require('@solana/web3.js');
const raw=JSON.parse(fs.readFileSync('$WALLET','utf8'));
const kp=Keypair.fromSecretKey(Uint8Array.from(raw));
console.log(kp.publicKey.toBase58());
")"
echo "Follow wallet pubkey: $PUBKEY"

STATE="$ROOT/data/pumpswap-combo-follow/state.json"
if [[ -f "$STATE" ]]; then
  STATE="$STATE" python3 - <<'PY'
import json, os
p = os.environ["STATE"]
with open(p, encoding="utf-8") as f:
    s = json.load(f)
if s.get("halted"):
    s["halted"] = False
    s.pop("haltReason", None)
    s.pop("haltedAt", None)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)
        f.write("\n")
    print("Cleared manual halt in follow state.json")
PY
fi

sudo -u "$USER" -H bash -c "cd '$ROOT' && npm run typecheck"

sudo -u "$USER" env PM2_HOME=/home/salpha/.pm2 HOME=/home/salpha ENABLE_PUMPSWAP_COMBO_PM2=true bash -c "
  set -e
  cd '$ROOT'
  pm2 startOrReload '$ROOT/ecosystem.config.cjs' --only pumpswap-combo-follow-live --update-env
  pm2 save
  pm2 describe pumpswap-combo-follow-live | head -22
"

echo "OK: pumpswap-combo-follow-live. Journal: data/pumpswap-combo-follow/journal.jsonl"
