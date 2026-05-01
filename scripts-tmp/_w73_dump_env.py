import json, sys
arr = json.load(sys.stdin)
keys = ['PAPER_SAFETY_CHECK_ENABLED','PAPER_PRIORITY_FEE_ENABLED',
        'PAPER_PRIORITY_FEE_TICKER_MS','PAPER_PRIORITY_FEE_PERCENTILE',
        'PAPER_PRIORITY_FEE_TARGET_CU','PAPER_PRIORITY_FEE_MAX_AGE_MS']
want = {'pt1-diprunner','pt1-oscar','pt1-dno'}
for a in arr:
    n=a.get('name')
    if n not in want: continue
    e=a.get('pm2_env',{})
    print(f'--- {n} (status={e.get("status")} restarts={e.get("unstable_restarts",0)}) ---')
    for k in keys:
        print(f'  {k:35s}={e.get(k)!r}')
