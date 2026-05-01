#!/usr/bin/env bash
RELOAD_MS=$((1777665088 * 1000))
echo "reload approx: $RELOAD_MS"
for p in pt1-dno pt1-diprunner pt1-oscar; do
  f="/opt/solana-alpha/data/paper2/${p}.jsonl"
  echo "=== $p ==="
  tail -200 "$f" | python3 -c "
import json, sys
RELOAD_MS=$RELOAD_MS
opens=[]
for ln in sys.stdin:
  try: o=json.loads(ln)
  except: continue
  if o.get('kind')!='open': continue
  opens.append(o)
fresh=[o for o in opens if o.get('ts',0)>=RELOAD_MS]
old=[o for o in opens if o.get('ts',0)<RELOAD_MS]
print(f'  total tail open events: {len(opens)} (fresh after reload: {len(fresh)}, old: {len(old)})')
for o in fresh:
  pv=o.get('priceVerify')
  print(f'    fresh ts={o.get(\"ts\")} mint={o.get(\"mint\",\"\")[:8]} priceVerify={pv}')
for o in old[-3:]:
  pv=o.get('priceVerify')
  print(f'    old   ts={o.get(\"ts\")} mint={o.get(\"mint\",\"\")[:8]} priceVerify={pv}')
"
done
echo
echo "=== priority-fee monitor ticks (sanity) ==="
for p in pt1-dno pt1-diprunner pt1-oscar; do
  printf '  %-18s ' "$p"
  tail -300 "/home/salpha/.pm2/logs/${p}-out.log" 2>/dev/null | grep -E 'priorityFee|price-verify|verifyEntryPrice' | tail -1 | head -c 200
  echo
done
