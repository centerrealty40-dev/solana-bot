#!/usr/bin/env bash
# Cloud Agent / CI SSH wrapper for Solana Alpha VPS (read-only by default at call sites).
#
# Credentials (one of):
#   VPS_SSH_PRIVATE_KEY      — PEM body (supports literal \n in secret UI)
#   VPS_SSH_PRIVATE_KEY_B64  — base64-encoded PEM (easier in Cursor Secrets)
#   VPS_SSH_KEY_PATH         — path to existing key file (local Desktop agent)
#
# Optional:
#   VPS_SSH_HOST             — default 187.124.38.242
#   VPS_SSH_USER             — default root
#   VPS_APP_DIR              — default /opt/solana-alpha
#   VPS_SSH_RUNTIME_USER     — default salpha (for vps-salpha-exec)
#
# Usage:
#   bash scripts/platform/vps-ssh.sh '<remote shell command as root>'
#   bash scripts/platform/vps-ssh.sh --salpha '<command in /opt/solana-alpha as salpha>'
#   bash scripts/platform/vps-ssh.sh --test
#
# Never commit private keys. Never print VPS_SSH_* values.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${VPS_SSH_HOST:-187.124.38.242}"
USER="${VPS_SSH_USER:-root}"
APP_DIR="${VPS_APP_DIR:-/opt/solana-alpha}"
RUNTIME_USER="${VPS_SSH_RUNTIME_USER:-salpha}"

KEY_FILE=""
KEY_TEMP=""
cleanup() {
  if [[ -n "${KEY_TEMP}" && -f "${KEY_TEMP}" ]]; then
    rm -f "${KEY_TEMP}"
  fi
}
trap cleanup EXIT

resolve_key_file() {
  if [[ -n "${VPS_SSH_KEY_PATH:-}" ]]; then
    if [[ ! -f "${VPS_SSH_KEY_PATH}" ]]; then
      echo "vps-ssh: VPS_SSH_KEY_PATH not found: ${VPS_SSH_KEY_PATH}" >&2
      exit 2
    fi
    KEY_FILE="${VPS_SSH_KEY_PATH}"
    return
  fi

  if [[ -n "${VPS_SSH_PRIVATE_KEY_B64:-}" ]]; then
    KEY_TEMP="$(mktemp "${TMPDIR:-/tmp}/vps-ssh-key.XXXXXX")"
    chmod 600 "${KEY_TEMP}"
    printf '%s' "${VPS_SSH_PRIVATE_KEY_B64}" | base64 -d > "${KEY_TEMP}" 2>/dev/null ||
      printf '%s' "${VPS_SSH_PRIVATE_KEY_B64}" | base64 -d > "${KEY_TEMP}"
    KEY_FILE="${KEY_TEMP}"
    return
  fi

  if [[ -n "${VPS_SSH_PRIVATE_KEY:-}" ]]; then
    KEY_TEMP="$(mktemp "${TMPDIR:-/tmp}/vps-ssh-key.XXXXXX")"
    chmod 600 "${KEY_TEMP}"
    # Cursor Secrets often store PEM as one line with \n escapes.
    printf '%b' "${VPS_SSH_PRIVATE_KEY}" > "${KEY_TEMP}"
    KEY_FILE="${KEY_TEMP}"
    return
  fi

  # Desktop fallback (Windows path via WSL / Git Bash is user's responsibility).
  local desktop_key="${HOME}/.ssh/botadmin_187_auto"
  if [[ -f "${desktop_key}" ]]; then
    KEY_FILE="${desktop_key}"
    return
  fi

  cat >&2 <<'EOF'
vps-ssh: no SSH credentials.

Cloud Agent (iPhone): add Cursor Secret VPS_SSH_PRIVATE_KEY_B64 or VPS_SSH_PRIVATE_KEY.
See docs/agents/CLOUD_AGENT_VPS_SSH.md

Desktop: export VPS_SSH_KEY_PATH=~/.ssh/botadmin_187_auto
EOF
  exit 2
}

ssh_base() {
  resolve_key_file
  ssh \
    -i "${KEY_FILE}" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=20 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    "${USER}@${HOST}" \
    "$@"
}

if [[ "${1:-}" == "--test" ]]; then
  ssh_base "echo vps-ssh-ok host=\$(hostname) user=\$(whoami) date=\$(date -Is)"
  exit 0
fi

if [[ "${1:-}" == "--salpha" ]]; then
  shift
  if [[ $# -lt 1 ]]; then
    echo "vps-ssh: --salpha requires a command" >&2
    exit 1
  fi
  REMOTE_CMD="$1"
  ssh_base "sudo -u ${RUNTIME_USER} -H bash -c $(printf '%q' "cd ${APP_DIR} && ${REMOTE_CMD}")"
  exit 0
fi

if [[ $# -lt 1 ]]; then
  echo "vps-ssh: missing remote command (or use --test / --salpha)" >&2
  exit 1
fi

ssh_base "$@"
