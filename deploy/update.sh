#!/usr/bin/env bash
#
# Pull latest code, install deps, run new migrations, restart pm2.
# Run as the salpha user from /opt/solana-alpha:
#   sudo -iu salpha
#   cd /opt/solana-alpha
#   bash deploy/update.sh

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> git pull"
git pull --ff-only

echo "==> npm ci"
npm ci

echo "==> running migrations (idempotent)"
npm run db:migrate

echo "==> reinstalling dashboard views"
npm run views:install

echo "==> pm2 reload (zero-downtime)"
pm2 reload ecosystem.config.cjs

echo "==> done. pm2 status:"
pm2 status
