#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha

if grep -q '^PAPER_PRICE_VERIFY_QUOTE_URL=' /opt/solana-alpha/.env; then
  sudo sed -i 's|^PAPER_PRICE_VERIFY_QUOTE_URL=.*|PAPER_PRICE_VERIFY_QUOTE_URL=https://lite-api.jup.ag/swap/v1/quote|' /opt/solana-alpha/.env
  echo 'replaced existing key'
else
  echo 'PAPER_PRICE_VERIFY_QUOTE_URL=https://lite-api.jup.ag/swap/v1/quote' | sudo tee -a /opt/solana-alpha/.env
  echo 'appended new key'
fi
echo
echo '--- final value in .env ---'
grep '^PAPER_PRICE_VERIFY_QUOTE_URL' /opt/solana-alpha/.env

echo
echo '--- pm2 reload pt1-dno ---'
sudo -u salpha pm2 reload --update-env pt1-dno >/dev/null
sleep 3
sudo -u salpha pm2 jlist | python3 - <<'PY'
import json, sys
arr=json.load(sys.stdin)
for a in arr:
    if a.get('name')=='pt1-dno':
        e=a.get('pm2_env',{})
        print(f"  PAPER_PRICE_VERIFY_ENABLED      ={e.get('PAPER_PRICE_VERIFY_ENABLED')!r}")
        print(f"  PAPER_PRICE_VERIFY_BLOCK_ON_FAIL={e.get('PAPER_PRICE_VERIFY_BLOCK_ON_FAIL')!r}")
        print(f"  PAPER_PRICE_VERIFY_QUOTE_URL    ={e.get('PAPER_PRICE_VERIFY_QUOTE_URL')!r}")
PY

echo
echo '--- wait 90s for fresh opens, then re-audit jsonl ---'
sleep 90
tail -1500 /opt/solana-alpha/data/paper2/pt1-dno.jsonl > /tmp/_w74_pt1dno2.jsonl
python3 /tmp/_w74_parse_pv.py < /tmp/_w74_pt1dno2.jsonl
