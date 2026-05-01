#!/usr/bin/env bash
for p in pt1-dno pt1-diprunner pt1-oscar; do
  echo "--- $p ---"
  sudo -u salpha pm2 env "$p" 2>/dev/null | grep -E '^(PAPER_PRICE_VERIFY_|PAPER_SAFETY_CHECK|PAPER_PRIORITY_FEE_ENABLED)=' | sort
done
echo
echo "=== heartbeats (last) ==="
for p in pt1-dno pt1-diprunner pt1-oscar; do
  printf '  %-18s ' "$p"
  tail -200 "/home/salpha/.pm2/logs/${p}-out.log" 2>/dev/null | grep -E 'heartbeat|started|ready' | tail -1 | head -c 250
  echo
done
echo
echo "=== priceVerify keys present in last 200 lines per strategy ==="
for p in pt1-dno pt1-diprunner pt1-oscar; do
  f="/opt/solana-alpha/data/paper2/${p}.jsonl"
  if [ -f "$f" ]; then
    cnt=$(tail -200 "$f" | grep -c '"priceVerify"' || true)
    cntopen=$(tail -200 "$f" | grep -c '"kind":"open"' || true)
    printf '  %-18s priceVerify=%s open=%s\n' "$p" "$cnt" "$cntopen"
  fi
done
