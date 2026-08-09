#!/usr/bin/env python3
"""
Fit per-wallet TD exit formulas from overnight dense tape.

Reads:
  data/milddip/leader-dense-YYYYMMDD.jsonl   (leader_bag_tick @ ~1s)
  data/milddip/leader-observer-YYYYMMDD.jsonl (buys/sells/session_flat)

Usage:
  python3 scripts/milddip/leader-dense-exit-fit.py
  python3 scripts/milddip/leader-dense-exit-fit.py --dir data/milddip --tol-sec 5

Outputs artifacts/milddip-leader-edge/leader_dense_exit_fit.json
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path


def load_jsonl(path: Path):
    if not path.exists():
        return []
    out = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="data/milddip")
    ap.add_argument("--tol-sec", type=float, default=5.0, help="exit timing tolerance")
    ap.add_argument("--out", default="artifacts/milddip-leader-edge/leader_dense_exit_fit.json")
    args = ap.parse_args()
    d = Path(args.dir)

    ticks = []
    events = []
    for p in sorted(d.glob("leader-dense-*.jsonl")):
        ticks.extend(load_jsonl(p))
    for p in sorted(d.glob("leader-observer-*.jsonl")):
        events.extend(load_jsonl(p))

    buys = [e for e in events if e.get("kind") == "leader_buy_observed" and not e.get("isAdd")]
    flats = [e for e in events if e.get("kind") == "leader_session_flat"]
    ticks = [t for t in ticks if t.get("kind") == "leader_bag_tick"]

    by_bag_ticks: dict[tuple[str, str], list] = defaultdict(list)
    for t in ticks:
        key = (str(t.get("leader") or ""), str(t.get("mint") or ""))
        by_bag_ticks[key].append(t)
    for k in by_bag_ticks:
        by_bag_ticks[k].sort(key=lambda x: int(x.get("tsMs") or 0))

    sessions = []
    for flat in flats:
        leader = str(flat.get("leader") or "")
        mint = str(flat.get("mint") or "")
        key = (leader, mint)
        series = by_bag_ticks.get(key) or []
        if len(series) < 3:
            continue
        # trim ticks to hold window
        opened = flat.get("openedBlockTime")
        closed = flat.get("blockTime")
        if opened and closed:
            t0 = int(opened) * 1000
            t1 = int(closed) * 1000
            series = [t for t in series if t0 - 2000 <= int(t.get("tsMs") or 0) <= t1 + 2000]
        if len(series) < 3:
            continue
        entry_td = bool(flat.get("isTdEntry"))
        if flat.get("entryClass") in (
            "shallow",
            "mild_shallow",
            "mild_deep",
            "deep_knife",
            "rug_knife",
        ):
            entry_td = True
        if not entry_td:
            # still keep greens separately if needed; default focus TD
            pass
        gaps = []
        for i in range(1, len(series)):
            gaps.append((int(series[i].get("tsMs") or 0) - int(series[i - 1].get("tsMs") or 0)) / 1000.0)
        sessions.append(
            {
                "leader": leader[:8],
                "mint": mint[:8],
                "isTd": entry_td,
                "final": flat.get("pnlPctApprox"),
                "held": flat.get("heldSec"),
                "mfe": flat.get("mfePct"),
                "mae": flat.get("maePct"),
                "givebackAtExit": flat.get("givebackPctAtExit"),
                "bounceAtExit": flat.get("bouncePctAtExit"),
                "nTicks": len(series),
                "medGapSec": statistics.median(gaps) if gaps else None,
                "series": series,
            }
        )

    td = [s for s in sessions if s["isTd"]]
    report: dict = {
        "n_ticks": len(ticks),
        "n_buys": len(buys),
        "n_flats": len(flats),
        "n_sessions_with_dense": len(sessions),
        "n_td_sessions": len(td),
        "tick_gap_med_sec": statistics.median(
            [s["medGapSec"] for s in sessions if s.get("medGapSec") is not None]
        )
        if sessions
        else None,
        "wallets": {},
    }

    # Simple high-cover scans with second-level tolerance
    for lead in sorted({s["leader"] for s in td}):
        ss = [s for s in td if s["leader"] == lead]
        best = []
        for arm in (5, 8, 10):
            for gb in (5, 8, 10, 12, 15):
                hit = trig = 0
                for s in ss:
                    fire = None
                    armed = False
                    for t in s["series"]:
                        mfe = t.get("mfePct")
                        gb_v = t.get("givebackPct")
                        if isinstance(mfe, (int, float)) and mfe >= arm:
                            armed = True
                        if armed and isinstance(gb_v, (int, float)) and gb_v <= -gb:
                            fire = t
                            break
                    if not fire:
                        continue
                    trig += 1
                    held = float(s["held"] or 0)
                    fire_held = float(fire.get("heldSec") or 0)
                    if abs(held - fire_held) <= args.tol_sec:
                        hit += 1
                best.append((hit / len(ss) if ss else 0, hit, trig, f"trail a{arm}/g{gb}"))
        for tp in (8, 10, 12, 15, 20):
            hit = trig = 0
            for s in ss:
                fire = None
                for t in s["series"]:
                    pnl = t.get("pnlPct")
                    if isinstance(pnl, (int, float)) and pnl >= tp:
                        fire = t
                        break
                if not fire:
                    continue
                trig += 1
                held = float(s["held"] or 0)
                fire_held = float(fire.get("heldSec") or 0)
                if abs(held - fire_held) <= args.tol_sec:
                    hit += 1
            best.append((hit / len(ss) if ss else 0, hit, trig, f"TP{tp}"))
        best.sort(reverse=True)
        report["wallets"][lead] = {
            "n_td": len(ss),
            "med_ticks": statistics.median([s["nTicks"] for s in ss]) if ss else None,
            "top_rules_tol_sec": args.tol_sec,
            "top": [
                {"rule": name, "cover": cov, "hit": hit, "trig": trig}
                for cov, hit, trig, name in best[:12]
            ],
        }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in report if k != "wallets"}, indent=2))
    for lead, w in report["wallets"].items():
        print(f"\n{lead} n_td={w['n_td']} med_ticks={w['med_ticks']}")
        for row in w["top"][:5]:
            print(
                f"  {row['rule']}: cover={row['cover']*100:.0f}% hit={row['hit']}/{w['n_td']} trig={row['trig']}"
            )
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
