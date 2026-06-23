#!/usr/bin/env bash
# Postgres → Cloudflare R2 (chunked, via R2 HTTP API).
# Reads CF_*, R2_BUCKET, TELEGRAM_* from /opt/solana-alpha/.env.
# Cron: 10 3 * * * bash /opt/solana-alpha/scripts/ops/backup-db-r2-api.sh >> /opt/solana-alpha/data/logs/db-backup.log 2>&1
set -euo pipefail

BASE="${APP_DIR:-/opt/solana-alpha}"
LOG="${BASE}/data/logs/db-backup.log"
BACKUP_DIR="${BACKUP_HOME:-/home/salpha/backups}/postgres"

mkdir -p "${BACKUP_DIR}" "${BASE}/data/logs"
cd "${BASE}"

# shellcheck disable=SC1091
source "${BASE}/scripts/ops/_backup-common.sh"
load_backup_env

trap 'rc=$?; if [[ $rc -ne 0 ]]; then send_tg_backup "[HEALTH][backup-db] FAIL rc=$rc; see ${LOG}"; fi' EXIT

if ! r2_credentials_ok; then
  log "Missing CF_ACCOUNT_ID / CF_API_TOKEN / R2_BUCKET"
  exit 1
fi

DB_NAME="solana_alpha"
TS=$(date +%Y%m%d-%H%M%S)
DUMP="${BACKUP_DIR}/${DB_NAME}_${TS}.dump"
ARCHIVE="${DUMP}.zst"
BASENAME="$(basename "${ARCHIVE}")"
PREFIX="postgres/chunks/${BASENAME}"
TMPDIR="/tmp/r2_db_${TS}"

log "backup start (target=${PREFIX})"

pg_dump -Fc --no-owner --no-acl \
  --schema=public --schema=drizzle \
  -d "${DB_NAME}" -f "${DUMP}"
DUMP_SIZE=$(stat -c '%s' "${DUMP}")
log "pg_dump ok size=${DUMP_SIZE}B file=${DUMP}"

zstd -q -19 -T0 "${DUMP}" -o "${ARCHIVE}"
rm -f "${DUMP}"
ARCH_SIZE=$(stat -c '%s' "${ARCHIVE}")
log "compress ok size=${ARCH_SIZE}B file=${ARCHIVE}"

mkdir -p "${TMPDIR}"
if ! r2_put_chunked "${ARCHIVE}" "${PREFIX}" "${TMPDIR}"; then
  exit 1
fi

find "${BACKUP_DIR}" -type f -name "*.dump.zst" -mtime +14 -delete || true
rm -rf "${TMPDIR}"

human_size=$(numfmt --to=iec --suffix=B "${ARCH_SIZE}" 2>/dev/null || echo "${ARCH_SIZE}B")
send_tg_backup "[HEALTH][backup-db] OK ${DB_NAME} ${TS} archive=${human_size}"
log "backup done"
