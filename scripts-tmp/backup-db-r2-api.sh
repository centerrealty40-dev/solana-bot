#!/usr/bin/env bash
# Postgres → Cloudflare R2 (chunked, via R2 HTTP API).
# Reads CF_*, R2_BUCKET, TELEGRAM_* from /opt/solana-alpha/.env.
# Cron: 10 3 * * * /opt/solana-alpha/scripts-tmp/backup-db-r2-api.sh >> /opt/solana-alpha/data/logs/db-backup.log 2>&1
set -euo pipefail

BASE="/opt/solana-alpha"
LOG="${BASE}/data/logs/db-backup.log"
mkdir -p "${BASE}/backups" "${BASE}/data/logs"

# load env (CF_*, R2_BUCKET, TELEGRAM_*) — same file as the rest of the stack
if [[ -f "${BASE}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${BASE}/.env"
  set +a
fi

CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
CF_API_TOKEN="${CF_API_TOKEN:-}"
R2_BUCKET="${R2_BUCKET:-solana-alpha-backups}"

DB_NAME="solana_alpha"
BACKUP_DIR="${BASE}/backups"

ts_iso() { date -Is; }

log()    { echo "[$(ts_iso)] $*" | tee -a "${LOG}"; }

send_tg() {
  local text="$1"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -sS -m 10 -X POST \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -H "content-type: application/json" \
      -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"text\":\"${text}\"}" \
      >/dev/null || true
  fi
}

trap 'rc=$?; if [[ $rc -ne 0 ]]; then send_tg "[HEALTH][backup] ❌ FAIL rc=$rc; see ${LOG}"; fi' EXIT

if [[ -z "${CF_ACCOUNT_ID}" || -z "${CF_API_TOKEN}" || -z "${R2_BUCKET}" ]]; then
  log "Missing CF_ACCOUNT_ID / CF_API_TOKEN / R2_BUCKET"
  exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)
DUMP="${BACKUP_DIR}/${DB_NAME}_${TS}.dump"
ARCHIVE="${DUMP}.zst"
BASENAME="$(basename "${ARCHIVE}")"
PREFIX="postgres/chunks/${BASENAME}"

log "backup start (target=${PREFIX})"

# dump only schemas owned by salpha (skip meteora_dash and any other foreign product)
pg_dump -Fc --no-owner --no-acl \
  --schema=public --schema=drizzle \
  -d "${DB_NAME}" -f "${DUMP}"
DUMP_SIZE=$(stat -c '%s' "${DUMP}")
log "pg_dump ok size=${DUMP_SIZE}B file=${DUMP}"

zstd -q -19 -T0 "${DUMP}" -o "${ARCHIVE}"
rm -f "${DUMP}"
ARCH_SIZE=$(stat -c '%s' "${ARCHIVE}")
log "compress ok size=${ARCH_SIZE}B file=${ARCHIVE}"

# split into <=90MB chunks to bypass R2 single-PUT 100MB limit
TMPDIR="/tmp/r2_${TS}"
mkdir -p "${TMPDIR}"
split -b 90M -d -a 4 "${ARCHIVE}" "${TMPDIR}/part_"

idx=0
for part in "${TMPDIR}"/part_*; do
  name=$(basename "${part}")
  key="${PREFIX}/${name}"
  url="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${key}"

  code=$(curl -sS -o "${TMPDIR}/resp_${name}.json" -w "%{http_code}" \
    -X PUT "${url}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    --data-binary @"${part}")

  if [[ "${code}" != "200" ]]; then
    log "upload failed chunk=${name} code=${code}"
    cat "${TMPDIR}/resp_${name}.json" | tee -a "${LOG}" >/dev/null
    exit 1
  fi
  idx=$((idx+1))
done

# manifest
MANIFEST="${TMPDIR}/manifest.txt"
{
  echo "file=${BASENAME}"
  echo "parts=${idx}"
  echo "created_at=$(ts_iso)"
  echo "dump_size=${DUMP_SIZE}"
  echo "archive_size=${ARCH_SIZE}"
  for part in "${TMPDIR}"/part_*; do
    echo "$(basename "${part}")"
  done
} > "${MANIFEST}"

mkey="${PREFIX}/manifest.txt"
murl="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${mkey}"
mcode=$(curl -sS -o "${TMPDIR}/resp_manifest.json" -w "%{http_code}" \
  -X PUT "${murl}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  --data-binary @"${MANIFEST}")
if [[ "${mcode}" != "200" ]]; then
  log "manifest upload failed code=${mcode}"
  cat "${TMPDIR}/resp_manifest.json" | tee -a "${LOG}" >/dev/null
  exit 1
fi

log "upload ok: ${PREFIX} parts=${idx} archive=${ARCH_SIZE}B"

# local retention (14d)
find "${BACKUP_DIR}" -type f -name "*.dump.zst" -mtime +14 -delete || true
find "${BACKUP_DIR}" -type f -name "*.dump"     -mtime +1  -delete || true
rm -rf "${TMPDIR}"

# Human-readable size for telegram
human_size=$(numfmt --to=iec --suffix=B "${ARCH_SIZE}" 2>/dev/null || echo "${ARCH_SIZE}B")
send_tg "[HEALTH][backup] ✅ OK ${DB_NAME} ${TS} parts=${idx} archive=${human_size}"
