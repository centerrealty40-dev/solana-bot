#!/usr/bin/env python3
"""
Unified TD exit scheme hunt with better metrics:
1) pnl-proximity (±3%)
2) time-proximity (trigger within last 90s / last 2 marks)
3) winner anatomy per leader
4) shared bounce-scrape + optional trail
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
    from_trough: float


def load_sessions():
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
                    mfe=(peak / entry - 1) * 100,
                    gb=(mark / peak - 1) * 100,
                    turn=turn,
                    pc5m=float(d["pc5m"]) if d.get("pc5m") is not None else None,
                    price=float(mark),
                    from_trough=(mark / trough - 1) * 100,
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
                "exit_from_trough": series[-1].from_trough if series else None,
                "exit_pc": (sell.get("gates") or {}).get("pc5m")
                if (sell.get("gates") or {}).get("pc5m") is not None
                else (sell.get("dex") or {}).get("pc5m"),
                "exit_turn": (sell.get("dex") or {}).get("turnover5mLiq"),
            }
        )
    return sessions


def first_trigger(s, pred_mark_state):
    """pred_mark_state(m, state)-> (fire:bool, newstate). Return (held, pnl) or None."""
    state = {}
    for m in s["marks"]:
        fire, state = pred_mark_state(m, state)
        if fire:
            return m.held, m.pnl
    return None


def eval_rich(ss, pred_mark_state, tol_pnl=3.0, tol_time=90.0):
    trig = pnl_ok = time_ok = either = early = 0
    for s in ss:
        hit = first_trigger(s, pred_mark_state)
        if hit is None:
            continue
        held_hit, pnl_hit = hit
        trig += 1
        ok_p = abs(pnl_hit - s["final"]) < tol_pnl
        ok_t = (s["held"] - held_hit) <= tol_time
        if ok_p:
            pnl_ok += 1
        if ok_t:
            time_ok += 1
        if ok_p or ok_t:
            either += 1
        if pnl_hit - s["final"] > tol_pnl and not ok_t:
            early += 1
    n = len(ss)
    return {
        "n": n,
        "trig": trig,
        "cover": trig / n if n else 0,
        "pnl_rate": pnl_ok / trig if trig else 0,
        "time_rate": time_ok / trig if trig else 0,
        "either_rate": either / trig if trig else 0,
        "either_cover": either / n if n else 0,
        "early": early,
        "score": (either / trig if trig else 0) * (trig / n if n else 0),
    }


def main():
    sessions = load_sessions()
    path = [s for s in sessions if len(s["marks"]) >= 3]
    print(f"sessions={len(sessions)} path={len(path)}")

    by = defaultdict(list)
    for s in path:
        by[s["leader"]].append(s)

    print("\n=== Winner anatomy per leader (final>+5) ===")
    for lead, ss in sorted(by.items()):
        wins = [s for s in ss if s["final"] > 5]
        losses = [s for s in ss if s["final"] <= 0]
        print(f"\n{lead}: wins={len(wins)} losses={len(losses)}")
        if wins:
            print(
                f"  WIN final50={pct([s['final'] for s in wins],0.5):.1f} "
                f"mfe50={pct([s['mfe'] for s in wins],0.5):.1f} "
                f"mae50={pct([s['mae'] for s in wins],0.5):.1f} "
                f"exit_gb50={pct([s['exit_gb'] for s in wins],0.5):.1f} "
                f"bounce50={pct([s['exit_from_trough'] for s in wins],0.5):.1f} "
                f"held50={pct([s['held'] for s in wins],0.5):.0f}s "
                f"nearPeak(gb>-5)={sum(1 for s in wins if s['exit_gb'] is not None and s['exit_gb']>-5)}/{len(wins)} "
                f"bounce>=8={sum(1 for s in wins if (s['exit_from_trough'] or 0)>=8)}/{len(wins)}"
            )
        if losses:
            print(
                f"  LOSS final50={pct([s['final'] for s in losses],0.5):.1f} "
                f"mfe50={pct([s['mfe'] for s in losses],0.5):.1f} "
                f"mae50={pct([s['mae'] for s in losses],0.5):.1f} "
                f"exit_gb50={pct([s['exit_gb'] for s in losses],0.5):.1f} "
                f"held50={pct([s['held'] for s in losses],0.5):.0f}s "
                f"armed8={sum(1 for s in losses if (s['mfe'] or 0)>=8)}/{len(losses)}"
            )

    # Candidate family:
    # A) bounce-from-trough scrape (sell when bounce >= B after dump >= D)
    # B) trail after arm
    # C) A or B
    # D) sell when pnl>=TP (hard)
    # E) pc5m reclaim

    cands = []

    def reg(name, maker):
        cands.append((name, maker))

    for dump in [3, 5, 8]:
        for bnc in [5, 8, 10, 12, 15]:

            def maker(dump=dump, bnc=bnc):
                def step(m, st):
                    trough = st.get("trough")
                    trough_pnl = st.get("trough_pnl")
                    if trough is None or m.price < trough:
                        st["trough"] = m.price
                        st["trough_pnl"] = m.pnl
                        trough = m.price
                        trough_pnl = m.pnl
                    fire = trough_pnl is not None and trough_pnl <= -dump and m.from_trough >= bnc
                    return fire, st

                return step

            reg(f"bounce d{dump}/b{bnc}", maker)

    for arm in [5, 8, 10]:
        for gb in [8, 10, 12, 15]:

            def maker(arm=arm, gb=gb):
                def step(m, st):
                    if m.mfe >= arm:
                        st["armed"] = True
                    fire = bool(st.get("armed")) and m.gb <= -gb
                    return fire, st

                return step

            reg(f"trail a{arm}/g{gb}", maker)

    for tp in [8, 10, 12, 15]:

        def maker(tp=tp):
            def step(m, st):
                return m.pnl >= tp, st

            return step

        reg(f"TP{tp}", maker)

    for thr in [2, 5, 8]:

        def maker(thr=thr):
            def step(m, st):
                return (m.pc5m is not None and m.pc5m >= thr and m.held >= 30), st

            return step

        reg(f"pc{thr}", maker)

    # composites
    for dump, bnc in [(5, 8), (5, 10), (8, 8), (8, 10)]:
        for arm, gb in [(5, 10), (8, 10), (8, 12), (8, 15), (10, 15)]:

            def maker(dump=dump, bnc=bnc, arm=arm, gb=gb):
                def step(m, st):
                    trough = st.get("trough")
                    trough_pnl = st.get("trough_pnl")
                    if trough is None or m.price < trough:
                        st["trough"] = m.price
                        st["trough_pnl"] = m.pnl
                        trough_pnl = m.pnl
                    if m.mfe >= arm:
                        st["armed"] = True
                    bounce = trough_pnl is not None and trough_pnl <= -dump and m.from_trough >= bnc
                    trail = bool(st.get("armed")) and m.gb <= -gb
                    return bounce or trail, st

                return step

            reg(f"bounce d{dump}b{bnc}|trail a{arm}g{gb}", maker)

    # bounce then sell on first giveback from bounce peak (micro-trail after bounce)
    for dump, bnc in [(5, 8), (5, 10), (8, 10)]:
        for micro_gb in [3, 5, 8]:

            def maker(dump=dump, bnc=bnc, micro_gb=micro_gb):
                def step(m, st):
                    if st.get("trough") is None or m.price < st["trough"]:
                        st["trough"] = m.price
                        st["trough_pnl"] = m.pnl
                    # track peak after qualified bounce
                    if st.get("trough_pnl") is not None and st["trough_pnl"] <= -dump:
                        if m.from_trough >= bnc:
                            st["bounced"] = True
                    if st.get("bounced"):
                        bp = st.get("bounce_peak")
                        if bp is None or m.price > bp:
                            st["bounce_peak"] = m.price
                            bp = m.price
                        gb = (m.price / bp - 1) * 100
                        if gb <= -micro_gb:
                            return True, st
                    return False, st

                return step

            reg(f"bounceTrail d{dump}b{bnc}/mg{micro_gb}", maker)

    print("\n=== ALL PATH ranked by either-score ===")
    rows = []
    for name, maker in cands:
        r = eval_rich(path, maker())
        r["name"] = name
        rows.append(r)
    rows.sort(key=lambda r: (-r["score"], -r["either_rate"]))
    for r in rows[:20]:
        print(
            f"  {r['name']}: either={r['either_rate']*100:.0f}% cover={r['cover']*100:.0f}% "
            f"pnl={r['pnl_rate']*100:.0f}% time={r['time_rate']*100:.0f}% "
            f"trig={r['trig']} earlyBad={r['early']} score={r['score']:.3f}"
        )

    print("\n=== Per-leader best (either-score) ===")
    for lead, ss in sorted(by.items()):
        best = None
        for name, maker in cands:
            r = eval_rich(ss, maker())
            r["name"] = name
            if best is None or r["score"] > best["score"]:
                best = r
        print(
            f"{lead}: {best['name']} either={best['either_rate']*100:.0f}% "
            f"cover={best['cover']*100:.0f}% pnl={best['pnl_rate']*100:.0f}% "
            f"time={best['time_rate']*100:.0f}% trig={best['trig']}/{best['n']}"
        )
        # also show top 5
        ranked = []
        for name, maker in cands:
            r = eval_rich(ss, maker())
            r["name"] = name
            ranked.append(r)
        ranked.sort(key=lambda r: (-r["score"], -r["either_rate"]))
        for r in ranked[:8]:
            print(
                f"   {r['name']}: either={r['either_rate']*100:.0f}% cover={r['cover']*100:.0f}% "
                f"pnl={r['pnl_rate']*100:.0f}% time={r['time_rate']*100:.0f}% trig={r['trig']}"
            )

    # Endpoint corroboration: short winners cluster
    print("\n=== Endpoint short-winner exit_pc / final (no marks needed) ===")
    for lead in sorted(set(s["leader"] for s in sessions)):
        ss = [
            s
            for s in sessions
            if s["leader"] == lead and s["held"] < 600 and s["final"] > 5
        ]
        if not ss:
            continue
        print(
            f"{lead}: n={len(ss)} final50={pct([s['final'] for s in ss],0.5):.1f} "
            f"p25={pct([s['final'] for s in ss],0.25):.1f} p75={pct([s['final'] for s in ss],0.75):.1f} "
            f"exit_pc50={pct([s['exit_pc'] for s in ss if s['exit_pc'] is not None],0.5)}"
        )

    # Armed exit_gb modes per leader
    print("\n=== Armed MFE>=8 exit_gb modes ===")
    for lead, ss in sorted(by.items()):
        armed = [s for s in ss if (s["mfe"] or 0) >= 8 and s["exit_gb"] is not None]
        if not armed:
            continue
        peakish = sum(1 for s in armed if s["exit_gb"] > -5)
        trailish = sum(1 for s in armed if -18 <= s["exit_gb"] <= -8)
        print(
            f"{lead}: armed={len(armed)} peakish(gb>-5)={peakish}({100*peakish/len(armed):.0f}%) "
            f"trailish(-18..-8)={trailish}({100*trailish/len(armed):.0f}%) "
            f"gb50={pct([s['exit_gb'] for s in armed],0.5):.1f}"
        )

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_unified.json").write_text(
        json.dumps(
            {
                "n": len(sessions),
                "n_path": len(path),
                "top": rows[:30],
            },
            indent=2,
        )
    )
    print("\nWrote artifacts/leader_td_exit_unified.json")


if __name__ == "__main__":
    main()
