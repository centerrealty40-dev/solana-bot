#!/usr/bin/env bash
# Quick local-only inspection of last few open events in paper2 jsonls.
set -euo pipefail
for f in /opt/solana-alpha/data/paper2/pt1-*.jsonl; do
  echo "=== $f ==="
  tail -500 "$f" | jq -c 'select(.kind=="open") | {mint, symbol, entryMcUsd, totalInvestedUsd, feat_fdv: .features.fdv_usd, feat_mc: .features.market_cap_usd}' | tail -3
done
