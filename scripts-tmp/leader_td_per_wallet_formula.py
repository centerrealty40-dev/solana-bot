#!/usr/bin/env python3
"""
Fit TWO separate TD exit formulas — one per leader wallet.
Maximize explain of actual flat exits (time or pnl proximity).
Split UP (armed) / DOWN (never-arm) inside each wallet.
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

DATA = Path("data/milddip")
MAX_HOLD = 6 * 3600
TD = {"shallow", "mild_shallow", "mild_deep", "deep_knife", "rug_knife"}
TIME_TOL = 180.0
PNL_TOL = 5.0


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
    turn: float | None
    vol5m: float | None
    price: float


def load():
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
        t0, t1 = bt * 1000, (sell.get("blockTime") or bt) * 1000
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
            series.append(
                Mk(
                    held=max(0, (ts - t0) / 1000),
                    pnl=pnl,
                    mfe=(peak / entry - 1) * 100,
                    gb=(mark / peak - 1) * 100,
                    bounce=(mark / trough - 1) * 100,
                    pc5m=float(pc) if pc is not None else None,
                    turn=float(turn) if turn is not None else None,
                    vol5m=float(d["vol5m"]) if d.get("vol5m") is not None else None,
                    price=float(mark),
                )
            )
        if len(series) < 3:
            continue
        mfe = max(m.mfe for m in series)
        out.append(
            {
                "leader": (b.get("leader") or "")[:8],
                "mint": (b.get("mint") or "")[:8],
                "final": final,
                "held": float((sell.get("blockTime") or 0) - bt),
                "mfe": mfe,
                "series": series,
            }
        )
    return out


def explained(s, fire_held, fire_pnl):
    dt = s["held"] - fire_held
    return (0 <= dt <= TIME_TOL) or abs(fire_pnl - s["final"]) < PNL_TOL


def eval_step(ss, step):
    hit = trig = early = 0
    for s in ss:
        st = {}
        fired = None
        for m in s["series"]:
            ok, st = step(m, st, s)
            if ok:
                fired = m
                break
        if fired is None:
            continue
        trig += 1
        if explained(s, fired.held, fired.pnl):
            hit += 1
        elif s["held"] - fired.held > TIME_TOL:
            early += 1
    n = len(ss)
    cover = hit / n if n else 0
    prec = hit / trig if trig else 0
    # maximize explained fraction of ALL trades in this bucket
    score = cover * (0.35 + 0.65 * prec)
    return dict(n=n, hit=hit, trig=trig, cover=cover, prec=prec, early=early, score=score)


def fit_up(ss, label):
    """UP = mfe reached arm_gate; fit trail/tp/stall."""
    print(f"\n===== {label} UP fit n={len(ss)} =====")
    if not ss:
        return None
    rows = []

    # trail
    for arm in [3, 5, 8, 10, 12, 15]:
        for gb in [5, 6, 8, 10, 12, 15, 18, 20]:

            def step(m, st, s, arm=arm, gb=gb):
                if m.mfe >= arm:
                    st["a"] = True
                return bool(st.get("a")) and m.gb <= -gb, st

            r = eval_step(ss, step)
            rows.append((r["score"], r, f"trail a{arm}/g{gb}", ("trail", arm, gb)))

    # tp | trail
    for tp in [8, 10, 12, 15, 20, 25]:
        for arm in [5, 8, 10, 12]:
            for gb in [8, 10, 12, 15]:

                def step(m, st, s, tp=tp, arm=arm, gb=gb):
                    if m.pnl >= tp:
                        return True, st
                    if m.mfe >= arm:
                        st["a"] = True
                    return bool(st.get("a")) and m.gb <= -gb, st

                r = eval_step(ss, step)
                rows.append((r["score"], r, f"tp{tp}|trail a{arm}/g{gb}", ("tp_trail", tp, arm, gb)))

    # stall after arm
    for arm in [5, 8, 10]:
        for stall in [45, 60, 90, 120, 180]:
            for min_pnl in [0, 5, 8, 10, 12]:

                def step(m, st, s, arm=arm, stall=stall, min_pnl=min_pnl):
                    if m.price >= st.get("pk", m.price) * 1.0001 or "pk" not in st:
                        if m.price >= st.get("pk", 0):
                            st["pk"] = m.price
                            st["pk_h"] = m.held
                    if m.mfe >= arm:
                        st["a"] = True
                    if st.get("a") and m.pnl >= min_pnl and (m.held - st.get("pk_h", 0)) >= stall:
                        return True, st
                    return False, st

                r = eval_step(ss, step)
                rows.append(
                    (r["score"], r, f"stall a{arm}/s{stall}/p{min_pnl}", ("stall", arm, stall, min_pnl))
                )

    # pc+tp into strength
    for pc in [2, 5, 8, 10]:
        for tp in [5, 8, 10, 12, 15]:

            def step(m, st, s, pc=pc, tp=tp):
                return m.pc5m is not None and m.pc5m >= pc and m.pnl >= tp and m.held >= 30, st

            r = eval_step(ss, step)
            rows.append((r["score"], r, f"pc{pc}&tp{tp}", ("pc_tp", pc, tp)))

    rows.sort(key=lambda x: (-x[0], -x[1]["cover"], -x[1]["prec"]))
    print("TOP UP:")
    for _, r, name, _ in rows[:12]:
        print(
            f"  {name}: hit={r['hit']}/{r['n']}({r['cover']*100:.0f}%) "
            f"trig={r['trig']} prec={r['prec']*100:.0f}% early={r['early']}"
        )
    # prefer high cover of the bucket
    by_cover = sorted(rows, key=lambda x: (-x[1]["cover"], -x[1]["prec"]))
    print("TOP UP by cover:")
    for _, r, name, _ in by_cover[:8]:
        print(
            f"  {name}: hit={r['hit']}/{r['n']}({r['cover']*100:.0f}%) "
            f"prec={r['prec']*100:.0f}% early={r['early']}"
        )
    best = rows[0]
    return {"name": best[2], "stats": best[1], "spec": best[3]}


def fit_down(ss, label):
    """DOWN = never reached arm_gate."""
    print(f"\n===== {label} DOWN fit n={len(ss)} =====")
    if not ss:
        return None
    rows = []

    # durable pnl + tape (NO held-time primary)
    for sl in [10, 12, 15, 18, 20, 25, 30]:
        for nmark in [1, 2, 3, 4]:
            for pc in [None, 2, 0, -2, -5, -8]:
                for turn in [None, 0.05, 0.08, 0.1, 0.15, 0.2]:
                    for vol in [None, 100, 200, 500, 1000]:
                        if pc is None and turn is None and vol is None and nmark == 1:
                            # pure SL allowed as baseline
                            pass

                        def step(m, st, s, sl=sl, nmark=nmark, pc=pc, turn=turn, vol=vol):
                            ok = m.pnl <= -sl
                            if ok and pc is not None:
                                ok = m.pc5m is not None and m.pc5m <= pc
                            if ok and turn is not None:
                                ok = m.turn is not None and m.turn <= turn
                            if ok and vol is not None:
                                ok = m.vol5m is not None and m.vol5m <= vol
                            st["c"] = st.get("c", 0) + 1 if ok else 0
                            return st["c"] >= nmark, st

                        label_r = f"DUR pnl<=-{sl}/n{nmark}"
                        if pc is not None:
                            label_r += f"&pc<={pc}"
                        if turn is not None:
                            label_r += f"&turn<={turn}"
                        if vol is not None:
                            label_r += f"&vol<={vol}"
                        r = eval_step(ss, step)
                        rows.append(
                            (
                                r["score"],
                                r,
                                label_r,
                                ("dur", sl, nmark, pc, turn, vol),
                            )
                        )

    # failed bounce
    for bnc in [5, 8, 10, 12, 15]:
        for sl in [8, 10, 12, 15, 20]:

            def step(m, st, s, bnc=bnc, sl=sl):
                if m.bounce >= bnc:
                    st["b"] = True
                return bool(st.get("b")) and m.pnl <= -sl, st

            r = eval_step(ss, step)
            rows.append((r["score"], r, f"FAILBNC b{bnc}->pnl<=-{sl}", ("failbnc", bnc, sl)))

    # bounce scrape while still trying (sell strength after dump) — rare on down but test
    for dump in [5, 8, 10]:
        for bnc in [5, 8, 10]:

            def step(m, st, s, dump=dump, bnc=bnc):
                if m.pnl <= -dump:
                    st["d"] = True
                return bool(st.get("d")) and m.bounce >= bnc, st

            r = eval_step(ss, step)
            rows.append((r["score"], r, f"reclaim d{dump}/b{bnc}", ("reclaim", dump, bnc)))

    # soft: pnl + sell pressure already in turn/vol; also pc-only stuck
    for sl in [12, 15, 20]:
        for pc in [0, -2, -5]:

            def step(m, st, s, sl=sl, pc=pc):
                return m.pnl <= -sl and m.pc5m is not None and m.pc5m <= pc, st

            r = eval_step(ss, step)
            rows.append((r["score"], r, f"stuck pnl<=-{sl}&pc<={pc}", ("stuck", sl, pc)))

    rows.sort(key=lambda x: (-x[0], -x[1]["cover"], -x[1]["prec"]))
    # filter absurd zero-trig
    rows = [x for x in rows if x[1]["trig"] >= max(5, int(0.15 * len(ss)))]
    print("TOP DOWN:")
    for _, r, name, _ in rows[:15]:
        print(
            f"  {name}: hit={r['hit']}/{r['n']}({r['cover']*100:.0f}%) "
            f"trig={r['trig']} prec={r['prec']*100:.0f}% early={r['early']}"
        )
    by_cover = sorted(rows, key=lambda x: (-x[1]["cover"], -x[1]["prec"]))
    print("TOP DOWN by cover:")
    for _, r, name, _ in by_cover[:10]:
        print(
            f"  {name}: hit={r['hit']}/{r['n']}({r['cover']*100:.0f}%) "
            f"prec={r['prec']*100:.0f}% early={r['early']}"
        )
    if not rows:
        return None
    best = rows[0]
    return {"name": best[2], "stats": best[1], "spec": best[3]}


def compose_wallet(ss, arm_gate, up_spec, down_spec):
    """Full policy score on all wallet TD sessions."""

    def step(m, st, s):
        if m.mfe >= arm_gate:
            st["armed"] = True
        if st.get("armed"):
            kind = up_spec[0]
            if kind == "trail":
                _, arm, gb = up_spec
                if m.mfe >= arm and m.gb <= -gb:
                    return True, st
            elif kind == "tp_trail":
                _, tp, arm, gb = up_spec
                if m.pnl >= tp:
                    return True, st
                if m.mfe >= arm and m.gb <= -gb:
                    return True, st
            elif kind == "stall":
                _, arm, stall, min_pnl = up_spec
                if m.price >= st.get("pk", 0):
                    st["pk"] = m.price
                    st["pk_h"] = m.held
                if m.mfe >= arm and m.pnl >= min_pnl and (m.held - st.get("pk_h", 0)) >= stall:
                    return True, st
            elif kind == "pc_tp":
                _, pc, tp = up_spec
                if m.pc5m is not None and m.pc5m >= pc and m.pnl >= tp and m.held >= 30:
                    return True, st
        else:
            kind = down_spec[0]
            if kind == "dur":
                _, sl, nmark, pc, turn, vol = down_spec
                ok = m.pnl <= -sl
                if ok and pc is not None:
                    ok = m.pc5m is not None and m.pc5m <= pc
                if ok and turn is not None:
                    ok = m.turn is not None and m.turn <= turn
                if ok and vol is not None:
                    ok = m.vol5m is not None and m.vol5m <= vol
                st["c"] = st.get("c", 0) + 1 if ok else 0
                if st["c"] >= nmark:
                    return True, st
            elif kind == "failbnc":
                _, bnc, sl = down_spec
                if m.bounce >= bnc:
                    st["b"] = True
                if st.get("b") and m.pnl <= -sl:
                    return True, st
            elif kind == "reclaim":
                _, dump, bnc = down_spec
                if m.pnl <= -dump:
                    st["d"] = True
                if st.get("d") and m.bounce >= bnc:
                    return True, st
            elif kind == "stuck":
                _, sl, pc = down_spec
                if m.pnl <= -sl and m.pc5m is not None and m.pc5m <= pc:
                    return True, st
        return False, st

    return eval_step(ss, step)


def main():
    sessions = load()
    by = defaultdict(list)
    for s in sessions:
        by[s["leader"]].append(s)
    print("TD path sessions", {k: len(v) for k, v in sorted(by.items())})

    report = {}
    for lead, ss in sorted(by.items()):
        print(f"\n\n########## WALLET {lead} n={len(ss)} ##########")
        best_wallet = None
        for arm_gate in [5, 8, 10]:
            up_ss = [s for s in ss if s["mfe"] >= arm_gate]
            down_ss = [s for s in ss if s["mfe"] < arm_gate]
            print(f"\n--- arm_gate={arm_gate} up={len(up_ss)} down={len(down_ss)} ---")
            up = fit_up(up_ss, f"{lead}/arm{arm_gate}")
            down = fit_down(down_ss, f"{lead}/arm{arm_gate}")
            if not up or not down:
                continue
            full = compose_wallet(ss, arm_gate, up["spec"], down["spec"])
            print(
                f"COMPOSE arm{arm_gate}: UP={up['name']} | DOWN={down['name']} -> "
                f"hit={full['hit']}/{full['n']}({full['cover']*100:.0f}%) "
                f"prec={full['prec']*100:.0f}% early={full['early']}"
            )
            # also score UP/DOWN covers separately under compose
            cand = {
                "arm_gate": arm_gate,
                "up": up,
                "down": down,
                "full": full,
            }
            if best_wallet is None or full["cover"] > best_wallet["full"]["cover"] or (
                full["cover"] == best_wallet["full"]["cover"]
                and full["prec"] > best_wallet["full"]["prec"]
            ):
                best_wallet = cand

        # refine: grid top UP x top DOWN around best arm
        print(f"\n===== REFINE {lead} =====")
        refine_best = best_wallet
        for arm_gate in [5, 8, 10]:
            up_ss = [s for s in ss if s["mfe"] >= arm_gate]
            down_ss = [s for s in ss if s["mfe"] < arm_gate]
            # collect top-5 up and top-5 down by cover*prec
            up_cands = []
            for arm in [5, 8, 10, 12]:
                for gb in [8, 10, 12, 15]:
                    for tp in [None, 10, 12, 15, 20]:
                        if tp is None:
                            spec = ("trail", arm, gb)
                            name = f"trail a{arm}/g{gb}"

                            def step(m, st, s, arm=arm, gb=gb):
                                if m.mfe >= arm:
                                    st["a"] = True
                                return bool(st.get("a")) and m.gb <= -gb, st

                        else:
                            spec = ("tp_trail", tp, arm, gb)
                            name = f"tp{tp}|trail a{arm}/g{gb}"

                            def step(m, st, s, tp=tp, arm=arm, gb=gb):
                                if m.pnl >= tp:
                                    return True, st
                                if m.mfe >= arm:
                                    st["a"] = True
                                return bool(st.get("a")) and m.gb <= -gb, st

                        r = eval_step(up_ss, step)
                        up_cands.append((r["cover"] * r["prec"], r, name, spec))
            up_cands.sort(key=lambda x: -x[0])
            down_cands = []
            for sl in [12, 15, 18, 20, 25]:
                for nmark in [2, 3, 4]:
                    for pc in [None, 0, -5]:
                        for turn in [None, 0.05, 0.1]:
                            for vol in [None, 200, 500]:
                                if pc is None and turn is None and vol is None:
                                    continue
                                spec = ("dur", sl, nmark, pc, turn, vol)
                                name = f"DUR -{sl}/n{nmark}"
                                if pc is not None:
                                    name += f"/pc{pc}"
                                if turn is not None:
                                    name += f"/t{turn}"
                                if vol is not None:
                                    name += f"/v{vol}"

                                def step(m, st, s, sl=sl, nmark=nmark, pc=pc, turn=turn, vol=vol):
                                    ok = m.pnl <= -sl
                                    if ok and pc is not None:
                                        ok = m.pc5m is not None and m.pc5m <= pc
                                    if ok and turn is not None:
                                        ok = m.turn is not None and m.turn <= turn
                                    if ok and vol is not None:
                                        ok = m.vol5m is not None and m.vol5m <= vol
                                    st["c"] = st.get("c", 0) + 1 if ok else 0
                                    return st["c"] >= nmark, st

                                r = eval_step(down_ss, step)
                                if r["trig"] < 5:
                                    continue
                                down_cands.append((r["cover"] * r["prec"], r, name, spec))
            for bnc, sl in [(8, 15), (10, 15), (12, 15), (8, 20), (12, 20)]:
                spec = ("failbnc", bnc, sl)
                name = f"FAILBNC b{bnc}/sl{sl}"

                def step(m, st, s, bnc=bnc, sl=sl):
                    if m.bounce >= bnc:
                        st["b"] = True
                    return bool(st.get("b")) and m.pnl <= -sl, st

                r = eval_step(down_ss, step)
                down_cands.append((r["cover"] * r["prec"], r, name, spec))
            down_cands.sort(key=lambda x: -x[0])

            for _, ur, uname, uspec in up_cands[:6]:
                for _, dr, dname, dspec in down_cands[:8]:
                    full = compose_wallet(ss, arm_gate, uspec, dspec)
                    if refine_best is None or full["cover"] > refine_best["full"]["cover"] or (
                        abs(full["cover"] - refine_best["full"]["cover"]) < 1e-9
                        and full["prec"] > refine_best["full"]["prec"]
                    ):
                        refine_best = {
                            "arm_gate": arm_gate,
                            "up": {"name": uname, "stats": ur, "spec": uspec},
                            "down": {"name": dname, "stats": dr, "spec": dspec},
                            "full": full,
                        }

        best_wallet = refine_best
        print(
            f"\n######## BEST {lead} ########\n"
            f"arm_gate={best_wallet['arm_gate']}\n"
            f"UP:   {best_wallet['up']['name']} "
            f"(bucket hit {best_wallet['up']['stats']['hit']}/{best_wallet['up']['stats']['n']} "
            f"prec {best_wallet['up']['stats']['prec']*100:.0f}%)\n"
            f"DOWN: {best_wallet['down']['name']} "
            f"(bucket hit {best_wallet['down']['stats']['hit']}/{best_wallet['down']['stats']['n']} "
            f"prec {best_wallet['down']['stats']['prec']*100:.0f}%)\n"
            f"FULL: hit={best_wallet['full']['hit']}/{best_wallet['full']['n']} "
            f"({best_wallet['full']['cover']*100:.0f}%) prec={best_wallet['full']['prec']*100:.0f}% "
            f"early={best_wallet['full']['early']}"
        )
        report[lead] = {
            "n": len(ss),
            "arm_gate": best_wallet["arm_gate"],
            "up": best_wallet["up"]["name"],
            "up_stats": best_wallet["up"]["stats"],
            "down": best_wallet["down"]["name"],
            "down_stats": best_wallet["down"]["stats"],
            "full": best_wallet["full"],
            "up_spec": best_wallet["up"]["spec"],
            "down_spec": best_wallet["down"]["spec"],
        }

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_per_wallet_formula.json").write_text(
        json.dumps(report, indent=2, default=str)
    )
    print("\nWrote artifacts/leader_td_per_wallet_formula.json")
    print("\n======== FINAL ========")
    for lead, r in sorted(report.items()):
        print(f"{lead}: arm>={r['arm_gate']}")
        print(f"  UP:   {r['up']}")
        print(f"  DOWN: {r['down']}")
        print(
            f"  FULL explain {r['full']['hit']}/{r['full']['n']} "
            f"({r['full']['cover']*100:.0f}%) prec={r['full']['prec']*100:.0f}%"
        )


if __name__ == "__main__":
    main()
