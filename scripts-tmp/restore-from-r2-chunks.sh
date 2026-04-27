#!/usr/bin/env bash
set -euo pipefail

CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
CF_API_TOKEN="${CF_API_TOKEN:-}"
R2_BUCKET="${R2_BUCKET:-solana-alpha-backups}"
PREFIX="${1:-}"   # optional: postgres/chunks/solana_alpha_YYYYMMDD-HHMMSS.dump.zst

WORKDIR="/tmp/r2-restore-check"
mkdir -p "${WORKDIR}"
cd "${WORKDIR}"

if [[ -z "${CF_ACCOUNT_ID}" || -z "${CF_API_TOKEN}" ]]; then
  echo "Missing CF_ACCOUNT_ID / CF_API_TOKEN"
  exit 1
fi

LIST_URL="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects?prefix=postgres/chunks/"
JSON=$(curl -sS "${LIST_URL}" -H "Authorization: Bearer ${CF_API_TOKEN}")
echo "${JSON}" > objects.json

if ! grep -q "\"success\":true" objects.json; then
  echo "List failed:"
  cat objects.json
  exit 1
fi

if [[ -z "${PREFIX}" ]]; then
  PREFIX=$(python3 - <<PY
import json
j=json.load(open("objects.json"))
r=j.get("result", [])
if isinstance(r, dict):
    objs=r.get("objects", [])
elif isinstance(r, list):
    objs=r
else:
    objs=[]
keys=[]
for o in objs:
    if isinstance(o, dict) and "key" in o:
        keys.append(o["key"])
man=[k for k in keys if k.endswith("/manifest.txt")]
man.sort()
print(man[-1].rsplit("/manifest.txt",1)[0] if man else "")
PY
)
fi

if [[ -z "${PREFIX}" ]]; then
  echo "No backup manifests found in R2."
  exit 1
fi

echo "Using prefix: ${PREFIX}"

MANIFEST_URL="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${PREFIX}/manifest.txt"
curl -sS "${MANIFEST_URL}" -H "Authorization: Bearer ${CF_API_TOKEN}" -o manifest.txt

if ! grep -q "^parts=" manifest.txt; then
  echo "Bad manifest:"
  cat manifest.txt
  exit 1
fi

FILE_NAME=$(grep "^file=" manifest.txt | cut -d= -f2-)
PARTS=$(grep "^parts=" manifest.txt | cut -d= -f2)

echo "Manifest file=${FILE_NAME} parts=${PARTS}"

mkdir -p parts
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  URL="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${PREFIX}/${p}"
  curl -sS "${URL}" -H "Authorization: Bearer ${CF_API_TOKEN}" -o "parts/${p}"
done < <(tail -n +4 manifest.txt)

cat parts/part_* > "${FILE_NAME}"

ls -lh "${FILE_NAME}"
zstd -t "${FILE_NAME}"
zstd -d "${FILE_NAME}" -o dump.file
pg_restore --list dump.file >/dev/null

echo "RESTORE CHECK OK: archive valid, pg_restore can read dump"
