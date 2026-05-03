#!/usr/bin/env bash
# Пилот GRWS на VPS: seed-пул (стабильный RPC-путь), замер QN через расширение окна Admin API,
# счётчик кошельков по времени и по логу коллектора.
set -euo pipefail
APP=/opt/solana-alpha
KEY_FILE="$APP/data/qn-admin-api-key.secret"
QN_API="https://api.quicknode.com/v0/usage/rpc"
LOG=/tmp/grws-pilot-$(date -u +%Y%m%dT%H%M%SZ).log

qn_credits_used_in_window() {
  local s="$1"
  local e="$2"
  sudo -u salpha bash -lc "KEY=\$(cat '$KEY_FILE'); curl -sS '${QN_API}?start_time=${s}&end_time=${e}' -H 'accept: application/json' -H \"x-api-key: \${KEY}\"" |
    node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const u=j.data??j;const n=u.credits_used;console.log(Number.isFinite(n)?String(Math.round(n)):'na');}catch(e){console.log('parse_err');}});"
}

echo "=== GRWS pilot log: $LOG ===" | tee "$LOG"
echo "cron_note=sleep 90s: TG hourly :05 UTC; post-pm2_reload burst fade" | tee -a "$LOG"
sleep 90

SEED_JSON=/tmp/grws-seed-pools.json
cat >"$SEED_JSON" <<'EOF'
[{"pool_address":"DQpk9uTXHDNbg2dC6K2r5Yyh11T3XRvxqj4BuCap8uu6","base_mint":"6PCvNLVm46eXHNAPEMARFCDTGimWRRQV37mrSBMHKAyu","quote_mint":"So11111111111111111111111111111111111111112"}]
EOF
chmod a+r "$SEED_JSON"
echo "seed_pools_file=$SEED_JSON (обход Gecko для стабильного пилота)" | tee -a "$LOG"

T_MARK=$(date +%s)
WINDOW_START=$((T_MARK - 3600))
echo "utc_T_MARK=$(date -u -d "@${T_MARK}" +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
echo "qn_window_for_delta=[start=\${WINDOW_START}..end=T_MARK] then end=T_POLL after 120s sleep" | tee -a "$LOG"

CRED_BEFORE="$(qn_credits_used_in_window "$WINDOW_START" "$T_MARK")"
echo "qn_credits_used_window_before_run(start=${WINDOW_START},end=${T_MARK})=$CRED_BEFORE" | tee -a "$LOG"

T0_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "wallets_cutoff_first_seen_utc=$T0_ISO" | tee -a "$LOG"

W_BEFORE_TOTAL=$(sudo -u postgres psql -d solana_alpha -t -A -c "SELECT count(*)::text FROM wallets WHERE coalesce(metadata->>'collector_id','') = 'sa-grws';")
echo "wallets_sa_grws_total_before=$W_BEFORE_TOTAL" | tee -a "$LOG"

sudo -u salpha bash -lc "cd '$APP' && \
  SA_GRWS_SEED_POOLS_PATH=${SEED_JSON} \
  SA_GRWS_MAX_POOLS_PER_RUN=5 \
  SA_GRWS_SIG_PAGES_MAX=3 \
  SA_GRWS_MAX_TX_FETCHES_PER_POOL=15 \
  SA_GRWS_RPC_SLEEP_MS=350 \
  SA_GRWS_DRY_RUN=0 \
  /usr/bin/node scripts-tmp/sa-grws-collector.mjs" 2>&1 | tee -a "$LOG"

T_END=$(date +%s)
echo "collector_elapsed_sec=$((T_END - T_MARK))" | tee -a "$LOG"

# Дать QuickNode Console API время включить RPC в окно (иначе короткие срезы часто 0).
sleep 120
T_POLL=$(date +%s)
CRED_AFTER="$(qn_credits_used_in_window "$WINDOW_START" "$T_POLL")"
echo "qn_credits_used_window_after_poll(start=${WINDOW_START},end=${T_POLL})=$CRED_AFTER" | tee -a "$LOG"

node -e "
const before = Number(process.argv[1]);
const after = Number(process.argv[2]);
const ok = Number.isFinite(before) && Number.isFinite(after);
console.log('qn_credits_delta_expanded_window_approx=' + (ok ? String(Math.max(0, Math.round(after - before))) : 'n/a'));
console.log('qn_note=delta ~ usage за интервал [T_MARK .. T_POLL] плюс шум других процессов на том же аккаунте');
" "$CRED_BEFORE" "$CRED_AFTER" | tee -a "$LOG"

W_AFTER_TOTAL=$(sudo -u postgres psql -d solana_alpha -t -A -c "SELECT count(*)::text FROM wallets WHERE coalesce(metadata->>'collector_id','') = 'sa-grws';")
echo "wallets_sa_grws_total_after=$W_AFTER_TOTAL" | tee -a "$LOG"

W_NEW_SINCE=$(sudo -u postgres psql -d solana_alpha -t -A -c "SELECT count(*)::text FROM wallets WHERE coalesce(metadata->>'collector_id','') = 'sa-grws' AND first_seen_at >= '${T0_ISO}'::timestamptz;")
echo "wallets_sa_grws_new_since_cutoff=$W_NEW_SINCE" | tee -a "$LOG"

node -e "
const fs = require('fs');
const p = process.argv[1];
const raw = fs.readFileSync(p, 'utf8');
const lines = raw.split(/\n/).filter(l => l.includes('\"msg\":\"tick completed\"'));
const last = lines[lines.length - 1];
if (!last) { console.log('collector_tick_parse=no_tick_line'); process.exit(0); }
try {
  const j = JSON.parse(last);
  console.log('collector_walletsInserted=' + (j.walletsInserted ?? 'n/a'));
  console.log('collector_walletsUnique=' + (j.walletsUnique ?? 'n/a'));
  console.log('collector_rpcBillableCalls=' + (j.rpcBillableCalls ?? 'n/a'));
  console.log('collector_estimatedQuicknodeCredits=' + (j.estimatedQuicknodeCredits ?? 'n/a'));
  console.log('collector_txFetchedTotal=' + (j.txFetchedTotal ?? 'n/a'));
} catch (e) {
  console.log('collector_tick_parse=error');
}
" "$LOG" | tee -a "$LOG"

echo "=== pilot done ===" | tee -a "$LOG"
