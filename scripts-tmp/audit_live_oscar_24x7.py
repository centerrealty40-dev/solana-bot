#!/usr/bin/env python3
"""Read-only health audit for Live Oscar 24/7 (run on VPS as salpha)."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path('/opt/solana-alpha')
WL = ROOT / 'data/live/live-oscar-mint-whitelist.txt'
JSONL = ROOT / 'data/live/pt1-oscar-live.jsonl'
HEALTH = ROOT / 'data/live-discovery-health.json'


def load_wl() -> list[str]:
    out: list[str] = []
    for line in WL.read_text(encoding='utf-8', errors='replace').splitlines():
        s = line.split('#')[0].strip()
        if len(s) >= 32:
            out.append(s)
    return out


def pm2_online(names: list[str]) -> dict[str, str]:
    try:
        raw = subprocess.check_output(['pm2', 'jlist'], text=True)
        data = json.loads(raw)
    except Exception as e:
        return {n: f'pm2_error:{e}' for n in names}
    by = {x['name']: x['pm2_env']['status'] for x in data}
    return {n: by.get(n, 'missing') for n in names}


def main() -> int:
    issues: list[str] = []
    core = [
        'live-oscar',
        'copy-trader',
        'pumpswap-dip-bot',
        'live-oscar-dashboard',
        'sa-raydium',
        'sa-meteora',
        'sa-pumpswap',
        'sa-moonshot',
        'sa-collector-watch',
    ]
    st = pm2_online(core)
    print('=== PM2 ===')
    for n in core:
        s = st[n]
        print(f'  {n:28} {s}')
        if s != 'online':
            issues.append(f'pm2:{n}={s}')

    if HEALTH.is_file():
        h = json.loads(HEALTH.read_text(encoding='utf-8'))
        print('\n=== discovery health (30m window) ===')
        print(json.dumps(h, indent=2))
        if int(h.get('opened', 0)) == 0 and int(h.get('evaluated', 0) or 0) > 50:
            issues.append('no_opens_many_evals')

    wl = load_wl()
    latest_eval: dict[str, dict] = {}
    latest_miss: dict[str, dict] = {}
    if JSONL.is_file():
        for line in JSONL.read_text(encoding='utf-8', errors='replace').splitlines()[-80000:]:
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            m = o.get('mint')
            if m not in wl:
                continue
            ts = int(o.get('ts') or 0)
            k = o.get('kind')
            if k == 'live_discovery_eval' and ts >= int(latest_eval.get(m, {}).get('ts') or 0):
                latest_eval[m] = o
            if k == 'live_discovery_universe_miss' and ts >= int(latest_miss.get(m, {}).get('ts') or 0):
                latest_miss[m] = o

    no_snap = [
        m
        for m in wl
        if m in latest_miss
        and 'no_snapshot_row_30m' in ' '.join(latest_miss[m].get('reasons') or [])
        and m not in latest_eval
    ]
    has_eval = len(latest_eval)
    print(f'\n=== whitelist ({len(wl)} mints) ===')
    print(f'  with live_discovery_eval: {has_eval}')
    print(f'  universe_miss no_snapshot only: {len(no_snap)}')
    if no_snap:
        print('  examples:', ', '.join(no_snap[:8]))
        issues.append(f'wl_no_snapshot:{len(no_snap)}')

    print('\n=== summary ===')
    if issues:
        print('ISSUES:', '; '.join(issues))
        return 1
    print('OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
