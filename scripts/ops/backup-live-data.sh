#!/usr/bin/env bash
# Backup live JSONL journals + runtime state (snapshots, denylist, graduated mints).
# Local: /home/salpha/backups/live/ (rotation). R2: runtime bundle + small journals daily; large journals weekly (--r2-full-journals).
# Cron daily:  30 3 * * * bash /opt/solana-alpha/scripts/ops/backup-live-data.sh >> /opt/solana-alpha/data/logs/live-backup.log 2>&1
# Cron weekly: 0 4 * * 0 bash /opt/solana-alpha/scripts/ops/backup-live-data.sh --r2-full-journals >> ...
set -euo pipefail

BASE="${APP_DIR:-/opt/solana-alpha}"
LIVE_DIR="${BASE}/data/live"
LOG="${BASE}/data/logs/live-backup.log"
BACKUP_DIR="${BACKUP_HOME:-/home/salpha/backups}/live"
R2_FULL=0

for arg in "$@"; do
  case "$arg" in
    --r2-full-journals) R2_FULL=1 ;;
  esac
done

mkdir -p "${BACKUP_DIR}/runtime" "${BACKUP_DIR}/journals" "${BASE}/data/logs"

# shellcheck disable=SC1091
source "${BASE}/scripts/ops/_backup-common.sh"
load_backup_env

trap 'rc=$?; if [[ $rc -ne 0 ]]; then send_tg_backup "[HEALTH][backup-live] FAIL rc=$rc; see ${LOG}"; fi' EXIT

TS=$(date +%Y%m%d-%H%M%S)

RUNTIME_FILES=(
  live-oscar-open-snapshot.json
  live-oscar-preset-c-open-snapshot.json
  live-oscar-permanent-denylist.txt
  live-oscar-permanent-denylist.seed.txt
  live-oscar-mint-graduated.txt
  live-oscar-preset-c-mint-graduated.txt
  live-oscar-preset-c-permanent-denylist.txt
  live-oscar-whitelist-consec-loss.json
)

DAILY_R2_JOURNALS=(
  live-oscar-preset-c.jsonl
)

LOCAL_JOURNALS=(
  pt1-oscar-live.jsonl
  live-oscar-preset-c.jsonl
)

log "live backup start ts=${TS} r2_full=${R2_FULL}"

# --- runtime bundle ---
RUNTIME_TAR="${BACKUP_DIR}/runtime/runtime_${TS}.tar"
RUNTIME_ZST="${RUNTIME_TAR}.zst"
RUNTIME_LIST=()
for f in "${RUNTIME_FILES[@]}"; do
  if [[ -f "${LIVE_DIR}/${f}" ]]; then
    RUNTIME_LIST+=("${f}")
  fi
done

if [[ ${#RUNTIME_LIST[@]} -eq 0 ]]; then
  log "runtime: no files found, skip"
else
  tar -C "${LIVE_DIR}" -cf "${RUNTIME_TAR}" "${RUNTIME_LIST[@]}"
  zstd -q -19 -T0 "${RUNTIME_TAR}" -o "${RUNTIME_ZST}"
  rm -f "${RUNTIME_TAR}"
  log "runtime bundle ok files=${#RUNTIME_LIST[@]} archive=${RUNTIME_ZST}"

  if r2_credentials_ok; then
    TMPDIR="/tmp/r2_live_runtime_${TS}"
    mkdir -p "${TMPDIR}"
    if r2_put_chunked "${RUNTIME_ZST}" "live/runtime/runtime_${TS}.tar.zst" "${TMPDIR}"; then
      log "runtime uploaded to R2"
    else
      exit 1
    fi
    rm -rf "${TMPDIR}"
  else
    log "runtime: R2 credentials missing, local only"
  fi
fi

find "${BACKUP_DIR}/runtime" -type f -name "*.tar.zst" -mtime +30 -delete || true

# --- journals: local zstd ---
compress_journal() {
  local src="$1"
  local dest="$2"
  local size
  size=$(stat -c '%s' "${src}")
  local level=19
  if [[ "${size}" -gt $((500 * 1024 * 1024)) ]]; then
    level=3
    log "journal large file (${size}B) using zstd -${level}"
  fi
  zstd -q "-${level}" -T0 "${src}" -o "${dest}"
}

# Copy active JSONL to staging so concurrent appends do not break zstd.
stage_journal_copy() {
  local src="$1"
  local staging="$2"
  log "journal staging copy start $(basename "${src}")"
  cp -a "${src}" "${staging}"
  log "journal staging copy ok $(basename "${staging}")"
}

for j in "${LOCAL_JOURNALS[@]}"; do
  src="${LIVE_DIR}/${j}"
  if [[ ! -f "${src}" ]]; then
    log "journal skip missing ${j}"
    continue
  fi
  dest="${BACKUP_DIR}/journals/${j%.jsonl}_${TS}.jsonl.zst"
  staging="${BACKUP_DIR}/journals/.staging_${j%.jsonl}_${TS}.jsonl"
  stage_journal_copy "${src}" "${staging}"
  compress_journal "${staging}" "${dest}"
  rm -f "${staging}"
  log "journal local ok ${j} -> $(basename "${dest}")"
done

find "${BACKUP_DIR}/journals" -type f -name "*.jsonl.zst" -mtime +7 -delete || true

# --- journals: daily R2 (small) ---
if r2_credentials_ok; then
  for j in "${DAILY_R2_JOURNALS[@]}"; do
    src="${LIVE_DIR}/${j}"
    [[ -f "${src}" ]] || continue
    archive="${BACKUP_DIR}/journals/${j%.jsonl}_${TS}.jsonl.zst"
    if [[ ! -f "${archive}" ]]; then
      staging="${BACKUP_DIR}/journals/.staging_${j%.jsonl}_${TS}.jsonl"
      stage_journal_copy "${src}" "${staging}"
      compress_journal "${staging}" "${archive}"
      rm -f "${staging}"
    fi
    TMPDIR="/tmp/r2_live_journal_${TS}_${j}"
    mkdir -p "${TMPDIR}"
    if r2_put_chunked "${archive}" "live/journals/${j%.jsonl}_${TS}.jsonl.zst" "${TMPDIR}"; then
      log "journal R2 ok ${j}"
    else
      rm -rf "${TMPDIR}"
      exit 1
    fi
    rm -rf "${TMPDIR}"
  done
fi

# --- large journals: weekly full R2 ---
if [[ "${R2_FULL}" -eq 1 ]] && r2_credentials_ok; then
  for j in pt1-oscar-live.jsonl; do
    src="${LIVE_DIR}/${j}"
    [[ -f "${src}" ]] || continue
    archive="${BACKUP_DIR}/journals/${j%.jsonl}_${TS}_weekly.jsonl.zst"
    log "weekly R2 journal compress start ${j}"
    staging="${BACKUP_DIR}/journals/.staging_${j%.jsonl}_${TS}_weekly.jsonl"
    stage_journal_copy "${src}" "${staging}"
    compress_journal "${staging}" "${archive}"
    rm -f "${staging}"
    TMPDIR="/tmp/r2_live_weekly_${TS}"
    mkdir -p "${TMPDIR}"
    if r2_put_chunked "${archive}" "live/journals-weekly/${j%.jsonl}_${TS}.jsonl.zst" "${TMPDIR}"; then
      log "weekly R2 journal ok ${j}"
    else
      rm -rf "${TMPDIR}"
      exit 1
    fi
    rm -rf "${TMPDIR}"
  done
  find "${BACKUP_DIR}/journals" -type f -name "*_weekly.jsonl.zst" -mtime +14 -delete || true
fi

send_tg_backup "[HEALTH][backup-live] OK ts=${TS} runtime_files=${#RUNTIME_LIST[@]} r2_full=${R2_FULL}"
log "live backup done"
