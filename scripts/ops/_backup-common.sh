#!/usr/bin/env bash
# Shared helpers for scripts/ops/backup-*.sh (source, do not execute directly).
set -euo pipefail

BASE="${APP_DIR:-/opt/solana-alpha}"
BACKUP_HOME="${BACKUP_HOME:-/home/salpha/backups}"

ts_iso() { date -Is; }

log() {
  local msg="[$(ts_iso)] $*"
  echo "$msg"
  if [[ -n "${LOG:-}" ]]; then
    echo "$msg" >>"${LOG}"
  fi
}

load_backup_env() {
  if [[ -f "${BASE}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${BASE}/.env"
    set +a
  fi
  CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
  CF_API_TOKEN="${CF_API_TOKEN:-}"
  R2_BUCKET="${R2_BUCKET:-solana-alpha-backups}"
  export CF_ACCOUNT_ID CF_API_TOKEN R2_BUCKET
}

send_tg_backup() {
  local text="$1"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -sS -m 10 -X POST \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -H "content-type: application/json" \
      -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"text\":\"${text}\"}" \
      >/dev/null || true
  fi
}

r2_credentials_ok() {
  [[ -n "${CF_ACCOUNT_ID}" && -n "${CF_API_TOKEN}" && -n "${R2_BUCKET}" ]]
}

# PUT one object to R2; prints HTTP status code.
r2_put_object() {
  local key="$1"
  local file="$2"
  local url="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${key}"
  curl -sS -o "${3:-/dev/null}" -w "%{http_code}" \
    -X PUT "${url}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    --data-binary @"${file}"
}

# Upload file to R2, splitting into <=90MB chunks when needed.
r2_put_chunked() {
  local file="$1"
  local prefix="$2"
  local tmpdir="$3"
  local resp_dir="${tmpdir}/resp"
  mkdir -p "${resp_dir}"

  local size
  size=$(stat -c '%s' "${file}")
  local chunk_limit=$((90 * 1024 * 1024))

  if [[ "${size}" -le "${chunk_limit}" ]]; then
    local key="${prefix}/$(basename "${file}")"
    local code
    code=$(r2_put_object "${key}" "${file}" "${resp_dir}/single.json")
    if [[ "${code}" != "200" ]]; then
      log "R2 upload failed key=${key} code=${code}"
      return 1
    fi
    log "R2 upload ok key=${key} size=${size}B"
    return 0
  fi

  split -b 90M -d -a 4 "${file}" "${tmpdir}/part_"
  local idx=0
  for part in "${tmpdir}"/part_*; do
    local name
    name=$(basename "${part}")
    local key="${prefix}/${name}"
    local code
    code=$(r2_put_object "${key}" "${part}" "${resp_dir}/${name}.json")
    if [[ "${code}" != "200" ]]; then
      log "R2 chunk upload failed chunk=${name} code=${code}"
      return 1
    fi
    idx=$((idx + 1))
  done

  local manifest="${tmpdir}/manifest.txt"
  {
    echo "file=$(basename "${file}")"
    echo "parts=${idx}"
    echo "created_at=$(ts_iso)"
    echo "archive_size=${size}"
    for part in "${tmpdir}"/part_*; do
      echo "$(basename "${part}")"
    done
  } >"${manifest}"

  local mkey="${prefix}/manifest.txt"
  local mcode
  mcode=$(r2_put_object "${mkey}" "${manifest}" "${resp_dir}/manifest.json")
  if [[ "${mcode}" != "200" ]]; then
    log "R2 manifest upload failed code=${mcode}"
    return 1
  fi
  log "R2 chunked upload ok prefix=${prefix} parts=${idx} size=${size}B"
}
