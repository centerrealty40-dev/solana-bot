#!/usr/bin/env python3
"""
Roll up mild-dip leader-observer JSONL into +/- segment stats.

Reads data/milddip/leader-observer-YYYYMMDD.jsonl (or --dir) and prints:
  - session flat PnL by entryClass / turnDump.branch / leader
  - buy coverage MAIN vs SHALLOW
  - hold-time buckets

Usage:
  python3 scripts/milddip/leader-segment-stats.py
  python3 scripts/milddip/leader-segment-stats.py --dir data/milddip --days 3
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    i = (len(xs) - 1) * p / 100
    lo = int(i)
    hi = min(lo + 1, len(xs) - 1)
    f = i - lo
    return xs[lo] * (1 - f) + xs[hi] * f


def summarize(name: str, pnls: list[float]) -> str:
    if not pnls:
        return f"{name}: n=0"
    wins = sum(1 for x in pnls if x > 0)
    return (
        f"{name}: n={len(pnls)} win={wins / len(pnls):.1%} "
        f"mean={statistics.mean(pnls):+.2f}% med={statistics.median(pnls):+.2f}% "
        f"p10={pct(pnls, 10):+.2f}% p90={pct(pnls, 90):+.2f}%"
    )


def hold_bucket(sec: float | None) -> str:
    if sec is None:
        return "unknown"
    m = sec / 60
    if m < 2:
        return "<2m"
    if m < 10:
        return "2-10m"
    if m < 30:
        return "10-30m"
    if m < 120:
        return "30-120m"
    return ">=120m"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="data/milddip")
    ap.add_argument("--days", type=int, default=7)
    args = ap.parse_args()
    root = Path(args.dir)
    files = sorted(root.glob("leader-observer-*.jsonl"))[-max(1, args.days) :]
    if not files:
        raise SystemExit(f"no leader-observer-*.jsonl under {root}")

    by_class: dict[str, list[float]] = defaultdict(list)
    by_branch: dict[str, list[float]] = defaultdict(list)
    by_leader: dict[str, list[float]] = defaultdict(list)
    by_hold: dict[str, list[float]] = defaultdict(list)
    by_mfe_bucket: dict[str, list[float]] = defaultdict(list)
    buys_branch = defaultdict(int)
    kinds = defaultdict(int)
    marks = 0

    for path in files:
        for line in path.open(encoding="utf-8"):
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            k = o.get("kind") or "?"
            kinds[k] += 1
            if k == "leader_bag_mark":
                marks += 1
            if k == "leader_buy_observed":
                td = o.get("turnDump") or {}
                br = td.get("branch") if isinstance(td, dict) else None
                if br:
                    buys_branch[str(br)] += 1
                elif isinstance(td, dict) and td.get("inMain") is False and td.get("inShallow") is False:
                    buys_branch["neither"] += 1
                else:
                    buys_branch["no_td"] += 1
            if k != "leader_session_flat":
                continue
            pnl = o.get("pnlPctApprox")
            if not isinstance(pnl, (int, float)) or not math.isfinite(pnl):
                continue
            # Cap absurd outliers from bad fill prices (quote-leg mix).
            if abs(pnl) > 500:
                continue
            cls = str(o.get("entryClass") or o.get("class") or "?")
            td = o.get("entryTurnDump") or {}
            br = str((td or {}).get("branch") or "?")
            lead = str(o.get("leader") or "?")[:8]
            by_class[cls].append(float(pnl))
            by_branch[br].append(float(pnl))
            by_leader[lead].append(float(pnl))
            by_hold[hold_bucket(o.get("heldSec"))].append(float(pnl))
            mfe = o.get("mfePct")
            if isinstance(mfe, (int, float)):
                mb = "<5%" if mfe < 5 else ("5-15%" if mfe < 15 else ("15-40%" if mfe < 40 else ">=40%"))
                by_mfe_bucket[mb].append(float(pnl))

    print(f"files={[p.name for p in files]}")
    print(f"kinds={dict(sorted(kinds.items(), key=lambda x: -x[1]))}")
    print(f"bag_marks={marks}")
    print(f"buy_turnDump_branch={dict(buys_branch)}")
    print("--- session flat PnL (capped |pnl|<=500%) ---")
    for lead, xs in sorted(by_leader.items(), key=lambda x: -len(x[1])):
        print(summarize(f"leader:{lead}", xs))
    print("--- by entryClass ---")
    for c, xs in sorted(by_class.items(), key=lambda x: -len(x[1])):
        print(summarize(c, xs))
    print("--- by entry turnDump.branch ---")
    for b, xs in sorted(by_branch.items(), key=lambda x: -len(x[1])):
        print(summarize(b, xs))
    print("--- by hold ---")
    for b, xs in sorted(by_hold.items(), key=lambda x: -len(x[1])):
        print(summarize(b, xs))
    if by_mfe_bucket:
        print("--- by MFE (needs marks) ---")
        for b, xs in sorted(by_mfe_bucket.items(), key=lambda x: -len(x[1])):
            print(summarize(b, xs))


if __name__ == "__main__":
    main()
