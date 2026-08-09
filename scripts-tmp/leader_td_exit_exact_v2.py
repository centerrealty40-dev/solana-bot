#!/usr/bin/env python3
"""
Exact formula v2:
- peak/gb for scoring uses marks STRICTLY before exit (no exit-as-peak artifact)
- test sell-into-strength: no new MFE for N sec while pnl>=TP
- test loss: first durable breach / reclaim-fail / trail0
"""
from __future__ import annotations

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


@dataclass
class Sess:
    leader: str
    held: float
    final: float
    marks: list  # before exit only
    exit_px: float
    entry: float

    @property
    def win(self):
        return self.final > 5

    @property
    def loss(self):
        return self.final < -5


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
            # strictly before exit block
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
                exit_px=float(exitp),
                entry=float(entry),
            )
        )
    return out


def pre_exit_features(s: Sess):
    """Features at last pre-exit mark + implied exit vs pre-peak."""
    last = s.marks[-1]
    peak = max(m.price for m in s.marks)
    # also track peak price chronologically
    peak = s.entry
    for m in s.marks:
        if m.price > peak:
            peak = m.price
    exit_pnl = s.final
    exit_gb_vs_prepeak = (s.exit_px / peak - 1) * 100 if peak > 0 else None
    return last, peak, exit_gb_vs_prepeak, exit_pnl


def first_fire(s, step):
    st = {}
    for m in s.marks:
        fire, st = step(m, st, s)
        if fire:
            return m
    return None


def eval_rule(ss, step, time_tol=180.0, pnl_tol=5.0):
    n = len(ss)
    trig = either = early = 0
    win_hit = win_n = loss_hit = loss_n = 0
    time_ok = pnl_ok = 0
    for s in ss:
        if s.win:
            win_n += 1
        if s.loss:
            loss_n += 1
        m = first_fire(s, step)
        if m is None:
            # allow fire on exit itself via virtual mark for rules that need exit touch
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
            either += 1
            if s.win:
                win_hit += 1
            if s.loss:
                loss_hit += 1
        elif dt > time_tol:
            early += 1
    return dict(
        n=n,
        trig=trig,
        cover=trig / n if n else 0,
        either_n=either,
        either_cover=either / n if n else 0,
        either_rate=either / trig if trig else 0,
        time_rate=time_ok / trig if trig else 0,
        pnl_rate=pnl_ok / trig if trig else 0,
        early=early,
        win_hit=win_hit,
        win_n=win_n,
        win_cov=win_hit / win_n if win_n else 0,
        loss_hit=loss_hit,
        loss_n=loss_n,
        loss_cov=loss_hit / loss_n if loss_n else 0,
        score=(either / n if n else 0)
        * (0.5 + 0.25 * (win_hit / win_n if win_n else 0) + 0.25 * (loss_hit / loss_n if loss_n else 0)),
    )


def fmt(r, name):
    return (
        f"{name}: hit={r['either_n']}/{r['n']}({r['either_cover']*100:.0f}%) "
        f"win={r['win_hit']}/{r['win_n']}({r['win_cov']*100:.0f}%) "
        f"loss={r['loss_hit']}/{r['loss_n']}({r['loss_cov']*100:.0f}%) "
        f"trig={r['trig']} early={r['early']} time={r['time_rate']*100:.0f}% "
        f"pnl={r['pnl_rate']*100:.0f}% score={r['score']:.3f}"
    )


def main():
    sessions = load()
    by = defaultdict(list)
    for s in sessions:
        by[s.leader].append(s)
    print(f"n={len(sessions)}", {k: len(v) for k, v in sorted(by.items())})

    # ---- Diagnostic: exit vs pre-exit peak (no artifact) ----
    print("\n=== Exit vs PRE-exit peak (true giveback at sell) ===")
    for lead, ss in sorted(by.items()):
        for label, pred in [("WIN", lambda s: s.win), ("LOSS", lambda s: s.loss)]:
            arr = [s for s in ss if pred(s)]
            gbs = []
            pnls = []
            mfes = []
            stalls = []  # seconds since last mfe update before exit
            for s in arr:
                last, peak, egb, _ = pre_exit_features(s)
                gbs.append(egb)
                pnls.append(s.final)
                mfes.append(last.mfe)
                # stall: time from last strict new peak to exit
                peak_h = None
                run_peak = s.entry
                for m in s.marks:
                    if m.price > run_peak * 1.0001:
                        run_peak = m.price
                        peak_h = m.held
                if peak_h is None:
                    peak_h = s.marks[0].held
                stalls.append(s.held - peak_h)
            print(
                f"{lead} {label}: n={len(arr)} exit_gb_vs_prepeak50={pct(gbs,0.5):.1f} "
                f"p25={pct(gbs,0.25):.1f} p75={pct(gbs,0.75):.1f} | "
                f"final50={pct(pnls,0.5):.1f} pre_mfe50={pct(mfes,0.5):.1f} "
                f"stall_sec50={pct(stalls,0.5):.0f}"
            )
            for lo, hi, lab in [
                (-100, -15, "gb<=-15"),
                (-15, -8, "-15..-8"),
                (-8, -3, "-8..-3"),
                (-3, 3, "-3..+3"),
                (3, 100, ">+3 (sold below? wait sold above prepeak)"),
            ]:
                c = sum(1 for x in gbs if x is not None and lo <= x < hi)
                print(f"   {lab}: {c} ({100*c/len(arr):.0f}%)")
            # sold ABOVE pre-peak means exit continued up through last marks
            above = sum(1 for x in gbs if x is not None and x > 3)
            near = sum(1 for x in gbs if x is not None and -3 <= x <= 3)
            below = sum(1 for x in gbs if x is not None and x < -3)
            print(f"   summary above/near/below prepeak: {above}/{near}/{below}")

    candidates = []

    # STRENGTH: pnl>=TP and no new peak for stall seconds (using marks)
    for tp in [5, 8, 10, 12, 15, 20]:
        for stall in [30, 60, 90, 120, 180, 300]:

            def maker(tp=tp, stall=stall):
                def step(m, st, s):
                    if m.price >= st.get("peak", s.entry) * 1.0001:
                        st["peak"] = m.price
                        st["peak_held"] = m.held
                    elif "peak" not in st:
                        st["peak"] = s.entry
                        st["peak_held"] = 0
                    if m.pnl >= tp and (m.held - st.get("peak_held", 0)) >= stall:
                        return True, st
                    return False, st

                return step

            candidates.append((f"STALL tp{tp}/s{stall}", maker()))

    # STRENGTH: pc5m>=X and pnl>=Y
    for pc in [2, 5, 8, 10, 15]:
        for tp in [5, 8, 10, 12, 15]:

            def maker(pc=pc, tp=tp):
                def step(m, st, s):
                    return (
                        m.pc5m is not None
                        and m.pc5m >= pc
                        and m.pnl >= tp
                        and m.held >= 30
                    ), st

                return step

            candidates.append((f"PC_TP pc{pc}/tp{tp}", maker()))

    # TRAIL with arm
    for arm in [0, 3, 5, 8, 10]:
        for gb in [5, 8, 10, 12, 15, 20, 25]:

            def maker(arm=arm, gb=gb):
                def step(m, st, s):
                    if arm == 0 or m.mfe >= arm:
                        st["a"] = True
                    return bool(st.get("a")) and m.gb <= -gb, st

                return step

            candidates.append((f"TRAIL a{arm}/g{gb}", maker()))

    # SL
    for sl in [10, 15, 20, 25, 30, 35, 40]:

        def maker(sl=sl):
            def step(m, st, s):
                return m.pnl <= -sl, st

            return step

        candidates.append((f"SL{sl}", maker()))

    # Combined: STALL/PC_TP for wins + SL for losses
    for tp in [8, 10, 12, 15]:
        for stall in [60, 120, 180]:
            for sl in [15, 20, 25, 30]:

                def maker(tp=tp, stall=stall, sl=sl):
                    def step(m, st, s):
                        if m.price >= st.get("peak", s.entry) * 1.0001:
                            st["peak"] = m.price
                            st["peak_held"] = m.held
                        elif "peak" not in st:
                            st["peak"] = s.entry
                            st["peak_held"] = 0
                        if m.pnl >= tp and (m.held - st.get("peak_held", 0)) >= stall:
                            return True, st
                        if m.pnl <= -sl:
                            return True, st
                        return False, st

                    return step

                candidates.append((f"STALL+SL tp{tp}/s{stall}/sl{sl}", maker()))

    for pc in [5, 8, 10]:
        for tp in [8, 10, 12]:
            for sl in [15, 20, 25, 30]:

                def maker(pc=pc, tp=tp, sl=sl):
                    def step(m, st, s):
                        if (
                            m.pc5m is not None
                            and m.pc5m >= pc
                            and m.pnl >= tp
                            and m.held >= 30
                        ):
                            return True, st
                        if m.pnl <= -sl:
                            return True, st
                        return False, st

                    return step

                candidates.append((f"PC_TP+SL pc{pc}/tp{tp}/sl{sl}", maker()))

    # TRAIL + SL if somehow not (redundant if arm0)
    for arm in [5, 8]:
        for gb in [10, 12, 15]:
            for sl in [20, 25, 30]:

                def maker(arm=arm, gb=gb, sl=sl):
                    def step(m, st, s):
                        if m.mfe >= arm:
                            st["a"] = True
                        if st.get("a") and m.gb <= -gb:
                            return True, st
                        if not st.get("a") and m.pnl <= -sl:
                            return True, st
                        return False, st

                    return step

                candidates.append((f"AT+SL a{arm}/g{gb}/sl{sl}", maker()))

    # Failed bounce then SL: bounce>=b then pnl back <= -sl or back under entry
    for bnc in [5, 8, 10]:
        for sl in [15, 20, 25]:

            def maker(bnc=bnc, sl=sl):
                def step(m, st, s):
                    if m.bounce >= bnc and m.pnl > 0:
                        st["had"] = True
                    if st.get("had") and m.pnl <= 0:
                        return True, st  # failed reclaim
                    if m.pnl <= -sl:
                        return True, st
                    return False, st

                return step

            candidates.append((f"FAILBNC b{bnc}|SL{sl}", maker()))

    print(f"candidates={len(candidates)}")

    def show(ss, label):
        rows = []
        for name, step in candidates:
            r = eval_rule(ss, step)
            r["name"] = name
            rows.append(r)
        rows.sort(key=lambda r: (-r["score"], -r["either_cover"]))
        print(f"\n==== {label} TOP ====")
        for r in rows[:15]:
            print(" ", fmt(r, r["name"]))
        print(f"==== {label} balanced win&loss >=30% ====")
        bal = [r for r in rows if r["win_cov"] >= 0.30 and r["loss_cov"] >= 0.30]
        bal.sort(key=lambda r: (-r["either_cover"], -r["score"]))
        for r in bal[:10]:
            print(" ", fmt(r, r["name"]))
        if not bal:
            print("  (none at 30%)")
            bal2 = [r for r in rows if r["win_cov"] >= 0.20 and r["loss_cov"] >= 0.20]
            bal2.sort(key=lambda r: (-r["either_cover"], -r["score"]))
            print("  fallback >=20%:")
            for r in bal2[:10]:
                print(" ", fmt(r, r["name"]))
        return rows

    show(sessions, "ALL")
    for lead, ss in sorted(by.items()):
        show(ss, lead)

    # Special: among losses, distribution of final and whether SL level matches exit
    print("\n=== LOSS: does final cluster at a SL level? ===")
    for lead, ss in sorted(by.items()):
        losses = [s for s in ss if s.loss]
        finals = [s.final for s in losses]
        print(f"{lead}: final50={pct(finals,0.5):.1f} p25={pct(finals,0.25):.1f} p75={pct(finals,0.75):.1f}")
        for center in [10, 15, 20, 25, 30, 35, 40]:
            c = sum(1 for x in finals if abs(x + center) <= 4)
            print(f"  near -{center}±4: {c}/{len(losses)} ({100*c/len(losses):.0f}%)")

    # Special: among wins, stall before exit
    print("\n=== WIN: stall seconds before exit / sold above prepeak? ===")
    for lead, ss in sorted(by.items()):
        wins = [s for s in ss if s.win]
        stalls = []
        above = near = below = 0
        for s in wins:
            _, peak, egb, _ = pre_exit_features(s)
            run_peak = s.entry
            peak_h = 0
            for m in s.marks:
                if m.price > run_peak * 1.0001:
                    run_peak = m.price
                    peak_h = m.held
            stalls.append(s.held - peak_h)
            if egb is None:
                continue
            if egb > 3:
                above += 1
            elif egb < -3:
                below += 1
            else:
                near += 1
        print(
            f"{lead}: stall50={pct(stalls,0.5):.0f}s stall25={pct(stalls,0.25):.0f} "
            f"stall75={pct(stalls,0.75):.0f} | sold above/near/below prepeak {above}/{near}/{below}"
        )

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_exact_v2.json").write_text(
        json.dumps({"n": len(sessions)}, indent=2)
    )


if __name__ == "__main__":
    main()
