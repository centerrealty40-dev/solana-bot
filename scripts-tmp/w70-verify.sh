#!/usr/bin/env bash
set -euo pipefail
echo "=== DoD1 online count ==="
sudo -u salpha pm2 list | grep -c online || true
echo "=== DoD2 forbidden in pm2 list ==="
sudo -u salpha pm2 list | grep -E 'sa-stream|sa-parser|sa-atlas' || echo "(none)"
echo "=== DoD3 dump forbidden names count (want 0) ==="
c=$(grep -cE '"name":"(sa-stream|sa-parser|sa-atlas)"' /home/salpha/.pm2/dump.pm2 2>/dev/null || true)
echo "${c:-0}"
echo "=== DoD4 systemd ==="
systemctl is-enabled pm2-salpha.service || true
echo "=== DoD5 env budgets ==="
grep -E '^QUICKNODE_(DAILY|HOURLY)_CREDIT_BUDGET=' /opt/solana-alpha/.env
echo "=== DoD6 health ==="
curl -fsS -o /dev/null -w "api/health %{http_code}\n" http://127.0.0.1:3008/api/health
for ep in raydium meteora orca moonshot jupiter; do
  code=$(curl -fsS -o /dev/null -w "%{http_code}" "http://127.0.0.1:3008/api/${ep}/health" || echo fail)
  echo "api/${ep}/health ${code}"
done
