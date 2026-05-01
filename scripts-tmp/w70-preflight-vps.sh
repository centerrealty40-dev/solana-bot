#!/usr/bin/env bash
# W7.0 Preflight — run on VPS as root (idempotent).
set -euo pipefail

SA_HOME=/home/salpha
SA_APP=/opt/solana-alpha
BACKUP_DIR="$SA_APP/data/backups/preW70-$(date -u +%Y%m%d-%H%M)"

upsert_env() {
  local key="$1" val="$2"
  local f="$SA_APP/.env"
  if grep -q "^${key}=" "$f" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$f"
  else
    printf '\n%s=%s\n' "$key" "$val" >>"$f"
  fi
}

echo "=== W7.0 backup -> $BACKUP_DIR ==="
mkdir -p "$BACKUP_DIR"
cp -a "$SA_APP/.env" "$BACKUP_DIR/.env.bak"
cp -a "$SA_HOME/.pm2/dump.pm2" "$BACKUP_DIR/dump.pm2.bak" 2>/dev/null || true

echo "=== W7.0 .env upserts ==="
upsert_env QUICKNODE_DAILY_CREDIT_BUDGET 2400000
upsert_env QUICKNODE_HOURLY_CREDIT_BUDGET 100000
upsert_env QUICKNODE_DAILY_ENFORCE 1
upsert_env QUICKNODE_USAGE_TELEGRAM 0
upsert_env QUICKNODE_HOURLY_REMAINING_TELEGRAM 1
upsert_env QUICKNODE_HOURLY_RECENT_MINUTES_LIST '10,30,60'
chown salpha:salpha "$SA_APP/.env"

echo "=== systemd: unmask + restore unit (stay disabled) ==="
if [ -L /etc/systemd/system/pm2-salpha.service ] && [ "$(readlink /etc/systemd/system/pm2-salpha.service)" = /dev/null ]; then
  systemctl unmask pm2-salpha.service
fi
if [ ! -f /etc/systemd/system/pm2-salpha.service ] || [ -L /etc/systemd/system/pm2-salpha.service ]; then
  cp -f /etc/systemd/system/pm2-salpha.service.disabled. /etc/systemd/system/pm2-salpha.service
fi
systemctl daemon-reload
systemctl disable pm2-salpha.service 2>/dev/null || true

echo "=== pm2 start (strict --only) ==="
sudo -u salpha bash -lc "cd $SA_APP && set -a && . ./.env && set +a && pm2 start ecosystem.config.cjs --only dashboard-organizer-paper,sa-raydium,sa-meteora,sa-orca,sa-moonshot,sa-jupiter,sa-direct-lp,pt1-diprunner,pt1-oscar,pt1-dno && pm2 save"

echo "=== verify dump has no stream/parser/atlas ==="
if grep -qE 'sa-stream|sa-parser|sa-atlas' "$SA_HOME/.pm2/dump.pm2" 2>/dev/null; then
  echo "FAIL: forbidden apps in dump.pm2"
  grep -E 'sa-stream|sa-parser|sa-atlas' "$SA_HOME/.pm2/dump.pm2" || true
  exit 1
fi

echo "=== W7.0 done ==="
systemctl is-enabled pm2-salpha.service || true
sudo -u salpha pm2 list
