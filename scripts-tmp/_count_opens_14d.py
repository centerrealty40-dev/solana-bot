import json
import sys
import time

path = sys.argv[1] if len(sys.argv) > 1 else "data/live/pt1-oscar-live.jsonl"
days = float(sys.argv[2]) if len(sys.argv) > 2 else 14
t0 = time.time() * 1000 - days * 864e5
opens = closes = 0
with open(path, encoding="utf-8", errors="replace") as f:
    for line in f:
        if "live_position_open" in line:
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (o.get("ts") or 0) < t0:
                continue
            if o.get("strategyId") not in (None, "live-oscar"):
                continue
            opens += 1
        elif "live_position_close" in line:
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (o.get("ts") or 0) < t0:
                continue
            if o.get("strategyId") not in (None, "live-oscar"):
                continue
            closes += 1
print(json.dumps({"opens": opens, "closes": closes}))
