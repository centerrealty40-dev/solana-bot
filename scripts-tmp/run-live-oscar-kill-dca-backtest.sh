#!/usr/bin/env bash
# Live Oscar — контрфактуальный бэк-тест по закрытым сделкам (журнал + ряд цен в Postgres).
# Запуск на VPS от salpha с загруженным .env (DATABASE_URL / SA_PG_DSN):
#   bash scripts-tmp/run-live-oscar-kill-dca-backtest.sh [path/to/pt1-oscar-live.jsonl]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a
if [[ -f .env ]]; then . ./.env; fi
set +a
JSONL="${1:-data/live/pt1-oscar-live.jsonl}"
STAMP="$(date -u +%Y%m%dT%H%MZ)"
OUT="/tmp/live-oscar-kill-dca-backtest-${STAMP}"
echo "Writing ${OUT}-drawdown.json, ${OUT}-dca.json, ${OUT}-mega.json"
npx tsx scripts-tmp/live-oscar-killstop-drawdown-grid.ts "$JSONL" --kill-min 5 --kill-max 25 --kill-step 1 >"${OUT}-drawdown.json"
npx tsx scripts-tmp/live-oscar-dca-killstop-analysis.ts "$JSONL" >"${OUT}-dca.json"
npx tsx scripts-tmp/live-oscar-strategy-mega-grid.ts "$JSONL" >"${OUT}-mega.json"
echo "Done. Outputs:"
echo "  ${OUT}-drawdown.json"
echo "  ${OUT}-dca.json"
echo "  ${OUT}-mega.json (kill × DCA × TP-grid mode B)"
if command -v jq >/dev/null 2>&1; then
  echo "--- drawdown best kill (modeled sum vs actual) ---"
  jq '{bestK:.bestKillDrawdownPct_theoreticalMaxSumModeledPnl,bestSum:.bestSumModeledNetUsd,actual:.actualSumNetPnlUsd,trades:.tradesWithSnapshots}' "${OUT}-drawdown.json"
  echo "--- no-DCA counterfactual (initial legs only) ---"
  jq '.counterfactual_noDcaLegs_model | {bestStopPctFromGrid_global,bestSumNetUsd_global,vsActualDelta_global}' "${OUT}-dca.json"
  echo "--- mega-grid best (kill + DCA mode + B-ladder) ---"
  jq '{best:.bestOverall,actual:.actualSumNetPnlUsd,top3:.top25[0:3]}' "${OUT}-mega.json"
fi
