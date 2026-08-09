#!/usr/bin/env python3
"""Test whether pc5m-reclaim and/or bounce-from-entry are the shared TD exit trigger."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

DATA = Path("data/milddip")
MAX_HOLD = 6 * 3600
TD_CLASS = {"shallow", "mild_shallow", "mild_deep", "deep_knife", "rug_knife"}


def price_usd(o):
    if not o:
        return None
    p = o.get("dexPriceUsd") or o.get("exitPriceUsd") or o.get("markPriceUsd")
    if p is None:
        p = (o.get("dex") or {}).get("priceUsd")
    try:
        p = float(p) if p is not None else None
    except (TypeError, ValueError):
        return None
    return p if p and p > 0 else None


def is_td_buy(o):
    if o.get("class") == "green":
        return False
    g = o.get("gates") or {}
    td = o.get("turnDump") or {}
    if g.get("main") is True:
        return True
    if td.get("inMain") or td.get("inShallow") or td.get("branch") in ("main", "shallow"):
        return True
    return o.get("class") in TD_CLASS


def pct(xs, q):
    if not xs:
        return None
    s = sorted(xs)
    return s[int(q * (len(s) - 1))]


def main():
    buys, sells_by = [], defaultdict(list)
    for path in sorted(DATA.glob("leader-observer*.jsonl")):
        with open(path) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                k = o.get("kind")
                if k == "leader_buy_observed":
                    buys.append(o)
                elif k == "leader_sell_observed":
                    sells_by[(o.get("leader"), o.get("mint"))].append(o)
    for k in sells_by:
        sells_by[k].sort(key=lambda x: x.get("blockTime") or 0)

    rows = []
    for b in buys:
        if not is_td_buy(b) or b.get("isAdd"):
            continue
        key = (b.get("leader"), b.get("mint"))
        bt = b.get("blockTime") or 0
        if not bt:
            continue
        sell = None
        for s in sells_by.get(key, []):
            st = s.get("blockTime") or 0
            if st < bt:
                continue
            if st - bt > MAX_HOLD:
                break
            if s.get("isFlat") or s.get("tokenPostUi") == 0:
                sell = s
                break
        if not sell:
            continue
        entry = price_usd(b)
        exitp = price_usd(sell)
        if not entry or not exitp:
            continue
        final = (exitp / entry - 1) * 100
        if not (-95 <= final <= 300):
            continue
        eg = sell.get("gates") or {}
        ed = sell.get("dex") or {}
        bd = b.get("dex") or {}
        rows.append(
            {
                "leader": (b.get("leader") or "")[:8],
                "cls": b.get("class"),
                "held": float((sell.get("blockTime") or 0) - bt),
                "final": final,
                "entry_pc": (b.get("gates") or {}).get("pc5m")
                if (b.get("gates") or {}).get("pc5m") is not None
                else bd.get("pc5m"),
                "exit_pc": eg.get("pc5m") if eg.get("pc5m") is not None else ed.get("pc5m"),
                "exit_turn": ed.get("turnover5mLiq"),
                "exit_pc1h": eg.get("pc1h") if eg.get("pc1h") is not None else ed.get("pc1h"),
            }
        )

    print(f"n={len(rows)} leaders={Counter(r['leader'] for r in rows)}")

    # Hypothesis: winners exit with pc5m flipped green above threshold
    print("\n=== Exit pc5m by outcome ===")
    for lead in sorted(set(r["leader"] for r in rows)):
        for label, pred in [
            ("win_short", lambda r: r["held"] < 600 and r["final"] > 5),
            ("win_any", lambda r: r["final"] > 5),
            ("loss_any", lambda r: r["final"] < -5),
            ("loss_long", lambda r: r["held"] >= 1200 and r["final"] < -5),
        ]:
            arr = [r for r in rows if r["leader"] == lead and pred(r) and r["exit_pc"] is not None]
            if not arr:
                continue
            pcs = [r["exit_pc"] for r in arr]
            print(
                f"{lead} {label}: n={len(arr)} exit_pc50={pct(pcs,0.5):.2f} "
                f"p25={pct(pcs,0.25):.2f} p75={pct(pcs,0.75):.2f} "
                f"pc>0={sum(1 for p in pcs if p>0)/len(pcs):.2f} "
                f"pc>5={sum(1 for p in pcs if p>5)/len(pcs):.2f} "
                f"pc>10={sum(1 for p in pcs if p>10)/len(pcs):.2f}"
            )

    # Hypothesis: fixed TP from entry
    print("\n=== Final PnL clusters for short wins ===")
    for lead in sorted(set(r["leader"] for r in rows)):
        arr = [r for r in rows if r["leader"] == lead and r["held"] < 600 and r["final"] > 0]
        if not arr:
            continue
        finals = [r["final"] for r in arr]
        print(
            f"{lead}: n={len(arr)} final50={pct(finals,0.5):.1f} "
            f"p10={pct(finals,0.1):.1f} p90={pct(finals,0.9):.1f}"
        )
        for lo, hi in [(0, 5), (5, 10), (10, 15), (15, 20), (20, 30), (30, 50), (50, 200)]:
            n = sum(1 for x in finals if lo <= x < hi)
            print(f"  [{lo},{hi}): {n} ({100*n/len(arr):.0f}%)")

    # Delta pc: exit_pc - entry_pc
    print("\n=== pc5m delta (exit-entry) short wins ===")
    for lead in sorted(set(r["leader"] for r in rows)):
        arr = [
            r
            for r in rows
            if r["leader"] == lead
            and r["held"] < 600
            and r["final"] > 5
            and r["entry_pc"] is not None
            and r["exit_pc"] is not None
        ]
        if not arr:
            print(lead, "no paired pc")
            continue
        deltas = [r["exit_pc"] - r["entry_pc"] for r in arr]
        print(
            f"{lead}: n={len(arr)} dpc50={pct(deltas,0.5):.2f} "
            f"entry_pc50={pct([r['entry_pc'] for r in arr],0.5):.2f} "
            f"exit_pc50={pct([r['exit_pc'] for r in arr],0.5):.2f} "
            f"flip_to_pos={sum(1 for r in arr if r['entry_pc']<0<=r['exit_pc'])}/{len(arr)}"
        )

    # Reject time/stop: fraction of losses that would hit -15/-25/-50 before exit? endpoint only rough
    print("\n=== Loser hold vs final (no time-stop evidence) ===")
    for lead in sorted(set(r["leader"] for r in rows)):
        losses = [r for r in rows if r["leader"] == lead and r["final"] < -5]
        if not losses:
            continue
        print(
            f"{lead}: losses={len(losses)} held50={pct([r['held'] for r in losses],0.5):.0f}s "
            f"held90={pct([r['held'] for r in losses],0.9):.0f}s "
            f"final50={pct([r['final'] for r in losses],0.5):.1f} "
            f"held>30m={sum(1 for r in losses if r['held']>=1800)}/{len(losses)} "
            f"held>1h={sum(1 for r in losses if r['held']>=3600)}/{len(losses)}"
        )

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_pc_bounce.json").write_text(
        json.dumps({"n": len(rows), "by_leader": dict(Counter(r["leader"] for r in rows))}, indent=2)
    )


if __name__ == "__main__":
    main()
