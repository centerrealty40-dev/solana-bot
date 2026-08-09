#!/usr/bin/env python3
"""Analyze leader daily-green math from copytrader leader_session_closed + observer flats."""
from __future__ import annotations

import json
import math
import random
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts/milddip-leader-edge"


def phi(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def analyze_session_pcts(pcts: list[float], by_day: dict[str, list[float]]) -> dict:
    n = len(pcts)
    mean = sum(pcts) / n
    med = sorted(pcts)[n // 2]
    var = sum((x - mean) ** 2 for x in pcts) / n
    sd = math.sqrt(var) if var > 0 else 0.0
    win = sum(1 for x in pcts if x > 0) / n
    daily = {
        d: {
            "n": len(v),
            "win": sum(1 for x in v if x > 0) / len(v),
            "med": sorted(v)[len(v) // 2],
            "mean": sum(v) / len(v),
            "sumPct": sum(v),
            "green": sum(v) > 0,
        }
        for d, v in sorted(by_day.items())
    }
    sizes = [len(v) for v in by_day.values()]
    rng = random.Random(0)
    green_counts = []
    for _ in range(2000):
        pool = pcts[:]
        rng.shuffle(pool)
        g = 0
        i = 0
        for sz in sizes:
            if sum(pool[i : i + sz]) > 0:
                g += 1
            i += sz
        green_counts.append(g)
    p_day = {n0: phi(mean * math.sqrt(n0) / sd) if sd > 0 else None for n0 in (50, 100, 200, 300, 400, 500)}
    return {
        "n": n,
        "win": win,
        "mean": mean,
        "med": med,
        "sd": sd,
        "daily": daily,
        "bootstrap_all_days_green": sum(1 for x in green_counts if x == len(sizes)) / len(green_counts),
        "p_day_green_approx": p_day,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # Optional: pass journal path via env; else expect precomputed json from VPS pull
    pre = OUT / "8zkg_leader_closed_daily.json"
    if pre.exists():
        print(json.dumps(json.loads(pre.read_text()), indent=2)[:2000])
    print("See LEADER_DAILY_EDGE.md for full writeup.")


if __name__ == "__main__":
    main()
