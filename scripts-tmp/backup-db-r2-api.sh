#!/usr/bin/env bash
# Legacy path — delegates to tracked scripts/ops/backup-db-r2-api.sh
exec bash /opt/solana-alpha/scripts/ops/backup-db-r2-api.sh "$@"
