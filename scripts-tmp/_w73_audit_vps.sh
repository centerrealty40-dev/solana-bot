#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha

echo '===== git remote vs HEAD ====='
git rev-parse HEAD
git ls-remote origin v2 | head -1
echo
echo '===== git ls-files priority-fee tests ====='
git ls-files src/papertrader/pricing tests/papertrader-priority-fee.test.ts 2>&1 | head -10 || true
echo '(empty above means W7.3 code is NOT in repo)'
echo
echo '===== ownership of priority-fee.ts ====='
ls -la src/papertrader/pricing/
echo
echo '===== per-strategy live env ====='
sudo -u salpha pm2 jlist | python3 /tmp/_w73_dump_env.py
echo
echo '===== priority-fee cache ====='
cat data/priority-fee-cache.json 2>/dev/null
echo
echo
echo '===== last 10 lines that mention priority-fee in any pt1 log ====='
tail -3000 /home/salpha/.pm2/logs/pt1-dno-out.log /home/salpha/.pm2/logs/pt1-diprunner-out.log /home/salpha/.pm2/logs/pt1-oscar-out.log 2>/dev/null \
  | grep -E 'priority-fee|priorityFee' | tail -10 || echo '(none)'
echo
echo '===== /api/paper2/priority-fee ====='
set -a; . /opt/solana-alpha/.env; set +a
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" http://127.0.0.1:3008/api/paper2/priority-fee
echo
