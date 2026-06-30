#!/usr/bin/env bash
# Read-only: verify dc-trader PM2 process survived solana-alpha deploy.
# dc-trader (/opt/dc-trader) is a separate product but shares salpha PM2_HOME.
# Usage: bash scripts/release/verify-dc-trader-pm2.sh
#   STRICT=1 — exit 1 instead of WARN when dc-trader is missing/offline.
set -euo pipefail

DC_TRADER_APP="${DC_TRADER_APP:-dc-trader}"
DC_TRADER_DIR="${DC_TRADER_DIR:-/opt/dc-trader}"
STRICT="${STRICT:-0}"

warn() {
  echo "[verify-dc-trader-pm2] WARN: $*" >&2
}

ok() {
  echo "[verify-dc-trader-pm2] OK: $*"
}

if ! command -v pm2 >/dev/null 2>&1; then
  warn "pm2 not in PATH — skip"
  exit 0
fi

if [[ ! -d "$DC_TRADER_DIR" ]]; then
  ok "dc-trader not installed at $DC_TRADER_DIR — skip"
  exit 0
fi

STATUS="$(
  pm2 jlist 2>/dev/null | node -e "
const app = process.argv[1];
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const p = d.find((x) => x.name === app);
if (!p) {
  process.stdout.write('missing');
  process.exit(0);
}
const st = p.pm2_env?.status || 'unknown';
const up = p.pm2_env?.pm_uptime
  ? Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000) + 's'
  : '';
process.stdout.write(st + (up ? ' ' + up : ''));
" "$DC_TRADER_APP" 2>/dev/null || echo "unknown"
)"

case "$STATUS" in
  online*)
    ok "pm2 $DC_TRADER_APP $STATUS"
    exit 0
    ;;
  missing*)
    msg="pm2 $DC_TRADER_APP missing from salpha PM2 (never use 'pm2 stop all' on shared VPS)"
    if [[ "$STRICT" == "1" ]]; then
      echo "[verify-dc-trader-pm2] FAIL: $msg" >&2
      exit 1
    fi
    warn "$msg — restart: cd $DC_TRADER_DIR && pm2 start ecosystem.config.cjs && pm2 save"
    exit 0
    ;;
  *)
    msg="pm2 $DC_TRADER_APP status=$STATUS (expected online)"
    if [[ "$STRICT" == "1" ]]; then
      echo "[verify-dc-trader-pm2] FAIL: $msg" >&2
      exit 1
    fi
    warn "$msg"
    exit 0
    ;;
esac
