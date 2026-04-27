#!/usr/bin/env bash
# One-shot: add daily discover-smart-money to salpha crontab (idempotent). Run on server as root.
set -euo pipefail
sudo -u salpha sh -c '(crontab -l 2>/dev/null | grep -v "scripts/cron/discover-smart-money.sh"; echo "20 4 * * * /opt/solana-alpha/scripts/cron/discover-smart-money.sh") | crontab -'
echo "Installed for salpha:"
sudo -u salpha crontab -l | grep -F discover-smart-money || true
