#!/usr/bin/env bash
# Remove legacy detective cron block (backfill / sigseed / scam-farm) from salpha crontab.
# Idempotent. Does not touch hourly Telegram, jupiter-shadow, or git-sync jobs.
#
#   sudo bash /opt/solana-alpha/scripts/cron/uninstall-detective-data-plane-salpha.sh
#
set -euo pipefail

U="${CRON_USER:-salpha}"

sudo -u "$U" bash <<'EOSCRIPT'
set -euo pipefail
TMP="$(mktemp)"
chmod 600 "$TMP"
(crontab -l 2>/dev/null || true) | awk '
/^# SA_ALPHA_DP_BEGIN$/ {skip=1; next}
/^# SA_ALPHA_DP_END$/ {skip=0; next}
!skip {print}
' >"$TMP"
crontab "$TMP"
rm -f "$TMP"
EOSCRIPT

echo "[ok] detective data-plane cron removed for user $U (marker # SA_ALPHA_DP_BEGIN … # SA_ALPHA_DP_END)"
