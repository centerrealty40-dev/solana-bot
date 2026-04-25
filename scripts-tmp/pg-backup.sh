#!/bin/bash
set -euo pipefail
source /opt/solana-alpha/.env
BACKUP_DIR=/var/backups/postgres
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d-%H%M)
pg_dump "$DATABASE_URL" \
  --format=custom --no-owner --no-privileges \
  | gzip > "$BACKUP_DIR/solana_alpha-$DATE.dump.gz"
find "$BACKUP_DIR" -name "solana_alpha-*.dump.gz" -mtime +14 -delete
echo "[$(date)] backup ok: $(ls -lh $BACKUP_DIR/solana_alpha-$DATE.dump.gz | awk '{print $5,$9}')"
