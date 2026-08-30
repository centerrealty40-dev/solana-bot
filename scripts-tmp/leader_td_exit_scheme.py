#!/usr/bin/env python3
"""
Characterize TD-entry leader exit scheme:
- filter: non-green / TD classes only
- path PnL vs buy dex.priceUsd
- regime split: armed trail vs never-arm
- per-leader param fit for shared scheme
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass
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


def sane(p):
    return p is not None and -95 <= p <= 300


@dataclass
class Mk:
    held: float
    pnl: float
    mfe: float
    gb: float
    turn: float | None
    pc5m: float | None
    price: float


def load():
    buys, sells_by, marks_by = [], defaultdict(list), defaultdict(list)
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
                elif k == "leader_bag_mark":
                    marks_by[(o.get("leader"), o.get("mint"))].append(o)
    for k in sells_by:
        sells_by[k].sort(key=lambda x: x.get("blockTime") or 0)
    for k in marks_by:
        marks_by[k].sort(key=lambda x: x.get("tsMs") or 0)
    return buys, sells_by, marks_by


def build_sessions(buys, sells_by, marks_by):
    sessions = []
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
        if not entry:
            continue
        exitp = price_usd(sell)
        final = (exitp / entry - 1) * 100 if exitp else None
        if final is not None and not sane(final):
            final = None
        t0 = bt * 1000
        t1 = (sell.get("blockTime") or bt) * 1000 + 5000
        series = []
        peak = entry
        for m in marks_by.get(key, []):
            ts = m.get("tsMs") or 0
            if ts < t0 - 5000 or ts > t1:
                continue
            mark = price_usd(m)
            if not mark:
                continue
            pnl = (mark / entry - 1) * 100
            if not sane(pnl):
                continue
            if mark > peak:
                peak = mark
            mfe = (peak / entry - 1) * 100
            gb = (mark / peak - 1) * 100
            d = m.get("dex") or {}
            vol, liq = d.get("vol5m"), d.get("liq")
            td = m.get("turnDump") or {}
            turn = None
            if td.get("turn") is not None:
                turn = float(td["turn"])
            elif vol is not None and liq and liq > 0:
                turn = float(vol) / float(liq)
            series.append(
                Mk(
                    held=max(0, (ts - t0) / 1000),
                    pnl=pnl,
                    mfe=mfe,
                    gb=gb,
                    turn=turn,
                    pc5m=float(d["pc5m"]) if d.get("pc5m") is not None else None,
                    price=float(mark),
                )
            )
        if final is None and series:
            final = series[-1].pnl
        if final is None:
            continue
        sessions.append(
            {
                "leader": (b.get("leader") or "")[:8],
                "mint": (b.get("mint") or "")[:8],
                "cls": b.get("class"),
                "held": float((sell.get("blockTime") or 0) - bt),
                "final": final,
                "marks": series,
                "mfe": max((m.mfe for m in series), default=None),
                "mae": min((m.pnl for m in series), default=None),
                "exit_gb": series[-1].gb if series else None,
                "exit_pc": (sell.get("gates") or {}).get("pc5m")
                if (sell.get("gates") or {}).get("pc5m") is not None
                else (sell.get("dex") or {}).get("pc5m"),
                "exit_turn": (sell.get("dex") or {}).get("turnover5mLiq"),
            }
        )
    return sessions


def near(a, b, tol=3.0):
    return abs(a - b) < tol


def eval_on(ss, pred, tol=3.0):
    trig = expl = early = late = 0
    for s in ss:
        hit = pred(s)
        if hit is None:
            continue
        trig += 1
        d = hit - s["final"]
        if abs(d) < tol:
            expl += 1
        elif d > tol:
            early += 1  # rule exits higher than actual → would have been better / early vs their exit
        else:
            late += 1
    return {
        "n": len(ss),
        "trig": trig,
        "cover": trig / len(ss) if ss else 0,
        "expl": expl,
        "rate": expl / trig if trig else 0,
        "early": early,
        "late": late,
    }


def main():
    buys, sells_by, marks_by = load()
    sessions = build_sessions(buys, sells_by, marks_by)
    path = [s for s in sessions if len(s["marks"]) >= 3]
    print(f"sessions={len(sessions)} path={len(path)}")
    print("leaders", Counter(s["leader"] for s in sessions))
    print("path leaders", Counter(s["leader"] for s in path))

    # --- Endpoint: winners vs losers structure ---
    print("\n=== Endpoint winner scrape levels (held<10m, final>0) ===")
    short = [s for s in sessions if s["held"] < 600 and s["final"] > 0]
    print(
        f"n={len(short)} final50={pct([s['final'] for s in short],0.5):.1f} "
        f"p25={pct([s['final'] for s in short],0.25):.1f} p75={pct([s['final'] for s in short],0.75):.1f}"
    )
    for lo, hi in [(5, 10), (8, 12), (10, 15), (12, 18), (15, 25)]:
        n = sum(1 for s in short if lo <= s["final"] < hi)
        print(f"  final [{lo},{hi}): {n} ({100*n/len(short):.0f}%)")

    # --- Path regime split ---
    print("\n=== Path regime by MFE ===")
    for thr in [3, 5, 8, 10, 12, 15]:
        armed = [s for s in path if s["mfe"] is not None and s["mfe"] >= thr]
        never = [s for s in path if s["mfe"] is not None and s["mfe"] < thr]
        if not armed and not never:
            continue
        print(
            f"arm>={thr}: armed={len(armed)} win={sum(1 for s in armed if s['final']>0)/max(1,len(armed)):.2f} "
            f"final50={pct([s['final'] for s in armed],0.5):.1f} exit_gb50={pct([s['exit_gb'] for s in armed if s['exit_gb'] is not None],0.5)} | "
            f"never={len(never)} win={sum(1 for s in never if s['final']>0)/max(1,len(never)):.2f} "
            f"final50={pct([s['final'] for s in never],0.5) if never else None}"
        )

    # Exit giveback distribution for armed bags
    print("\n=== Armed (MFE>=8) exit giveback buckets ===")
    armed8 = [s for s in path if s["mfe"] is not None and s["mfe"] >= 8 and s["exit_gb"] is not None]
    for lo, hi, lab in [
        (-100, -20, "<=-20"),
        (-20, -15, "-20..-15"),
        (-15, -12, "-15..-12"),
        (-12, -10, "-12..-10"),
        (-10, -8, "-10..-8"),
        (-8, -5, "-8..-5"),
        (-5, -3, "-5..-3"),
        (-3, 0, "-3..0"),
        (0, 50, ">=0"),
    ]:
        n = sum(1 for s in armed8 if lo <= s["exit_gb"] < hi)
        print(f"  {lab}: {n} ({100*n/len(armed8):.0f}%)")
    print(
        f"exit_gb p50={pct([s['exit_gb'] for s in armed8],0.5):.1f} "
        f"p25={pct([s['exit_gb'] for s in armed8],0.25):.1f} "
        f"p75={pct([s['exit_gb'] for s in armed8],0.75):.1f}"
    )

    # --- Fit trail on armed subset only ---
    print("\n=== Trail fit on MFE>=arm subset (must explain their exit_gb) ===")
    for arm in [5, 8, 10, 12]:
        subset = [s for s in path if s["mfe"] is not None and s["mfe"] >= arm]
        best = None
        for gb in [5, 6, 8, 10, 12, 15, 18, 20]:

            def pred(s, arm=arm, gb=gb):
                for m in s["marks"]:
                    if m.mfe >= arm and m.gb <= -gb:
                        return m.pnl
                return None

            r = eval_on(subset, pred)
            score = r["rate"] * r["cover"]
            row = (score, r["rate"], r["cover"], r["trig"], r["expl"], gb)
            if best is None or row > best:
                best = row
        print(
            f"arm={arm} n={len(subset)} best gb={best[5]} "
            f"expl={best[1]*100:.0f}% cover={best[2]*100:.0f}% trig={best[3]} score={best[0]:.3f}"
        )

    # --- Never-arm exits: what fires? ---
    print("\n=== Never-arm (MFE<5) exit hypotheses ===")
    never = [s for s in path if s["mfe"] is not None and s["mfe"] < 5]
    print(f"n={len(never)} final50={pct([s['final'] for s in never],0.5):.1f} held50={pct([s['held'] for s in never],0.5):.0f}s")

    def grid_never(name, maker):
        best = None
        for params, pred in maker():
            r = eval_on(never, pred)
            score = r["rate"] * r["cover"]
            row = (score, r["rate"], r["cover"], r["trig"], r["expl"], r["early"], r["late"], params)
            if best is None or row[0] > best[0]:
                best = row
        print(
            f"{name}: best={best[7]} expl={best[1]*100:.0f}% cover={best[2]*100:.0f}% "
            f"trig={best[3]} early={best[5]} late={best[6]} score={best[0]:.3f}"
        )
        return best

    def maker_sl():
        for sl in [8, 10, 12, 15, 20, 25, 30, 40, 50]:

            def pred(s, sl=sl):
                for m in s["marks"]:
                    if m.pnl <= -sl:
                        return m.pnl
                return None

            yield f"SL{sl}", pred

    def maker_tp():
        for tp in [3, 5, 8, 10, 12, 15]:

            def pred(s, tp=tp):
                for m in s["marks"]:
                    if m.pnl >= tp:
                        return m.pnl
                return None

            yield f"TP{tp}", pred

    def maker_reclaim():
        for dump in [5, 8, 10, 12, 15]:
            for rec in [-2, 0, 2, 3, 5]:

                def pred(s, dump=dump, rec=rec):
                    seen = False
                    for m in s["marks"]:
                        if m.pnl <= -dump:
                            seen = True
                        if seen and m.pnl >= rec:
                            return m.pnl
                    return None

                yield f"d{dump}/r{rec}", pred

    def maker_bounce():
        for dump in [5, 8, 10, 12]:
            for bnc in [3, 5, 8, 10, 12]:

                def pred(s, dump=dump, bnc=bnc):
                    trough = None
                    trough_pnl = None
                    for m in s["marks"]:
                        if trough is None or m.price < trough:
                            trough = m.price
                            trough_pnl = m.pnl
                        if trough_pnl is None or trough_pnl > -dump:
                            continue
                        if (m.price / trough - 1) * 100 >= bnc:
                            return m.pnl
                    return None

                yield f"d{dump}/b{bnc}", pred

    def maker_pc():
        for thr in [0, 2, 5, 8, 10]:

            def pred(s, thr=thr):
                for m in s["marks"]:
                    if m.pc5m is not None and m.pc5m >= thr and m.held >= 30:
                        return m.pnl
                return None

            yield f"pc{thr}", pred

    def maker_turn_dead():
        for thr in [0.02, 0.05, 0.08, 0.1, 0.15, 0.2]:

            def pred(s, thr=thr):
                for m in s["marks"]:
                    if m.turn is not None and m.turn <= thr and m.held >= 60 and m.pnl < 0:
                        return m.pnl
                return None

            yield f"turn<={thr}", pred

    def maker_time():
        for sec in [180, 300, 600, 900, 1800, 3600]:

            def pred(s, sec=sec):
                for m in s["marks"]:
                    if m.held >= sec:
                        return m.pnl
                return None

            yield f"t{sec}", pred

    grid_never("SL", maker_sl)
    grid_never("TP", maker_tp)
    grid_never("reclaim", maker_reclaim)
    grid_never("bounce", maker_bounce)
    grid_never("pc5m", maker_pc)
    grid_never("turn_dead", maker_turn_dead)
    grid_never("time", maker_time)

    # --- Shared scheme: quickTP OR trail OR (optional SL) ---
    print("\n=== Shared scheme grid (all path) ===")
    rows = []
    for tp in [None, 8, 10, 12, 15, 20]:
        for arm in [5, 8, 10, 12]:
            for gb in [8, 10, 12, 15]:
                for sl in [None, 20, 25, 30, 40]:

                    def pred(s, tp=tp, arm=arm, gb=gb, sl=sl):
                        armed = False
                        for m in s["marks"]:
                            if tp is not None and m.pnl >= tp:
                                return m.pnl
                            if m.mfe >= arm:
                                armed = True
                            if armed and m.gb <= -gb:
                                return m.pnl
                            if sl is not None and m.pnl <= -sl:
                                return m.pnl
                        return None

                    r = eval_on(path, pred)
                    name = f"TP{tp}|a{arm}g{gb}|SL{sl}"
                    rows.append((r["rate"] * r["cover"], r, name, tp, arm, gb, sl))
    rows.sort(key=lambda x: -x[0])
    print("TOP shared by score:")
    for score, r, name, *_ in rows[:15]:
        print(
            f"  {name}: expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% "
            f"trig={r['trig']} early={r['early']} late={r['late']} score={score:.3f}"
        )
    rows2 = sorted(rows, key=lambda x: (-x[1]["rate"], -x[1]["cover"]))
    print("TOP shared by explain rate (trig>=40):")
    shown = 0
    for score, r, name, *_ in rows2:
        if r["trig"] < 40:
            continue
        print(
            f"  {name}: expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% "
            f"trig={r['trig']} early={r['early']} late={r['late']}"
        )
        shown += 1
        if shown >= 15:
            break

    # --- Per-leader independent fit of same scheme family ---
    print("\n=== Per-leader best TP|trail|SL ===")
    by = defaultdict(list)
    for s in path:
        by[s["leader"]].append(s)
    leader_best = {}
    for lead, ss in sorted(by.items()):
        best = None
        for tp in [None, 8, 10, 12, 15]:
            for arm in [5, 8, 10, 12, 15]:
                for gb in [6, 8, 10, 12, 15]:
                    for sl in [None, 20, 25, 30]:

                        def pred(s, tp=tp, arm=arm, gb=gb, sl=sl):
                            armed = False
                            for m in s["marks"]:
                                if tp is not None and m.pnl >= tp:
                                    return m.pnl
                                if m.mfe >= arm:
                                    armed = True
                                if armed and m.gb <= -gb:
                                    return m.pnl
                                if sl is not None and m.pnl <= -sl:
                                    return m.pnl
                            return None

                        r = eval_on(ss, pred)
                        # prefer high explain among decent coverage
                        score = r["rate"] * (0.5 + 0.5 * r["cover"])
                        row = (score, r, tp, arm, gb, sl)
                        if best is None or row[0] > best[0]:
                            best = row
        r = best[1]
        leader_best[lead] = best
        print(
            f"{lead}: TP{best[2]} a{best[3]}/g{best[4]} SL{best[5]} "
            f"expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% "
            f"trig={r['trig']}/{len(ss)} early={r['early']} late={r['late']}"
        )

    # --- Cross-check: if same scheme different params, how much do leaders differ? ---
    print("\n=== Fixed scheme family sensitivity ===")
    # trail-only (no TP no SL) — pure giveback after arm
    for arm, gb in [(5, 10), (8, 10), (8, 12), (10, 10), (10, 15), (12, 15)]:

        def pred(s, arm=arm, gb=gb):
            for m in s["marks"]:
                if m.mfe >= arm and m.gb <= -gb:
                    return m.pnl
            return None

        print(f"\ntrail a{arm}/g{gb}:")
        for lead, ss in sorted(by.items()):
            r = eval_on(ss, pred)
            print(
                f"  {lead}: expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% "
                f"trig={r['trig']}/{len(ss)}"
            )

    # Armed-only explain: among those who reached arm, does trail fire near exit?
    print("\n=== Conditional: among bags that reached arm, trail proximity to exit ===")
    for arm in [5, 8, 10]:
        for gb in [8, 10, 12, 15]:
            for lead, ss in sorted(by.items()):
                subset = [s for s in ss if s["mfe"] is not None and s["mfe"] >= arm]

                def pred(s, arm=arm, gb=gb):
                    for m in s["marks"]:
                        if m.mfe >= arm and m.gb <= -gb:
                            return m.pnl
                    return None

                r = eval_on(subset, pred)
                if lead == sorted(by.keys())[0]:
                    print(f"a{arm}/g{gb}:")
                print(
                    f"  {lead} armed={len(subset)} expl={r['rate']*100:.0f}% "
                    f"cover={r['cover']*100:.0f}% trig={r['trig']}"
                )

    # Endpoint implication for never-path sessions (no marks): hold×pnl
    print("\n=== All TD endpoint: quick green vs long bleed ===")
    for lead in sorted(set(s["leader"] for s in sessions)):
        ss = [s for s in sessions if s["leader"] == lead]
        q = [s for s in ss if s["held"] < 300]
        long = [s for s in ss if s["held"] >= 1800]
        print(
            f"{lead}: n={len(ss)} short<5m n={len(q)} win={sum(1 for s in q if s['final']>0)/max(1,len(q)):.2f} "
            f"pnl50={pct([s['final'] for s in q],0.5)} | "
            f"long>=30m n={len(long)} win={sum(1 for s in long if s['final']>0)/max(1,len(long)):.2f} "
            f"pnl50={pct([s['final'] for s in long],0.5)}"
        )

    out = {
        "n": len(sessions),
        "n_path": len(path),
        "leader_best": {
            k: {
                "tp": v[2],
                "arm": v[3],
                "gb": v[4],
                "sl": v[5],
                "expl": v[1]["rate"],
                "cover": v[1]["cover"],
                "trig": v[1]["trig"],
            }
            for k, v in leader_best.items()
        },
        "top_shared": [
            {"name": name, "expl": r["rate"], "cover": r["cover"], "trig": r["trig"], "score": score}
            for score, r, name, *_ in rows[:20]
        ],
    }
    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_scheme.json").write_text(json.dumps(out, indent=2))
    print("\nWrote artifacts/leader_td_exit_scheme.json")


if __name__ == "__main__":
    main()
