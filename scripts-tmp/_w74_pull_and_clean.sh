#!/usr/bin/env bash
set -uo pipefail
cd /opt/solana-alpha

echo '===== git pull v2 ====='
sudo -u salpha git fetch origin v2
sudo -u salpha git reset --hard origin/v2
sudo -u salpha git log -1 --oneline
echo
echo '===== remove temporary PAPER_PRICE_VERIFY_QUOTE_URL from .env (now default) ====='
sudo sed -i '/^PAPER_PRICE_VERIFY_QUOTE_URL=/d' /opt/solana-alpha/.env
grep -E '^PAPER_PRICE_VERIFY_' /opt/solana-alpha/.env || echo '(no W7.4 keys left)'
echo
echo '===== pm2 reload pt1-dno (pick up new default URL) ====='
sudo -u salpha pm2 reload --update-env pt1-dno 2>&1 | tail -3
sleep 5
echo
echo '===== verify env in process ====='
PID=$(pgrep -f 'PAPER_STRATEGY_ID=pt1-dno' | head -1)
echo "pt1-dno pid=$PID"
if [ -n "$PID" ] && [ -r "/proc/$PID/environ" ]; then
  sudo cat "/proc/$PID/environ" | tr '\0' '\n' | grep -E 'PAPER_PRICE_VERIFY_QUOTE_URL|PAPER_PRICE_VERIFY_ENABLED' || echo '(URL not in syscall env, but dotenv loads it from .env at runtime — expected)'
fi
