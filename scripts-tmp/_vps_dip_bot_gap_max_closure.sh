#!/bin/bash
# ON VPS as root: repeat gap → deep sigseed → wide-window resweep until gaps shrink or max iterations.
# Maximizes recall for dip_bot-style wallets (RPC-heavy). Tune env before run.
#
# Optional env:
#   DIP_BOT_GAP_MAX_ITERATIONS=6
#   DIP_BOT_GAP_SIGSEED_ROUNDS_PER_ITER=55
#   DIP_BOT_GAP_RESWEEP_RUNS=55
#   DIP_BOT_GAP_T_PRE_MS=7200000          # 2h pre-window
#   DIP_BOT_MAX_SIG_PAGES=10
#   DIP_BOT_MAX_SIG_TX=160
#   DIP_BOT_MAX_SIG_MINTS=35
#   DIP_BOT_MAX_SIG_CREDITS_RUN=220000
#
set -euo pipefail
ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
PAPER_JSONL="$ROOT/data/paper2/pt1-oscar.jsonl"
LIVE_JSONL="$ROOT/data/live/pt1-oscar-live.jsonl"
TSX="$ROOT/node_modules/.bin/tsx"
MAX_ITERS="${DIP_BOT_GAP_MAX_ITERATIONS:-6}"
SIG_ROUNDS="${DIP_BOT_GAP_SIGSEED_ROUNDS_PER_ITER:-55}"
RESWEEP_RUNS="${DIP_BOT_GAP_RESWEEP_RUNS:-55}"
T_PRE_MS="${DIP_BOT_GAP_T_PRE_MS:-7200000}"
SIG_PAGES="${DIP_BOT_MAX_SIG_PAGES:-10}"
SIG_TX="${DIP_BOT_MAX_SIG_TX:-160}"
SIG_MINTS="${DIP_BOT_MAX_SIG_MINTS:-35}"
SIG_CREDITS_RUN="${DIP_BOT_MAX_SIG_CREDITS_RUN:-220000}"

ensure_tsx() {
  if [[ ! -x "$TSX" ]]; then
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
    echo 'DIP_BOT_T_PRE_MS=$T_PRE_MS'
    echo 'DIP_BOT_MIN_USD_ONE_EVENT=0'
    echo 'DIP_BOT_MIN_HITS=1'
    echo 'DIP_BOT_MAX_ANCHORS_PER_RUN=500'
    echo \"DIP_BOT_LIVE_JSONL=$jsonl\"
  } >> .env && grep '^DIP_BOT_' .env"
}

anchors_only_reset() {
  sudo -u postgres psql -d solana_alpha -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM dip_bot_intel_anchors_processed;
UPDATE dip_bot_intel_state SET last_jsonl_offset_bytes = 0, updated_at = now() WHERE id = 1;
SQL
}

gap_mint_count() {
  sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && '$TSX' src/scripts/dip-bot-intel-anchor-gaps.ts" \
    | tee "/tmp/dip_anchor_gaps.iter_${iter}.json" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d.trim());process.stdout.write(String(j.distinctMintsWithOnlyZeroBuyerAnchors || 0));});"
}

run_sigseed_round() {
  sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && \
    export SA_SIGSEED_SIG_PAGES_MAX=$SIG_PAGES && \
    export SA_SIGSEED_MAX_TX_PER_MINT=$SIG_TX && \
    export SA_SIGSEED_MAX_MINTS_PER_RUN=$SIG_MINTS && \
    export SA_SIGSEED_MAX_CREDITS_PER_RUN=$SIG_CREDITS_RUN && \
    SA_SIGSEED_ENABLED=1 npm run sigseed:run" || true
}

resweep_both() {
  merge_dip_bot_env "$PAPER_JSONL"
  anchors_only_reset
  local i
  for ((i = 1; i <= RESWEEP_RUNS; i++)); do
    echo "---- dip-bot paper $i / $RESWEEP_RUNS ----"
    sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && '$TSX' src/scripts/dip-bot-intel-run.ts"
  done
  merge_dip_bot_env "$LIVE_JSONL"
  anchors_only_reset
  for ((i = 1; i <= RESWEEP_RUNS; i++)); do
    echo "---- dip-bot live $i / $RESWEEP_RUNS ----"
    sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && '$TSX' src/scripts/dip-bot-intel-run.ts"
  done
}

ensure_tsx
sudo -u salpha mkdir -p "$ROOT/data/logs"

iter=1
while [[ $iter -le $MAX_ITERS ]]; do
  echo ""
  echo "############################################"
  echo "### MAX CLOSURE iteration $iter / $MAX_ITERS ###"
  echo "############################################"

  N="$(gap_mint_count || echo 999)"
  echo "=== gap mints (distinct with only zero-buyer anchors): $N ==="
  if [[ "${N:-999}" == "0" ]]; then
    echo "[max-closure] no gap mints left — stop"
    break
  fi

  echo "=== sigseed:enqueue-mints ==="
  sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run sigseed:enqueue-mints -- --from-dip-anchor-gaps"

  echo "=== deep sigseed x ${SIG_ROUNDS} (pages=${SIG_PAGES} tx/mint=${SIG_TX}) ==="
  for ((r = 1; r <= SIG_ROUNDS; r++)); do
    echo "---- sigseed $r / $SIG_ROUNDS ----"
    run_sigseed_round
  done

  echo "=== resweep paper+live (T_PRE_MS=$T_PRE_MS) ==="
  resweep_both

  iter=$((iter + 1))
done

echo "=== final coverage + gaps + export candidates ==="
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:coverage" || true
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:anchor-gaps" | tee /tmp/dip_anchor_gaps.final.json
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:export-candidates -- --detail" | tee "$ROOT/data/logs/dip_bot_candidates_detail.json"
sudo -u salpha bash -lc "cd '$ROOT' && set -a && [[ -f .env ]] && . ./.env && set +a && npm run dip-bot-intel:export-candidates -- --csv" | tee "$ROOT/data/logs/dip_bot_candidates.csv"

sudo -u postgres psql -d solana_alpha -x <<'SQL'
SELECT count(*) AS wallet_tags_dip_bot_intel FROM wallet_tags WHERE tag = 'dip_bot' AND source = 'dip_bot_intel';
SELECT count(*) AS observation_wallets FROM (SELECT DISTINCT wallet FROM dip_bot_intel_observations) t;
SELECT count(*) AS observations FROM dip_bot_intel_observations;
SELECT count(*) AS anchors_processed FROM dip_bot_intel_anchors_processed;
SELECT count(*) AS anchors_buyer_rows_pos FROM dip_bot_intel_anchors_processed WHERE buyer_rows > 0;
SQL

echo "[dip_bot gap max-closure] done"
