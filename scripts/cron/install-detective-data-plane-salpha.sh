#!/usr/bin/env bash
# Идемпотентно добавляет в crontab пользователя salpha блок задач контура детектива
# без стрима: enqueue → wallet-backfill:pilot → funding → sigseed (ежечасно) → scam-farm → отчёты ledger.
#
# Запуск на VPS (после git pull):
#   sudo bash /opt/solana-alpha/scripts/cron/install-detective-data-plane-salpha.sh
#
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
U="${CRON_USER:-salpha}"

if [[ ! -d "$ROOT" ]]; then
  echo "[fatal] directory not found: $ROOT"
  exit 1
fi

mkdir -p "$ROOT/data/logs"

sudo -u "$U" env ROOT="$ROOT" bash <<'EOSCRIPT'
set -euo pipefail
TMP="$(mktemp)"
chmod 600 "$TMP"
(crontab -l 2>/dev/null || true) | awk '
/^# SA_ALPHA_DP_BEGIN$/ {skip=1; next}
/^# SA_ALPHA_DP_END$/ {skip=0; next}
!skip {print}
' >"$TMP"

cat >>"$TMP" <<EOF
# SA_ALPHA_DP_BEGIN
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SHELL=/bin/bash
10 3 * * * cd $ROOT && SA_BACKFILL_ENABLED=1 npm run wallet-backfill:run -- --enqueue-from-wallets=500 >> $ROOT/data/logs/wallet-backfill-enqueue.log 2>&1
25 3 * * * cd $ROOT && SA_BACKFILL_ENABLED=1 npm run wallet-backfill:pilot >> $ROOT/data/logs/wallet-backfill-pilot-cron.log 2>&1
40 3 * * * cd $ROOT && SA_FUNDING_BACKFILL_ENABLED=1 npm run wallet-funding:backfill >> $ROOT/data/logs/wallet-funding-backfill.log 2>&1
15 4 * * * cd $ROOT && npm run scam-farm:detect >> $ROOT/data/logs/scam-farm-detect-cron.log 2>&1
5 */6 * * * cd $ROOT && npm run sa-qn-global-report >> $ROOT/data/logs/sa-qn-global-report.log 2>&1
0 4 * * * cd $ROOT && npm run sa-qn-budget-check >> $ROOT/data/logs/sa-qn-budget-check.log 2>&1
8 * * * * cd $ROOT && SA_SIGSEED_ENQUEUE_ENABLED=1 npm run sigseed:enqueue >> $ROOT/data/logs/sigseed-enqueue.log 2>&1
18 * * * * cd $ROOT && SA_SIGSEED_ENABLED=1 npm run sigseed:run >> $ROOT/data/logs/sigseed-run.log 2>&1
# SA_ALPHA_DP_END
EOF

crontab "$TMP"
rm -f "$TMP"
EOSCRIPT

echo "[ok] detective data-plane cron installed for user $U (markers: # SA_ALPHA_DP_BEGIN … # SA_ALPHA_DP_END)"
