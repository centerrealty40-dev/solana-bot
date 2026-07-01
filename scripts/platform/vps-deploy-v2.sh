#!/usr/bin/env bash
# Deploy Solana Alpha on VPS from Cloud Agent (Git v2 only — NORM §5.2).
#
# Safety: requires explicit confirmation env:
#   VPS_DEPLOY_CONFIRM=1 bash scripts/platform/vps-deploy-v2.sh
#
# Optional: VPS_DEPLOY_PM2_ONLY=live-oscar  (default: full ecosystem reload)
#
# See docs/agents/CLOUD_AGENT_VPS_SSH.md

set -euo pipefail

if [[ "${VPS_DEPLOY_CONFIRM:-}" != "1" ]]; then
  cat >&2 <<'EOF'
vps-deploy-v2: refused — set VPS_DEPLOY_CONFIRM=1 and mark task as deploy-session.

This runs: git fetch/reset origin/v2, npm ci, pm2 reload on production.
EOF
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PM2_ONLY="${VPS_DEPLOY_PM2_ONLY:-}"

REMOTE="
set -euo pipefail
cd /opt/solana-alpha
git fetch origin v2
git reset --hard origin/v2
npm ci
"

if [[ -n "${PM2_ONLY}" ]]; then
  REMOTE+="
pm2 reload ecosystem.config.cjs --only ${PM2_ONLY} --update-env
"
else
  REMOTE+="
pm2 reload ecosystem.config.cjs --update-env
"
fi

REMOTE+="
git rev-parse HEAD
git status -sb
pm2 list | head -25
"

echo "=== vps-deploy-v2: starting (confirmed) ==="
bash "${SCRIPT_DIR}/vps-ssh.sh" --salpha "${REMOTE}"
echo "=== vps-deploy-v2: done ==="
