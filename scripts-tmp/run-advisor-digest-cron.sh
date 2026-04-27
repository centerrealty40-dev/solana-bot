#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
set -a
. /opt/solana-alpha/.env.hourly
export DIGEST_WINDOW_HOURS=24
export DIGEST_TOP_N=6
export DIGEST_SEND_TELEGRAM=1
mkdir -p /opt/solana-alpha/data/logs
exec /usr/bin/node scripts-tmp/advisor-digest.mjs >> /opt/solana-alpha/data/logs/advisor-digest.log 2>&1
