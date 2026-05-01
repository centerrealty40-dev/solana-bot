#!/usr/bin/env bash
set -uo pipefail

echo '===== ensure pt1-dno reloaded with new env ====='
sudo -u salpha pm2 reload --update-env pt1-dno 2>&1 | tail -5
sleep 5
echo
echo '===== env in pt1-dno (via pm2 describe instead of jlist) ====='
sudo -u salpha pm2 describe pt1-dno 2>/dev/null | grep -E 'PAPER_PRICE_VERIFY|status|exec cwd' | head -20
echo
echo '===== wait 100s for fresh open events ====='
sleep 100
echo
echo '===== priceVerify shape pt1-dno (since reload) ====='
tail -2000 /opt/solana-alpha/data/paper2/pt1-dno.jsonl > /tmp/_w74_pt1dno3.jsonl
python3 /tmp/_w74_parse_pv.py < /tmp/_w74_pt1dno3.jsonl
