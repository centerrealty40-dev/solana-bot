#!/usr/bin/env python3
"""Anatomy of TD-entry losses + clarify dump-at-entry vs dump-after-entry."""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

DATA = Path("data/milddip")
MAX_HOLD = 6 * 3600
TD = {"shallow", "mild_shallow", "mild_deep", "deep_knife", "rug_knife"}


def price(o):
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


def pct(xs, q):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    s = sorted(xs)
    return s[int(q * (len(s) - 1))]


def is_td(o):
    if o.get("class") == "green":
        return False
    g = o.get("gates") or {}
    td = o.get("turnDump") or {}
    if g.get("main") is True:
        return True
    if td.get("inMain") or td.get("inShallow") or td.get("branch") in ("main", "shallow"):
        return True
    return o.get("class") in TD


def main():
    buys, sells, marks = [], defaultdict(list), defaultdict(list)
    for p in sorted(DATA.glob("leader-observer*.jsonl")):
        with open(p) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                k = o.get("kind")
                if k == "leader_buy_observed":
                    buys.append(o)
                elif k == "leader_sell_observed":
                    sells[(o.get("leader"), o.get("mint"))].append(o)
                elif k == "leader_bag_mark":
                    marks[(o.get("leader"), o.get("mint"))].append(o)
    for k in sells:
        sells[k].sort(key=lambda x: x.get("blockTime") or 0)
    for k in marks:
        marks[k].sort(key=lambda x: x.get("tsMs") or 0)

    ep_loss = defaultdict(list)
    ep_win = defaultdict(list)
    path_loss = defaultdict(list)

    for b in buys:
        if not is_td(b) or b.get("isAdd"):
            continue
        key = (b.get("leader"), b.get("mint"))
        bt = b.get("blockTime") or 0
        if not bt:
            continue
        sell = None
        for s in sells.get(key, []):
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
        entry = price(b)
        exitp = price(sell)
        if not entry or not exitp:
            continue
        final = (exitp / entry - 1) * 100
        if not (-95 <= final <= 300):
            continue
        lead = (b.get("leader") or "")[:8]
        held = float((sell.get("blockTime") or 0) - bt)
        bd = b.get("dex") or {}
        ed = sell.get("dex") or {}
        eg = sell.get("gates") or {}
        entry_pc = (b.get("gates") or {}).get("pc5m")
        if entry_pc is None:
            entry_pc = bd.get("pc5m")
        exit_pc = eg.get("pc5m") if eg.get("pc5m") is not None else ed.get("pc5m")
        exit_turn = ed.get("turnover5mLiq")
        row = {
            "final": final,
            "held": held,
            "entry_pc": entry_pc,
            "exit_pc": exit_pc,
            "exit_turn": exit_turn,
        }
        if final > 5:
            ep_win[lead].append(row)
        elif final < -5:
            ep_loss[lead].append(row)
        else:
            continue

        if final >= -5:
            continue

        t0 = bt * 1000
        t1 = (sell.get("blockTime") or bt) * 1000 + 5000
        series = []
        peak = entry
        trough = entry
        for m in marks.get(key, []):
            ts = m.get("tsMs") or 0
            if ts < t0 - 5000 or ts > t1:
                continue
            mark = price(m)
            if not mark:
                continue
            pnl = (mark / entry - 1) * 100
            if not (-95 <= pnl <= 300):
                continue
            if mark > peak:
                peak = mark
            if mark < trough:
                trough = mark
            d = m.get("dex") or {}
            series.append(
                {
                    "held": max(0, (ts - t0) / 1000),
                    "pnl": pnl,
                    "mfe": (peak / entry - 1) * 100,
                    "gb": (mark / peak - 1) * 100,
                    "bounce": (mark / trough - 1) * 100,
                    "price": mark,
                    "pc": d.get("pc5m"),
                    "turn": d.get("turnover5mLiq"),
                }
            )
        if len(series) < 3:
            continue

        def first_cross(thr):
            for x in series:
                if x["pnl"] <= thr:
                    return x["held"], x["pnl"]
            return None

        last = series[-1]
        late_up = False
        if len(series) >= 4:
            late_up = series[-1]["price"] > series[-4]["price"] and last["pnl"] < 0
        path_loss[lead].append(
            {
                "final": final,
                "held": held,
                "mfe": max(x["mfe"] for x in series),
                "mae": min(x["pnl"] for x in series),
                "exit_gb": last["gb"],
                "exit_bounce": last["bounce"],
                "max_bounce": max(x["bounce"] for x in series),
                "exit_pc": exit_pc,
                "exit_turn": exit_turn,
                "cross20": first_cross(-20),
                "cross30": first_cross(-30),
                "cross40": first_cross(-40),
                "late_up": late_up,
            }
        )

    print("=== ENTRY dump (pc5m at buy): wins vs losses ===")
    for lead in sorted(set(ep_win) | set(ep_loss)):
        wp = [r["entry_pc"] for r in ep_win[lead] if r["entry_pc"] is not None]
        lp = [r["entry_pc"] for r in ep_loss[lead] if r["entry_pc"] is not None]
        print(
            f"{lead}: wins={len(ep_win[lead])} entry_pc50={pct(wp,0.5)} | "
            f"losses={len(ep_loss[lead])} entry_pc50={pct(lp,0.5)}"
        )

    print("\n=== ENDPOINT losses ===")
    for lead, arr in sorted(ep_loss.items()):
        n = len(arr)
        print(f"\n{lead}: n={n}")
        print(
            f"  final50={pct([a['final'] for a in arr],0.5):.1f} "
            f"held50={pct([a['held'] for a in arr],0.5):.0f}s "
            f"held90={pct([a['held'] for a in arr],0.9):.0f}s"
        )
        print(f"  exit_pc50={pct([a['exit_pc'] for a in arr],0.5)}")
        print(f"  exit_turn50={pct([a['exit_turn'] for a in arr],0.5)}")
        for lo, hi, lab in [
            (-100, -50, "<=-50"),
            (-50, -30, "-50..-30"),
            (-30, -20, "-30..-20"),
            (-20, -10, "-20..-10"),
            (-10, -5, "-10..-5"),
        ]:
            c = sum(1 for a in arr if lo <= a["final"] < hi)
            print(f"  pnl {lab}: {c} ({100*c/n:.0f}%)")
        for lo, hi, lab in [
            (0, 300, "<5m"),
            (300, 900, "5-15m"),
            (900, 1800, "15-30m"),
            (1800, 3600, "30-60m"),
            (3600, 1e9, ">1h"),
        ]:
            c = sum(1 for a in arr if lo <= a["held"] < hi)
            print(f"  hold {lab}: {c} ({100*c/n:.0f}%)")

    print("\n=== PATH losses: exit mechanics ===")
    for lead, arr in sorted(path_loss.items()):
        n = len(arr)
        print(f"\n{lead}: path_losses={n}")
        print(
            f"  mfe50={pct([a['mfe'] for a in arr],0.5):.1f} "
            f"mae50={pct([a['mae'] for a in arr],0.5):.1f} "
            f"final50={pct([a['final'] for a in arr],0.5):.1f}"
        )
        print(f"  never meaningfully green (mfe<3): {sum(1 for a in arr if a['mfe']<3)}/{n}")
        print(f"  touched -20: {sum(1 for a in arr if a['cross20'])}/{n}")
        print(f"  touched -30: {sum(1 for a in arr if a['cross30'])}/{n}")
        print(f"  touched -40: {sum(1 for a in arr if a['cross40'])}/{n}")

        def after(cross_key, window):
            quick = slow = never = 0
            for a in arr:
                c = a[cross_key]
                if not c:
                    never += 1
                    continue
                if a["held"] - c[0] <= window:
                    quick += 1
                else:
                    slow += 1
            return quick, slow, never

        q, s, nv = after("cross20", 120)
        print(f"  after first -20: exit<=2m={q}, later={s}, never={nv}  (SL-like if quick high)")
        q, s, nv = after("cross30", 180)
        print(f"  after first -30: exit<=3m={q}, later={s}, never={nv}")
        q, s, nv = after("cross40", 180)
        print(f"  after first -40: exit<=3m={q}, later={s}, never={nv}")

        peakish_red = sum(1 for a in arr if a["exit_gb"] is not None and a["exit_gb"] > -5)
        print(f"  exit near local peak while red (gb>-5): {peakish_red}/{n}")
        print(f"  late_up into still-red exit: {sum(1 for a in arr if a['late_up'])}/{n}")
        print(
            f"  max_bounce50={pct([a['max_bounce'] for a in arr],0.5):.1f} "
            f"exit_bounce50={pct([a['exit_bounce'] for a in arr],0.5):.1f}"
        )
        turns = [a["exit_turn"] for a in arr if a["exit_turn"] is not None]
        if turns:
            print(
                f"  exit_turn50={pct(turns,0.5):.3f} "
                f"turn<0.05={sum(1 for t in turns if t < 0.05)}/{len(turns)}"
            )


if __name__ == "__main__":
    main()
