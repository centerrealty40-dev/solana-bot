#!/usr/bin/env bash
set -euo pipefail
APP=/opt/solana-alpha
KEY_FILE="$APP/data/qn-admin-api-key.secret"
QN_API="https://api.quicknode.com/v0/usage/rpc"
LOG=/tmp/grws-pilot-$(date -u +%Y%m%dT%H%M%SZ).log

echo "=== GRWS pilot log: $LOG ===" | tee "$LOG"
echo "utc_mark_start=$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"

T0=$(date +%s)
echo "T0_unix=$T0" | tee -a "$LOG"

BEFORE=$(sudo -u postgres psql -d solana_alpha -t -A -c "SELECT count(*)::text FROM wallets WHERE coalesce(metadata->>'collector_id','') = 'sa-grws';")
echo "wallets_sa_grws_before=$BEFORE" | tee -a "$LOG"

TREF=$((T0 - 120))
REF_JSON=$(sudo -u salpha bash -lc "KEY=\$(cat '$KEY_FILE'); curl -sS '${QN_API}?start_time=${TREF}&end_time=${T0}' -H 'accept: application/json' -H \"x-api-key: \${KEY}\"")
echo "qn_ref_window_last_120s_json=$REF_JSON" | tee -a "$LOG"

sudo -u salpha bash -lc "cd '$APP' && \
  SA_GRWS_GECKO_PAGES_MAX=2 \
  SA_GRWS_MAX_POOLS_PER_RUN=5 \
  SA_GRWS_SIG_PAGES_MAX=3 \
  SA_GRWS_MAX_TX_FETCHES_PER_POOL=12 \
  SA_GRWS_RPC_SLEEP_MS=350 \
  SA_GRWS_DRY_RUN=0 \
  /usr/bin/node scripts-tmp/sa-grws-collector.mjs" 2>&1 | tee -a "$LOG"

T1=$(date +%s)
echo "T1_unix=$T1" | tee -a "$LOG"
echo "elapsed_sec=$((T1 - T0))" | tee -a "$LOG"
echo "utc_mark_end=$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"

WIN_JSON=$(sudo -u salpha bash -lc "KEY=\$(cat '$KEY_FILE'); curl -sS '${QN_API}?start_time=${T0}&end_time=${T1}' -H 'accept: application/json' -H \"x-api-key: \${KEY}\"")
echo "qn_experiment_window_json=$WIN_JSON" | tee -a "$LOG"

AFTER=$(sudo -u postgres psql -d solana_alpha -t -A -c "SELECT count(*)::text FROM wallets WHERE coalesce(metadata->>'collector_id','') = 'sa-grws';")
echo "wallets_sa_grws_after=$AFTER" | tee -a "$LOG"

echo "=== pilot done ===" | tee -a "$LOG"
