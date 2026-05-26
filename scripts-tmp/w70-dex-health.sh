#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
set -a
# shellcheck disable=SC1091
source ./.env
set +a
for s in raydium meteora orca moonshot; do
  code=$(curl -fsS -u "${DASHBOARD_BASIC_USER}:${DASHBOARD_BASIC_PASSWORD}" -o /dev/null -w "%{http_code}" "http://127.0.0.1:3008/api/dex/${s}/health")
  echo "api/dex/${s}/health ${code}"
done
code=$(curl -fsS -u "${DASHBOARD_BASIC_USER}:${DASHBOARD_BASIC_PASSWORD}" -o /dev/null -w "%{http_code}" http://127.0.0.1:3008/api/jupiter/health)
echo "api/jupiter/health ${code}"
code=$(curl -fsS -u "${DASHBOARD_BASIC_USER}:${DASHBOARD_BASIC_PASSWORD}" -o /dev/null -w "%{http_code}" http://127.0.0.1:3008/api/direct-lp/health)
echo "api/direct-lp/health ${code}"
