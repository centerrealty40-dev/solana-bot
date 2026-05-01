#!/usr/bin/env bash
set -a; . /opt/solana-alpha/.env; set +a
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" 'http://127.0.0.1:3008/api/paper2' > /tmp/_paper2.json
python3 - <<'PY'
import json
with open('/tmp/_paper2.json') as f:
    d = json.load(f)
strats = d.get('strategies', [])
print(f'strategies returned: {len(strats)}')
for s in strats:
    sid = s.get('strategyId')
    closed = s.get('recentClosed') or []
    print(f'  {sid}: {len(closed)} closed rows')
    for c in closed[:3]:
        ec = c.get('exitContext')
        line = f"    {c.get('exitReason'):>10} pnl={c.get('pnlPct',0):+.2f}% age={int(c.get('durationMin',0))}m"
        if ec:
            line += f" trigger=\"{ec.get('triggerLabel')}\" peak={ec.get('peakPnlPct')}% retrace={ec.get('retraceFromPeakPct')} hits={ec.get('tpLadderHits')}/{ec.get('tpLadderTotal')} armed={ec.get('trailingArmed')}"
        else:
            line += " exitContext=NONE (legacy row, will fall back to plain headline)"
        print(line)
PY
