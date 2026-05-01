import json, sys, collections
total_open = 0; with_pv = 0
kinds = collections.Counter(); reasons = collections.Counter()
slips = []; impacts = []; samples = []
eval_skips = collections.Counter()
for ln in sys.stdin:
    try:
        o = json.loads(ln)
    except Exception:
        continue
    if o.get('kind') == 'eval-skip-open':
        r = o.get('reason','')
        if isinstance(r, str) and r.startswith('price_verify:'):
            eval_skips[r] += 1
        continue
    if o.get('kind') != 'open':
        continue
    total_open += 1
    pv = o.get('priceVerify')
    if not isinstance(pv, dict):
        continue
    with_pv += 1
    k = pv.get('kind','?')
    kinds[k] += 1
    if k in ('blocked','skipped'):
        reasons[k+':'+str(pv.get('reason','?'))] += 1
    if k == 'ok':
        if isinstance(pv.get('slipPct'), (int,float)):
            slips.append(pv['slipPct'])
        if isinstance(pv.get('priceImpactPct'), (int,float)):
            impacts.append(pv['priceImpactPct'])
        if len(samples) < 2:
            samples.append({k2: pv.get(k2) for k2 in (
                'jupiterPriceUsd','snapshotPriceUsd','slipPct','priceImpactPct','routeHops','ageMs')})

print(f'open events scanned: {total_open}')
print(f'open events with priceVerify: {with_pv}')
print(f'kind distribution: {dict(kinds)}')
print(f'block/skip reasons: {dict(reasons)}')
print(f'eval-skip-open price_verify:* count: {dict(eval_skips)}')

def pct(arr, p):
    if not arr: return None
    s = sorted(arr)
    return s[min(len(s)-1, int(len(s)*p/100))]

if slips:
    print(f'slipPct: n={len(slips)} avg={sum(slips)/len(slips):.3f} p50={pct(slips,50)} p90={pct(slips,90)}')
else:
    print('slipPct: n=0')
if impacts:
    print(f'impactPct: n={len(impacts)} avg={sum(impacts)/len(impacts):.3f} p90={pct(impacts,90)}')
else:
    print('impactPct: n=0')
print('first ok samples:')
for s in samples:
    print(' ', json.dumps(s))
