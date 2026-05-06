#!/bin/bash
# ON VPS as root: anchor-gaps → sigseed queue → several sigseed:run rounds →
# reset dip_bot anchors + watermark → resweep paper+live JSONL → coverage + gaps.
# Prerequisites: `.env` has DATABASE_URL / SA_PG_DSN + RPC for sigseed; SA_SIGSEED_ENABLED used only inside this script for worker.
set -euo pipefail
ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
PAPER_JSONL="$ROOT/data/paper2/pt1-oscar.jsonl"
LIVE_JSONL="$ROOT/data/live/pt1-oscar-live.jsonl"
TSX="$ROOT/node_modules/.bin/tsx"
SIGSEED_ROUNDS="${DIP_BOT_GAP_SIGSEED_ROUNDS:-25}"
RESWEEP_RUNS="${DIP_BOT_GAP_RESWEEP_RUNS:-80}"

ensure_tsx() {
  if [[ ! -x "$TSX" ]]; then
    echo "[gap→sigseed] tsx missing — npm ci"
    sudo -u salpha bash -lc "cd '$ROOT' && npm ci"
  fi
  [[ -x "$TSX" ]] || exit 1
}

merge_dip_bot_env() {
  local jsonl=$1
  sudo -u salpha bash -lc "cd '$ROOT' && touch .env"
  sudo -u salpha bash -lc "cd '$ROOT' && grep -v '^DIP_BOT_T_PRE_MS=' .env | grep -v '^DIP_BOT_MIN_USD_ONE_EVENT=' | grep -v '^DIP_BOT_MIN_HITS=' | grep -v '^DIP_BOT_MAX_ANCHORS_PER_RUN=' | grep -v '^DIP_BOT_LIVE_JSONL=' | grep -v '^DIP_BOT_ANCHOR_STRATEGY_IDS=' | grep -v '^DIP_BOT_ANCHOR_ANY_STRATEGY=' > /tmp/sa.env.strip && mv /tmp/sa.env.strip .env"
  sudo -u salpha bash -lc "cd '$ROOT' && {
    echo 'DIP_BOT_ANCHOR_STRATEGY_IDS=*'
    echo 'DIP_BOT_T_PRE_MS=${DIP_BOT_GAP_T_PRE_MS:-1800000}'
    echo 'DIP_BOT_MIN_USD_ONE_EVENT=${DIP_BOT_GAP_MIN_USD:-0}'
    echo 'DIP_BOT_MIN_HITS=1'
    echo 'DIP_BOT_MAX_ANCHORS_PER_RUN=400'
    echo \"DIP_BOT_LIVE_JSONL=$jsonl\"
  } >> .env && grep '^DIP_BOT_' .env"
}

anchors_only_reset() {
  sudo -u postgres psql -d solana_alpha -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM dip_bot_intel_anchors_processed;
UPDATE dip_bot_intel_state SET last_jsonl_offset_bytes = 0, updated_at = now() WHERE id = 1;
SQL
}

ensure_tsx

echo "=== dip-bot-intel:anchor-gaps (before) ==="
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:anchor-gaps" | tee /tmp/dip_anchor_gaps.before.json

echo "=== sigseed:enqueue-mints --from-dip-anchor-gaps ==="
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run sigseed:enqueue-mints -- --from-dip-anchor-gaps"

echo "=== sigseed:run x ${SIGSEED_ROUNDS} ==="
for ((r = 1; r <= SIGSEED_ROUNDS; r++)); do
  echo "---- sigseed round $r / $SIGSEED_ROUNDS ----"
  sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && SA_SIGSEED_ENABLED=1 npm run sigseed:run" || true
done

echo "=== merge dip_bot env + anchors_only_reset → resweep paper ==="
merge_dip_bot_env "$PAPER_JSONL"
anchors_only_reset
for ((i = 1; i <= RESWEEP_RUNS; i++)); do
  echo "---- dip-bot-intel paper $i / $RESWEEP_RUNS ----"
  sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && '$TSX' src/scripts/dip-bot-intel-run.ts"
done

echo "=== resweep live ==="
merge_dip_bot_env "$LIVE_JSONL"
anchors_only_reset
for ((i = 1; i <= RESWEEP_RUNS; i++)); do
  echo "---- dip-bot-intel live $i / $RESWEEP_RUNS ----"
  sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && '$TSX' src/scripts/dip-bot-intel-run.ts"
done

echo "=== coverage + anchor-gaps (after) ==="
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:coverage" || true
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:anchor-gaps" | tee /tmp/dip_anchor_gaps.after.json

sudo -u postgres psql -d solana_alpha -x <<'SQL'
SELECT count(*) AS wallet_tags_dip_bot_intel FROM wallet_tags WHERE tag = 'dip_bot' AND source = 'dip_bot_intel';
SELECT count(*) AS observations FROM dip_bot_intel_observations;
SELECT count(*) AS anchors_processed FROM dip_bot_intel_anchors_processed;
SELECT count(*) AS anchors_buyer_rows_pos FROM dip_bot_intel_anchors_processed WHERE buyer_rows > 0;
SQL

echo "[gap→sigseed→resweep] done"
