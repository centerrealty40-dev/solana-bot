#!/usr/bin/env bash
# W6.12 — одноразовый или редкий узкий прогон wallet-backfill (pump.fun swaps + money_flows),
# без стрима. Деплой только через git (см. deploy/RUNTIME.md).
set -euo pipefail
ROOT="${SOLANA_ALPHA_ROOT:-/opt/solana-alpha}"
cd "$ROOT"
LOG="${ROOT}/data/logs/wallet-backfill-pilot.log"
mkdir -p "$(dirname "$LOG")"
{
  echo "=== $(date -uIs) wallet-backfill-pilot-salpha ==="
  npm run sa-qn-global-report || true
  # Раскомментируйте при пустой очереди:
  # SA_BACKFILL_ENABLED=1 npm run wallet-backfill:run -- --enqueue-from-wallets=400
  SA_BACKFILL_ENABLED=1 npm run wallet-backfill:pilot
  npm run wallet-intel:doctor || true
  npm run sa-qn-global-report || true
} >>"$LOG" 2>&1
