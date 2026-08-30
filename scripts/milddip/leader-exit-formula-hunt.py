#!/usr/bin/env python3
"""
Leader exit formula hunt — trade-by-trade coefficient search.

Method (same spirit as turn→dump entry RE):
  1. Rebuild bag sessions from leader-observer JSONL.
  2. Rebase entry to the first Dex mark (quote fills are often 20–1000× garbage).
  3. For every dense path ( ≥3 marks ), walk mark features at exit.
  4. Score candidate rules by first-fire vs actual exit heldSec (±tol).

Usage (on VPS clone with journals):
  python3 scripts/milddip/leader-exit-formula-hunt.py
  python3 scripts/milddip/leader-exit-formula-hunt.py --dir data/milddip --tol 120

What this has shown so far (Aug 9 dense window):
  - No single TP/SL/trail coefficient reaches entry-formula quality.
  - Best combined rules ~15–17% hit / ~40% early on dense held<8000s.
  - Real on-chain hold cluster ≈8450–8510s (~2.35h) — candidate soft max-hold.
  - Never-arm bags exit at wildly different red levels (no fixed SL).
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

WALLETS = {
    "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ": "8zkg",
    "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5": "7BNax",
}


def num(x: Any) -> float | None:
    try:
        if x is None:
            return None
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def dex_obj(o: dict) -> dict:
    d = o.get("dex")
    return d if isinstance(d, dict) and not d.get("error") else {}


def dex_px(o: dict) -> float | None:
    d = dex_obj(o)
    return num(d.get("priceUsd")) or num(o.get("dexPriceUsd")) or num(o.get("markPriceUsd"))


def load_events(dir_path: Path) -> list[dict]:
    files = sorted(
        p for p in dir_path.glob("leader-observer-20*.jsonl") if p.stat().st_size > 10_000
    )
    events: list[dict] = []
    for p in files:
        with p.open() as f:
            for line in f:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    print(f"files={[p.name for p in files]} events={len(events)}")
    return events


def rebuild_sessions(events: list[dict]) -> list[dict]:
    by: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for o in events:
        lead = o.get("leader")
        mint = o.get("mint")
        if lead in WALLETS and mint:
            by[(lead, mint)].append(o)

    sessions: list[dict] = []
    for (lead, mint), evs in by.items():
        evs = sorted(evs, key=lambda e: e.get("tsMs") or e.get("blockTime") or 0)
        cur: dict | None = None
        for o in evs:
            k = o.get("kind")
            if k == "leader_buy_observed" and o.get("isNewBag"):
                cur = {
                    "leader": WALLETS[lead],
                    "mint": mint,
                    "openedIso": o.get("blockIso"),
                    "entrySig": o.get("signature"),
                    "entryClass": o.get("class"),
                    "entryPc5m": num(dex_obj(o).get("pc5m")),
                    "marks": [],
                }
            elif cur is not None:
                if k == "leader_bag_mark":
                    px = num(o.get("markPriceUsd")) or dex_px(o)
                    if px and px > 0:
                        cur["marks"].append(
                            {
                                "held": o.get("heldSec"),
                                "px": px,
                                "pc5m": num(dex_obj(o).get("pc5m")),
                            }
                        )
                elif k == "leader_sell_observed" and o.get("isFlat"):
                    marks = cur["marks"]
                    held = o.get("heldSec")
                    if len(marks) >= 3:
                        ent = marks[0]["px"]
                        peak = ent
                        trough = ent
                        path = []
                        for m in marks:
                            peak = max(peak, m["px"])
                            trough = min(trough, m["px"])
                            pnl = (m["px"] / ent - 1) * 100
                            path.append(
                                {
                                    "held": m["held"],
                                    "pnl": pnl,
                                    "mfe": (peak / ent - 1) * 100,
                                    "mae": (trough / ent - 1) * 100,
                                    "gb_pp": (peak / ent - 1) * 100 - pnl,
                                    "bounce": (m["px"] / trough - 1) * 100,
                                    "pc5m": m.get("pc5m"),
                                }
                            )
                        exit_px = dex_px(o) or marks[-1]["px"]
                        peak = max(peak, exit_px)
                        trough = min(trough, exit_px)
                        pnl = (exit_px / ent - 1) * 100
                        mfe = (peak / ent - 1) * 100
                        mae = (trough / ent - 1) * 100
                        if abs(pnl) <= 150 and abs(mfe) <= 300:
                            sessions.append(
                                {
                                    **{
                                        k2: cur[k2]
                                        for k2 in (
                                            "leader",
                                            "mint",
                                            "openedIso",
                                            "entrySig",
                                            "entryClass",
                                            "entryPc5m",
                                        )
                                    },
                                    "closedIso": o.get("blockIso"),
                                    "exitSig": o.get("signature"),
                                    "held": held,
                                    "pnl": pnl,
                                    "mfe": mfe,
                                    "mae": mae,
                                    "gap": mfe - pnl,
                                    "path": path,
                                    "n_marks": len(path),
                                }
                            )
                    cur = None
    return sessions


Pred = Callable[[dict, list[dict], int], bool]


def eval_rule(rows: list[dict], pred: Pred, tol: int) -> dict:
    hit = early = never = 0
    for s in rows:
        path = s["path"]
        held = s["held"] or path[-1]["held"] or 0
        syn = {
            **path[-1],
            "held": held,
            "pnl": s["pnl"],
            "mfe": s["mfe"],
            "mae": s["mae"],
            "gb_pp": s["gap"],
            "bounce": (s["pnl"] - s["mae"]) if s["mae"] < s["pnl"] else 0,
        }
        ext = path + [syn]
        fired = None
        for i, m in enumerate(ext):
            if pred(m, ext, i):
                fired = m["held"] or 0
                break
        if fired is None:
            never += 1
        elif abs(fired - held) <= tol:
            hit += 1
        elif fired + tol < held:
            early += 1
        else:
            never += 1
    n = len(rows)
    return {
        "n": n,
        "hit": hit / n if n else 0,
        "early": early / n if n else 0,
        "never": never / n if n else 0,
    }


def archetype(s: dict) -> str:
    held = s["held"] or 0
    if held >= 8000:
        return "MAXHOLD_~2.35h"
    if s["mfe"] >= 8 and s["gap"] <= 3:
        return "ARMED_NEAR_PEAK"
    if s["mfe"] >= 8 and s["gap"] > 3:
        return "ARMED_GAVE_BACK"
    if s["mfe"] < 5 and s["pnl"] <= -15:
        return "NEVER_ARM_DEEP_RED"
    if s["mfe"] < 5 and -15 < s["pnl"] <= -5:
        return "NEVER_ARM_MILD_RED"
    if abs(s["pnl"]) <= 5:
        return "FLAT_SCRATCH"
    return "OTHER"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="data/milddip")
    ap.add_argument("--tol", type=int, default=120)
    ap.add_argument("--dump-trades", action="store_true")
    args = ap.parse_args()

    events = load_events(Path(args.dir))
    sessions = rebuild_sessions(events)
    dense = [s for s in sessions if s["n_marks"] >= 3]
    print(f"dense_sessions={len(dense)} by_leader={Counter(s['leader'] for s in dense)}")

    # Hold cluster probe (all flats, not only dense)
    holds = [
        o.get("heldSec")
        for o in events
        if o.get("kind") == "leader_session_flat" and o.get("heldSec") is not None
    ]
    near = sum(1 for h in holds if 8400 <= int(h) <= 8600)
    print(f"flats={len(holds)} held_in_[8400,8600]={near} ({100*near/max(1,len(holds)):.1f}%)")

    if args.dump_trades:
        for i, s in enumerate(sorted(dense, key=lambda x: (x["leader"], x["openedIso"] or "")), 1):
            print(
                f"\n#{i:02d} {s['leader']} {s['mint'][:12]} held={s['held']} "
                f"pnl={s['pnl']:+.1f} mfe={s['mfe']:+.1f} mae={s['mae']:+.1f} gap={s['gap']:+.1f} "
                f"arch={archetype(s)}"
            )
            for m in s["path"]:
                print(
                    f"  t={m['held']:>5} pnl={m['pnl']:+7.2f} mfe={m['mfe']:+7.2f} "
                    f"mae={m['mae']:+7.2f} gb_pp={m['gb_pp']:+7.2f}"
                )

    print("\n=== ARCHETYPES (dense) ===")
    c = Counter(archetype(s) for s in dense)
    for k, n in c.most_common():
        print(f"  {k}: {n}")

    rows = [s for s in dense if (s["held"] or 0) < 8000]
    print(f"\n=== RULE GRID dense held<8000 n={len(rows)} tol={args.tol}s ===")
    cands: list[tuple[float, float, str, dict]] = []

    for tp in (8, 10, 12, 15, 20, 25):
        r = eval_rule(rows, lambda m, p, i, tp=tp: m["pnl"] >= tp, args.tol)
        cands.append((r["hit"], -r["early"], f"TP>={tp}", r))
    for sl in (12, 15, 20, 25, 30, 35, 40):
        r = eval_rule(rows, lambda m, p, i, sl=sl: m["pnl"] <= -sl, args.tol)
        cands.append((r["hit"], -r["early"], f"SL<=-{sl}", r))
    for arm in (5, 8, 10, 12):
        for gb in (3, 5, 8, 10, 12, 15):
            def pred(m, p, i, arm=arm, gb=gb):
                peak = max(x["mfe"] for x in p[: i + 1])
                return peak >= arm and m["gb_pp"] >= gb

            r = eval_rule(rows, pred, args.tol)
            cands.append((r["hit"], -r["early"], f"trail arm{arm}/gb{gb}", r))
        for frac in (0.3, 0.4, 0.5, 0.6, 0.7):
            def pred(m, p, i, arm=arm, frac=frac):
                peak = max(x["mfe"] for x in p[: i + 1])
                return peak >= arm and m["gb_pp"] >= frac * peak

            r = eval_rule(rows, pred, args.tol)
            cands.append((r["hit"], -r["early"], f"trail arm{arm}/frac{frac}", r))

    def or_trail_tp_sl(m, p, i):
        peak = max(x["mfe"] for x in p[: i + 1])
        if m["pnl"] >= 15:
            return True
        if peak >= 8 and m["gb_pp"] >= 0.5 * peak:
            return True
        if peak < 8 and m["pnl"] <= -25:
            return True
        return False

    r = eval_rule(rows, or_trail_tp_sl, args.tol)
    cands.append((r["hit"], -r["early"], "OR TP15 / trail8/frac0.5 / SL25", r))

    cands.sort(key=lambda x: (x[0], x[1]), reverse=True)
    print("TOP 20:")
    seen: set[str] = set()
    shown = 0
    for hit, neg_e, name, r in cands:
        if name in seen:
            continue
        seen.add(name)
        print(
            f"  hit={r['hit']:.0%} early={r['early']:.0%} never={r['never']:.0%} n={r['n']}  {name}"
        )
        shown += 1
        if shown >= 20:
            break

    print(
        "\nNOTE: hit%% = first-fire within tol of actual exit. "
        "Entry-quality formulas need high hit AND low early. "
        "If best hit stays ~15% with early~40%, there is no single % exit law in this tape."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
