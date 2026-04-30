#!/usr/bin/env bash
# List Cloudflare R2 bucket contents and look for atlas backups.
set -euo pipefail
ENV_FILE="${ENV_FILE:-/opt/solana-alpha/.env}"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}"

echo "=== bucket=${R2_BUCKET} ==="
echo "--- top-level keys (first 1000, sorted by key) ---"
curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${API}/objects?per_page=1000" \
  | jq -r '.result[]?.key' \
  | sort

echo ""
echo "--- objects with size, mtime (raw json, last 30 by key) ---"
curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${API}/objects?per_page=1000" \
  | jq '[.result[] | {key, size, uploaded: .uploaded}] | sort_by(.key) | reverse | .[0:30]'

echo ""
echo "--- prefix scan: postgres/ ---"
curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${API}/objects?per_page=1000&prefix=postgres/" \
  | jq -r '.result[]?.key' | sort | uniq -c | sort -nr | head -20

echo ""
echo "--- prefix scan: atlas/ ---"
curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${API}/objects?per_page=1000&prefix=atlas/" \
  | jq -r '.result[]?.key' | sort | head -20 || true

echo ""
echo "--- prefix scan: wallet_tags ---"
curl -sS -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${API}/objects?per_page=1000&prefix=wallet_tags" \
  | jq -r '.result[]?.key' | sort | head -20 || true

echo "DONE"
