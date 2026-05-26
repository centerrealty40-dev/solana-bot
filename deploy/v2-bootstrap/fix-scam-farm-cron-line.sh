#!/usr/bin/env bash
# Fix SCAM_FARM_CRON so `set -a && source .env` does not glob-expand */30
set -euo pipefail
ENVF="${1:-/opt/solana-alpha/.env}"
tmp="$(mktemp)"
grep -v '^SCAM_FARM_CRON=' "$ENVF" > "$tmp"
printf '%s\n' 'SCAM_FARM_CRON="*/30 * * * *"' >> "$tmp"
mv "$tmp" "$ENVF"
