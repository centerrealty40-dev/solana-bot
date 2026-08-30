#!/usr/bin/env python3
"""
Find LEADER loss-exit formula on TD entries only.
No hard time-stop as primary. Hunt metric combos at/near actual exit.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass
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


@dataclass
class Mk:
    held: float
    pnl: float
    mfe: float
    gb: float
    bounce: float
    pc5m: float | None
    pc1h: float | None
    turn: float | None
    vol5m: float | None
    liq: float | None
    buys5m: float | None
    sells5m: float | None


def load_loss_sessions():
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

    out = []
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
        # LOSS only: never meaningfully green OR finished red
        t0 = bt * 1000
        t1 = (sell.get("blockTime") or bt) * 1000
        series = []
        peak = entry
        trough = entry
        for m in marks.get(key, []):
            ts = m.get("tsMs") or 0
            if ts < t0 - 5000 or ts >= t1:
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
            g = m.get("gates") or {}
            turn = d.get("turnover5mLiq")
            if turn is None and d.get("vol5m") is not None and d.get("liq"):
                turn = float(d["vol5m"]) / float(d["liq"])
            pc = g.get("pc5m") if g.get("pc5m") is not None else d.get("pc5m")
            pc1h = g.get("pc1h") if g.get("pc1h") is not None else d.get("pc1h")
            series.append(
                Mk(
                    held=max(0, (ts - t0) / 1000),
                    pnl=pnl,
                    mfe=(peak / entry - 1) * 100,
                    gb=(mark / peak - 1) * 100,
                    bounce=(mark / trough - 1) * 100,
                    pc5m=float(pc) if pc is not None else None,
                    pc1h=float(pc1h) if pc1h is not None else None,
                    turn=float(turn) if turn is not None else None,
                    vol5m=float(d["vol5m"]) if d.get("vol5m") is not None else None,
                    liq=float(d["liq"]) if d.get("liq") is not None else None,
                    buys5m=float(d["buys5m"]) if d.get("buys5m") is not None else None,
                    sells5m=float(d["sells5m"]) if d.get("sells5m") is not None else None,
                )
            )
        if len(series) < 3:
            continue
        mfe = max(m.mfe for m in series)
        # loss bag: finished red AND never armed much
        if final >= -5:
            continue
        if mfe >= 8:
            # was green then died — separate bucket, keep labeled
            kind = "armed_then_lost"
        else:
            kind = "never_arm_loss"
        # entry features
        bd = b.get("dex") or {}
        bg = b.get("gates") or {}
        ed = sell.get("dex") or {}
        eg = sell.get("gates") or {}
        out.append(
            {
                "leader": (b.get("leader") or "")[:8],
                "mint": (b.get("mint") or "")[:8],
                "kind": kind,
                "final": final,
                "held": float((sell.get("blockTime") or 0) - bt),
                "mfe": mfe,
                "mae": min(m.pnl for m in series),
                "series": series,
                "entry_pc": bg.get("pc5m") if bg.get("pc5m") is not None else bd.get("pc5m"),
                "entry_turn": bd.get("turnover5mLiq"),
                "exit_pc": eg.get("pc5m") if eg.get("pc5m") is not None else ed.get("pc5m"),
                "exit_turn": ed.get("turnover5mLiq"),
                "exit_vol": ed.get("vol5m"),
                "exit_liq": ed.get("liq"),
            }
        )
    return out


def eval_rule(ss, step, time_tol=180.0, pnl_tol=5.0):
    hit = trig = early = 0
    for s in ss:
        st = {}
        fired = None
        for m in s["series"]:
            fire, st = step(m, st)
            if fire:
                fired = m
                break
        if fired is None:
            continue
        trig += 1
        dt = s["held"] - fired.held
        if (0 <= dt <= time_tol) or abs(fired.pnl - s["final"]) < pnl_tol:
            hit += 1
        elif dt > time_tol:
            early += 1
    n = len(ss)
    return dict(
        n=n,
        trig=trig,
        hit=hit,
        cover=hit / n if n else 0,
        prec=hit / trig if trig else 0,
        early=early,
        score=(hit / n if n else 0) * (0.4 + 0.6 * (hit / trig if trig else 0)),
    )


def fmt(name, r):
    return (
        f"{name}: hit={r['hit']}/{r['n']}({r['cover']*100:.0f}%) "
        f"trig={r['trig']} prec={r['prec']*100:.0f}% early={r['early']} score={r['score']:.3f}"
    )


def main():
    sessions = load_loss_sessions()
    by = defaultdict(list)
    for s in sessions:
        by[s["leader"]].append(s)
    print(f"loss path sessions={len(sessions)}", {k: len(v) for k, v in sorted(by.items())})
    print("kinds", Counter(s["kind"] for s in sessions))

    # Focus never-arm losses — the "went down" branch
    losses = [s for s in sessions if s["kind"] == "never_arm_loss"]
    print(f"\nnever_arm_loss n={len(losses)}")
    if not losses:
        return

    print("\n=== At EXIT mark (last pre-exit): metric snapshot ===")
    for lead in sorted(by):
        arr = [s for s in losses if s["leader"] == lead]
        if not arr:
            continue
        lasts = [s["series"][-1] for s in arr]
        print(f"\n{lead} n={len(arr)}")
        print(
            f"  pnl50={pct([m.pnl for m in lasts],0.5):.1f} "
            f"pc5m50={pct([m.pc5m for m in lasts],0.5)} "
            f"turn50={pct([m.turn for m in lasts],0.5)} "
            f"vol50={pct([m.vol5m for m in lasts],0.5)} "
            f"liq50={pct([m.liq for m in lasts],0.5)} "
            f"bounce50={pct([m.bounce for m in lasts],0.5):.1f} "
            f"held50={pct([m.held for m in lasts],0.5):.0f}"
        )
        # how often each critical flag true at exit
        flags = {
            "pnl<=-15": lambda m: m.pnl <= -15,
            "pnl<=-20": lambda m: m.pnl <= -20,
            "pnl<=-25": lambda m: m.pnl <= -25,
            "pc5m<=-5": lambda m: m.pc5m is not None and m.pc5m <= -5,
            "pc5m<=0": lambda m: m.pc5m is not None and m.pc5m <= 0,
            "pc5m is null": lambda m: m.pc5m is None,
            "turn<=0.05": lambda m: m.turn is not None and m.turn <= 0.05,
            "turn<=0.1": lambda m: m.turn is not None and m.turn <= 0.1,
            "vol<=500": lambda m: m.vol5m is not None and m.vol5m <= 500,
            "vol<=200": lambda m: m.vol5m is not None and m.vol5m <= 200,
            "vol==0": lambda m: m.vol5m is not None and m.vol5m <= 0,
            "sells>=buys": lambda m: m.sells5m is not None
            and m.buys5m is not None
            and m.sells5m >= m.buys5m,
            "bounce>=5 while red": lambda m: m.bounce >= 5 and m.pnl < 0,
            "bounce>=8 while red": lambda m: m.bounce >= 8 and m.pnl < 0,
        }
        for name, fn in flags.items():
            c = sum(1 for m in lasts if fn(m))
            print(f"  {name}: {c}/{len(arr)} ({100*c/len(arr):.0f}%)")

    # Combo prevalence at EXIT (what % of exits satisfy combo)
    print("\n=== EXIT-mark combo coverage (descriptive, not causal) ===")
    combos = [
        ("pnl<=-15 & pc<=-5", lambda m: m.pnl <= -15 and m.pc5m is not None and m.pc5m <= -5),
        ("pnl<=-15 & turn<=0.05", lambda m: m.pnl <= -15 and m.turn is not None and m.turn <= 0.05),
        ("pnl<=-15 & vol<=500", lambda m: m.pnl <= -15 and m.vol5m is not None and m.vol5m <= 500),
        ("pnl<=-20 & turn<=0.1", lambda m: m.pnl <= -20 and m.turn is not None and m.turn <= 0.1),
        ("pnl<=-15 & pc<=0 & turn<=0.1", lambda m: m.pnl <= -15 and m.pc5m is not None and m.pc5m <= 0 and m.turn is not None and m.turn <= 0.1),
        ("pnl<=-15 & (turn<=0.05 or vol<=200)", lambda m: m.pnl <= -15 and ((m.turn is not None and m.turn <= 0.05) or (m.vol5m is not None and m.vol5m <= 200))),
        ("pnl<=-20 & pc<=-5", lambda m: m.pnl <= -20 and m.pc5m is not None and m.pc5m <= -5),
        ("dead: turn<=0.05 & vol<=300 & pnl<0", lambda m: m.turn is not None and m.turn <= 0.05 and m.vol5m is not None and m.vol5m <= 300 and m.pnl < 0),
        ("failed bounce: bounce>=8 & pnl<=-10", lambda m: m.bounce >= 8 and m.pnl <= -10),
        ("pc null & pnl<=-20", lambda m: m.pc5m is None and m.pnl <= -20),
    ]
    for lead in ["ALL"] + sorted(by):
        arr = losses if lead == "ALL" else [s for s in losses if s["leader"] == lead]
        if not arr:
            continue
        print(f"\n{lead} n={len(arr)}")
        for name, fn in combos:
            c = sum(1 for s in arr if fn(s["series"][-1]))
            print(f"  {name}: {c}/{len(arr)} ({100*c/len(arr):.0f}%)")

    # Causal: first time combo becomes true — near exit?
    print("\n=== CAUSAL: first time combo true vs actual exit ===")
    rules = []

    def add(name, pred):
        def step(m, st, pred=pred):
            return pred(m), st

        rules.append((name, step))

    # metric combos WITHOUT held-time as required gate
    for sl in [12, 15, 18, 20, 25]:
        for pc in [None, 0, -2, -5, -8]:
            for turn in [None, 0.05, 0.08, 0.1, 0.15]:
                for vol in [None, 0, 100, 200, 500]:
                    # require at least one tape metric besides pnl
                    if pc is None and turn is None and vol is None:
                        continue

                    def pred(m, sl=sl, pc=pc, turn=turn, vol=vol):
                        if m.pnl > -sl:
                            return False
                        if pc is not None:
                            if m.pc5m is None or m.pc5m > pc:
                                return False
                        if turn is not None:
                            if m.turn is None or m.turn > turn:
                                return False
                        if vol is not None:
                            if m.vol5m is None or m.vol5m > vol:
                                return False
                        return True

                    label = f"pnl<=-{sl}"
                    if pc is not None:
                        label += f"&pc<={pc}"
                    if turn is not None:
                        label += f"&turn<={turn}"
                    if vol is not None:
                        label += f"&vol<={vol}"
                    add(label, pred)

    # durable pnl (no time) + tape
    for sl in [15, 20, 25]:
        for nmark in [2, 3, 4]:
            for turn in [None, 0.05, 0.1]:
                for pc in [None, 0, -5]:

                    def step(m, st, sl=sl, nmark=nmark, turn=turn, pc=pc):
                        ok = m.pnl <= -sl
                        if ok and turn is not None:
                            ok = m.turn is not None and m.turn <= turn
                        if ok and pc is not None:
                            ok = m.pc5m is not None and m.pc5m <= pc
                        st["c"] = st.get("c", 0) + 1 if ok else 0
                        return st["c"] >= nmark, st

                    label = f"DUR pnl<=-{sl}/n{nmark}"
                    if turn is not None:
                        label += f"&turn<={turn}"
                    if pc is not None:
                        label += f"&pc<={pc}"
                    rules.append((label, step))

    # failed bounce reclaim then still red
    for bnc in [5, 8, 10, 12]:
        for sl in [10, 15, 20]:

            def step(m, st, bnc=bnc, sl=sl):
                if m.bounce >= bnc:
                    st["b"] = True
                if st.get("b") and m.pnl <= -sl:
                    return True, st
                return False, st

            rules.append((f"FAILBNC b{bnc} then pnl<=-{sl}", step))

    # entry dump never recovers: pc stays red-ish and pnl deep
    for sl in [15, 20]:
        for pc in [-5, 0, 2]:

            def step(m, st, sl=sl, pc=pc):
                return m.pnl <= -sl and m.pc5m is not None and m.pc5m <= pc, st

            rules.append((f"stuck_red pnl<=-{sl}&pc<={pc}", step))

    print(f"rules={len(rules)}")

    def rank(ss, label, top=20):
        rows = []
        for name, step in rules:
            r = eval_rule(ss, step)
            r["name"] = name
            rows.append(r)
        rows.sort(key=lambda r: (-r["score"], -r["cover"], -r["prec"]))
        print(f"\n==== {label} TOP ====")
        for r in rows[:top]:
            if r["trig"] < 8:
                continue
            print(" ", fmt(r["name"], r))
        print(f"==== {label} best prec among cover>=40% ====")
        good = [r for r in rows if r["cover"] >= 0.40 and r["trig"] >= 10]
        good.sort(key=lambda r: (-r["prec"], -r["cover"]))
        for r in good[:12]:
            print(" ", fmt(r["name"], r))
        if not good:
            print("  (none)")
        return rows

    all_rows = rank(losses, "ALL never_arm_loss")
    for lead in sorted(by):
        arr = [s for s in losses if s["leader"] == lead]
        rank(arr, lead)

    # Explicitly reject pure time / pure SL for contrast
    print("\n=== REJECT baselines (for contrast) ===")
    baselines = []
    for sl in [15, 20, 25, 30]:

        def step(m, st, sl=sl):
            return m.pnl <= -sl, st

        baselines.append((f"PURE_SL{sl}", step))
    for t in [300, 600, 900, 1800]:

        def step(m, st, t=t):
            return m.held >= t and m.pnl < 0, st

        baselines.append((f"PURE_TRED{t}", step))
    for name, step in baselines:
        print(" ", fmt(name, eval_rule(losses, step)))

    Path("artifacts").mkdir(exist_ok=True)
    top = [
        {"name": r["name"], "cover": r["cover"], "prec": r["prec"], "hit": r["hit"], "trig": r["trig"]}
        for r in all_rows[:40]
    ]
    Path("artifacts/leader_td_loss_formula.json").write_text(json.dumps({"n": len(losses), "top": top}, indent=2))
    print("\nWrote artifacts/leader_td_loss_formula.json")


if __name__ == "__main__":
    main()
