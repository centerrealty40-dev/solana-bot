import json
import sys
import time

path = sys.argv[1] if len(sys.argv) > 1 else "data/live/pt1-oscar-live.jsonl"
days = float(sys.argv[2]) if len(sys.argv) > 2 else 14
t0 = time.time() * 1000 - days * 864e5
n = p = 0
with open(path, encoding="utf-8", errors="replace") as f:
    for line in f:
        if "live_discovery_eval" not in line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (o.get("ts") or 0) < t0:
            continue
        n += 1
        if o.get("pass"):
            p += 1
print(json.dumps({"evalRows": n, "evalPass": p}))
