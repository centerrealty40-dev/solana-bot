#!/usr/bin/env bash
# Run on server: cd /opt/solana-alpha && bash scripts-tmp/paper2-full-analysis-batch.sh
set -euo pipefail
cd /opt/solana-alpha
set -a
# shellcheck disable=SC1091
source .env
set +a

OUT="${PAPER2_ANALYSIS_OUT:-/tmp/paper2_full_analysis.txt}"
JSONL="data/live/pt1-oscar-live.jsonl"

{
  echo "======== UTC $(date -u +%Y-%m-%dT%H:%M:%SZ) ========"
  echo ""
  echo "## PM2 pt1-oscar — key paper env (ecosystem.config.cjs)"
  node -e "
    const p = require('./ecosystem.config.cjs');
    const a = p.apps.find((x) => x.name === 'pt1-oscar');
    if (!a) { console.log('pt1-oscar not found'); process.exit(1); }
    const e = a.env;
    const pick = (k) => e[k];
    console.log(JSON.stringify({
      PAPER_DCA_LEVELS: pick('PAPER_DCA_LEVELS'),
      PAPER_DCA_KILLSTOP: pick('PAPER_DCA_KILLSTOP'),
      PAPER_TIMEOUT_HOURS: pick('PAPER_TIMEOUT_HOURS'),
      PAPER_TP_GRID_STEP_PNL: pick('PAPER_TP_GRID_STEP_PNL'),
      PAPER_TP_GRID_SELL_FRACTION: pick('PAPER_TP_GRID_SELL_FRACTION'),
      PAPER_TRAIL_TRIGGER_X: pick('PAPER_TRAIL_TRIGGER_X'),
      PAPER_TRAIL_DROP: pick('PAPER_TRAIL_DROP'),
    }, null, 2));
  "
  echo ""

  echo "## A) Dual-regime vs baseline — 48h opens, 96h PG, prod DCA (--detail)"
  npx tsx src/scripts/paper2-dual-regime-compare.ts --since-hours 48 --hold-horizon-hours 96 --jsonl "$JSONL" --detail
  echo ""

  echo "## B) Same window — DCA override -5:0.25"
  npx tsx src/scripts/paper2-dual-regime-compare.ts --since-hours 48 --hold-horizon-hours 96 --jsonl "$JSONL" --dca-levels '-5:0.25' --detail
  echo ""

  echo "## C) Longer sample — 168h opens, 168h PG, prod DCA (--detail)"
  npx tsx src/scripts/paper2-dual-regime-compare.ts --since-hours 168 --hold-horizon-hours 168 --jsonl "$JSONL" --detail
  echo ""

  echo "## D) Scenario optimizer — 48h / 96h (drawdown bins + kill sweep + per-bucket grid)"
  npx tsx src/scripts/paper2-scenario-tp-trail-optimize.ts --since-hours 48 --hold-horizon-hours 96 --jsonl "$JSONL"
  echo ""

  echo "## E) DCA level sweep — 48h / 96h, PM2 exits vs tuned partial exits"
  npx tsx src/scripts/paper2-dca-entry-diagnostic.ts --since-hours 48 --hold-horizon-hours 96 --jsonl "$JSONL" --exit both
  echo ""

  echo "## F) Scenario optimizer — 168h / 168h"
  npx tsx src/scripts/paper2-scenario-tp-trail-optimize.ts --since-hours 168 --hold-horizon-hours 168 --jsonl "$JSONL"
  echo ""

  echo "======== END ========"
} 2>&1 | tee "$OUT"

echo "Wrote $OUT"
