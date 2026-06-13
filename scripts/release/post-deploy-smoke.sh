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

# Exactly one OS process for live-oscar.ts under salpha; env must match ecosystem (no stale root PM2).
if [[ "$PM2_APP" == "live-oscar" ]] && command -v pgrep >/dev/null 2>&1; then
  mapfile -t LIVE_OSCAR_PIDS < <(pgrep -f 'loader\.mjs src/scripts/live-oscar\.ts' 2>/dev/null || true)
  if [[ "${#LIVE_OSCAR_PIDS[@]}" -ne 1 ]]; then
    fail "expected exactly 1 live-oscar.ts OS process, got ${#LIVE_OSCAR_PIDS[@]} (pids: ${LIVE_OSCAR_PIDS[*]:-none})"
  fi
  LIVE_PID="${LIVE_OSCAR_PIDS[0]}"
  LIVE_USER="$(ps -o user= -p "$LIVE_PID" 2>/dev/null | tr -d ' ')"
  if [[ "$LIVE_USER" != "salpha" ]]; then
    fail "live-oscar.ts must run as salpha, got user=$LIVE_USER pid=$LIVE_PID"
  fi
  EXP_LEG="$(grep -E "PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD:" "$ROOT/ecosystem.config.cjs" | head -1 | sed -E "s/.*['\"]([0-9]+)['\"].*/\1/")"
  ACT_LEG="$(tr '\0' '\n' < "/proc/$LIVE_PID/environ" 2>/dev/null | grep '^PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD=' | cut -d= -f2 || true)"
  if [[ -n "$EXP_LEG" && -n "$ACT_LEG" && "$ACT_LEG" != "$EXP_LEG" ]]; then
    fail "live-oscar ENTRY_SPLIT_LEG_USD=$ACT_LEG != ecosystem $EXP_LEG (stale process env?)"
  fi
  if tr '\0' '\n' < "/proc/$LIVE_PID/environ" 2>/dev/null | grep -q '^LIVE_MINT_FIRST_PROBE_ENABLED=1'; then
    fail "live-oscar LIVE_MINT_FIRST_PROBE_ENABLED=1 on running process (stale /root/.pm2?)"
  fi
  ok "single live-oscar.ts pid=$LIVE_PID user=$LIVE_USER leg_usd=${ACT_LEG:-?}"

  if [[ -d /root/.pm2 ]]; then
    ROOT_ONLINE="$(PM2_HOME=/root/.pm2 HOME=/root pm2 jlist 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
process.stdout.write(d.some(x=>x.name==='live-oscar'&&x.pm2_env?.status==='online')?'yes':'no');
" 2>/dev/null || echo no)"
    if [[ "$ROOT_ONLINE" == "yes" ]]; then
      fail "/root/.pm2 still has online live-oscar — run: PM2_HOME=/root/.pm2 pm2 kill"
    fi
    ok "no online live-oscar under /root/.pm2"
  fi
fi

if [[ -f "$ERR_LOG" ]]; then
  UPTIME_SEC="$(pm2 jlist 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const p=d.find(x=>x.name==='$PM2_APP');
process.stdout.write(p&&p.pm2_env&&p.pm2_env.pm_uptime?String(Math.max(5,Math.floor((Date.now()-p.pm2_env.pm_uptime)/1000))):'60');
" 2>/dev/null || echo "60")"
  CUTOFF_EPOCH="$(node -e "process.stdout.write(String(Math.floor(Date.now()/1000)-Number(process.argv[1])))" "$UPTIME_SEC")"
  RECENT_BAD="$(node -e "
const fs=require('fs');
const logPath=process.argv[1];
const cutoff=Number(process.argv[2]);
if(!fs.existsSync(logPath)) process.exit(0);
const lines=fs.readFileSync(logPath,'utf8').split('\n');
const bad=/ERR_MODULE_NOT_FOUND|Cannot find module/;
for (const line of lines) {
  const m=line.match(/^\\d{4}-\\d{2}-\\d{2}T(\\d{2}):(\\d{2}):(\\d{2}):/);
  if(!m) continue;
  const iso=line.slice(0,19)+'Z';
  const ts=Math.floor(Date.parse(iso)/1000);
  if(Number.isFinite(ts)&&ts>=cutoff&&bad.test(line)){console.log(line);process.exit(0);}
}
" "$ERR_LOG" "$CUTOFF_EPOCH" 2>/dev/null || true)"
  if [[ -n "$RECENT_BAD" ]]; then
    echo "[post-deploy-smoke] errors since last PM2 start:" >&2
    echo "$RECENT_BAD" >&2
    fail "module load errors since PM2 restart in ${PM2_APP}-error.log"
  fi
fi

if [[ -f "$OUT_LOG" ]]; then
  sleep 12
  if ! tail -n 120 "$OUT_LOG" | grep -q 'papertrader executor start'; then
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
