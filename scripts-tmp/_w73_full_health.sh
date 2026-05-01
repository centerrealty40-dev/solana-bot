#!/usr/bin/env bash
set -euo pipefail
set -a
. /opt/solana-alpha/.env
set +a

echo '===== /api/paper2/priority-fee ====='
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" http://127.0.0.1:3008/api/paper2/priority-fee 2>&1 | head -40 || echo '(endpoint missing)'

echo
echo '===== priority-fee cache file ====='
ls -la /opt/solana-alpha/data/priority-fee-cache.json 2>/dev/null || echo '(no cache file)'
cat /opt/solana-alpha/data/priority-fee-cache.json 2>/dev/null || true

echo
echo '===== /api/qn/usage now ====='
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" http://127.0.0.1:3008/api/qn/usage \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('global   month=', d['monthCredits'], 'day=', d['dayCredits'], 'hour=', d['hourCredits'])
for f,v in d['perFeature'].items():
  print(f'  {f:14s} month={v[\"monthCredits\"]:6d}  day={v[\"dayCredits\"]:6d}  hour={v[\"hourCredits\"]:6d}  budget={v[\"budgetMonth\"]}')"

echo
echo '===== safety verdicts on opens since 17:33 reload ====='
for s in pt1-diprunner pt1-oscar pt1-dno; do
  P=/opt/solana-alpha/data/paper2/$s.jsonl
  echo "  --- $s ---"
  tail -500 "$P" | python3 -c "
import json,sys,collections
shapes=collections.Counter(); reasons=collections.Counter()
for ln in sys.stdin:
  try:
    o=json.loads(ln)
    if o.get('kind')!='open': continue
    if o.get('ts',0) < 1777656700000: continue  # 17:33 UTC reload boundary
    v=o.get('safety')
    if not isinstance(v,dict): shapes['<no-safety>']+=1; continue
    if 'skipped' in v: shapes['skipped']+=1; reasons['skip:'+str(v['skipped'])]+=1
    elif 'ok' in v:
      shapes[f\"ok={v['ok']}\"]+=1
      if v['ok'] is False:
        for r in (v.get('reasons') or []): reasons['fail:'+str(r)]+=1
  except: pass
total=sum(shapes.values())
print(f'    total fresh opens: {total}')
for k,c in shapes.most_common():
  print(f'    {c:3d} {k}')
for k,c in reasons.most_common(6):
  print(f'    {c:3d} reason={k}')
"
done

echo
echo '===== priority-fee in fresh open events ====='
for s in pt1-diprunner pt1-oscar pt1-dno; do
  P=/opt/solana-alpha/data/paper2/$s.jsonl
  printf '  %-15s ' "$s"
  tail -500 "$P" | python3 -c "
import json,sys,collections
src=collections.Counter(); cnt=0
for ln in sys.stdin:
  try:
    o=json.loads(ln)
    if o.get('kind') not in ('open','dca_add','partial_sell','close'): continue
    if o.get('ts',0) < 1777656700000: continue
    pf=o.get('priorityFee')
    if isinstance(pf,dict):
      cnt+=1
      src[str(pf.get('source','?'))]+=1
  except: pass
print(f'events_with_pri_fee={cnt}  sources={dict(src)}')"
done

echo
echo '===== heartbeat skippedSafety counter ====='
for s in pt1-diprunner pt1-oscar pt1-dno; do
  printf '  %-15s ' "$s"
  tail -100 "/home/salpha/.pm2/logs/$s-out.log" 2>/dev/null \
    | grep heartbeat | tail -1 \
    | python3 -c "
import json,sys
for ln in sys.stdin:
  i=ln.find('{')
  if i<0: continue
  o=json.loads(ln[i:])
  st=o.get('stats',{})
  print(f\"opened={st.get('opened',0)}  skippedSafety={st.get('skippedSafety',0)}  evaluated={st.get('evaluated',0)}  open={o.get('open')}\")"
done
