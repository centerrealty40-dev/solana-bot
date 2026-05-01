#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
set -a; . /opt/solana-alpha/.env; set +a

echo '===== fix root-owned + pull v2 ====='
sudo chown -R salpha:salpha src/papertrader/pricing/ scripts-tmp/ docs/strategy/specs/ tests/ 2>/dev/null || true
sudo -u salpha bash -lc 'cd /opt/solana-alpha && git fetch origin v2 && git reset --hard origin/v2 && git log -1 --oneline'
echo
echo '===== ownership after pull ====='
ls -la src/papertrader/pricing/ tests/ 2>&1 | head -10
echo
echo '===== pm2 reload pt1-dno + dashboard ====='
sudo -u salpha pm2 reload --update-env pt1-dno >/dev/null
sudo -u salpha pm2 reload --update-env dashboard-organizer-paper >/dev/null
sleep 5
echo
echo '===== per-strategy live env ====='
sudo -u salpha pm2 jlist | python3 /tmp/_w74_dump_env.py
echo
echo '===== priceVerify stamping & verdict shape (pt1-dno tail 1500) ====='
tail -1500 /opt/solana-alpha/data/paper2/pt1-dno.jsonl > /tmp/_w74_pt1dno.jsonl
python3 /tmp/_w74_parse_pv.py < /tmp/_w74_pt1dno.jsonl
echo
echo '===== /api/paper2/price-verify-stats?windowMin=120 ====='
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" \
  'http://127.0.0.1:3008/api/paper2/price-verify-stats?windowMin=120' | python3 -m json.tool || echo '(endpoint missing/error)'
echo
echo '===== last heartbeat skippedPriceVerify ====='
tail -200 /home/salpha/.pm2/logs/pt1-dno-out.log 2>/dev/null \
  | grep heartbeat | tail -3 \
  > /tmp/_w74_hb.txt
python3 /tmp/_w74_parse_hb.py < /tmp/_w74_hb.txt
