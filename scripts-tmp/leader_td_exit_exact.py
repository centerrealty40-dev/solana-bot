#!/usr/bin/env python3
"""
Exact codeable TD exit formula hunt for both leaders.
Primary metric: rule trigger time within tol of actual flat sell.
Secondary: trigger pnl within tol of final pnl.

Key insight to test: trailing stop from running peak WITH peak init at entry
(no arm gate) unifies winners (pullback from high) and losers (drop from entry).
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
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
    mint: str
    held: float
    final: float
    marks: list[Mk] = field(default_factory=list)

    @property
    def win(self):
        return self.final > 5

    @property
    def loss(self):
        return self.final < -5


def load_sessions():
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
            vol, liq = d.get("vol5m"), d.get("liq")
            turn = d.get("turnover5mLiq")
            if turn is None and vol is not None and liq and liq > 0:
                turn = float(vol) / float(liq)
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
        # ensure last mark near exit; if gap, append synthetic exit mark
        held = float((sell.get("blockTime") or 0) - bt)
        if series[-1].held < held - 30:
            peak2 = max(peak, exitp)
            trough2 = min(trough, exitp)
            series.append(
                Mk(
                    held=held,
                    price=float(exitp),
                    pnl=final,
                    mfe=(peak2 / entry - 1) * 100,
                    gb=(exitp / peak2 - 1) * 100,
                    bounce=(exitp / trough2 - 1) * 100,
                    pc5m=(sell.get("gates") or {}).get("pc5m")
                    if (sell.get("gates") or {}).get("pc5m") is not None
                    else (sell.get("dex") or {}).get("pc5m"),
                    turn=(sell.get("dex") or {}).get("turnover5mLiq"),
                )
            )
        out.append(
            Sess(
                leader=(b.get("leader") or "")[:8],
                mint=(b.get("mint") or "")[:8],
                held=held,
                final=final,
                marks=series,
            )
        )
    return out


def first_fire(s: Sess, step):
    st = {}
    for m in s.marks:
        fire, st = step(m, st, s)
        if fire:
            return m
    return None


def eval_rule(ss, step, time_tol=120.0, pnl_tol=5.0):
    """
    hit = rule fired.
    time_ok = fired within time_tol seconds BEFORE actual exit (not after conceptually).
    pnl_ok = |fire_pnl - final| < pnl_tol
    either = time_ok or pnl_ok
    early_bad = fired > time_tol before exit AND fire_pnl meaningfully different
    """
    n = len(ss)
    trig = time_ok = pnl_ok = either = early = miss = 0
    win_hit = win_n = loss_hit = loss_n = 0
    for s in ss:
        if s.win:
            win_n += 1
        if s.loss:
            loss_n += 1
        m = first_fire(s, step)
        if m is None:
            miss += 1
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
    return {
        "n": n,
        "trig": trig,
        "cover": trig / n if n else 0,
        "miss": miss,
        "time_rate": time_ok / trig if trig else 0,
        "pnl_rate": pnl_ok / trig if trig else 0,
        "either_rate": either / trig if trig else 0,
        "either_n": either,
        "either_cover": either / n if n else 0,
        "early": early,
        "win_hit": win_hit,
        "win_n": win_n,
        "win_cov": win_hit / win_n if win_n else 0,
        "loss_hit": loss_hit,
        "loss_n": loss_n,
        "loss_cov": loss_hit / loss_n if loss_n else 0,
        # prefer rules that cover BOTH sides
        "score": (either / n if n else 0)
        * (0.5 + 0.25 * (win_hit / win_n if win_n else 0) + 0.25 * (loss_hit / loss_n if loss_n else 0)),
    }


def fmt(r, name):
    return (
        f"{name}: either={r['either_rate']*100:.0f}% cover={r['cover']*100:.0f}% "
        f"hit={r['either_n']}/{r['n']} ({r['either_cover']*100:.0f}%) "
        f"win={r['win_hit']}/{r['win_n']}({r['win_cov']*100:.0f}%) "
        f"loss={r['loss_hit']}/{r['loss_n']}({r['loss_cov']*100:.0f}%) "
        f"time={r['time_rate']*100:.0f}% pnl={r['pnl_rate']*100:.0f}% early={r['early']} "
        f"score={r['score']:.3f}"
    )


def main():
    sessions = load_sessions()
    by = defaultdict(list)
    for s in sessions:
        by[s.leader].append(s)
    print(f"path sessions={len(sessions)} by={[ (k,len(v)) for k,v in sorted(by.items()) ]}")
    print(
        "wins/losses",
        {k: (sum(1 for s in v if s.win), sum(1 for s in v if s.loss)) for k, v in sorted(by.items())},
    )

    candidates = []

    # ---- H1: pure trailing from entry peak, NO arm (unifies win+loss) ----
    for gb in [5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40]:
        for min_held in [0, 30, 60]:

            def maker(gb=gb, min_held=min_held):
                def step(m, st, s):
                    if m.held < min_held:
                        return False, st
                    return m.gb <= -gb, st

                return step

            candidates.append((f"TRAIL0 gb{gb}/h{min_held}", maker()))

    # ---- H2: classic arm then trail ----
    for arm in [3, 5, 8, 10, 12]:
        for gb in [8, 10, 12, 15, 20]:

            def maker(arm=arm, gb=gb):
                def step(m, st, s):
                    if m.mfe >= arm:
                        st["a"] = True
                    return bool(st.get("a")) and m.gb <= -gb, st

                return step

            candidates.append((f"ARM_TRAIL a{arm}/g{gb}", maker()))

    # ---- H3: hard TP | hard SL ----
    for tp in [8, 10, 12, 15, 20, 25]:
        for sl in [10, 15, 20, 25, 30, 40, 50]:

            def maker(tp=tp, sl=sl):
                def step(m, st, s):
                    return m.pnl >= tp or m.pnl <= -sl, st

                return step

            candidates.append((f"TP{tp}|SL{sl}", maker()))

    # ---- H4: TRAIL0 OR hard TP (sell strength OR trail) ----
    for gb in [8, 10, 12, 15, 20]:
        for tp in [10, 12, 15, 20, None]:

            def maker(gb=gb, tp=tp):
                def step(m, st, s):
                    if tp is not None and m.pnl >= tp:
                        return True, st
                    return m.gb <= -gb, st

                return step

            candidates.append((f"TP{tp}|TRAIL0 g{gb}", maker()))

    # ---- H5: arm-trail for green path, SL if never arm ----
    for arm in [5, 8, 10]:
        for gb in [8, 10, 12, 15]:
            for sl in [15, 20, 25, 30]:

                def maker(arm=arm, gb=gb, sl=sl):
                    def step(m, st, s):
                        if m.mfe >= arm:
                            st["a"] = True
                        if st.get("a") and m.gb <= -gb:
                            return True, st
                        if (not st.get("a")) and m.pnl <= -sl:
                            return True, st
                        return False, st

                    return step

                candidates.append((f"AT|SL a{arm}/g{gb}/sl{sl}", maker()))

    # ---- H6: bounce reclaim (win path) | SL (loss path) ----
    for dump in [3, 5, 8]:
        for bnc in [5, 8, 10, 12]:
            for sl in [15, 20, 25, 30]:

                def maker(dump=dump, bnc=bnc, sl=sl):
                    def step(m, st, s):
                        thr = st.get("thr")
                        thr_pnl = st.get("thr_pnl")
                        if thr is None or m.price < thr:
                            st["thr"] = m.price
                            st["thr_pnl"] = m.pnl
                            thr_pnl = m.pnl
                        if thr_pnl is not None and thr_pnl <= -dump and m.bounce >= bnc:
                            return True, st
                        if m.pnl <= -sl:
                            return True, st
                        return False, st

                    return step

                candidates.append((f"BNC d{dump}/b{bnc}|SL{sl}", maker()))

    # ---- H7: TRAIL0 + asymmetric wider when mfe high ----
    # sell if gb<=-g_red when mfe<small, else gb<=-g_green
    for g_red in [10, 12, 15, 20, 25]:
        for g_green in [8, 10, 12, 15]:
            for split in [3, 5, 8]:

                def maker(g_red=g_red, g_green=g_green, split=split):
                    def step(m, st, s):
                        lim = g_green if m.mfe >= split else g_red
                        return m.gb <= -lim, st

                    return step

                candidates.append((f"ASY gR{g_red}/gG{g_green}/sp{split}", maker()))

    # ---- H8: time-red never-arm | trail when armed ----
    for arm in [5, 8]:
        for gb in [10, 12, 15]:
            for tsec in [600, 900, 1800, 3600]:

                def maker(arm=arm, gb=gb, tsec=tsec):
                    def step(m, st, s):
                        if m.mfe >= arm:
                            st["a"] = True
                        if st.get("a") and m.gb <= -gb:
                            return True, st
                        if (not st.get("a")) and m.held >= tsec and m.pnl < 0:
                            return True, st
                        return False, st

                    return step

                candidates.append((f"AT|TRED a{arm}/g{gb}/t{tsec}", maker()))

    # ---- H9: dead turn while red ----
    for arm in [5, 8]:
        for gb in [10, 12, 15]:
            for tturn in [0.02, 0.05, 0.1]:
                for min_held in [300, 600, 900]:

                    def maker(arm=arm, gb=gb, tturn=tturn, min_held=min_held):
                        def step(m, st, s):
                            if m.mfe >= arm:
                                st["a"] = True
                            if st.get("a") and m.gb <= -gb:
                                return True, st
                            if (
                                (not st.get("a"))
                                and m.held >= min_held
                                and m.pnl < 0
                                and m.turn is not None
                                and m.turn <= tturn
                            ):
                                return True, st
                            return False, st

                        return step

                    candidates.append((f"AT|DEAD a{arm}/g{gb}/t{tturn}/h{min_held}", maker()))

    # ---- H10: pc5m reclaim OR trail0 ----
    for gb in [10, 12, 15, 20]:
        for pcthr in [0, 2, 5, 8, 10]:

            def maker(gb=gb, pcthr=pcthr):
                def step(m, st, s):
                    if m.pc5m is not None and m.pc5m >= pcthr and m.held >= 30 and m.pnl > 0:
                        return True, st
                    return m.gb <= -gb, st

                return step

            candidates.append((f"PC{pcthr}|TRAIL0 g{gb}", maker()))

    print(f"\nCandidates: {len(candidates)}")

    # Evaluate globally and per leader
    def rank(ss, label, top=15, min_loss_cov=0.15):
        rows = []
        for name, step in candidates:
            r = eval_rule(ss, step)
            r["name"] = name
            rows.append(r)
        rows.sort(key=lambda r: (-r["score"], -r["loss_cov"], -r["win_cov"]))
        print(f"\n======== {label}: TOP by score ========")
        shown = 0
        for r in rows:
            print(" ", fmt(r, r["name"]))
            shown += 1
            if shown >= top:
                break
        print(f"\n======== {label}: best with loss_cov>=25% and win_cov>=25% ========")
        good = [r for r in rows if r["loss_cov"] >= 0.25 and r["win_cov"] >= 0.25]
        good.sort(key=lambda r: (-r["either_cover"], -r["score"]))
        for r in good[:12]:
            print(" ", fmt(r, r["name"]))
        if not good:
            print("  (none)")
        print(f"\n======== {label}: best LOSS coverage among either_cover>=20% ========")
        g2 = [r for r in rows if r["either_cover"] >= 0.20]
        g2.sort(key=lambda r: (-r["loss_cov"], -r["win_cov"]))
        for r in g2[:10]:
            print(" ", fmt(r, r["name"]))
        return rows

    all_rows = rank(sessions, "ALL")
    per = {}
    for lead, ss in sorted(by.items()):
        per[lead] = rank(ss, lead, top=12)

    # Focused refinement around TRAIL0 (the unify hypothesis)
    print("\n======== TRAIL0 fine grid per leader ========")
    for lead, ss in sorted(by.items()):
        print(f"\n{lead}:")
        best = None
        for gb in range(5, 46):
            for min_held in [0, 15, 30, 45, 60, 90]:

                def step(m, st, s, gb=gb, min_held=min_held):
                    if m.held < min_held:
                        return False, st
                    return m.gb <= -gb, st

                r = eval_rule(ss, step)
                r["name"] = f"TRAIL0 gb{gb}/h{min_held}"
                if best is None or r["score"] > best["score"]:
                    best = r
        print("  best", fmt(best, best["name"]))
        # also show Pareto: max loss_cov at win_cov>=40%
        pareto = []
        for gb in range(5, 46):

            def step(m, st, s, gb=gb):
                return m.gb <= -gb, st

            r = eval_rule(ss, step)
            r["gb"] = gb
            pareto.append(r)
        print("  TRAIL0 by gb (selected):")
        for r in pareto:
            if r["gb"] in (8, 10, 12, 15, 18, 20, 25, 30, 35, 40):
                print(
                    f"    g{r['gb']}: hit={r['either_n']}/{r['n']} win={r['win_cov']*100:.0f}% "
                    f"loss={r['loss_cov']*100:.0f}% early={r['early']}"
                )

    # Dual-param scheme forced structure:
    # if mfe>=arm: trail gb_green else: (pnl<=-sl OR (held>=t and pnl<0))
    print("\n======== Forced dual scheme grid ========")
    for lead, ss in sorted(by.items()):
        best = None
        for arm in [0, 3, 5, 8]:
            for gbg in [8, 10, 12, 15, 20]:
                for sl in [12, 15, 20, 25, 30, 40, 0]:
                    for tsec in [0, 600, 900, 1800, 3600]:

                        def step(m, st, s, arm=arm, gbg=gbg, sl=sl, tsec=tsec):
                            # arm=0 means always use trail from entry peak
                            if arm == 0:
                                return m.gb <= -gbg, st
                            if m.mfe >= arm:
                                st["a"] = True
                            if st.get("a") and m.gb <= -gbg:
                                return True, st
                            if not st.get("a"):
                                if sl > 0 and m.pnl <= -sl:
                                    return True, st
                                if tsec > 0 and m.held >= tsec and m.pnl < 0:
                                    return True, st
                            return False, st

                        r = eval_rule(ss, step)
                        name = f"DUAL arm{arm}/g{gbg}/sl{sl}/t{tsec}"
                        r["name"] = name
                        if best is None or r["score"] > best["score"]:
                            best = r
        print(f"{lead}: {fmt(best, best['name'])}")

    # Diagnostic: at actual exit mark, what is gb / pnl / mfe?
    print("\n======== At-exit mark features (what rule should see) ========")
    for lead, ss in sorted(by.items()):
        wins = [s for s in ss if s.win]
        losses = [s for s in ss if s.loss]
        for label, arr in [("WIN", wins), ("LOSS", losses)]:
            if not arr:
                continue
            egb = [s.marks[-1].gb for s in arr]
            ep = [s.marks[-1].pnl for s in arr]
            em = [s.marks[-1].mfe for s in arr]
            print(
                f"{lead} {label}: n={len(arr)} exit_gb50={pct(egb,0.5):.1f} "
                f"p25={pct(egb,0.25):.1f} p75={pct(egb,0.75):.1f} | "
                f"exit_pnl50={pct(ep,0.5):.1f} exit_mfe50={pct(em,0.5):.1f}"
            )
            # fraction with exit_gb in bands
            for lo, hi, lab in [
                (-100, -25, "gb<=-25"),
                (-25, -15, "-25..-15"),
                (-15, -10, "-15..-10"),
                (-10, -5, "-10..-5"),
                (-5, 0, "-5..0"),
                (0, 50, ">=0"),
            ]:
                c = sum(1 for x in egb if lo <= x < hi)
                print(f"   {lab}: {c} ({100*c/len(arr):.0f}%)")

    out = {
        "n": len(sessions),
        "by_leader": {k: len(v) for k, v in by.items()},
        "top_all": [
            {
                "name": r["name"],
                "score": r["score"],
                "either_cover": r["either_cover"],
                "win_cov": r["win_cov"],
                "loss_cov": r["loss_cov"],
            }
            for r in all_rows[:30]
        ],
    }
    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_exact.json").write_text(json.dumps(out, indent=2))
    print("\nWrote artifacts/leader_td_exit_exact.json")


if __name__ == "__main__":
    main()
