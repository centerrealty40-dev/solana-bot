#!/usr/bin/env bash
# W9.0 — dip_bot intel cron (normative: docs/strategy/specs/W9.0_dip_bot_intel_spec.md §11).
#
# Steady (weekly):   sudo bash …/install-dip-bot-cron-salpha.sh
# Bootstrap (daily): DIP_BOT_CRON_BOOTSTRAP=1 sudo bash …/install-dip-bot-cron-salpha.sh
# Custom schedule:   DIP_BOT_CRON_SCHEDULE='25 2 * * *' sudo bash …/install-dip-bot-cron-salpha.sh
#
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
U="${CRON_USER:-salpha}"

if [[ -n "${DIP_BOT_CRON_SCHEDULE:-}" ]]; then
  SCHEDULE="$DIP_BOT_CRON_SCHEDULE"
elif [[ "${DIP_BOT_CRON_BOOTSTRAP:-}" == "1" ]]; then
  SCHEDULE="25 2 * * *"
else
  SCHEDULE="25 2 * * 2"
fi

if [[ ! -d "$ROOT" ]]; then
  echo "[fatal] directory not found: $ROOT"
  exit 1
fi

mkdir -p "$ROOT/data/logs"

sudo -u "$U" env ROOT="$ROOT" SCHEDULE="$SCHEDULE" bash <<'EOSCRIPT'
set -euo pipefail
TMP="$(mktemp)"
chmod 600 "$TMP"
(crontab -l 2>/dev/null || true) | awk '
/^# DIP_BOT_CRON_BEGIN$/ {skip=1; next}
/^# DIP_BOT_CRON_END$/ {skip=0; next}
!skip {print}
' >"$TMP"

cat >>"$TMP" <<EOF
# DIP_BOT_CRON_BEGIN
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SHELL=/bin/bash
$SCHEDULE cd $ROOT && npm run dip-bot-intel:run >> $ROOT/data/logs/dip-bot-live-oscar.log 2>&1
# DIP_BOT_CRON_END
EOF

crontab "$TMP"
rm -f "$TMP"
EOSCRIPT

echo "[ok] dip-bot cron installed for user $U (schedule: $SCHEDULE UTC → dip-bot-live-oscar.log)"
