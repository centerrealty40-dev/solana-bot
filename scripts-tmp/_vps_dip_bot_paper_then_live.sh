#!/bin/bash
# ON VPS as root: paper Oscar JSONL then live JSONL, full dip_bot intel sweep.
set -euo pipefail
ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
PAPER_JSONL="$ROOT/data/paper2/pt1-oscar.jsonl"
LIVE_JSONL="$ROOT/data/live/pt1-oscar-live.jsonl"
TSX="$ROOT/node_modules/.bin/tsx"
RUNS_PER_PHASE="${DIP_BOT_RUNS_PER_PHASE:-100}"

ensure_tsx() {
  # Long sweeps can overlap another deploy; npm ci briefly removes node_modules/.bin/tsx.
  if [[ ! -x "$TSX" ]]; then
    echo "[dip_bot sweep] tsx missing at $TSX — running npm ci as salpha"
    sudo -u salpha bash -lc "cd '$ROOT' && npm ci"
  fi
  if [[ ! -x "$TSX" ]]; then
    echo "[dip_bot sweep] tsx still missing after npm ci"; exit 1
  fi
}

if [[ ! -f "$PAPER_JSONL" ]]; then echo "missing $PAPER_JSONL"; exit 1; fi
if [[ ! -f "$LIVE_JSONL" ]]; then echo "missing $LIVE_JSONL"; exit 1; fi

merge_env() {
  sudo -u salpha bash -lc "cd '$ROOT' && touch .env"
  # strip DIP_BOT_* we manage
  sudo -u salpha bash -lc "cd '$ROOT' && grep -v '^DIP_BOT_T_PRE_MS=' .env | grep -v '^DIP_BOT_MIN_USD_ONE_EVENT=' | grep -v '^DIP_BOT_MIN_HITS=' | grep -v '^DIP_BOT_MAX_ANCHORS_PER_RUN=' | grep -v '^DIP_BOT_LIVE_JSONL=' | grep -v '^DIP_BOT_ANCHOR_STRATEGY_IDS=' > /tmp/sa.env.strip && mv /tmp/sa.env.strip .env"
  sudo -u salpha bash -lc "cd '$ROOT' && {
    echo 'DIP_BOT_ANCHOR_STRATEGY_IDS=live-oscar,pt1-oscar'
    echo 'DIP_BOT_T_PRE_MS=300000'
    echo 'DIP_BOT_MIN_USD_ONE_EVENT=10'
    echo 'DIP_BOT_MIN_HITS=1'
    echo 'DIP_BOT_MAX_ANCHORS_PER_RUN=250'
    echo \"DIP_BOT_LIVE_JSONL=$1\"
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

echo "=== merge env (paper) ==="
merge_env "$PAPER_JSONL"
echo "=== full reset intel tables ==="
full_reset_intel
echo "=== run paper phase ==="
run_phase "paper pt1-oscar.jsonl"

echo "=== merge env (live) ==="
merge_env "$LIVE_JSONL"
echo "=== anchors reset for second file (keep observations+tags) ==="
anchors_only_reset
echo "=== run live phase ==="
run_phase "live pt1-oscar-live.jsonl"

echo "=== coverage ==="
ensure_tsx
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:coverage"

echo "=== PG totals ==="
sudo -u postgres psql -d solana_alpha -x <<'SQL'
SELECT count(*) AS wallet_tags_dip_bot_intel FROM wallet_tags WHERE tag = 'dip_bot' AND source = 'dip_bot_intel';
SELECT count(*) AS observations FROM dip_bot_intel_observations;
SELECT count(*) AS anchors_processed FROM dip_bot_intel_anchors_processed;
SELECT count(*) AS anchors_buyer_rows_pos FROM dip_bot_intel_anchors_processed WHERE buyer_rows > 0;
SQL
