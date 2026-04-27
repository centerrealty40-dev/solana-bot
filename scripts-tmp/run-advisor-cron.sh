#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
set -a
. /opt/solana-alpha/.env.hourly
export ADVISOR_WINDOW_HOURS=24
export ADVISOR_MIN_N=5
export ADVISOR_MIN_N_BUCKET=4
export ADVISOR_SEND_TELEGRAM=1
mkdir -p /opt/solana-alpha/data/logs
exec /usr/bin/node scripts-tmp/strategy-advisor.mjs >> /opt/solana-alpha/data/logs/advisor.log 2>&1
