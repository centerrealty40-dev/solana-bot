#!/usr/bin/env bash
set -euo pipefail
F=/opt/solana-alpha/ecosystem.config.cjs
B=/opt/solana-alpha/ecosystem.config.cjs.bak.safety

cp "$F" "$B"
sed -i "s/PAPER_SAFETY_CHECK_ENABLED: '0'/PAPER_SAFETY_CHECK_ENABLED: '1'/g" "$F"
echo '--- after sed ---'
grep -nE 'PAPER_SAFETY_CHECK_ENABLED' "$F"

echo
echo '--- pm2 reload all 3 paper strategies ---'
pm2 startOrReload "$F" --only pt1-diprunner,pt1-oscar,pt1-dno --update-env
sleep 4
pm2 jlist | python3 -c "
import json,sys
arr=json.load(sys.stdin)
for a in arr:
  if a['name'].startswith('pt1-'):
    e=a.get('pm2_env',{})
    print(f\"  {a['name']:14s} status={e.get('status')} safety_env={e.get('PAPER_SAFETY_CHECK_ENABLED')}\")"
