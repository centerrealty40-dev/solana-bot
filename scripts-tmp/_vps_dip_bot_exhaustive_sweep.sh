#!/bin/bash
# ON VPS as root: exhaustive dip_bot discovery — all strategies, optional grid T_PRE × MIN_USD.
# Default grid favors recall; override via env (space-separated):
#   DIP_BOT_EXHAUSTIVE_T_PRE_LIST="300000 600000 900000 1800000"
#   DIP_BOT_EXHAUSTIVE_MIN_USD_LIST="0 5 10"
# Each grid cell: full_reset_intel (tags+obs+anchors), paper sweep, live sweep, coverage, anchor-gaps JSON.
set -euo pipefail
ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
PAPER_JSONL="$ROOT/data/paper2/pt1-oscar.jsonl"
LIVE_JSONL="$ROOT/data/live/pt1-oscar-live.jsonl"
TSX="$ROOT/node_modules/.bin/tsx"
RUNS_PER_PHASE="${DIP_BOT_RUNS_PER_PHASE:-80}"
# Default: один проход максимального recall (30 мин пре-окно, любой USD порога в пре-окне).
# Несколько значений в списке = отдельный полный сброс intel на каждую ячейку (теги обнуляются).
T_GRID="${DIP_BOT_EXHAUSTIVE_T_PRE_LIST:-1800000}"
USD_GRID="${DIP_BOT_EXHAUSTIVE_MIN_USD_LIST:-0}"

ensure_tsx() {
  if [[ ! -x "$TSX" ]]; then
    echo "[dip_bot exhaustive] tsx missing at $TSX — npm ci"
    sudo -u salpha bash -lc "cd '$ROOT' && npm ci"
  fi
  [[ -x "$TSX" ]] || { echo "tsx still missing"; exit 1; }
}

merge_env_grid() {
  local jsonl=$1
  local t_pre=$2
  local min_usd=$3
  sudo -u salpha bash -lc "cd '$ROOT' && touch .env"
  sudo -u salpha bash -lc "cd '$ROOT' && grep -v '^DIP_BOT_T_PRE_MS=' .env | grep -v '^DIP_BOT_MIN_USD_ONE_EVENT=' | grep -v '^DIP_BOT_MIN_HITS=' | grep -v '^DIP_BOT_MAX_ANCHORS_PER_RUN=' | grep -v '^DIP_BOT_LIVE_JSONL=' | grep -v '^DIP_BOT_ANCHOR_STRATEGY_IDS=' | grep -v '^DIP_BOT_ANCHOR_ANY_STRATEGY=' > /tmp/sa.env.strip && mv /tmp/sa.env.strip .env"
  sudo -u salpha bash -lc "cd '$ROOT' && {
    echo 'DIP_BOT_ANCHOR_STRATEGY_IDS=*'
    echo 'DIP_BOT_T_PRE_MS=$t_pre'
    echo 'DIP_BOT_MIN_USD_ONE_EVENT=$min_usd'
    echo 'DIP_BOT_MIN_HITS=1'
    echo 'DIP_BOT_MAX_ANCHORS_PER_RUN=400'
    echo \"DIP_BOT_LIVE_JSONL=$jsonl\"
  } >> .env && grep '^DIP_BOT_' .env"
}

full_reset_intel() {
  sudo -u postgres psql -d solana_alpha -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM wallet_tags WHERE tag = 'dip_bot' AND source = 'dip_bot_intel';
DELETE FROM dip_bot_intel_observations;
DELETE FROM dip_bot_intel_anchors_processed;
UPDATE dip_bot_intel_state SET last_jsonl_offset_bytes = 0, updated_at = now() WHERE id = 1;
SQL
}

anchors_only_reset() {
  sudo -u postgres psql -d solana_alpha -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM dip_bot_intel_anchors_processed;
UPDATE dip_bot_intel_state SET last_jsonl_offset_bytes = 0, updated_at = now() WHERE id = 1;
SQL
}

run_phase() {
  local label=$1
  echo "========== PHASE: $label =========="
  local i
  for ((i = 1; i <= RUNS_PER_PHASE; i++)); do
    echo "---- dip-bot-intel run $i / $RUNS_PER_PHASE ----"
    ensure_tsx
    sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && '$TSX' src/scripts/dip-bot-intel-run.ts" || exit 1
  done
}

run_coverage_and_gaps() {
  ensure_tsx
  sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:coverage" || true
  sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:anchor-gaps" || true
  sudo -u postgres psql -d solana_alpha -x <<'SQL'
SELECT count(*) AS wallet_tags_dip_bot_intel FROM wallet_tags WHERE tag = 'dip_bot' AND source = 'dip_bot_intel';
SELECT count(*) AS observations FROM dip_bot_intel_observations;
SELECT count(*) AS anchors_processed FROM dip_bot_intel_anchors_processed;
SELECT count(*) AS anchors_buyer_rows_pos FROM dip_bot_intel_anchors_processed WHERE buyer_rows > 0;
SQL
}

if [[ ! -f "$PAPER_JSONL" ]]; then echo "missing $PAPER_JSONL"; exit 1; fi
if [[ ! -f "$LIVE_JSONL" ]]; then echo "missing $LIVE_JSONL"; exit 1; fi

for t_pre in $T_GRID; do
  for min_usd in $USD_GRID; do
    echo ""
    echo "################################################################"
    echo "### GRID CELL  T_PRE_MS=$t_pre  MIN_USD_ONE_EVENT=$min_usd  ###"
    echo "################################################################"
    merge_env_grid "$PAPER_JSONL" "$t_pre" "$min_usd"
    full_reset_intel
    run_phase "paper pt1-oscar.jsonl (exhaustive)"
    merge_env_grid "$LIVE_JSONL" "$t_pre" "$min_usd"
    anchors_only_reset
    run_phase "live pt1-oscar-live.jsonl (exhaustive)"
    echo "=== coverage + gaps + PG (cell T_PRE=$t_pre MIN_USD=$min_usd) ==="
    run_coverage_and_gaps
  done
done

echo "[dip_bot exhaustive] done"
