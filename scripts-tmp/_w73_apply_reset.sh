#!/usr/bin/env bash
set -euo pipefail
set -a
. /opt/solana-alpha/.env
set +a

cp /tmp/qn_reset.json /opt/solana-alpha/data/quicknode-usage.json
chown salpha:salpha /opt/solana-alpha/data/quicknode-usage.json
echo '--- meter file after reset ---'
cat /opt/solana-alpha/data/quicknode-usage.json
echo
echo '--- /api/qn/usage after reset ---'
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" http://127.0.0.1:3008/api/qn/usage \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('monthCredits=', d['monthCredits'], 'dayCredits=', d['dayCredits'], 'hourCredits=', d['hourCredits'])
print('budgets:', d['budgets'])
print('safety:', d['perFeature']['safety'])
"
