#!/usr/bin/env bash
# Encrypted backup of .env and wallet keypairs (gpg symmetric). Never commit output.
# Local: /home/salpha/backups/encrypted/ (30d rotation). Optional R2 when credentials present.
# Requires BACKUP_GPG_PASSPHRASE or BACKUP_GPG_PASSPHRASE_FILE in .env (outside git).
# Cron: 20 3 * * * bash /opt/solana-alpha/scripts/ops/backup-secrets-encrypted.sh >> /opt/solana-alpha/data/logs/secrets-backup.log 2>&1
set -euo pipefail

BASE="${APP_DIR:-/opt/solana-alpha}"
LOG="${BASE}/data/logs/secrets-backup.log"
BACKUP_DIR="${BACKUP_HOME:-/home/salpha/backups}/encrypted"

mkdir -p "${BACKUP_DIR}" "${BASE}/data/logs"

# shellcheck disable=SC1091
source "${BASE}/scripts/ops/_backup-common.sh"
load_backup_env

GPG_COMPLETE=0
trap 'rc=$?; rm -rf "${STAGING:-}" "${TMPDIR:-}"; if [[ $rc -ne 0 && "${GPG_COMPLETE}" -ne 1 ]]; then rm -f "${TAR:-}" "${ARCHIVE:-}"; fi; if [[ $rc -ne 0 ]]; then send_tg_backup "[HEALTH][backup-secrets] FAIL rc=$rc; see ${LOG}"; fi; exit "$rc"' EXIT

if ! command -v gpg >/dev/null 2>&1; then
  log "gpg not found"
  exit 1
fi

PASSPHRASE="${BACKUP_GPG_PASSPHRASE:-}"
if [[ -z "${PASSPHRASE}" && -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" && -f "${BACKUP_GPG_PASSPHRASE_FILE}" ]]; then
  PASSPHRASE=$(<"${BACKUP_GPG_PASSPHRASE_FILE}")
fi

if [[ -z "${PASSPHRASE}" ]]; then
  log "Missing BACKUP_GPG_PASSPHRASE or BACKUP_GPG_PASSPHRASE_FILE — skip secrets backup"
  exit 0
fi

TS=$(date +%Y%m%d-%H%M%S)
STAGING="/tmp/secrets_backup_${TS}"
TAR="${STAGING}/bundle.tar"
ARCHIVE="${BACKUP_DIR}/secrets_${TS}.tar.gz.gpg"

mkdir -p "${STAGING}/files"

copy_if_exists() {
  local src="$1"
  local dest_name="$2"
  if [[ -f "${src}" ]]; then
    cp -a "${src}" "${STAGING}/files/${dest_name}"
    log "included $(basename "${src}")"
  fi
}

log "secrets backup start ts=${TS}"

copy_if_exists "${BASE}/.env" "dot-env"
copy_if_exists "${BASE}/.env.hourly" "dot-env-hourly"

while IFS= read -r kp; do
  [[ -z "${kp}" ]] && continue
  rel="${kp#${BASE}/}"
  safe_name="${rel//\//__}"
  cp -a "${kp}" "${STAGING}/files/${safe_name}"
  log "included keypair ${safe_name}"
done < <(find "${BASE}/data" -name '*.keypair.json' -type f 2>/dev/null | sort)

if [[ ! -f "${STAGING}/files/dot-env" && -z "$(ls -A "${STAGING}/files" 2>/dev/null)" ]]; then
  log "nothing to backup"
  rm -rf "${STAGING}"
  exit 0
fi

tar -C "${STAGING}" -cf "${TAR}" files
printf '%s' "${PASSPHRASE}" | gpg --batch --yes --passphrase-fd 0 \
  --symmetric --cipher-algo AES256 -o "${ARCHIVE}" "${TAR}"
GPG_COMPLETE=1
rm -rf "${STAGING}"
STAGING=""

log "encrypted archive ok $(basename "${ARCHIVE}")"

if r2_credentials_ok; then
  TMPDIR="/tmp/r2_secrets_${TS}"
  mkdir -p "${TMPDIR}"
  if r2_put_chunked "${ARCHIVE}" "secrets/${TS}/secrets_${TS}.tar.gz.gpg" "${TMPDIR}"; then
    log "secrets uploaded to R2 prefix secrets/${TS}/"
  else
    rm -rf "${TMPDIR}"
    exit 1
  fi
  rm -rf "${TMPDIR}"
else
  log "R2 credentials missing — local encrypted copy only"
fi

find "${BACKUP_DIR}" -type f -name 'secrets_*.tar.gz.gpg' -mtime +7 -delete || true

send_tg_backup "[HEALTH][backup-secrets] OK ts=${TS}"
log "secrets backup done"
