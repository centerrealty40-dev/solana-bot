import json, sys, time
arr = json.load(sys.stdin)
keys = ['PAPER_PRICE_VERIFY_ENABLED','PAPER_PRICE_VERIFY_BLOCK_ON_FAIL',
        'PAPER_PRICE_VERIFY_USE_JUPITER_PRICE',
        'PAPER_PRICE_VERIFY_MAX_SLIP_PCT','PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT',
        'PAPER_PRICE_VERIFY_TIMEOUT_MS']
now = time.time()*1000
for a in arr:
    n = a.get('name','')
    if not n.startswith('pt1-'): continue
    e = a.get('pm2_env',{})
    upt = int(now - int(e.get('pm_uptime',0)))
    print(f"--- {n} status={e.get('status')} restarts={e.get('unstable_restarts',0)} uptime_ms={upt} ---")
    for k in keys:
        print(f"  {k:42s}={e.get(k)!r}")
