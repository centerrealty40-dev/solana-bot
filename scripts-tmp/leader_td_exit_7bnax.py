#!/usr/bin/env python3
"""Deep-dive 7BNax TD exits — trail fails, find their scheme."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

DATA = Path("data/milddip")
MAX_HOLD = 6 * 3600
LEAD = "7BNaxx6K"
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
    from_trough: float


def load_path():
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

    sessions = []
    for b in buys:
        if not is_td_buy(b) or b.get("isAdd"):
            continue
        if not (b.get("leader") or "").startswith(LEAD[:5]):
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
        trough = entry
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
            if mark < trough:
                trough = mark
            mfe = (peak / entry - 1) * 100
            gb = (mark / peak - 1) * 100
            from_trough = (mark / trough - 1) * 100
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
                    from_trough=from_trough,
                )
            )
        if final is None and series:
            final = series[-1].pnl
        if final is None or len(series) < 3:
            continue
        sessions.append(
            {
                "mint": (b.get("mint") or "")[:8],
                "cls": b.get("class"),
                "held": float((sell.get("blockTime") or 0) - bt),
                "final": final,
                "marks": series,
                "mfe": max(m.mfe for m in series),
                "mae": min(m.pnl for m in series),
                "exit_gb": series[-1].gb,
                "exit_from_trough": series[-1].from_trough,
                "exit_pc": (sell.get("gates") or {}).get("pc5m")
                if (sell.get("gates") or {}).get("pc5m") is not None
                else (sell.get("dex") or {}).get("pc5m"),
                "exit_turn": (sell.get("dex") or {}).get("turnover5mLiq"),
            }
        )
    return sessions


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
            early += 1
        else:
            late += 1
    return dict(
        n=len(ss),
        trig=trig,
        cover=trig / len(ss) if ss else 0,
        expl=expl,
        rate=expl / trig if trig else 0,
        early=early,
        late=late,
        score=(expl / trig if trig else 0) * (trig / len(ss) if ss else 0),
    )


def main():
    path = load_path()
    print(f"7BNax path sessions={len(path)}")
    print(
        "final50",
        pct([s["final"] for s in path], 0.5),
        "mfe50",
        pct([s["mfe"] for s in path], 0.5),
        "mae50",
        pct([s["mae"] for s in path], 0.5),
        "exit_gb50",
        pct([s["exit_gb"] for s in path], 0.5),
        "exit_from_trough50",
        pct([s["exit_from_trough"] for s in path], 0.5),
        "held50",
        pct([s["held"] for s in path], 0.5),
    )

    # Outcome clusters
    print("\n=== Clusters ===")
    for name, pred in [
        ("quick_win", lambda s: s["held"] < 600 and s["final"] > 5),
        ("armed_win", lambda s: s["mfe"] >= 8 and s["final"] > 0),
        ("armed_loss", lambda s: s["mfe"] >= 8 and s["final"] <= 0),
        ("never_loss", lambda s: s["mfe"] < 5 and s["final"] < 0),
        ("grind_win", lambda s: s["held"] >= 600 and s["final"] > 5),
    ]:
        arr = [s for s in path if pred(s)]
        if not arr:
            print(name, 0)
            continue
        print(
            f"{name}: n={len(arr)} final50={pct([s['final'] for s in arr],0.5):.1f} "
            f"mfe50={pct([s['mfe'] for s in arr],0.5):.1f} mae50={pct([s['mae'] for s in arr],0.5):.1f} "
            f"exit_gb50={pct([s['exit_gb'] for s in arr],0.5):.1f} "
            f"bounce50={pct([s['exit_from_trough'] for s in arr],0.5):.1f} "
            f"exit_pc50={pct([s['exit_pc'] for s in arr if s['exit_pc'] is not None],0.5)}"
        )

    results = []

    def add(name, pred):
        r = eval_on(path, pred)
        r["name"] = name
        results.append(r)
        flag = " **" if r["trig"] >= 20 and r["rate"] >= 0.35 else ""
        print(
            f"{name}: expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% "
            f"trig={r['trig']} early={r['early']} late={r['late']}{flag}"
        )

    print("\n--- H: bounce from trough ---")
    for dump in [3, 5, 8, 10, 12, 15]:
        for bnc in [3, 5, 8, 10, 12, 15, 20]:

            def pred(s, dump=dump, bnc=bnc):
                trough = None
                trough_pnl = None
                for m in s["marks"]:
                    if trough is None or m.price < trough:
                        trough = m.price
                        trough_pnl = m.pnl
                    if trough_pnl is None or trough_pnl > -dump:
                        continue
                    if m.from_trough >= bnc:
                        return m.pnl
                return None

            add(f"bounce d{dump}/b{bnc}", pred)

    print("\n--- H: reclaim after dump ---")
    for dump in [5, 8, 10, 12, 15]:
        for rec in [-5, -2, 0, 2, 5, 8]:

            def pred(s, dump=dump, rec=rec):
                seen = False
                for m in s["marks"]:
                    if m.pnl <= -dump:
                        seen = True
                    if seen and m.pnl >= rec:
                        return m.pnl
                return None

            add(f"reclaim d{dump}/r{rec}", pred)

    print("\n--- H: pc5m flip ---")
    for thr in [0, 2, 5, 8, 10, 15]:
        for min_held in [0, 30, 60, 120]:

            def pred(s, thr=thr, min_held=min_held):
                for m in s["marks"]:
                    if m.pc5m is not None and m.pc5m >= thr and m.held >= min_held:
                        return m.pnl
                return None

            add(f"pc{thr}@h{min_held}", pred)

    print("\n--- H: first green after red entry path ---")
    for thr in [0, 2, 5]:

        def pred(s, thr=thr):
            saw_red = False
            for m in s["marks"]:
                if m.pnl < -3:
                    saw_red = True
                if saw_red and m.pnl >= thr:
                    return m.pnl
            return None

        add(f"red_then_pnl>={thr}", pred)

    print("\n--- H: MFE then drop to near entry (breakeven stop) ---")
    for arm in [5, 8, 10, 12]:
        for band in [0, 2, 3, 5]:

            def pred(s, arm=arm, band=band):
                armed = False
                for m in s["marks"]:
                    if m.mfe >= arm:
                        armed = True
                    if armed and abs(m.pnl) <= band:
                        return m.pnl
                    if armed and m.pnl <= -band and band > 0:
                        # crossed back through entry
                        if m.pnl <= 0 and m.mfe >= arm:
                            return m.pnl
                return None

            add(f"BE arm{arm}/band{band}", pred)

    print("\n--- H: trail with wider/tighter ---")
    for arm in [3, 5, 8, 10]:
        for gb in [5, 8, 10, 15, 20, 25, 30]:

            def pred(s, arm=arm, gb=gb):
                armed = False
                for m in s["marks"]:
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.gb <= -gb:
                        return m.pnl
                return None

            add(f"trail a{arm}/g{gb}", pred)

    print("\n--- H: TP hard ---")
    for tp in [5, 8, 10, 12, 15, 20, 25]:

        def pred(s, tp=tp):
            for m in s["marks"]:
                if m.pnl >= tp:
                    return m.pnl
            return None

        add(f"TP{tp}", pred)

    print("\n--- H: SL hard ---")
    for sl in [10, 15, 20, 25, 30, 40]:

        def pred(s, sl=sl):
            for m in s["marks"]:
                if m.pnl <= -sl:
                    return m.pnl
            return None

        add(f"SL{sl}", pred)

    print("\n--- H: bounce OR trail ---")
    for dump, bnc in [(5, 5), (5, 8), (8, 5), (8, 8), (8, 10)]:
        for arm, gb in [(5, 10), (8, 10), (8, 15)]:

            def pred(s, dump=dump, bnc=bnc, arm=arm, gb=gb):
                trough = None
                trough_pnl = None
                armed = False
                for m in s["marks"]:
                    if trough is None or m.price < trough:
                        trough = m.price
                        trough_pnl = m.pnl
                    if trough_pnl is not None and trough_pnl <= -dump and m.from_trough >= bnc:
                        return m.pnl
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.gb <= -gb:
                        return m.pnl
                return None

            add(f"bounce d{dump}b{bnc}|trail a{arm}g{gb}", pred)

    print("\n--- H: pc OR trail ---")
    for thr in [2, 5, 8]:
        for arm, gb in [(5, 10), (8, 10), (8, 15)]:

            def pred(s, thr=thr, arm=arm, gb=gb):
                armed = False
                for m in s["marks"]:
                    if m.pc5m is not None and m.pc5m >= thr and m.held >= 30:
                        return m.pnl
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.gb <= -gb:
                        return m.pnl
                return None

            add(f"pc{thr}|trail a{arm}g{gb}", pred)

    print("\n======== TOP by score ========")
    results.sort(key=lambda r: -r["score"])
    for r in results[:25]:
        if r["trig"] < 15:
            continue
        print(
            f"  score={r['score']:.3f} expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% "
            f"trig={r['trig']} early={r['early']} late={r['late']} | {r['name']}"
        )

    print("\n======== TOP by expl rate trig>=25 ========")
    rr = [r for r in results if r["trig"] >= 25]
    rr.sort(key=lambda r: (-r["rate"], -r["cover"]))
    for r in rr[:20]:
        print(
            f"  expl={r['rate']*100:.0f}% cover={r['cover']*100:.0f}% "
            f"early={r['early']} late={r['late']} | {r['name']}"
        )

    # Manual: for winners, is exit closer to bounce-from-trough or giveback?
    wins = [s for s in path if s["final"] > 5]
    print(f"\n=== Winner anatomy n={len(wins)} ===")
    print(
        "exit_from_trough50",
        pct([s["exit_from_trough"] for s in wins], 0.5),
        "exit_gb50",
        pct([s["exit_gb"] for s in wins], 0.5),
        "mfe50",
        pct([s["mfe"] for s in wins], 0.5),
        "mae50",
        pct([s["mae"] for s in wins], 0.5),
        "final50",
        pct([s["final"] for s in wins], 0.5),
    )
    # Did they sell near local bounce peak (gb near 0 after bounce)?
    near_peak = sum(1 for s in wins if s["exit_gb"] is not None and s["exit_gb"] > -5)
    after_trough = sum(1 for s in wins if s["exit_from_trough"] is not None and s["exit_from_trough"] >= 5)
    print(f"exit near peak (gb>-5): {near_peak}/{len(wins)}")
    print(f"exit after >=5% bounce from trough: {after_trough}/{len(wins)}")

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_7bnax.json").write_text(
        json.dumps({"n": len(path), "top": results[:40]}, indent=2)
    )


if __name__ == "__main__":
    main()
