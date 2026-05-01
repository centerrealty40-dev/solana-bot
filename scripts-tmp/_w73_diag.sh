#!/usr/bin/env bash
set -euo pipefail
set -a
. /opt/solana-alpha/.env
set +a

echo "===== 1) ENV SAFETY FLAGS in /opt/solana-alpha/.env ====="
grep -E '^PAPER_SAFETY_' /opt/solana-alpha/.env || echo '(none)'
echo
echo "===== 2) ecosystem.config.cjs — per-strategy safety overrides ====="
grep -nE 'pt1-(diprunner|oscar|dno)|PAPER_SAFETY_' /opt/solana-alpha/ecosystem.config.cjs | head -60
echo
echo "===== 3) Live env in pm2 process pt1-dno ====="
sudo -u salpha pm2 describe pt1-dno | sed -n '1,50p' | grep -E 'PAPER_SAFETY_|exec cwd|status' || true
echo
echo "===== 4) Real shape of safety field on last 200 opens of pt1-dno ====="
P=/opt/solana-alpha/data/paper2/pt1-dno.jsonl
sudo -u salpha bash -c "tail -2000 $P | grep '\"kind\":\"open\"' | tail -200" > /tmp/_opens.jsonl
python3 /tmp/_w73_safety_shape.py
echo
echo "===== 5) /api/qn/usage FULL ====="
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" http://127.0.0.1:3008/api/qn/usage | python3 -m json.tool
echo
echo "===== 6) Where the 'global' counters come from — meter file ====="
ls -la /opt/solana-alpha/data/qn-*.json 2>/dev/null || true
echo
echo "--- contents (raw) ---"
for f in /opt/solana-alpha/data/qn-*.json; do
  [ -f "$f" ] || continue
  echo ">>> $f"
  cat "$f" | head -200
done
echo
echo "===== 7) Recent qn-client log lines (from pt1-dno) ====="
sudo -u salpha bash -c "tail -2000 /home/salpha/.pm2/logs/pt1-dno-out.log /home/salpha/.pm2/logs/pt1-dno-error.log 2>/dev/null | grep -iE 'qn-client|qn rpc|safety|budget|reserve' | tail -40" || true
