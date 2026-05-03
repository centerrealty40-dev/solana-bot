#!/usr/bin/env bash
set -euo pipefail
APP=/opt/solana-alpha
KEY_FILE="$APP/data/qn-admin-api-key.secret"
QN_API="https://api.quicknode.com/v0/usage/rpc"
LOG=/tmp/grws-pilot-$(date -u +%Y%m%dT%H%M%SZ).log

qn_period_credits() {
  sudo -u salpha bash -lc "KEY=\$(cat '$KEY_FILE'); curl -sS '$QN_API' -H 'accept: application/json' -H \"x-api-key: \${KEY}\"" |
    node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const u=j.data??j;console.log(typeof u.credits_used==='number'?u.credits_used:'na');}catch(e){console.log('parse_err');}});"
}

echo "=== GRWS pilot log: $LOG ===" | tee "$LOG"
echo "cron_note=avoid TG hourly at :05 UTC; sleep reduces Gecko 429 noise" | tee -a "$LOG"
sleep 75
SEED_JSON=/tmp/grws-seed-pools.json
cat >"$SEED_JSON" <<'EOF'
[{"pool_address":"DQpk9uTXHDNbg2dC6K2r5Yyh11T3XRvxqj4BuCap8uu6","base_mint":"6PCvNLVm46eXHNAPEMARFCDTGimWRRQV37mrSBMHKAyu","quote_mint":"So11111111111111111111111111111111111111112"}]
EOF
chmod a+r "$SEED_JSON"
echo "seed_pools_file=$SEED_JSON (benchmark; skips Gecko)" | tee -a "$LOG"

echo "utc_mark_start=$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"

T0=$(date +%s)
echo "T0_unix=$T0" | tee -a "$LOG"

CRED_START="$(qn_period_credits)"
echo "qn_billing_period_credits_used_start=$CRED_START" | tee -a "$LOG"

BEFORE=$(sudo -u postgres psql -d solana_alpha -t -A -c "SELECT count(*)::text FROM wallets WHERE coalesce(metadata->>'collector_id','') = 'sa-grws';")
echo "wallets_sa_grws_before=$BEFORE" | tee -a "$LOG"

TREF=$((T0 - 120))
REF_JSON=$(sudo -u salpha bash -lc "KEY=\$(cat '$KEY_FILE'); curl -sS '${QN_API}?start_time=${TREF}&end_time=${T0}' -H 'accept: application/json' -H \"x-api-key: \${KEY}\"")
echo "qn_ref_window_last_120s_json=$REF_JSON" | tee -a "$LOG"

sudo -u salpha bash -lc "cd '$APP' && \
  SA_GRWS_SEED_POOLS_PATH=${SEED_JSON} \
  SA_GRWS_MAX_POOLS_PER_RUN=5 \
  SA_GRWS_SIG_PAGES_MAX=3 \
  SA_GRWS_MAX_TX_FETCHES_PER_POOL=15 \
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

sleep 45
CRED_END="$(qn_period_credits)"
echo "qn_billing_period_credits_used_end=$CRED_END" | tee -a "$LOG"
node -e "
const a=process.argv[1], b=process.argv[2];
const x=Number(a), y=Number(b);
console.log('qn_billing_delta_approx=' + (Number.isFinite(x)&&Number.isFinite(y) ? String(Math.round(y-x)) : 'n/a'));
" "$CRED_START" "$CRED_END" | tee -a "$LOG"

echo "=== pilot done ===" | tee -a "$LOG"
