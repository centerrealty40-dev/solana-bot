#!/usr/bin/env python3
"""
Find shared exit scheme for leader wallets on TURN-DUMP entries only.

Excludes green-candle entries. Uses Dex mark/entry PnL (not poisoned fill PnL).
Tests hypotheses one-by-one against mark paths + final flat.
"""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

DATA = Path("data/milddip")


def is_td_entry(o: dict) -> bool:
    """Turn-dump entry branch only — exclude green."""
    ec = o.get("entryClass")
    if ec == "green":
        return False
    eg = o.get("entryGates") or {}
    et = o.get("entryTurnDump") or {}
    if eg.get("main") is True:
        return True
    if et.get("inMain") or et.get("inShallow"):
        return True
    if et.get("branch") in ("main", "shallow"):
        return True
    # dump-like class with turn present
    if ec in ("shallow", "mild_shallow", "mild_deep", "deep_knife", "rug_knife") and et:
        return True
    return False


def sane_pnl(entry: float | None, mark: float | None) -> float | None:
    if not entry or not mark or entry <= 0 or mark <= 0:
        return None
    p = (mark / entry - 1.0) * 100.0
    if p > 400 or p < -99.5:
        return None
    return p


@dataclass
class Mark:
    ts: int
    held: float
    pnl: float
    peak: float
    mfe: float
    giveback: float  # from peak, negative when below peak
    turn: float | None
    vol: float | None
    liq: float | None
    mcap: float | None
    pc5m: float | None
    price: float


@dataclass
class Session:
    key: tuple
    leader: str
    mint: str
    branch: str
    entry_turn: float | None
    entry_dump: float | None
    entry_pc5m: float | None
    marks: list[Mark]
    final_pnl: float
    held_sec: float | None
    buys: int
    sells: int


def load_td_sessions() -> list[Session]:
    flats: dict[tuple, dict] = {}
    marks_raw: dict[tuple, list] = defaultdict(list)

    for path in sorted(DATA.glob("leader-observer-2026080*.jsonl")):
        with open(path) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                k = o.get("kind")
                if k == "leader_session_flat":
                    if not is_td_entry(o):
                        continue
                    key = (o.get("leader"), o.get("mint"), o.get("openedBlockTime"))
                    flats[key] = o
                elif k == "leader_bag_mark":
                    # keep all marks; filter by TD flat join later
                    key = (o.get("leader"), o.get("mint"), o.get("openedBlockTime"))
                    marks_raw[key].append(o)
                elif k == "leader_session_open":
                    if not is_td_entry(o):
                        continue
                    # opens without flat yet ignored for exit fit

    sessions: list[Session] = []
    for key, flat in flats.items():
        raw = sorted(marks_raw.get(key, []), key=lambda x: x.get("tsMs") or 0)
        entry0 = flat.get("entryPriceUsd")
        series: list[Mark] = []
        peak = entry0 if entry0 and entry0 > 0 else None
        for m in raw:
            d = m.get("dex") or {}
            entry = m.get("entryPriceUsd") or entry0
            mark = m.get("markPriceUsd") or d.get("priceUsd")
            pnl = sane_pnl(entry, mark)
            if pnl is None or mark is None or entry is None:
                continue
            if peak is None or mark > peak:
                peak = mark
            mfe = (peak / entry - 1.0) * 100.0
            gb = (mark / peak - 1.0) * 100.0 if peak > 0 else 0.0
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
                    held=float(m.get("heldSec") or 0),
                    pnl=pnl,
                    peak=float(peak),
                    mfe=mfe,
                    giveback=gb,
                    turn=turn,
                    vol=float(vol) if vol is not None else None,
                    liq=float(liq) if liq else None,
                    mcap=float(d["mcap"]) if d.get("mcap") else None,
                    pc5m=float(d["pc5m"]) if d.get("pc5m") is not None else None,
                    price=float(mark),
                )
            )

        # final pnl preference: last sane mark, else cash if sane, else skip
        final = None
        if series:
            final = series[-1].pnl
        if final is None:
            cost = flat.get("totalCostUsd")
            cash = flat.get("cashPnlUsd")
            if cost and cost > 0 and cash is not None:
                p = 100.0 * cash / cost
                if -99.5 <= p <= 400:
                    final = p
        if final is None:
            continue

        et = flat.get("entryTurnDump") or {}
        eg = flat.get("entryGates") or {}
        branch = (
            et.get("branch")
            or ("main" if et.get("inMain") or eg.get("main") else None)
            or ("shallow" if et.get("inShallow") else None)
            or (flat.get("entryClass") or "td")
        )
        sessions.append(
            Session(
                key=key,
                leader=(flat.get("leader") or "")[:8],
                mint=(flat.get("mint") or "")[:8],
                branch=str(branch),
                entry_turn=et.get("turn"),
                entry_dump=et.get("dump"),
                entry_pc5m=eg.get("pc5m"),
                marks=series,
                final_pnl=final,
                held_sec=flat.get("heldSec"),
                buys=int(flat.get("buys") or 1),
                sells=int(flat.get("sells") or 1),
            )
        )
    return sessions


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    i = int(q * (len(s) - 1))
    return s[i]


def characterize(sessions: list[Session]) -> None:
    print(f"\n=== TD sessions n={len(sessions)} ===")
    print("by leader", Counter(s.leader for s in sessions))
    print("by branch", Counter(s.branch for s in sessions))
    with_marks = [s for s in sessions if len(s.marks) >= 2]
    print(f"with mark path >=2: {len(with_marks)}")
    helds = [s.held_sec for s in sessions if s.held_sec is not None]
    finals = [s.final_pnl for s in sessions]
    mfes = [s.marks[-1].mfe for s in with_marks]
    maes = [min(m.pnl for m in s.marks) for s in with_marks]
    print(
        f"heldSec p10/p50/p90={pct(helds,0.1):.0f}/{pct(helds,0.5):.0f}/{pct(helds,0.9):.0f}"
        if helds
        else "held n/a"
    )
    print(
        f"finalPnl p10/p50/p90={pct(finals,0.1):.1f}/{pct(finals,0.5):.1f}/{pct(finals,0.9):.1f} "
        f"winrate={sum(1 for x in finals if x>0)/len(finals):.2f}"
    )
    if mfes:
        print(f"path MFE p50={pct(mfes,0.5):.1f} MAE p50={pct(maes,0.5):.1f}")
    # short vs long
    short = [s for s in sessions if (s.held_sec or 0) < 180]
    long = [s for s in sessions if (s.held_sec or 0) >= 1800]
    print(f"held<3m: {len(short)} held>=30m: {len(long)}")
    if short:
        print(f"  short final p50={pct([s.final_pnl for s in short],0.5):.1f}")
    if long:
        print(f"  long final p50={pct([s.final_pnl for s in long],0.5):.1f}")


Pred = Callable[[Session], float | None]


def eval_hyp(
    name: str,
    sessions: list[Session],
    pred: Pred,
    *,
    min_trig: int = 8,
) -> dict[str, Any]:
    """
    For each session with marks: if rule triggers at mark pnl tp, compare to final.
    Also measure: trigger rate, median |tp - final|, fraction where |tp-final|<3pp
    (rule explains the actual exit), and early-cut of winners.
    """
    trig = 0
    explain = 0  # |tp-final| < 3
    helped = hurt = 0
    deltas = []
    false_cut_winners = 0  # triggered while path later reached +10 without having exited
    trigger_pnls = []
    trigger_held = []
    no_mark = 0
    for s in sessions:
        if len(s.marks) < 2:
            no_mark += 1
            # can't path-test
            continue
        tp = pred(s)
        if tp is None:
            continue
        trig += 1
        trigger_pnls.append(tp)
        # held at trigger
        for m in s.marks:
            # approximate: first mark where pnl==tp near
            if abs(m.pnl - tp) < 1e-9 or abs(m.pnl - tp) < 0.05:
                trigger_held.append(m.held)
                break
        d = tp - s.final_pnl
        deltas.append(d)
        if abs(d) < 3:
            explain += 1
        if d > 3:
            helped += 1
        elif d < -3:
            hurt += 1
        # would we have cut a path that finished green strong?
        if s.final_pnl >= 10 and tp < 5:
            false_cut_winners += 1

    out = {
        "name": name,
        "trig": trig,
        "eligible": len(sessions) - no_mark,
        "explain": explain,
        "explain_rate": explain / trig if trig else 0.0,
        "helped": helped,
        "hurt": hurt,
        "false_cut_winners": false_cut_winners,
        "avg_delta": sum(deltas) / len(deltas) if deltas else 0.0,
        "med_delta": pct(deltas, 0.5) if deltas else 0.0,
        "med_trig_pnl": pct(trigger_pnls, 0.5) if trigger_pnls else None,
        "med_trig_held": pct(trigger_held, 0.5) if trigger_held else None,
    }
    flag = " **" if trig >= min_trig and out["explain_rate"] >= 0.35 else ""
    print(
        f"{name}: trig={trig}/{out['eligible']} explain={explain} "
        f"({out['explain_rate']*100:.0f}%) help={helped} hurt={hurt} "
        f"falseW={false_cut_winners} medΔ={out['med_delta']:.1f} "
        f"trigPnl50={out['med_trig_pnl']} held50={out['med_trig_held']}{flag}"
    )
    return out


def first_mark(s: Session, cond: Callable[[Mark, list[Mark]], bool]) -> Mark | None:
    hist: list[Mark] = []
    for m in s.marks:
        hist.append(m)
        if cond(m, hist):
            return m
    return None


def main() -> None:
    sessions = load_td_sessions()
    characterize(sessions)
    path_sessions = [s for s in sessions if len(s.marks) >= 3]
    print(f"\nHypothesis tests on path sessions n={len(path_sessions)}")

    results: list[dict] = []

    # ----- H1: hard stop from entry -----
    print("\n--- H1 hard stop from entry ---")
    for thr in [8, 10, 12, 15, 20, 25, 30, 40, 50]:
        def pred(s, thr=thr):
            m = first_mark(s, lambda m, _h: m.pnl <= -thr)
            return m.pnl if m else None

        results.append(eval_hyp(f"H1 hardStop -{thr}%", path_sessions, pred))

    # ----- H2: arm on MFE then giveback from peak -----
    print("\n--- H2 arm MFE then giveback from peak ---")
    for arm in [3, 5, 8, 10, 12, 15, 20]:
        for gb in [3, 5, 6, 8, 10, 12, 15]:
            def pred(s, arm=arm, gb=gb):
                armed = False
                for m in s.marks:
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.giveback <= -gb:
                        return m.pnl
                return None

            results.append(eval_hyp(f"H2 arm{arm}/gb{gb}", path_sessions, pred, min_trig=10))

    # ----- H3: giveback from peak even without arm (always trail) -----
    print("\n--- H3 peak giveback always (no arm) ---")
    for gb in [5, 8, 10, 12, 15, 20]:
        def pred(s, gb=gb):
            # need some peak first
            m = first_mark(s, lambda m, _h: m.mfe >= 2 and m.giveback <= -gb)
            return m.pnl if m else None

        results.append(eval_hyp(f"H3 peakGB -{gb}% (mfe>=2)", path_sessions, pred))

    # ----- H4: take profit at MFE level (bank) -----
    print("\n--- H4 take-profit at MFE ---")
    for tp in [5, 8, 10, 12, 15, 20, 25, 30, 40, 50]:
        def pred(s, tp=tp):
            m = first_mark(s, lambda m, _h: m.pnl >= tp)
            return m.pnl if m else None

        results.append(eval_hyp(f"H4 TP +{tp}%", path_sessions, pred))

    # ----- H5: reclaim toward entry after being red -----
    print("\n--- H5 bounce reclaim toward entry ---")
    for dump in [5, 8, 10, 12, 15]:
        for reclaim in [0, 1, 2, 3]:  # exit when pnl >= -reclaim after mae<=-dump
            def pred(s, dump=dump, reclaim=reclaim):
                seen = False
                for m in s.marks:
                    if m.pnl <= -dump:
                        seen = True
                    if seen and m.pnl >= -reclaim:
                        return m.pnl
                return None

            results.append(
                eval_hyp(f"H5 dump-{dump} then reclaim>=-{reclaim}", path_sessions, pred)
            )

    # ----- H6: bounce off trough (post-entry) -----
    print("\n--- H6 bounce off trough ---")
    for min_dump in [5, 8, 10, 12]:
        for bounce in [3, 5, 8, 10]:
            def pred(s, min_dump=min_dump, bounce=bounce):
                trough = None
                trough_pnl = None
                for m in s.marks:
                    if trough is None or m.price < trough:
                        trough = m.price
                        trough_pnl = m.pnl
                    if trough is None or trough_pnl is None:
                        continue
                    if trough_pnl > -min_dump:
                        continue
                    off = (m.price / trough - 1.0) * 100.0
                    if off >= bounce:
                        return m.pnl
                return None

            results.append(
                eval_hyp(f"H6 troughDump{min_dump}/bounce{bounce}", path_sessions, pred)
            )

    # ----- H7: time grids (falsify "no timeout") -----
    print("\n--- H7 time grids (should be weak if no timeout) ---")
    for sec in [60, 120, 180, 300, 600, 900, 1800, 3600]:
        def pred(s, sec=sec):
            m = first_mark(s, lambda m, _h: m.held >= sec)
            return m.pnl if m else None

        results.append(eval_hyp(f"H7 time>={sec}s", path_sessions, pred))

    # ----- H8: time + still red -----
    print("\n--- H8 time + still red ---")
    for sec in [300, 600, 900, 1800]:
        for red in [0, 3, 5, 8, 10]:
            def pred(s, sec=sec, red=red):
                m = first_mark(s, lambda m, _h: m.held >= sec and m.pnl <= -red)
                return m.pnl if m else None

            results.append(eval_hyp(f"H8 t>={sec}s & pnl<=-{red}", path_sessions, pred))

    # ----- H9: turn dead while underwater -----
    print("\n--- H9 turn dead while red ---")
    for red in [0, 5, 8, 10]:
        for turn_thr in [0.02, 0.03, 0.05, 0.08]:
            def pred(s, red=red, turn_thr=turn_thr):
                consec = 0
                for m in s.marks:
                    if m.turn is not None and m.pnl <= -red and m.turn <= turn_thr and m.held >= 120:
                        consec += 1
                    else:
                        consec = 0
                    if consec >= 2:
                        return m.pnl
                return None

            results.append(
                eval_hyp(f"H9 red-{red} turn<={turn_thr} x2", path_sessions, pred)
            )

    # ----- H10: MFE bank style — scale at +8 then sleeve -----
    print("\n--- H10 MFE then sleeve giveback (proxy full exit) ---")
    for arm in [5, 8, 10]:
        for sleeve in [8, 10, 12, 15]:
            def pred(s, arm=arm, sleeve=sleeve):
                armed = False
                for m in s.marks:
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.giveback <= -sleeve:
                        return m.pnl
                return None

            results.append(eval_hyp(f"H10 arm{arm}/sleeve{sleeve}", path_sessions, pred))

    # ----- H11: exit when pc5m flips green after red entry -----
    print("\n--- H11 pc5m flip to green ---")
    for thr in [0, 1, 2, 3, 5]:
        def pred(s, thr=thr):
            m = first_mark(
                s,
                lambda m, _h: m.pc5m is not None and m.pc5m >= thr and m.held >= 30,
            )
            return m.pnl if m else None

        results.append(eval_hyp(f"H11 pc5m>=+{thr}", path_sessions, pred))

    # ----- H12: MAE then giveback from trough toward peak of recovery -----
    print("\n--- H12 after MAE<=-X, exit on giveback from local recovery peak ---")
    for mae_thr in [8, 10, 12, 15]:
        for gb in [3, 5, 8]:
            def pred(s, mae_thr=mae_thr, gb=gb):
                underwater = False
                local_peak = None
                for m in s.marks:
                    if m.pnl <= -mae_thr:
                        underwater = True
                        local_peak = m.price
                    if not underwater:
                        continue
                    if local_peak is None or m.price > local_peak:
                        local_peak = m.price
                    if local_peak and m.price / local_peak - 1.0 <= -gb / 100.0:
                        return m.pnl
                return None

            results.append(
                eval_hyp(f"H12 mae{mae_thr}/recovGB{gb}", path_sessions, pred)
            )

    # ----- H13: combination — TP if green else stop -----
    print("\n--- H13 OR: TP hit OR hard stop ---")
    for tp in [8, 10, 12, 15, 20]:
        for sl in [10, 12, 15, 20]:
            def pred(s, tp=tp, sl=sl):
                m = first_mark(s, lambda m, _h: m.pnl >= tp or m.pnl <= -sl)
                return m.pnl if m else None

            results.append(eval_hyp(f"H13 TP+{tp} OR SL-{sl}", path_sessions, pred))

    # ----- H14: arm trail with stop if never arms -----
    print("\n--- H14 trail if armed else SL ---")
    for arm in [5, 8]:
        for gb in [5, 8, 10, 12]:
            for sl in [12, 15, 20, 25]:
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

                results.append(
                    eval_hyp(f"H14 arm{arm}/gb{gb}/elseSL{sl}", path_sessions, pred)
                )

    # Rank by explain_rate among rules with enough triggers
    print("\n======== TOP by explain_rate (trig>=12) ========")
    ranked = [r for r in results if r["trig"] >= 12]
    ranked.sort(key=lambda r: (-r["explain_rate"], -r["trig"], r["false_cut_winners"]))
    for r in ranked[:25]:
        print(
            f"  {r['explain_rate']*100:5.1f}% explain  trig={r['trig']:3d} "
            f"help={r['helped']:2d} hurt={r['hurt']:2d} falseW={r['false_cut_winners']:2d} "
            f"medΔ={r['med_delta']:.1f} | {r['name']}"
        )

    print("\n======== TOP by low falseW among explain>=25% ========")
    ranked2 = [r for r in ranked if r["explain_rate"] >= 0.25]
    ranked2.sort(
        key=lambda r: (
            r["false_cut_winners"],
            -r["explain_rate"],
            -r["trig"],
        )
    )
    for r in ranked2[:20]:
        print(
            f"  falseW={r['false_cut_winners']:2d} explain={r['explain_rate']*100:.0f}% "
            f"trig={r['trig']} hurt={r['hurt']} | {r['name']}"
        )

    # Per-leader check of best candidates
    print("\n======== Per-leader fit for top candidates ========")
    top_names = [r["name"] for r in ranked[:8]]
    # rebuild preds for named tops — recompute simply for H14/H2/H13 patterns via parse is hard;
    # instead re-evaluate a shortlist of structurally promising rules.
    shortlist = []
    for arm in [5, 8]:
        for gb in [5, 8, 10, 12]:
            for sl in [15, 20, 25]:
                shortlist.append((f"H14 arm{arm}/gb{gb}/elseSL{sl}", arm, gb, sl))

    def pred_h14(s, arm, gb, sl):
        armed = False
        for m in s.marks:
            if m.mfe >= arm:
                armed = True
            if armed and m.giveback <= -gb:
                return m.pnl
            if (not armed) and m.pnl <= -sl:
                return m.pnl
        return None

    by_leader = defaultdict(list)
    for s in path_sessions:
        by_leader[s.leader].append(s)

    # evaluate best overall shortlist per leader
    cand_stats = []
    for name, arm, gb, sl in shortlist:
        per = {}
        total_expl = total_trig = 0
        for lead, ss in by_leader.items():
            expl = trig = 0
            for s in ss:
                tp = pred_h14(s, arm, gb, sl)
                if tp is None:
                    continue
                trig += 1
                if abs(tp - s.final_pnl) < 3:
                    expl += 1
            per[lead] = (expl, trig, expl / trig if trig else 0)
            total_expl += expl
            total_trig += trig
        rate = total_expl / total_trig if total_trig else 0
        cand_stats.append((rate, total_trig, name, per, arm, gb, sl))
    cand_stats.sort(reverse=True)
    for rate, trig, name, per, arm, gb, sl in cand_stats[:10]:
        print(f"\n{name}: overall explain={rate*100:.0f}% trig={trig}")
        for lead, (e, t, r) in sorted(per.items()):
            print(f"  {lead}: {e}/{t} ({r*100:.0f}%)")

    # Also check H2 pure trail and H13 OR
    print("\n======== H2 pure trail per leader ========")
    for arm, gb in [(5, 8), (5, 10), (8, 8), (8, 12), (5, 12)]:
        print(f"arm{arm}/gb{gb}:")
        for lead, ss in sorted(by_leader.items()):
            expl = trig = 0
            for s in ss:
                armed = False
                tp = None
                for m in s.marks:
                    if m.mfe >= arm:
                        armed = True
                    if armed and m.giveback <= -gb:
                        tp = m.pnl
                        break
                if tp is None:
                    continue
                trig += 1
                if abs(tp - s.final_pnl) < 3:
                    expl += 1
            print(f"  {lead}: {expl}/{trig} ({(expl/trig*100 if trig else 0):.0f}%)")

    out = {
        "n_td": len(sessions),
        "n_path": len(path_sessions),
        "top": ranked[:40],
    }
    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/leader_td_exit_hypotheses.json").write_text(json.dumps(out, indent=2))
    print("\nWrote artifacts/leader_td_exit_hypotheses.json")


if __name__ == "__main__":
    main()
