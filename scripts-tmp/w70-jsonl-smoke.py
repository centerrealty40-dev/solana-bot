#!/usr/bin/env python3
"""W7.0 smoke: count heartbeats and evals in last N minutes in pt1-*.jsonl."""
import glob
import json
import time

now_ms = time.time() * 1000
window_ms = 15 * 60 * 1000
paths = sorted(glob.glob('/opt/solana-alpha/data/paper2/pt1-*.jsonl'))
for p in paths:
    hb = ev = 0
    try:
        with open(p, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    j = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = int(j.get('ts') or 0)
                if ts and now_ms - ts > window_ms:
                    continue
                k = j.get('kind')
                if k == 'heartbeat':
                    hb += 1
                elif k == 'eval':
                    ev += 1
    except OSError as e:
        print(p, 'ERROR', e)
        continue
    print(p, 'heartbeat_15m', hb, 'eval_15m', ev)
