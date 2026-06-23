#!/usr/bin/env bash
# Legacy path — delegates to tracked scripts/ops/restore-from-r2-chunks.sh
exec bash /opt/solana-alpha/scripts/ops/restore-from-r2-chunks.sh "$@"
