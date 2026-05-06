#!/usr/bin/env bash
#
# Idempotent helper: upserts DASHBOARD_BASIC_USER / DASHBOARD_BASIC_PASSWORD
# into /opt/solana-alpha/.env on the VPS and restarts live-oscar-dashboard
# under salpha. Secrets are NEVER stored in the repo.
#
# Usage (from local machine, NOT committed-secret):
#   DASHBOARD_BASIC_USER=admin DASHBOARD_BASIC_PASSWORD='strong-pass' \
#     bash scripts-tmp/_deploy-dashboard-auth.sh
#
# Or run directly on the VPS as root:
#   DASHBOARD_BASIC_USER=admin DASHBOARD_BASIC_PASSWORD='strong-pass' \
#     bash /opt/solana-alpha/scripts-tmp/_deploy-dashboard-auth.sh
set -euo pipefail

if [[ -z "${DASHBOARD_BASIC_USER:-}" || -z "${DASHBOARD_BASIC_PASSWORD:-}" ]]; then
  echo "ERROR: DASHBOARD_BASIC_USER and DASHBOARD_BASIC_PASSWORD must be set in env" >&2
  exit 2
fi

ENV_FILE="/opt/solana-alpha/.env"
SSH_HOST="${DASHBOARD_DEPLOY_SSH_HOST:-187.124.38.242}"
SSH_USER="${DASHBOARD_DEPLOY_SSH_USER:-root}"
SSH_KEY="${DASHBOARD_DEPLOY_SSH_KEY:-$HOME/.ssh/botadmin_187_auto}"

run_remote() {
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$SSH_HOST" "$@"
}

# If we're already on the VPS, talk to the local fs directly.
if [[ -f "$ENV_FILE" && "$(hostname)" != "$(basename "$0")" ]] && [[ -z "${DASHBOARD_DEPLOY_FORCE_REMOTE:-}" ]] && id salpha &>/dev/null; then
  EXEC="bash -c"
else
  EXEC="run_remote"
fi

upsert_env_remote() {
  local key="$1" val="$2"
  # Escape only what /opt/solana-alpha/.env (KEY=VALUE flat file) cares about.
  local escaped
  escaped="$(printf '%s' "$val" | sed -e 's/[\/&]/\\&/g')"
  $EXEC "
    set -e
    if grep -q '^${key}=' '${ENV_FILE}'; then
      sudo sed -i 's/^${key}=.*/${key}=${escaped}/' '${ENV_FILE}'
    else
      echo '${key}=${val}' | sudo tee -a '${ENV_FILE}' >/dev/null
    fi
  "
}

echo "[deploy-auth] upserting DASHBOARD_BASIC_USER and DASHBOARD_BASIC_PASSWORD into ${ENV_FILE}"
upsert_env_remote DASHBOARD_BASIC_USER "$DASHBOARD_BASIC_USER"
upsert_env_remote DASHBOARD_BASIC_PASSWORD "$DASHBOARD_BASIC_PASSWORD"

echo "[deploy-auth] restarting live-oscar-dashboard under salpha"
$EXEC "sudo -u salpha pm2 flush live-oscar-dashboard && sudo -u salpha pm2 restart live-oscar-dashboard --update-env"

echo "[deploy-auth] smoke-test:"
$EXEC "curl -sS -o /dev/null -w 'health(no-auth): HTTP %{http_code}\n' http://127.0.0.1:3007/api/health"
$EXEC "curl -sS -o /dev/null -w 'paper2(no-auth): HTTP %{http_code}\n' http://127.0.0.1:3007/api/paper2"
$EXEC "curl -sS -o /dev/null -u '${DASHBOARD_BASIC_USER}:${DASHBOARD_BASIC_PASSWORD}' -w 'paper2(auth): HTTP %{http_code}\n' http://127.0.0.1:3007/api/paper2"

echo "[deploy-auth] done"
