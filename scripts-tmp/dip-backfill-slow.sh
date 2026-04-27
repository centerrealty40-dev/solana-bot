#!/usr/bin/env bash
cd /opt/solana-alpha || exit 1
set -euo pipefail

cd /opt/solana-alpha

WALLET="${DIP_WALLET:-498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma}"
DB_URL="${DATABASE_URL:-postgresql://salpha@/solana_alpha?host=/var/run/postgresql}"

RPCS=(
  "https://api.mainnet-beta.solana.com"
)

MAX_HOURS="${MAX_HOURS:-2}"
BATCH_SIGS="${BATCH_SIGS:-25}"
RPC_DELAY_MS="${RPC_DELAY_MS:-2500}"

end_ts=$(( $(date +%s) + MAX_HOURS*3600 ))
i=0

echo "start $(date -Is) wallet=${WALLET} hours=${MAX_HOURS}" | tee -a /opt/solana-alpha/data/logs/dip-backfill-slow.log

while [ "$(date +%s)" -lt "$end_ts" ]; do
  rpc="${RPCS[$((i % ${#RPCS[@]}))]}"
  i=$((i+1))

  echo "--- iter=$i rpc=$rpc $(date -Is)" | tee -a /opt/solana-alpha/data/logs/dip-backfill-slow.log

  set +e
  out=$(
    DATABASE_URL="$DB_URL" \
    PUBLIC_RPC_URL="$rpc" \
    DIP_WALLET="$WALLET" \
    DIP_LOOKBACK_DAYS=30 \
    DIP_MAX_SIGNATURES="$BATCH_SIGS" \
    DIP_RPC_DELAY_MS="$RPC_DELAY_MS" \
    node /opt/solana-alpha/scripts-tmp/dip-strategy-lab.mjs backfill 2>&1
  )
  code=$?
  set -e

  echo "$out" | tail -n 20 | tee -a /opt/solana-alpha/data/logs/dip-backfill-slow.log

  cnt=$(psql "${DB_URL:-postgresql://salpha@/solana_alpha?host=/var/run/postgresql}" -Atqc "select count(*) from wallet_trades_raw where wallet='${WALLET}'" 2>/dev/null || echo "0")
  echo "rows_now=$cnt" | tee -a /opt/solana-alpha/data/logs/dip-backfill-slow.log

  if echo "$out" | grep -qi "Too many requests"; then
    sleep 45
  elif [ $code -ne 0 ]; then
    sleep 20
  else
    sleep 8
  fi
done

echo "done $(date -Is)" | tee -a /opt/solana-alpha/data/logs/dip-backfill-slow.log
