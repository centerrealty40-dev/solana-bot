#!/usr/bin/env bash
# Oscar VPS: stop all solana-alpha PM2; run only dc-trader dcafr-dc-alert (DCA-Alert4Risky).
set -euo pipefail

HOST="${VPS_HOST:-187.124.38.242}"
USER="${VPS_SSH_USER:-root}"
KEY_FILE="${VPS_SSH_KEY_FILE:-}"

if [[ -z "$KEY_FILE" ]]; then
  KEY_FILE="$(mktemp)"
  trap 'rm -f "$KEY_FILE"' EXIT
  if [[ -n "${VPS_SSH_PRIVATE_KEY_B64:-}" ]]; then
    printf '%s' "$VPS_SSH_PRIVATE_KEY_B64" | base64 -d >"$KEY_FILE"
  elif [[ -n "${VPS_SSH_PRIVATE_KEY:-}" ]]; then
    printf '%s' "$VPS_SSH_PRIVATE_KEY" >"$KEY_FILE"
  else
    echo "Missing VPS_SSH_PRIVATE_KEY(_B64)" >&2
    exit 1
  fi
  chmod 600 "$KEY_FILE"
fi

SSH=(ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new "${USER}@${HOST}")

"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail

# Fix viralflow imports (scripts-tmp/ -> src/core/)
if [[ -f /opt/dc-trader/scripts-tmp/viralflow-dc-alert.ts ]]; then
  sed -i "s|'../core/|'../src/core/|g" /opt/dc-trader/scripts-tmp/viralflow-dc-alert.ts
fi

cat > /opt/dc-trader/ecosystem.config.cjs <<'EOF'
/** DCA-Alert4Risky only — no trading bot, no solana-alpha collectors. */
const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });
require('dotenv').config({ path: '/opt/solana-alpha/.env', override: false });

module.exports = {
  apps: [
    {
      name: 'dcafr-dc-alert',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'scripts-tmp/viralflow-dc-alert.ts',
      cwd: root,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 30,
      restart_delay: 5000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        NODE_NO_WARNINGS: '1',
        DC_ALERT_DRY_RUN: '0',
        DC_ALERT_RPC_URL:
          process.env.DC_ALERT_RPC_URL ||
          process.env.DCA_WATCH_RPC_URL ||
          process.env.SA_RPC_HTTP_URL ||
          '',
        DC_ALERT_TELEGRAM_BOT_TOKEN:
          process.env.DC_ALERT_TELEGRAM_BOT_TOKEN ||
          process.env.DCA_WATCH_TELEGRAM_BOT_TOKEN ||
          process.env.DC_TRADER_TELEGRAM_BOT_TOKEN ||
          '',
        DC_ALERT_TELEGRAM_CHAT_ID:
          process.env.DC_ALERT_TELEGRAM_CHAT_ID ||
          process.env.DCA_WATCH_TELEGRAM_CHAT_ID ||
          process.env.DC_TRADER_TELEGRAM_CHAT_ID ||
          '',
      },
    },
  ],
};
EOF
chown salpha:salpha /opt/dc-trader/ecosystem.config.cjs

sudo -u salpha -H bash -lc '
  set -euo pipefail
  cd /opt/solana-alpha
  git fetch origin v2 origin/cursor/dca-alert-only-no-collectors-5b8b
  git reset --hard origin/cursor/dca-alert-only-no-collectors-5b8b

  # Delete every PM2 app except pm2-logrotate
  mapfile -t names < <(pm2 jlist | node -e "
    const j=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));
    for (const p of j) if (p.name !== \"pm2-logrotate\") console.log(p.name);
  ")
  for n in "${names[@]}"; do
    [[ -z "$n" ]] && continue
    pm2 delete "$n" 2>/dev/null || pm2 stop "$n" 2>/dev/null || true
  done

  cd /opt/dc-trader
  pm2 delete dcafr-dc-alert 2>/dev/null || true
  pm2 start ecosystem.config.cjs --only dcafr-dc-alert --update-env
  pm2 save
  pm2 ls
  sleep 4
  pm2 logs dcafr-dc-alert --lines 20 --nostream || true
'
REMOTE
