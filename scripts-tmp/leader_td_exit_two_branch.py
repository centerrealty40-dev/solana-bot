#!/usr/bin/env python3
"""
Two-branch TD exit formula hunt:
  UP:   bag went green (mfe>=arm) → trail / stall / pc-tp
  DOWN: never meaningfully green → threshold combination hunt

Score: fire within time_tol of actual exit OR pnl within pnl_tol.
"""
from __future__ import annotations

import itertools
import json
from collections import defaultdict
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
    price: float
    pnl: float
    mfe: float
    gb: float
    bounce: float
    pc5m: float | None
    turn: float | None
    vol5m: float | None
    liq: float | None
    pc1h: float | None


@dataclass
class Sess:
    leader: str
    held: float
    final: float
    marks: list
    entry: float
    exit_px: float


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
        held = float((sell.get("blockTime") or 0) - bt)
        t0 = bt * 1000
        t_exit = (sell.get("blockTime") or bt) * 1000
        series = []
        peak = entry
        trough = entry
        for m in marks.get(key, []):
            ts = m.get("tsMs") or 0
            if ts < t0 - 5000 or ts >= t_exit:
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
            turn = d.get("turnover5mLiq")
            if turn is None and d.get("vol5m") is not None and d.get("liq"):
                turn = float(d["vol5m"]) / float(d["liq"])
            series.append(
                Mk(
                    held=max(0, (ts - t0) / 1000),
                    price=float(mark),
                    pnl=pnl,
                    mfe=(peak / entry - 1) * 100,
                    gb=(mark / peak - 1) * 100,
                    bounce=(mark / trough - 1) * 100,
                    pc5m=float(d["pc5m"]) if d.get("pc5m") is not None else None,
                    turn=float(turn) if turn is not None else None,
                    vol5m=float(d["vol5m"]) if d.get("vol5m") is not None else None,
                    liq=float(d["liq"]) if d.get("liq") is not None else None,
                    pc1h=float(d["pc1h"]) if d.get("pc1h") is not None else None,
                )
            )
        if len(series) < 3:
            continue
        out.append(
            Sess(
                leader=(b.get("leader") or "")[:8],
                held=held,
                final=final,
                marks=series,
                entry=float(entry),
                exit_px=float(exitp),
            )
        )
    return out


def first_fire(s, step):
    st = {}
    for m in s.marks:
        fire, st = step(m, st, s)
        if fire:
            return m
    return None


def eval_on(ss, step, time_tol=180.0, pnl_tol=5.0):
    n = len(ss)
    if n == 0:
        return dict(n=0, hit=0, cover=0, trig=0, early=0, time_rate=0, pnl_rate=0, score=0)
    hit = trig = early = time_ok = pnl_ok = 0
    for s in ss:
        m = first_fire(s, step)
        if m is None:
            continue
        trig += 1
        dt = s.held - m.held
        t_ok = 0 <= dt <= time_tol
        p_ok = abs(m.pnl - s.final) < pnl_tol
        if t_ok:
            time_ok += 1
        if p_ok:
            pnl_ok += 1
        if t_ok or p_ok:
            hit += 1
        elif dt > time_tol:
            early += 1
    return dict(
        n=n,
        hit=hit,
        cover=hit / n,
        trig=trig,
        trig_rate=trig / n,
        early=early,
        time_rate=time_ok / trig if trig else 0,
        pnl_rate=pnl_ok / trig if trig else 0,
        precision=hit / trig if trig else 0,
        score=(hit / n) * (0.5 + 0.5 * (hit / trig if trig else 0)),
    )


def fmt(name, r):
    return (
        f"{name}: hit={r['hit']}/{r['n']}({r['cover']*100:.0f}%) "
        f"trig={r['trig']}({r['trig_rate']*100:.0f}%) prec={r['precision']*100:.0f}% "
        f"early={r['early']} time={r['time_rate']*100:.0f}% pnl={r['pnl_rate']*100:.0f}% "
        f"score={r['score']:.3f}"
    )


def split_up_down(ss, arm_gate=5.0):
    """UP = ever reached arm_gate MFE; DOWN = never."""
    up, down = [], []
    for s in ss:
        mfe = max(m.mfe for m in s.marks)
        if mfe >= arm_gate:
            up.append(s)
        else:
            down.append(s)
    return up, down


def hunt_up(ss, label):
    print(f"\n======== UP BRANCH {label} n={len(ss)} ========")
    if not ss:
        return None
    # descriptive
    egbs = []
    for s in ss:
        peak = max(m.price for m in s.marks)
        egbs.append((s.exit_px / peak - 1) * 100)
    print(
        f"  final50={pct([s.final for s in ss],0.5):.1f} "
        f"exit_gb_vs_prepeak50={pct(egbs,0.5):.1f} "
        f"mfe50={pct([max(m.mfe for m in s.marks) for s in ss],0.5):.1f}"
    )

    rows = []

    # classic trail
    for arm in [3, 5, 8, 10, 12, 15]:
        for gb in [3, 5, 6, 8, 10, 12, 15, 18, 20]:

            def step(m, st, s, arm=arm, gb=gb):
                if m.mfe >= arm:
                    st["a"] = True
                return bool(st.get("a")) and m.gb <= -gb, st

            r = eval_on(ss, step)
            rows.append((r["score"], r, f"trail a{arm}/g{gb}"))

    # trail from entry peak once armed, OR micro-trail after TP
    for arm in [5, 8, 10]:
        for gb in [5, 8, 10, 12, 15]:
            for tp in [None, 10, 12, 15, 20]:

                def step(m, st, s, arm=arm, gb=gb, tp=tp):
                    if tp is not None and m.pnl >= tp:
                        return True, st
                    if m.mfe >= arm:
                        st["a"] = True
                    return bool(st.get("a")) and m.gb <= -gb, st

                r = eval_on(ss, step)
                rows.append((r["score"], r, f"tp{tp}|trail a{arm}/g{gb}"))

    # stall after arm (no new high)
    for arm in [5, 8, 10]:
        for stall in [45, 60, 90, 120, 180, 240]:
            for min_pnl in [0, 5, 8, 10]:

                def step(m, st, s, arm=arm, stall=stall, min_pnl=min_pnl):
                    if m.mfe >= arm:
                        st["a"] = True
                    if m.price >= st.get("pk", s.entry) * 1.0001:
                        st["pk"] = m.price
                        st["pk_h"] = m.held
                    if st.get("a") and m.pnl >= min_pnl and (m.held - st.get("pk_h", 0)) >= stall:
                        return True, st
                    return False, st

                r = eval_on(ss, step)
                rows.append((r["score"], r, f"stall a{arm}/s{stall}/p{min_pnl}"))

    # giveback measured only after arm, with min mfe cushion
    for arm in [5, 8, 10, 12]:
        for gb in [5, 8, 10, 12, 15]:
            for min_pnl in [None, 0, 3, 5]:

                def step(m, st, s, arm=arm, gb=gb, min_pnl=min_pnl):
                    if m.mfe >= arm:
                        st["a"] = True
                    if not st.get("a"):
                        return False, st
                    if min_pnl is not None and m.pnl < min_pnl:
                        return False, st
                    return m.gb <= -gb, st

                r = eval_on(ss, step)
                rows.append((r["score"], r, f"trail+floor a{arm}/g{gb}/f{min_pnl}"))

    rows.sort(key=lambda x: (-x[0], -x[1]["cover"]))
    print("  TOP UP:")
    for _, r, name in rows[:15]:
        print("   ", fmt(name, r))
    # prefer high precision among cover>=40%
    good = [x for x in rows if x[1]["cover"] >= 0.40]
    good.sort(key=lambda x: (-x[1]["precision"], -x[1]["cover"]))
    print("  TOP UP cover>=40% by precision:")
    for _, r, name in good[:10]:
        print("   ", fmt(name, r))
    return rows[0] if rows else None


def hunt_down(ss, label):
    print(f"\n======== DOWN BRANCH {label} n={len(ss)} ========")
    if not ss:
        return None
    print(
        f"  final50={pct([s.final for s in ss],0.5):.1f} "
        f"held50={pct([s.held for s in ss],0.5):.0f}s "
        f"mae50={pct([min(m.pnl for m in s.marks) for s in ss],0.5):.1f}"
    )
    # feature snapshot at exit-1 mark
    lasts = [s.marks[-1] for s in ss]
    print(
        f"  at last mark: pnl50={pct([m.pnl for m in lasts],0.5):.1f} "
        f"pc5m50={pct([m.pc5m for m in lasts],0.5)} "
        f"turn50={pct([m.turn for m in lasts],0.5)} "
        f"vol5m50={pct([m.vol5m for m in lasts],0.5)} "
        f"held50={pct([m.held for m in lasts],0.5):.0f}"
    )

    rows = []

    # single thresholds
    for sl in [10, 12, 15, 18, 20, 22, 25, 30, 35, 40]:

        def step(m, st, s, sl=sl):
            return m.pnl <= -sl, st

        r = eval_on(ss, step)
        rows.append((r["score"], r, f"SL{sl}"))

    for tsec in [300, 600, 900, 1200, 1800, 2700, 3600]:

        def step(m, st, s, tsec=tsec):
            return m.held >= tsec and m.pnl < 0, st

        r = eval_on(ss, step)
        rows.append((r["score"], r, f"TRED t{tsec}"))

    for turn in [0.02, 0.05, 0.08, 0.1, 0.15, 0.2]:
        for min_held in [180, 300, 600, 900]:

            def step(m, st, s, turn=turn, min_held=min_held):
                return (
                    m.held >= min_held
                    and m.pnl < 0
                    and m.turn is not None
                    and m.turn <= turn
                ), st

            r = eval_on(ss, step)
            rows.append((r["score"], r, f"DEAD turn<={turn}/h{min_held}"))

    # combinations: (held>=T AND pnl<=-SL)
    for tsec in [180, 300, 600, 900, 1200, 1800]:
        for sl in [8, 10, 12, 15, 20, 25]:

            def step(m, st, s, tsec=tsec, sl=sl):
                return m.held >= tsec and m.pnl <= -sl, st

            r = eval_on(ss, step)
            rows.append((r["score"], r, f"HELD+SL t{tsec}/sl{sl}"))

    # (held>=T AND turn<=X AND pnl<=-SL)
    for tsec in [300, 600, 900, 1800]:
        for turn in [0.05, 0.1, 0.15, 0.2]:
            for sl in [10, 15, 20, 25]:

                def step(m, st, s, tsec=tsec, turn=turn, sl=sl):
                    if m.turn is None:
                        return False, st
                    return m.held >= tsec and m.turn <= turn and m.pnl <= -sl, st

                r = eval_on(ss, step)
                rows.append((r["score"], r, f"HELD+DEAD+SL t{tsec}/turn{turn}/sl{sl}"))

    # (held>=T AND pc5m<=P AND pnl<=-SL)
    for tsec in [300, 600, 900, 1800]:
        for pc in [-5, 0, 2, 5]:
            for sl in [10, 15, 20, 25]:

                def step(m, st, s, tsec=tsec, pc=pc, sl=sl):
                    if m.pc5m is None:
                        return False, st
                    return m.held >= tsec and m.pc5m <= pc and m.pnl <= -sl, st

                r = eval_on(ss, step)
                rows.append((r["score"], r, f"HELD+PC+SL t{tsec}/pc<={pc}/sl{sl}"))

    # vol dead: vol5m<=V and held and pnl
    for tsec in [300, 600, 900, 1800]:
        for vol in [0, 50, 100, 200, 500]:
            for sl in [10, 15, 20, 25]:

                def step(m, st, s, tsec=tsec, vol=vol, sl=sl):
                    if m.vol5m is None:
                        return False, st
                    return m.held >= tsec and m.vol5m <= vol and m.pnl <= -sl, st

                r = eval_on(ss, step)
                rows.append((r["score"], r, f"HELD+VOL+SL t{tsec}/vol<={vol}/sl{sl}"))

    # durable SL: pnl<=-sl for N consecutive marks (~65s each)
    for sl in [10, 15, 20, 25]:
        for nmark in [2, 3, 4, 5]:

            def step(m, st, s, sl=sl, nmark=nmark):
                if m.pnl <= -sl:
                    st["c"] = st.get("c", 0) + 1
                else:
                    st["c"] = 0
                return st["c"] >= nmark, st

            r = eval_on(ss, step)
            rows.append((r["score"], r, f"DUR_SL sl{sl}/n{nmark}"))

    # mae deep then any bounce fail back under threshold
    for dump in [15, 20, 25, 30]:
        for rec in [-10, -5, 0]:

            def step(m, st, s, dump=dump, rec=rec):
                if m.pnl <= -dump:
                    st["d"] = True
                if st.get("d") and m.pnl >= rec:
                    st["r"] = True
                if st.get("r") and m.pnl <= -dump:
                    return True, st
                if m.pnl <= -(dump + 10):
                    return True, st
                return False, st

            r = eval_on(ss, step)
            rows.append((r["score"], r, f"FAILREC d{dump}/r{rec}"))

    # OR-combine best families: durable SL OR (held+dead)
    for sl, nmark in [(15, 3), (20, 2), (20, 3), (25, 2), (25, 3)]:
        for tsec, turn in [(600, 0.1), (900, 0.1), (1800, 0.05), (1800, 0.1)]:

            def step(m, st, s, sl=sl, nmark=nmark, tsec=tsec, turn=turn):
                if m.pnl <= -sl:
                    st["c"] = st.get("c", 0) + 1
                else:
                    st["c"] = 0
                if st["c"] >= nmark:
                    return True, st
                if (
                    m.held >= tsec
                    and m.pnl < 0
                    and m.turn is not None
                    and m.turn <= turn
                ):
                    return True, st
                return False, st

            r = eval_on(ss, step)
            rows.append((r["score"], r, f"DURSL|DEAD sl{sl}/n{nmark}|t{tsec}/turn{turn}"))

    # OR: held+sl OR dead
    for tsec, sl in [(300, 20), (600, 15), (600, 20), (900, 15), (900, 20), (1800, 15)]:
        for turn, th in [(0.05, 600), (0.1, 900), (0.1, 1800)]:

            def step(m, st, s, tsec=tsec, sl=sl, turn=turn, th=th):
                if m.held >= tsec and m.pnl <= -sl:
                    return True, st
                if m.held >= th and m.pnl < 0 and m.turn is not None and m.turn <= turn:
                    return True, st
                return False, st

            r = eval_on(ss, step)
            rows.append((r["score"], r, f"HELD_SL|DEAD t{tsec}/sl{sl}|dead{th}/{turn}"))

    rows.sort(key=lambda x: (-x[0], -x[1]["cover"]))
    print("  TOP DOWN:")
    for _, r, name in rows[:20]:
        print("   ", fmt(name, r))
    good = [x for x in rows if x[1]["cover"] >= 0.40]
    good.sort(key=lambda x: (-x[1]["precision"], -x[1]["cover"]))
    print("  TOP DOWN cover>=40% by precision:")
    for _, r, name in good[:12]:
        print("   ", fmt(name, r))

    # feature thresholds at actual exit mark (what critical combo looks like)
    print("  EXIT-mark empirical thresholds (DOWN):")
    pnls = [m.pnl for m in lasts]
    turns = [m.turn for m in lasts if m.turn is not None]
    pcs = [m.pc5m for m in lasts if m.pc5m is not None]
    vols = [m.vol5m for m in lasts if m.vol5m is not None]
    helds = [m.held for m in lasts]
    print(
        f"    pnl p50/p75={pct(pnls,0.5):.1f}/{pct(pnls,0.75):.1f} "
        f"turn p50={pct(turns,0.5)} pc p50={pct(pcs,0.5)} "
        f"vol p50={pct(vols,0.5)} held p50={pct(helds,0.5):.0f}"
    )
    return rows[0] if rows else None


def main():
    sessions = load()
    by = defaultdict(list)
    for s in sessions:
        by[s.leader].append(s)
    print(f"sessions={len(sessions)}", {k: len(v) for k, v in sorted(by.items())})

    summary = {}
    for arm_gate in [3, 5, 8]:
        print(f"\n\n##### SPLIT arm_gate={arm_gate} #####")
        up_all, down_all = split_up_down(sessions, arm_gate)
        print(f"ALL up={len(up_all)} down={len(down_all)}")
        hunt_up(up_all, f"ALL/arm{arm_gate}")
        hunt_down(down_all, f"ALL/arm{arm_gate}")
        for lead, ss in sorted(by.items()):
            up, down = split_up_down(ss, arm_gate)
            print(f"\n--- {lead} arm{arm_gate} up={len(up)} down={len(down)} ---")
            bu = hunt_up(up, f"{lead}/arm{arm_gate}")
            bd = hunt_down(down, f"{lead}/arm{arm_gate}")
            summary[f"{lead}/arm{arm_gate}"] = {
                "up_n": len(up),
                "down_n": len(down),
                "best_up": bu[2] if bu else None,
                "best_up_cover": bu[1]["cover"] if bu else None,
                "best_down": bd[2] if bd else None,
                "best_down_cover": bd[1]["cover"] if bd else None,
            }

    # Cross-check: full two-branch policy with best-looking params
    print("\n\n======== COMPOSE two-branch policies ========")
    policies = [
        # name, arm_gate, up_rule, down_rule
        ("trail8/12 + held600/sl20", 5, ("trail", 8, 12), ("held_sl", 600, 20)),
        ("trail5/10 + held600/sl20", 5, ("trail", 5, 10), ("held_sl", 600, 20)),
        ("trail8/15 + dursl20/3", 5, ("trail", 8, 15), ("dursl", 20, 3)),
        ("trail10/15 + held900/sl15", 5, ("trail", 10, 15), ("held_sl", 900, 15)),
        ("stall8/120/5 + held600/sl20", 5, ("stall", 8, 120, 5), ("held_sl", 600, 20)),
        ("trail8/12 + dead900/0.1|sl20", 5, ("trail", 8, 12), ("dead_or_sl", 900, 0.1, 20)),
        ("trail5/8 + dursl15/3|dead1800/0.05", 5, ("trail", 5, 8), ("dursl_dead", 15, 3, 1800, 0.05)),
        ("tp12|trail8/12 + held600/sl20", 5, ("tp_trail", 12, 8, 12), ("held_sl", 600, 20)),
        ("trail8/15 + held1800/sl15", 8, ("trail", 8, 15), ("held_sl", 1800, 15)),
        ("stall5/90/8 + dursl20/2", 5, ("stall", 5, 90, 8), ("dursl", 20, 2)),
    ]

    def make_policy(arm_gate, up, down):
        def step(m, st, s):
            # track arm
            if m.mfe >= arm_gate:
                st["armed"] = True
            # UP rules only if armed
            if st.get("armed"):
                kind = up[0]
                if kind == "trail":
                    _, arm, gb = up
                    if m.mfe >= arm and m.gb <= -gb:
                        return True, st
                elif kind == "stall":
                    _, arm, stall, min_pnl = up
                    if m.price >= st.get("pk", s.entry) * 1.0001:
                        st["pk"] = m.price
                        st["pk_h"] = m.held
                    if m.mfe >= arm and m.pnl >= min_pnl and (m.held - st.get("pk_h", 0)) >= stall:
                        return True, st
                elif kind == "tp_trail":
                    _, tp, arm, gb = up
                    if m.pnl >= tp:
                        return True, st
                    if m.mfe >= arm and m.gb <= -gb:
                        return True, st
            else:
                # DOWN rules only if never armed
                kind = down[0]
                if kind == "held_sl":
                    _, tsec, sl = down
                    if m.held >= tsec and m.pnl <= -sl:
                        return True, st
                elif kind == "dursl":
                    _, sl, nmark = down
                    if m.pnl <= -sl:
                        st["c"] = st.get("c", 0) + 1
                    else:
                        st["c"] = 0
                    if st["c"] >= nmark:
                        return True, st
                elif kind == "dead_or_sl":
                    _, th, turn, sl = down
                    if m.pnl <= -sl:
                        return True, st
                    if m.held >= th and m.pnl < 0 and m.turn is not None and m.turn <= turn:
                        return True, st
                elif kind == "dursl_dead":
                    _, sl, nmark, th, turn = down
                    if m.pnl <= -sl:
                        st["c"] = st.get("c", 0) + 1
                    else:
                        st["c"] = 0
                    if st["c"] >= nmark:
                        return True, st
                    if m.held >= th and m.pnl < 0 and m.turn is not None and m.turn <= turn:
                        return True, st
            return False, st

        return step

    for name, arm_gate, up, down in policies:
        step = make_policy(arm_gate, up, down)
        print(f"\nPOLICY {name}:")
        r = eval_on(sessions, step)
        print("  ALL", fmt("ALL", r))
        for lead, ss in sorted(by.items()):
            # side coverage
            up_ss, down_ss = split_up_down(ss, arm_gate)
            ru = eval_on(up_ss, step)
            rd = eval_on(down_ss, step)
            print(f"  {lead} ALL", fmt("", eval_on(ss, step)))
            print(f"  {lead} UP ", fmt("", ru))
            print(f"  {lead} DN ", fmt("", rd))

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_two_branch.json").write_text(json.dumps(summary, indent=2))
    print("\nWrote artifacts/leader_td_exit_two_branch.json")


if __name__ == "__main__":
    main()
