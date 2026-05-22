#!/usr/bin/env bash
# Post-deploy smoke for live-oscar on VPS. Read-only. Run as salpha after pm2 reload.
# Usage: bash scripts/release/post-deploy-smoke.sh
set -euo pipefail

ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
PM2_APP="${PM2_APP:-live-oscar}"
ERR_LOG="${HOME}/.pm2/logs/${PM2_APP}-error.log"
OUT_LOG="${HOME}/.pm2/logs/${PM2_APP}-out.log"
JOURNAL="${ROOT}/data/live/pt1-oscar-live.jsonl"

fail() {
  echo "[post-deploy-smoke] FAIL: $*" >&2
  exit 1
}

ok() {
  echo "[post-deploy-smoke] OK: $*"
}

cd "$ROOT" || fail "missing repo root $ROOT"

SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
ok "HEAD $SHA"

if ! command -v pm2 >/dev/null 2>&1; then
  fail "pm2 not in PATH"
fi

STATUS="$(pm2 jlist 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const p=d.find(x=>x.name==='$PM2_APP');
if(!p){process.stdout.write('missing');process.exit(0);}
process.stdout.write(p.pm2_env.status+' '+Math.floor((Date.now()-p.pm2_env.pm_uptime)/1000)+'s');
" 2>/dev/null || echo "unknown")"

case "$STATUS" in
  online*) ok "pm2 $PM2_APP $STATUS" ;;
  *) fail "pm2 $PM2_APP status=$STATUS" ;;
esac

if [[ -f "$ERR_LOG" ]]; then
  if tail -n 40 "$ERR_LOG" | grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find module'; then
    echo "[post-deploy-smoke] recent error.log tail:" >&2
    tail -n 15 "$ERR_LOG" >&2
    fail "module load errors in ${PM2_APP}-error.log"
  fi
fi

if [[ -f "$OUT_LOG" ]]; then
  if ! tail -n 80 "$OUT_LOG" | grep -q 'papertrader executor start'; then
    fail "no recent executor start in ${PM2_APP}-out.log"
  fi
fi

if [[ -f "$JOURNAL" ]]; then
  RECENT="$(tail -n 200 "$JOURNAL" | grep -c 'live_discovery_eval' || true)"
  if [[ "${RECENT:-0}" -lt 1 ]]; then
    fail "no live_discovery_eval in last 200 journal lines (discovery not ticking?)"
  fi
  ok "journal has live_discovery_eval in recent tail"
else
  echo "[post-deploy-smoke] WARN: journal missing at $JOURNAL" >&2
fi

ok "smoke passed for $PM2_APP @ $SHA"
