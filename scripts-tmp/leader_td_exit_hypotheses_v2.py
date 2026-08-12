#!/usr/bin/env python3
"""
Turn-dump-only leader exit hypothesis search v2.

Builds sessions from TD isNewBag buys → first isFlat sell (≤6h),
attaches bag marks by (leader,mint) in [buy,sell], uses Dex mark/entry PnL.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

DATA = Path("data/milddip")
MAX_HOLD_SEC = 6 * 3600


def is_td_buy(o: dict) -> bool:
    if o.get("class") == "green":
        return False
    g = o.get("gates") or {}
    td = o.get("turnDump") or {}
    if g.get("main") is True:
        return True
    if td.get("inMain") or td.get("inShallow") or td.get("branch") in ("main", "shallow"):
        return True
    if o.get("class") in ("shallow", "mild_shallow", "mild_deep", "deep_knife", "rug_knife"):
        return True
    return False


def sane_pnl(entry: float | None, mark: float | None) -> float | None:
    if not entry or not mark or entry <= 0 or mark <= 0:
        return None
    p = (mark / entry - 1.0) * 100.0
    if p > 300 or p < -95:
        return None
    return p


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[int(q * (len(s) - 1))]


@dataclass
class Mark:
    ts: int
    held: float
    pnl: float
    mfe: float
    giveback: float
    turn: float | None
    pc5m: float | None
    price: float
    vol: float | None
    liq: float | None


@dataclass
class Session:
    leader: str
    mint: str
    branch: str
    entry_class: str
    entry_turn: float | None
    entry_dump: float | None
    held: float
    final_pnl: float
    marks: list[Mark]


def load_sessions() -> list[Session]:
    buys: list[dict] = []
    sells_by: dict[tuple, list] = defaultdict(list)
    marks_by: dict[tuple, list] = defaultdict(list)

    for path in sorted(DATA.glob("leader-observer-2026080*.jsonl")):
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

    sessions: list[Session] = []
    for b in buys:
        if not is_td_buy(b):
            continue
        if b.get("isAdd"):
            continue
        if b.get("isNewBag") is False:
            continue
        key = (b.get("leader"), b.get("mint"))
        bt = b.get("blockTime") or 0
        if not bt:
            continue
        # first flat sell within MAX_HOLD
        sell = None
        for s in sells_by.get(key, []):
            st = s.get("blockTime") or 0
            if st < bt:
                continue
            if st - bt > MAX_HOLD_SEC:
                break
            if s.get("isFlat") or s.get("tokenPostUi") == 0:
                sell = s
                break
        if sell is None:
            continue
        held = float((sell.get("blockTime") or 0) - bt)
        if held < 5:
            continue

        entry = b.get("dexPriceUsd")
        if not entry or entry <= 0:
            entry = b.get("fillPriceUsd")
        # marks in window
        t0 = bt * 1000
        t1 = (sell.get("blockTime") or bt) * 1000 + 5_000
        raw = [m for m in marks_by.get(key, []) if t0 - 5_000 <= (m.get("tsMs") or 0) <= t1]
        series: list[Mark] = []
        peak = entry if entry and entry > 0 else None
        for m in raw:
            d = m.get("dex") or {}
            e = m.get("entryPriceUsd") or entry
            mark = m.get("markPriceUsd") or d.get("priceUsd")
            pnl = sane_pnl(e, mark)
            if pnl is None or mark is None or e is None:
                continue
            if peak is None or mark > peak:
                peak = mark
            mfe = (peak / e - 1.0) * 100.0
            gb = (mark / peak - 1.0) * 100.0 if peak else 0.0
            vol = d.get("vol5m")
            liq = d.get("liq")
            turn = None
            td = m.get("turnDump") or {}
            if td.get("turn") is not None:
                turn = float(td["turn"])
            elif vol is not None and liq and liq > 0:
                turn = float(vol) / float(liq)
            series.append(
                Mark(
                    ts=int(m.get("tsMs") or 0),
                    held=float(m.get("heldSec") or max(0, ((m.get("tsMs") or t0) - t0) / 1000)),
                    pnl=pnl,
                    mfe=mfe,
                    giveback=gb,
                    turn=turn,
                    pc5m=float(d["pc5m"]) if d.get("pc5m") is not None else None,
                    price=float(mark),
                    vol=float(vol) if vol is not None else None,
                    liq=float(liq) if liq else None,
                )
            )

        final = None
        if series:
            final = series[-1].pnl
        if final is None:
            exitp = sell.get("dexPriceUsd") or sell.get("exitPriceUsd")
            final = sane_pnl(entry, exitp)
        if final is None:
            continue

        td = b.get("turnDump") or {}
        branch = (
            td.get("branch")
            or ("main" if td.get("inMain") or (b.get("gates") or {}).get("main") else None)
            or ("shallow" if td.get("inShallow") else None)
            or b.get("class")
            or "td"
        )
        sessions.append(
            Session(
                leader=(b.get("leader") or "")[:8],
                mint=(b.get("mint") or "")[:8],
                branch=str(branch),
                entry_class=str(b.get("class") or ""),
                entry_turn=td.get("turn"),
                entry_dump=td.get("dump"),
                held=held,
                final_pnl=final,
                marks=series,
            )
        )
    return sessions


def characterize(sessions: list[Session]) -> None:
    print(f"TD sessions n={len(sessions)}")
    print("leaders", Counter(s.leader for s in sessions))
    print("branch", Counter(s.branch for s in sessions))
    print("entryClass", Counter(s.entry_class for s in sessions))
    helds = [s.held for s in sessions]
    finals = [s.final_pnl for s in sessions]
    print(
        f"held p10/50/90={pct(helds,0.1):.0f}/{pct(helds,0.5):.0f}/{pct(helds,0.9):.0f} "
        f"final p10/50/90={pct(finals,0.1):.1f}/{pct(finals,0.5):.1f}/{pct(finals,0.9):.1f} "
        f"win={sum(1 for x in finals if x>0)/len(finals):.2f}"
    )
    path = [s for s in sessions if len(s.marks) >= 3]
    print(f"with mark path>=3: {len(path)}")
    if path:
        mfes = [max(m.mfe for m in s.marks) for s in path]
        maes = [min(m.pnl for m in s.marks) for s in path]
        print(f"path MFE p50={pct(mfes,0.5):.1f} MAE p50={pct(maes,0.5):.1f}")
        # exit location vs peak/entry
        gbs = []
        for s in path:
            last = s.marks[-1]
            gbs.append(last.giveback)
        print(f"exit giveback-from-peak p50={pct(gbs,0.5):.1f}")


def eval_hyp(name: str, sessions: list[Session], pred: Callable[[Session], float | None]) -> dict:
    trig = explain = helped = hurt = false_w = 0
    deltas = []
    trig_pnls = []
    trig_held = []
    for s in sessions:
        tp = pred(s)
        if tp is None:
            continue
        trig += 1
        trig_pnls.append(tp)
        # held at first near match
        for m in s.marks:
            if abs(m.pnl - tp) < 0.051:
                trig_held.append(m.held)
                break
        d = tp - s.final_pnl
        deltas.append(d)
        if abs(d) < 3:
            explain += 1
        elif d > 3:
            helped += 1
        else:
            hurt += 1
        if s.final_pnl >= 10 and tp < 5:
            false_w += 1
    out = {
        "name": name,
        "trig": trig,
        "n": len(sessions),
        "explain": explain,
        "explain_rate": explain / trig if trig else 0.0,
        "helped": helped,
        "hurt": hurt,
        "false_w": false_w,
        "med_delta": pct(deltas, 0.5) or 0.0,
        "med_trig_pnl": pct(trig_pnls, 0.5),
        "med_trig_held": pct(trig_held, 0.5),
        "cover": trig / len(sessions) if sessions else 0.0,
    }
    star = " **" if trig >= 30 and out["explain_rate"] >= 0.3 else ""
    print(
        f"{name}: trig={trig}/{len(sessions)} ({out['cover']*100:.0f}%) "
        f"explain={explain} ({out['explain_rate']*100:.0f}%) "
        f"help={helped} hurt={hurt} falseW={false_w} "
        f"medΔ={out['med_delta']:.1f} pnl50={out['med_trig_pnl']} held50={out['med_trig_held']}{star}"
    )
    return out


def first(s: Session, cond) -> Mark | None:
    hist = []
    for m in s.marks:
        hist.append(m)
        if cond(m, hist):
            return m
    return None


def main() -> None:
    sessions = load_sessions()
    characterize(sessions)
    path = [s for s in sessions if len(s.marks) >= 3]
    print(f"\n=== Testing on path sessions n={len(path)} ===")
    if len(path) < 20:
        print("WARNING: still low path count")

    results: list[dict] = []

    print("\n--- H1 hard stop ---")
    for thr in [8, 10, 12, 15, 20, 25, 30, 40, 50]:
        results.append(
            eval_hyp(
                f"H1 SL-{thr}",
                path,
                lambda s, thr=thr: (m.pnl if (m := first(s, lambda m, h: m.pnl <= -thr)) else None),
            )
        )

    print("\n--- H2 arm+giveback ---")
    for arm in [3, 5, 8, 10, 12, 15, 20]:
        for gb in [3, 5, 6, 8, 10, 12, 15, 20]:
            def pred(s, arm=arm, gb=gb):
                armed = False
                for m in s.marks:
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.giveback <= -gb:
                        return m.pnl
                return None

            results.append(eval_hyp(f"H2 arm{arm}/gb{gb}", path, pred))

    print("\n--- H3 peak giveback always ---")
    for gb in [5, 8, 10, 12, 15, 20]:
        results.append(
            eval_hyp(
                f"H3 gb{gb} mfe>=2",
                path,
                lambda s, gb=gb: (
                    m.pnl if (m := first(s, lambda m, h: m.mfe >= 2 and m.giveback <= -gb)) else None
                ),
            )
        )

    print("\n--- H4 TP ---")
    for tp in [5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 80, 100]:
        results.append(
            eval_hyp(
                f"H4 TP+{tp}",
                path,
                lambda s, tp=tp: (m.pnl if (m := first(s, lambda m, h: m.pnl >= tp)) else None),
            )
        )

    print("\n--- H5 dump then reclaim ---")
    for dump in [5, 8, 10, 12, 15, 20]:
        for reclaim in [-2, 0, 1, 2, 3, 5]:
            def pred(s, dump=dump, reclaim=reclaim):
                seen = False
                for m in s.marks:
                    if m.pnl <= -dump:
                        seen = True
                    if seen and m.pnl >= reclaim:
                        return m.pnl
                return None

            results.append(eval_hyp(f"H5 dump{dump}/rec{reclaim}", path, pred))

    print("\n--- H6 trough bounce ---")
    for min_dump in [5, 8, 10, 12, 15]:
        for bounce in [3, 5, 8, 10, 12]:
            def pred(s, min_dump=min_dump, bounce=bounce):
                trough = None
                trough_pnl = None
                for m in s.marks:
                    if trough is None or m.price < trough:
                        trough = m.price
                        trough_pnl = m.pnl
                    if trough is None or trough_pnl is None or trough_pnl > -min_dump:
                        continue
                    off = (m.price / trough - 1.0) * 100.0
                    if off >= bounce:
                        return m.pnl
                return None

            results.append(eval_hyp(f"H6 dump{min_dump}/bnc{bounce}", path, pred))

    print("\n--- H7 pure time ---")
    for sec in [60, 120, 180, 300, 600, 900, 1800, 3600]:
        results.append(
            eval_hyp(
                f"H7 t>={sec}",
                path,
                lambda s, sec=sec: (m.pnl if (m := first(s, lambda m, h: m.held >= sec)) else None),
            )
        )

    print("\n--- H8 time+red ---")
    for sec in [180, 300, 600, 900, 1800]:
        for red in [0, 3, 5, 8, 10, 15]:
            results.append(
                eval_hyp(
                    f"H8 t>={sec}&pnl<=-{red}",
                    path,
                    lambda s, sec=sec, red=red: (
                        m.pnl
                        if (m := first(s, lambda m, h: m.held >= sec and m.pnl <= -red))
                        else None
                    ),
                )
            )

    print("\n--- H9 turn dead + red ---")
    for red in [0, 5, 8, 10]:
        for thr in [0.02, 0.03, 0.05, 0.08, 0.12]:
            def pred(s, red=red, thr=thr):
                c = 0
                for m in s.marks:
                    if (
                        m.turn is not None
                        and m.held >= 120
                        and m.pnl <= -red
                        and m.turn <= thr
                    ):
                        c += 1
                    else:
                        c = 0
                    if c >= 2:
                        return m.pnl
                return None

            results.append(eval_hyp(f"H9 red{red}/turn{thr}", path, pred))

    print("\n--- H11 pc5m green ---")
    for thr in [0, 1, 2, 3, 5, 8]:
        results.append(
            eval_hyp(
                f"H11 pc5m>={thr}",
                path,
                lambda s, thr=thr: (
                    m.pnl
                    if (
                        m := first(
                            s,
                            lambda m, h: m.pc5m is not None and m.pc5m >= thr and m.held >= 30,
                        )
                    )
                    else None
                ),
            )
        )

    print("\n--- H13 TP OR SL ---")
    for tp in [8, 10, 12, 15, 20, 25, 30]:
        for sl in [10, 12, 15, 20, 25, 30]:
            results.append(
                eval_hyp(
                    f"H13 TP{tp}|SL{sl}",
                    path,
                    lambda s, tp=tp, sl=sl: (
                        m.pnl
                        if (m := first(s, lambda m, h: m.pnl >= tp or m.pnl <= -sl))
                        else None
                    ),
                )
            )

    print("\n--- H14 arm trail else SL ---")
    for arm in [3, 5, 8, 10]:
        for gb in [5, 8, 10, 12, 15]:
            for sl in [12, 15, 20, 25, 30]:
                def pred(s, arm=arm, gb=gb, sl=sl):
                    armed = False
                    for m in s.marks:
                        if m.mfe >= arm:
                            armed = True
                        if armed and m.giveback <= -gb:
                            return m.pnl
                        if (not armed) and m.pnl <= -sl:
                            return m.pnl
                    return None

                results.append(eval_hyp(f"H14 a{arm}/g{gb}/sl{sl}", path, pred))

    print("\n--- H15: TP then trail remainder proxy (full exit at first of TP or trail) ---")
    # already covered by H13/H14 mostly

    print("\n--- H16: exit near max(entry, VWAP) reclaim: pnl cross 0 after being red ---")
    def pred_cross0(s):
        seen = False
        for m in s.marks:
            if m.pnl <= -5:
                seen = True
            if seen and m.pnl >= 0:
                return m.pnl
        return None

    results.append(eval_hyp("H16 red-5 then cross0", path, pred_cross0))

    # Score: high explain_rate, decent coverage, low false_w
    print("\n======== TOP explain_rate (trig>=40, cover>=0.25) ========")
    ranked = [
        r
        for r in results
        if r["trig"] >= 40 and r["cover"] >= 0.25
    ]
    ranked.sort(key=lambda r: (-r["explain_rate"], r["false_w"], -r["trig"]))
    for r in ranked[:30]:
        print(
            f"  expl={r['explain_rate']*100:5.1f}% cover={r['cover']*100:4.0f}% "
            f"trig={r['trig']:3d} falseW={r['false_w']:2d} hurt={r['hurt']:2d} "
            f"medΔ={r['med_delta']:.1f} | {r['name']}"
        )

    print("\n======== TOP score = explain*cover / (1+falseW) ========")
    for r in results:
        r["score"] = r["explain_rate"] * r["cover"] / (1 + r["false_w"] / max(1, r["trig"]))
    ranked2 = [r for r in results if r["trig"] >= 30]
    ranked2.sort(key=lambda r: -r["score"])
    for r in ranked2[:25]:
        print(
            f"  score={r['score']:.3f} expl={r['explain_rate']*100:.0f}% "
            f"cover={r['cover']*100:.0f}% falseW={r['false_w']} | {r['name']}"
        )

    # Per-leader for top 5
    print("\n======== Per-leader for top score rules ========")
    top = ranked2[:5]
    by_lead = defaultdict(list)
    for s in path:
        by_lead[s.leader].append(s)

    # Re-define preds for H14 / H2 / H13 via name parse
    def make_pred(name: str):
        if name.startswith("H14 "):
            # H14 a5/g8/sl20
            parts = name.split()[1]
            a = int(parts.split("/g")[0][1:])
            rest = parts.split("/g")[1]
            g = int(rest.split("/sl")[0])
            sl = int(rest.split("/sl")[1])

            def pred(s, a=a, g=g, sl=sl):
                armed = False
                for m in s.marks:
                    if m.mfe >= a:
                        armed = True
                    if armed and m.giveback <= -g:
                        return m.pnl
                    if (not armed) and m.pnl <= -sl:
                        return m.pnl
                return None

            return pred
        if name.startswith("H2 "):
            # H2 arm5/gb8
            parts = name.split()[1]
            a = int(parts.split("/gb")[0].replace("arm", ""))
            g = int(parts.split("/gb")[1])

            def pred(s, a=a, g=g):
                armed = False
                for m in s.marks:
                    if m.mfe >= a:
                        armed = True
                    if armed and m.giveback <= -g:
                        return m.pnl
                return None

            return pred
        if name.startswith("H13 "):
            parts = name.split()[1]  # TP10|SL15
            tp = int(parts.split("|")[0].replace("TP", ""))
            sl = int(parts.split("|")[1].replace("SL", ""))

            def pred(s, tp=tp, sl=sl):
                m = first(s, lambda m, h: m.pnl >= tp or m.pnl <= -sl)
                return m.pnl if m else None

            return pred
        return None

    for r in top:
        pred = make_pred(r["name"])
        if not pred:
            print(f"(skip per-leader parse) {r['name']}")
            continue
        print(f"\n{r['name']}:")
        for lead, ss in sorted(by_lead.items()):
            expl = trig = 0
            for s in ss:
                tp = pred(s)
                if tp is None:
                    continue
                trig += 1
                if abs(tp - s.final_pnl) < 3:
                    expl += 1
            print(f"  {lead}: {expl}/{trig} ({(100*expl/trig if trig else 0):.0f}%) of {len(ss)} sessions")

    # Endpoint-only analysis (no marks): exit pnl vs held clusters for all sessions
    print("\n======== Endpoint clusters (all TD sessions, with/without marks) ========")
    for label, lo, hi in [
        ("<3m", 0, 180),
        ("3-10m", 180, 600),
        ("10-30m", 600, 1800),
        ("30-60m", 1800, 3600),
        ("1-6h", 3600, 100000),
    ]:
        arr = [s for s in sessions if lo <= s.held < hi]
        if not arr:
            continue
        pnls = [s.final_pnl for s in arr]
        print(
            f"{label}: n={len(arr)} win={sum(1 for p in pnls if p>0)/len(pnls):.2f} "
            f"pnl50={pct(pnls,0.5):.1f} pnl10={pct(pnls,0.1):.1f} pnl90={pct(pnls,0.9):.1f}"
        )

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_hypotheses_v2.json").write_text(
        json.dumps({"n": len(sessions), "n_path": len(path), "top": ranked2[:40]}, indent=2)
    )
    print("\nWrote artifacts/leader_td_exit_hypotheses_v2.json")


if __name__ == "__main__":
    main()
