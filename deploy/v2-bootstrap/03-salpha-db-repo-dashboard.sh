#!/usr/bin/env bash
# Stage 0: salpha user, Postgres role+DB, clone repo, branch v2, .env, npm ci, migrate,
# PM2 dashboard only, Caddy -> :3008
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

REPO_URL="${REPO_URL:-https://github.com/centerrealty40-dev/solana-bot.git}"
APP_DIR="${APP_DIR:-/opt/solana-alpha}"
DOMAIN="${DOMAIN:-etonne-moi.com}"

log() { echo "=== $* ==="; }

log "[1] salpha unix user + ssh"
if ! id salpha >/dev/null 2>&1; then
  useradd -m -s /bin/bash salpha
fi
install -d -m 700 -o salpha -g salpha /home/salpha/.ssh
if [ -f /root/.ssh/authorized_keys ]; then
  install -m 600 -o salpha -g salpha /root/.ssh/authorized_keys /home/salpha/.ssh/authorized_keys
fi

log "[2] app dir + restore .env"
mkdir -p "$APP_DIR"
if [ -f /root/env.restore ]; then
  install -m 600 -o salpha -g salpha /root/env.restore "$APP_DIR/.env"
fi
if [ -f /root/env.hourly.restore ]; then
  install -m 600 -o salpha -g salpha /root/env.hourly.restore "$APP_DIR/.env.hourly"
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: missing $APP_DIR/.env (upload /root/env.restore first)"
  exit 1
fi

log "[3] extract Postgres password from DATABASE_URL"
DB_URL_LINE="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 || true)"
if [ -z "$DB_URL_LINE" ]; then
  echo "ERROR: DATABASE_URL not found in .env"
  exit 1
fi
PGPASS="$(printf '%s\n' "$DB_URL_LINE" | sed -n 's|^DATABASE_URL=postgresql://salpha:\([^@]*\)@.*|\1|p')"
if [ -z "$PGPASS" ]; then
  echo "ERROR: could not parse password from DATABASE_URL"
  exit 1
fi

log "[4] Postgres role + database + statement_timeout"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='salpha'" | grep -q 1 \
  || sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE USER salpha WITH PASSWORD '${PGPASS}';"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER USER salpha WITH PASSWORD '${PGPASS}';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='solana_alpha'" | grep -q 1 \
  || sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE solana_alpha OWNER salpha;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE solana_alpha OWNER TO salpha;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE salpha SET statement_timeout = '30s';"

log "[5] git clone + branch v2"
chown -R salpha:salpha "$APP_DIR" 2>/dev/null || true
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u salpha bash -lc "cd '$APP_DIR' && find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
  sudo -u salpha git -c safe.directory='*' clone "$REPO_URL" "$APP_DIR"
fi
sudo -u salpha git -C "$APP_DIR" fetch origin
sudo -u salpha git -C "$APP_DIR" checkout main
sudo -u salpha git -C "$APP_DIR" pull --ff-only origin main || true
if sudo -u salpha git -C "$APP_DIR" rev-parse --verify v2 >/dev/null 2>&1; then
  sudo -u salpha git -C "$APP_DIR" checkout v2
else
  sudo -u salpha git -C "$APP_DIR" checkout -B v2
fi

log "[6] restore .env again (clone cleared)"
install -m 600 -o salpha -g salpha /root/env.restore "$APP_DIR/.env"
if [ -f /root/env.hourly.restore ]; then
  install -m 600 -o salpha -g salpha /root/env.hourly.restore "$APP_DIR/.env.hourly"
fi
chown -R salpha:salpha "$APP_DIR"

log "[7] Node deps (npm ci)"
sudo -u salpha bash -lc "cd '$APP_DIR' && npm ci"

log "[8] DB migrations"
sudo -u salpha bash -lc "cd '$APP_DIR' && npm run db:migrate"

log "[9] paper dashboard data path"
sudo -u salpha mkdir -p "$APP_DIR/data/paper2"
sudo -u salpha touch "$APP_DIR/data/paper2/organizer-paper.jsonl"
chown -R salpha:salpha "$APP_DIR/data"

log "[10] pm2 (dashboard only)"
if ! sudo -u salpha bash -lc 'command -v pm2' >/dev/null 2>&1; then
  sudo -u salpha npm install -g pm2@latest
fi
sudo -u salpha bash -lc "cd '$APP_DIR' && pm2 delete dashboard-organizer-paper 2>/dev/null || true"
sudo -u salpha bash -lc "cd '$APP_DIR' && pm2 start ecosystem.config.cjs && pm2 save"

STARTUP_CMD="$(sudo -u salpha bash -lc 'pm2 startup systemd -u salpha --hp /home/salpha' | grep -E '^sudo ' || true)"
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD" || true
fi

log "[11] Caddy ($DOMAIN -> 127.0.0.1:3008)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3008
}
EOF
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

log "[12] sanity"
sleep 2
curl -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3008/" || true
sudo -u salpha pm2 list

log "DONE 03-salpha-db-repo-dashboard"
