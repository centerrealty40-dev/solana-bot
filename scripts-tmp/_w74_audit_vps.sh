#!/usr/bin/env bash
set -euo pipefail
cd /opt/solana-alpha
set -a; . /opt/solana-alpha/.env; set +a

echo '===== git ====='
git rev-parse HEAD
git log -3 --oneline
echo
echo '===== W7.4 source presence + ownership ====='
ls -la src/papertrader/pricing/price-verify.ts src/papertrader/types.ts 2>&1 | head -5
git ls-files src/papertrader/pricing/price-verify.ts | head -5
echo
echo '===== /opt/solana-alpha/.env W7.4 keys ====='
grep -E '^PAPER_PRICE_VERIFY_' /opt/solana-alpha/.env || echo '(no global W7.4 env)'
echo
echo '===== per-strategy live env (PAPER_PRICE_VERIFY_*) ====='
sudo -u salpha pm2 jlist | python3 - <<'PY'
import json, sys
arr = json.load(sys.stdin)
keys = ['PAPER_PRICE_VERIFY_ENABLED', 'PAPER_PRICE_VERIFY_BLOCK_ON_FAIL',
        'PAPER_PRICE_VERIFY_USE_JUPITER_PRICE',
        'PAPER_PRICE_VERIFY_MAX_SLIP_PCT', 'PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT',
        'PAPER_PRICE_VERIFY_TIMEOUT_MS']
for a in arr:
    n = a.get('name','')
    if not n.startswith('pt1-'): continue
    e = a.get('pm2_env',{})
    print(f"--- {n} status={e.get('status')} restarts={e.get('unstable_restarts',0)} uptime_ms={int((__import__('time').time()*1000) - int(e.get('pm_uptime',0)))} ---")
    for k in keys:
        print(f"  {k:42s}={e.get(k)!r}")
PY
echo
echo '===== priceVerify stamping & verdict shape (pt1-dno tail 800) ====='
tail -800 /opt/solana-alpha/data/paper2/pt1-dno.jsonl | python3 - <<'PY'
import json, sys, collections
total_open = 0; with_pv = 0
kinds = collections.Counter(); reasons = collections.Counter()
slips = []; impacts = []
samples = []
eval_skips = collections.Counter()
for ln in sys.stdin:
    try:
        o = json.loads(ln)
    except: continue
    if o.get('kind') == 'eval-skip-open':
        r = o.get('reason','')
        if isinstance(r, str) and r.startswith('price_verify:'):
            eval_skips[r] += 1
        continue
    if o.get('kind') != 'open': continue
    total_open += 1
    pv = o.get('priceVerify')
    if not isinstance(pv, dict): continue
    with_pv += 1
    k = pv.get('kind','?')
    kinds[k] += 1
    if k in ('blocked','skipped'):
        reasons[k+':'+str(pv.get('reason','?'))] += 1
    if k == 'ok':
        if isinstance(pv.get('slipPct'), (int,float)): slips.append(pv['slipPct'])
        if isinstance(pv.get('priceImpactPct'), (int,float)): impacts.append(pv['priceImpactPct'])
        if len(samples) < 2:
            samples.append({k2: pv.get(k2) for k2 in ('jupiterPriceUsd','snapshotPriceUsd','slipPct','priceImpactPct','routeHops','ageMs')})

print(f'open events scanned: {total_open}')
print(f'open events with priceVerify: {with_pv}')
print(f'kind distribution: {dict(kinds)}')
print(f'block/skip reasons: {dict(reasons)}')
print(f'eval-skip-open price_verify:* count: {dict(eval_skips)}')
def pct(arr,p):
    if not arr: return None
    s = sorted(arr)
    return s[min(len(s)-1, int(len(s)*p/100))]
print(f'slipPct: n={len(slips)} avg={sum(slips)/len(slips):.3f} p50={pct(slips,50)} p90={pct(slips,90)}' if slips else 'slipPct: n=0')
print(f'impactPct: n={len(impacts)} avg={sum(impacts)/len(impacts):.3f} p90={pct(impacts,90)}' if impacts else 'impactPct: n=0')
print('first ok samples:')
for s in samples:
    print(' ', json.dumps(s))
PY
echo
echo '===== /api/paper2/price-verify-stats?windowMin=120 ====='
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" \
  'http://127.0.0.1:3008/api/paper2/price-verify-stats?windowMin=120' | python3 -m json.tool
echo
echo '===== last heartbeat skippedPriceVerify ====='
tail -200 /home/salpha/.pm2/logs/pt1-dno-out.log 2>/dev/null \
  | grep heartbeat | tail -3 \
  | python3 - <<'PY'
import json, sys
for ln in sys.stdin:
    i = ln.find('{')
    if i < 0: continue
    o = json.loads(ln[i:])
    st = o.get('stats',{})
    print(f"opened={st.get('opened',0)} skippedSafety={st.get('skippedSafety',0)} skippedPriceVerify={st.get('skippedPriceVerify','<missing>')} evaluated={st.get('evaluated',0)} open={o.get('open')}")
PY
