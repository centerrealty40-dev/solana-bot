#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${BACKFILL_PROJECT_DIR:-$(pwd)}"
LOG_DIR="${BACKFILL_LOG_DIR:-/opt/solana-alpha/data/logs}"
PID_DIR="${BACKFILL_PID_DIR:-$LOG_DIR}"
HYDRATORS="${BACKFILL_HYDRATORS:-3}"
DAYS="${BACKFILL_TARGET_DAYS:-60}"
CRAWLER_LOG="$LOG_DIR/backfill-signatures.log"
HYDRATE_LOG_PREFIX="$LOG_DIR/backfill-hydrate"
RUNNER_PID="$PID_DIR/backfill-runner.pid"
CRAWLER_PID="$PID_DIR/backfill-signatures.pid"

mkdir -p "$LOG_DIR" "$PID_DIR"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG_DIR/backfill-runner.log" >&2
}

die() {
  log "[fatal] $*"
  exit 1
}

load_env() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    export DATABASE_URL
    return
  fi
  if [[ ! -f "$PROJECT_DIR/.env" ]]; then
    die "DATABASE_URL is not set and $PROJECT_DIR/.env is missing"
  fi
  DATABASE_URL="$(
    cd "$PROJECT_DIR" && node -e "import('dotenv/config').then(()=>{ if (!process.env.DATABASE_URL) process.exit(2); process.stdout.write(process.env.DATABASE_URL); })"
  )" || die "DATABASE_URL is not set in $PROJECT_DIR/.env"
  export DATABASE_URL
}

check_deps() {
  command -v node >/dev/null 2>&1 || die "node not found"
  command -v psql >/dev/null 2>&1 || die "psql not found"
  load_env
  [[ -f "$PROJECT_DIR/scripts-tmp/backfill-signatures.mjs" ]] || die "missing backfill-signatures.mjs in $PROJECT_DIR"
  [[ -f "$PROJECT_DIR/scripts-tmp/backfill-hydrate.mjs" ]] || die "missing backfill-hydrate.mjs in $PROJECT_DIR"
}

stop_pids() {
  local pid
  for f in "$CRAWLER_PID" "$PID_DIR"/backfill-hydrate-*.pid; do
    [[ -f "$f" ]] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      log "[stop] killing pid=$pid file=$f"
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$f"
  done
}

stop_runner() {
  if [[ -f "$RUNNER_PID" ]]; then
    local pid
    pid="$(cat "$RUNNER_PID" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      log "[stop] killing runner pid=$pid"
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$RUNNER_PID"
  fi
  stop_pids
}

start_all() {
  check_deps
  if [[ -f "$RUNNER_PID" ]]; then
    local existing_pid
    existing_pid="$(cat "$RUNNER_PID" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      die "runner already running pid=$existing_pid"
    fi
  fi

  cd "$PROJECT_DIR"
  echo "$$" > "$RUNNER_PID"
  trap 'log "[trap] stopping backfill children"; stop_pids; rm -f "$RUNNER_PID"; exit 0' INT TERM EXIT

  log "[start] applying backfill schema"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts-tmp/backfill-schema.sql >> "$LOG_DIR/backfill-schema.log" 2>&1 || die "schema apply failed; see $LOG_DIR/backfill-schema.log"

  log "[start] crawler days=$DAYS log=$CRAWLER_LOG"
  node scripts-tmp/backfill-signatures.mjs --days "$DAYS" --dry-run 0 >> "$CRAWLER_LOG" 2>&1 &
  echo "$!" > "$CRAWLER_PID"

  local i
  for i in $(seq 1 "$HYDRATORS"); do
    log "[start] hydrator index=$i log=$HYDRATE_LOG_PREFIX-$i.log"
    BACKFILL_HYDRATOR_ID="$i" node scripts-tmp/backfill-hydrate.mjs --workers 1 >> "$HYDRATE_LOG_PREFIX-$i.log" 2>&1 &
    echo "$!" > "$PID_DIR/backfill-hydrate-$i.pid"
  done

  while true; do
    if [[ -f "$CRAWLER_PID" ]]; then
      local cp
      cp="$(cat "$CRAWLER_PID")"
      if ! kill -0 "$cp" >/dev/null 2>&1; then
        log "[info] crawler finished or exited; check $CRAWLER_LOG"
        rm -f "$CRAWLER_PID"
      fi
    fi

    for f in "$PID_DIR"/backfill-hydrate-*.pid; do
      [[ -f "$f" ]] || continue
      local hp
      hp="$(cat "$f")"
      if ! kill -0 "$hp" >/dev/null 2>&1; then
        local idx
        idx="${f##*-}"
        idx="${idx%.pid}"
        die "hydrator died pid=$hp file=$f; see ${HYDRATE_LOG_PREFIX}-${idx}.log"
      fi
    done
    sleep 15
  done
}

case "${1:-start}" in
  start)
    start_all
    ;;
  stop)
    stop_runner
    ;;
  restart)
    stop_runner
    sleep 2
    start_all
    ;;
  status)
    echo "runner_pid=$(cat "$RUNNER_PID" 2>/dev/null || true)"
    echo "crawler_pid=$(cat "$CRAWLER_PID" 2>/dev/null || true)"
    for f in "$PID_DIR"/backfill-hydrate-*.pid; do
      [[ -f "$f" ]] && echo "$(basename "$f" .pid)_pid=$(cat "$f")"
    done
    ;;
  *)
    die "usage: $0 {start|stop|restart|status}"
    ;;
esac
