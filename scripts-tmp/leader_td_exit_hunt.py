#!/usr/bin/env python3
"""
Hunt shared TD-entry exit scheme using:
1) endpoint features on all TD buy→flat sells
2) mark paths with PnL = dex.price / buy.dexPrice (ignore poisoned fill entry)
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

DATA = Path("data/milddip")
MAX_HOLD = 6 * 3600


def price_usd(o: dict | None) -> float | None:
    if not o:
        return None
    p = o.get("dexPriceUsd") or o.get("exitPriceUsd") or o.get("markPriceUsd")
    if p is None:
        d = o.get("dex") or {}
        p = d.get("priceUsd")
    try:
        p = float(p) if p is not None else None
    except (TypeError, ValueError):
        return None
    return p if p and p > 0 else None


def is_td_buy(o: dict) -> bool:
    if o.get("class") == "green":
        return False
    g = o.get("gates") or {}
    td = o.get("turnDump") or {}
    if g.get("main") is True:
        return True
    if td.get("inMain") or td.get("inShallow") or td.get("branch") in ("main", "shallow"):
        return True
    return o.get("class") in (
        "shallow",
        "mild_shallow",
        "mild_deep",
        "deep_knife",
        "rug_knife",
    )


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


def main():
    buys = []
    sells_by = defaultdict(list)
    marks_by = defaultdict(list)
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
        held = float((sell.get("blockTime") or 0) - bt)
        entry = price_usd(b)
        if not entry:
            continue
        exitp = price_usd(sell)
        final = None
        if exitp:
            final = (exitp / entry - 1) * 100
            if not sane(final):
                final = None

        # marks: ALWAYS pnl vs buy dex entry (ignore poisoned fill entryPriceUsd)
        t0, t1 = bt * 1000, (sell.get("blockTime") or bt) * 1000 + 5000
        series = []
        peak = entry
        for m in marks_by.get(key, []):
            ts = m.get("tsMs") or 0
            if ts < t0 - 5000 or ts > t1:
                continue
            d = m.get("dex") or {}
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
            vol = d.get("vol5m")
            liq = d.get("liq")
            turn = None
            td = m.get("turnDump") or {}
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

        eg = sell.get("gates") or {}
        etd = sell.get("turnDump") or {}
        btd = b.get("turnDump") or {}
        sessions.append(
            {
                "leader": (b.get("leader") or "")[:8],
                "mint": (b.get("mint") or "")[:8],
                "cls": b.get("class"),
                "branch": btd.get("branch")
                or ("main" if btd.get("inMain") or (b.get("gates") or {}).get("main") else b.get("class")),
                "held": held,
                "final": final,
                "entry_turn": btd.get("turn"),
                "entry_dump": btd.get("dump"),
                "entry_pc": (b.get("gates") or {}).get("pc5m"),
                "exit_pc": (eg.get("pc5m") if eg else None)
                if (eg and eg.get("pc5m") is not None)
                else (sell.get("dex") or {}).get("pc5m"),
                "exit_turn": etd.get("turn")
                if etd
                else (sell.get("dex") or {}).get("turnover5mLiq"),
                "exit_dump": etd.get("dump") if etd else None,
                "marks": series,
                "mfe_path": max((m.mfe for m in series), default=None),
                "mae_path": min((m.pnl for m in series), default=None),
                "exit_gb": series[-1].gb if series else None,
            }
        )

    print(f"sessions={len(sessions)} path>=3={sum(1 for s in sessions if len(s['marks'])>=3)}")
    print("leaders", Counter(s["leader"] for s in sessions))
    print("class", Counter(s["cls"] for s in sessions))

    # ---- Endpoint structure ----
    print("\n=== EXIT PnL buckets ===")
    finals = [s["final"] for s in sessions]
    for lo, hi, lab in [
        (-100, -20, "<=-20"),
        (-20, -10, "-20..-10"),
        (-10, -5, "-10..-5"),
        (-5, 0, "-5..0"),
        (0, 5, "0..5"),
        (5, 10, "5..10"),
        (10, 15, "10..15"),
        (15, 25, "15..25"),
        (25, 50, "25..50"),
        (50, 400, ">=50"),
    ]:
        n = sum(1 for p in finals if lo <= p < hi)
        print(f"  {lab}: {n} ({100*n/len(finals):.0f}%)")

    print("\n=== Hold buckets × outcome ===")
    for lo, hi, lab in [
        (0, 120, "<2m"),
        (120, 300, "2-5m"),
        (300, 600, "5-10m"),
        (600, 1200, "10-20m"),
        (1200, 1800, "20-30m"),
        (1800, 3600, "30-60m"),
        (3600, 100000, "1-6h"),
    ]:
        arr = [s for s in sessions if lo <= s["held"] < hi]
        if not arr:
            continue
        ps = [s["final"] for s in arr]
        print(
            f"{lab}: n={len(arr)} win={sum(1 for p in ps if p>0)/len(ps):.2f} "
            f"pnl50={pct(ps,0.5):.1f} pnl10={pct(ps,0.1):.1f} pnl90={pct(ps,0.9):.1f}"
        )

    # Short green exits: what exit_pc / exit_turn?
    print("\n=== Short winners held<3m final>+5: exit features ===")
    short_w = [s for s in sessions if s["held"] < 180 and s["final"] > 5]
    print("n", len(short_w))
    if short_w:
        print("final50", pct([s["final"] for s in short_w], 0.5))
        pcs = [s["exit_pc"] for s in short_w if s["exit_pc"] is not None]
        turns = [s["exit_turn"] for s in short_w if s["exit_turn"] is not None]
        print("exit_pc50", pct(pcs, 0.5), "n", len(pcs))
        print("exit_turn50", pct(turns, 0.5), "n", len(turns))

    print("\n=== Long losers held>=20m final<-5: exit features ===")
    long_l = [s for s in sessions if s["held"] >= 1200 and s["final"] < -5]
    print("n", len(long_l))
    if long_l:
        print("final50", pct([s["final"] for s in long_l], 0.5))
        pcs = [s["exit_pc"] for s in long_l if s["exit_pc"] is not None]
        turns = [s["exit_turn"] for s in long_l if s["exit_turn"] is not None]
        print("exit_pc50", pct(pcs, 0.5), "n", len(pcs))
        print("exit_turn50", pct(turns, 0.5), "n", len(turns))

    # Correlation: exit near +X?
    print("\n=== Do winners exit near round TP levels? ===")
    winners = [s for s in sessions if s["final"] > 0]
    for center, tol in [(5, 2), (8, 2), (10, 2.5), (12, 2.5), (15, 3), (20, 4)]:
        n = sum(1 for s in winners if abs(s["final"] - center) <= tol)
        print(f"  final in [{center-tol},{center+tol}]: {n}/{len(winners)} ({100*n/len(winners):.0f}%)")

    # ---- Path hypotheses on rich mark set ----
    path = [s for s in sessions if len(s["marks"]) >= 3]
    print(f"\n=== PATH n={len(path)} ===")
    if path:
        print(
            "mfe50",
            pct([s["mfe_path"] for s in path if s["mfe_path"] is not None], 0.5),
            "mae50",
            pct([s["mae_path"] for s in path if s["mae_path"] is not None], 0.5),
            "exit_gb50",
            pct([s["exit_gb"] for s in path if s["exit_gb"] is not None], 0.5),
        )

    def eval_rule(name, pred, min_trig=20):
        trig = expl = help_ = hurt = false_w = 0
        deltas = []
        for s in path:
            tp = pred(s)
            if tp is None:
                continue
            trig += 1
            d = tp - s["final"]
            deltas.append(d)
            if abs(d) < 3:
                expl += 1
            elif d > 3:
                help_ += 1
            else:
                hurt += 1
            if s["final"] >= 10 and tp < 5:
                false_w += 1
        rate = expl / trig if trig else 0
        cover = trig / len(path) if path else 0
        med = pct(deltas, 0.5) if deltas else 0
        flag = " **" if trig >= min_trig and rate >= 0.28 else ""
        print(
            f"{name}: trig={trig}/{len(path)} cover={cover*100:.0f}% "
            f"expl={expl}({rate*100:.0f}%) help={help_} hurt={hurt} falseW={false_w} "
            f"medΔ={med:.1f}{flag}"
        )
        return dict(
            name=name,
            trig=trig,
            cover=cover,
            rate=rate,
            expl=expl,
            help=help_,
            hurt=hurt,
            false_w=false_w,
            med=med,
            score=rate * cover / (1 + false_w / max(1, trig)),
        )

    results = []
    print("\n--- H2 arm+gb ---")
    for arm in [3, 5, 8, 10, 12, 15]:
        for gb in [3, 5, 6, 8, 10, 12, 15]:
            def pred(s, arm=arm, gb=gb):
                armed = False
                for m in s["marks"]:
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.gb <= -gb:
                        return m.pnl
                return None

            results.append(eval_rule(f"H2 a{arm}/g{gb}", pred))

    print("\n--- H14 a/g/sl ---")
    for arm in [3, 5, 8, 10]:
        for gb in [5, 8, 10, 12]:
            for sl in [12, 15, 20, 25, 30]:
                def pred(s, arm=arm, gb=gb, sl=sl):
                    armed = False
                    for m in s["marks"]:
                        if m.mfe >= arm:
                            armed = True
                        if armed and m.gb <= -gb:
                            return m.pnl
                        if (not armed) and m.pnl <= -sl:
                            return m.pnl
                    return None

                results.append(eval_rule(f"H14 a{arm}/g{gb}/sl{sl}", pred))

    print("\n--- H13 TP|SL ---")
    for tp in [5, 8, 10, 12, 15, 20, 25]:
        for sl in [10, 15, 20, 25, 30]:
            def pred(s, tp=tp, sl=sl):
                for m in s["marks"]:
                    if m.pnl >= tp or m.pnl <= -sl:
                        return m.pnl
                return None

            results.append(eval_rule(f"H13 TP{tp}|SL{sl}", pred))

    print("\n--- H5 reclaim ---")
    for dump in [5, 8, 10, 12]:
        for rec in [0, 2, 5, 8, 10]:
            def pred(s, dump=dump, rec=rec):
                seen = False
                for m in s["marks"]:
                    if m.pnl <= -dump:
                        seen = True
                    if seen and m.pnl >= rec:
                        return m.pnl
                return None

            results.append(eval_rule(f"H5 d{dump}/r{rec}", pred))

    print("\n--- H6 trough bounce ---")
    for dump in [5, 8, 10, 12]:
        for bnc in [3, 5, 8, 10]:
            def pred(s, dump=dump, bnc=bnc):
                trough = None
                trough_pnl = None
                for m in s["marks"]:
                    if trough is None or m.price < trough:
                        trough = m.price
                        trough_pnl = m.pnl
                    if trough is None or trough_pnl is None or trough_pnl > -dump:
                        continue
                    if (m.price / trough - 1) * 100 >= bnc:
                        return m.pnl
                return None

            results.append(eval_rule(f"H6 d{dump}/b{bnc}", pred))

    print("\n--- H7 time ---")
    for sec in [60, 120, 180, 300, 600, 900, 1800]:
        def pred(s, sec=sec):
            for m in s["marks"]:
                if m.held >= sec:
                    return m.pnl
            return None

        results.append(eval_rule(f"H7 t{sec}", pred))

    print("\n--- H11 pc5m ---")
    for thr in [0, 2, 5, 8, 10]:
        def pred(s, thr=thr):
            for m in s["marks"]:
                if m.pc5m is not None and m.pc5m >= thr and m.held >= 30:
                    return m.pnl
            return None

        results.append(eval_rule(f"H11 pc{thr}", pred))

    # Composite: quick TP OR (armed trail) OR (deep SL)
    print("\n--- H20 composite quickTP / trail / SL ---")
    for tp in [8, 10, 12, 15]:
        for arm, gb in [(5, 8), (5, 10), (8, 10), (8, 12)]:
            for sl in [20, 25, 30]:
                def pred(s, tp=tp, arm=arm, gb=gb, sl=sl):
                    armed = False
                    for m in s["marks"]:
                        if m.pnl >= tp:
                            return m.pnl
                        if m.mfe >= arm:
                            armed = True
                        if armed and m.gb <= -gb:
                            return m.pnl
                        if m.pnl <= -sl:
                            return m.pnl
                    return None

                results.append(eval_rule(f"H20 TP{tp}|a{arm}g{gb}|SL{sl}", pred))

    print("\n======== TOP by score ========")
    results.sort(key=lambda r: -r["score"])
    for r in results[:25]:
        if r["trig"] < 15:
            continue
        print(
            f"  score={r['score']:.3f} expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% "
            f"trig={r['trig']} falseW={r['false_w']} hurt={r['hurt']} | {r['name']}"
        )

    print("\n======== TOP by explain rate (trig>=25) ========")
    rr = [r for r in results if r["trig"] >= 25]
    rr.sort(key=lambda r: (-r["rate"], r["false_w"]))
    for r in rr[:20]:
        print(
            f"  expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% falseW={r['false_w']} "
            f"hurt={r['hurt']} | {r['name']}"
        )

    # Per leader for best few
    print("\n======== Per-leader top composites ========")
    # manually test a few strong structural candidates
    cands = [
        ("TP12|a5g10|SL25", 12, 5, 10, 25),
        ("TP10|a5g8|SL20", 10, 5, 8, 20),
        ("TP15|a5g10|SL25", 15, 5, 10, 25),
        ("TP10|a8g12|SL30", 10, 8, 12, 30),
        ("a5g10 else SL25", None, 5, 10, 25),
    ]
    by = defaultdict(list)
    for s in path:
        by[s["leader"]].append(s)

    for name, tp, arm, gb, sl in cands:
        print(f"\n{name}:")
        for lead, ss in sorted(by.items()):
            expl = trig = 0
            for s in ss:
                armed = False
                tp_hit = None
                for m in s["marks"]:
                    if tp is not None and m.pnl >= tp:
                        tp_hit = m.pnl
                        break
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.gb <= -gb:
                        tp_hit = m.pnl
                        break
                    if m.pnl <= -sl:
                        tp_hit = m.pnl
                        break
                if tp_hit is None:
                    continue
                trig += 1
                if abs(tp_hit - s["final"]) < 3:
                    expl += 1
            print(f"  {lead}: {expl}/{trig} ({100*expl/trig if trig else 0:.0f}%) of {len(ss)}")

    # Endpoint implication: short holds are +10..15 scrapes
    print("\n=== Hypothesis from endpoints ===")
    print(
        "Short TD exits (<3m) are almost always green ~+10-15% → bounce/TP scrape.\n"
        "Long TD holds (1-6h) flip to losing → no hard time-stop; they wait and often die.\n"
        "Shared scheme likely: TAKE-PROFIT / bounce-reclaim primary; wide or no SL; trail after arm."
    )

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_hunt.json").write_text(
        json.dumps(
            {
                "n": len(sessions),
                "n_path": len(path),
                "top": results[:40],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
