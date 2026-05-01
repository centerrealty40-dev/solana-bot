#!/usr/bin/env bash
set -euo pipefail
set -a
. /opt/solana-alpha/.env
set +a

echo '===== /api/qn/usage AFTER reset + safety enabled ====='
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" http://127.0.0.1:3008/api/qn/usage \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('global   month=', d['monthCredits'], 'day=', d['dayCredits'], 'hour=', d['hourCredits'])
print('budgets', d['budgets'])
print('safety ', d['perFeature']['safety'])
"

echo
echo '===== fresh open events with safety since reload ====='
for s in pt1-diprunner pt1-oscar pt1-dno; do
  P=/opt/solana-alpha/data/paper2/$s.jsonl
  echo "  --- $s ---"
  tail -300 "$P" | python3 -c "
import json, sys, collections
shapes=collections.Counter(); ok=collections.Counter(); reasons=collections.Counter()
for ln in sys.stdin:
  try:
    o=json.loads(ln)
    if o.get('kind')!='open': continue
    v=o.get('safety')
    if not isinstance(v,dict): shapes['<no-dict>']+=1; continue
    if 'skipped' in v:
      shapes['skipped']+=1; reasons['skip:'+str(v['skipped'])]+=1
    elif 'ok' in v:
      shapes[f\"ok={v['ok']}\"]+=1
      if v['ok'] is False:
        for r in (v.get('reasons') or []): reasons['fail:'+str(r)]+=1
  except Exception: pass
for k,c in shapes.most_common():
  print(f'    {c:3d} {k}')
for k,c in reasons.most_common(8):
  print(f'    {c:3d} reason={k}')
"
done

echo
echo '===== eval-skip-open with reason safety:* (last 2h) ====='
for s in pt1-diprunner pt1-oscar pt1-dno; do
  P=/opt/solana-alpha/data/paper2/$s.jsonl
  printf '  %-15s skips: ' "$s"
  tail -2000 "$P" | grep -c 'safety:' || echo 0
done
