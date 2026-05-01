import json, collections
shapes = collections.Counter()
verdict_ok = collections.Counter()
skipped_reason = collections.Counter()
samples = []
total = 0
with open('/tmp/_opens.jsonl') as f:
    for ln in f:
        try:
            o = json.loads(ln)
            if o.get('kind') != 'open': continue
            total += 1
            v = o.get('safety')
            if v is None:
                shapes['<no-safety-field>'] += 1
                continue
            if isinstance(v, dict):
                if 'skipped' in v:
                    shapes['skipped'] += 1
                    skipped_reason[str(v.get('skipped'))] += 1
                elif 'ok' in v:
                    shapes[f"ok={v['ok']}"] += 1
                    verdict_ok[str(v.get('ok'))] += 1
                    if v.get('ok') is False and len(samples) < 3:
                        samples.append({k: v.get(k) for k in ('ok','reasons','top_holder_pct','mint_authority','freeze_authority')})
                else:
                    shapes[f"keys={tuple(sorted(v.keys()))}"] += 1
            else:
                shapes[f"type={type(v).__name__}"] += 1
        except Exception:
            pass
print(f'total open events scanned: {total}')
print('safety shape distribution:')
for k,c in shapes.most_common():
    print(f'  {c:4d}  {k}')
if skipped_reason:
    print('skipped reasons:')
    for k,c in skipped_reason.most_common():
        print(f'  {c:4d}  reason={k}')
if samples:
    print('first 3 ok:false samples:')
    for s in samples:
        print(' ', json.dumps(s, ensure_ascii=False)[:200])
