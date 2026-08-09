#!/usr/bin/env python3
"""
8zkg ONLY — DIP buys only. Iterative reverse-eng of dump-depth entry + exit impulse.

Method (as demanded):
1) Take one leader dump buy → measure depth features.
2) Hypothesize a threshold/band.
3) Test coverage on OTHER mints (leave-one-mint-out + time train/test).
4) If not converging → next hypothesis family.
5) Same for sells: impulse / bounce / giveback / time.
"""
from __future__ import annotations

import json
import math
import os
import statistics as st
from collections import defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path

ROOT = Path("/opt/solana-alpha")
DATA = ROOT / "data/milddip"
LEADER = "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ"
OUT = Path("/tmp/leader-reverse")
OUT.mkdir(parents=True, exist_ok=True)


def load_env() -> None:
    p = ROOT / ".env"
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def pct(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or not (a > 0 and b > 0):
        return None
    return (b / a - 1.0) * 100.0


def dist(xs: list[float]) -> dict:
    if not xs:
        return {"n": 0}
    xs = sorted(xs)
    n = len(xs)
    return {
        "n": n,
        "p10": xs[int(0.1 * (n - 1))],
        "p25": xs[int(0.25 * (n - 1))],
        "p50": xs[n // 2],
        "p75": xs[int(0.75 * (n - 1))],
        "p90": xs[int(0.9 * (n - 1))],
        "mean": sum(xs) / n,
    }


def hist(xs: list[float], edges: list[float]) -> list[dict]:
    if not xs:
        return []
    counts = [0] * (len(edges) + 1)
    for v in xs:
        placed = False
        for i, e in enumerate(edges):
            if v <= e:
                counts[i] += 1
                placed = True
                break
        if not placed:
            counts[-1] += 1
    labels = []
    prev = None
    for e in edges:
        labels.append(f"({prev if prev is not None else '-inf'},{e}]")
        prev = e
    labels.append(f"({edges[-1]},+inf)")
    n = len(xs)
    return [{"bin": lab, "n": c, "pct": 100 * c / n} for lab, c in zip(labels, counts)]


def fit_narrowest(xs: list[float], cover: float) -> tuple[float, float] | None:
    if len(xs) < 20:
        return None
    xs = sorted(xs)
    need = max(1, int(math.ceil(cover * len(xs))))
    best = None
    for i in range(0, len(xs) - need + 1):
        lo, hi = xs[i], xs[i + need - 1]
        w = hi - lo
        if best is None or w < best[0]:
            best = (w, lo, hi)
    assert best
    return best[1], best[2]


@dataclass
class Rec:
    mint: str
    ts: int
    is_add: bool | None
    is_new: bool | None
    class_: str | None
    pc5m: float
    dump: float
    pc1h: float | None
    turn: float | None
    vol1h_mcap: float | None
    pressure: float | None
    age_h: float | None
    liq: float | None
    vol5m: float | None
    size: float | None
    entry: float | None
    dex_px: float | None
    slip: float | None
    # path depths (positive = dump depth %)
    d60: float | None = None
    d120: float | None = None
    d300: float | None = None
    d900: float | None = None
    # bounce into entry from local low in pre-window
    bounce60: float | None = None
    bounce300: float | None = None
    # exit
    close_ts: int | None = None
    exit_px: float | None = None
    held_s: float | None = None
    pnl: float | None = None
    mfe: float | None = None
    mae: float | None = None
    gb_peak: float | None = None
    bounce_from_trough: float | None = None  # exit vs min during hold
    trough_to_entry: float | None = None


def load_marks() -> dict[str, list[tuple[int, float]]]:
    by: dict[str, list[tuple[int, float]]] = defaultdict(list)
    with (DATA / "journal.jsonl").open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") not in ("mild_dip_mark", "mark"):
                continue
            mint = e.get("mint")
            ts = e.get("ts")
            px = e.get("priceUsd") or e.get("px")
            if not mint or not ts or not px:
                continue
            try:
                by[mint].append((int(ts), float(px)))
            except Exception:
                continue
    for m in by:
        by[m].sort()
    print("marks mints", len(by), "pts", sum(len(v) for v in by.values()))
    return by


def path_features(path: list[tuple[int, float]], ts: int, entry: float) -> dict:
    out: dict = {}
    for name, win in (("d60", 60_000), ("d120", 120_000), ("d300", 300_000), ("d900", 900_000)):
        pre = [px for t, px in path if ts - win <= t <= ts]
        if len(pre) >= 2:
            dd = pct(max(pre), entry)
            if dd is not None:
                out[name] = -dd  # positive depth
            # bounce from local low into entry
            b = pct(min(pre), entry)
            if name == "d60":
                out["bounce60"] = b
            if name == "d300":
                out["bounce300"] = b
    return out


def build_recs(marks: dict[str, list[tuple[int, float]]]) -> list[Rec]:
    buys = []
    flats = []
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        # skip truncated rotated fragments with timestamps in name beyond daily
        name = p.name
        if name.count("-") > 2 and not name.endswith(tuple(f"{d}.jsonl" for d in range(10))):
            # keep only YYYYMMDD.jsonl style primarily; still allow all for completeness
            pass
        for line in p.open():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("leader") != LEADER:
                continue
            if e.get("kind") == "leader_buy_observed":
                buys.append(e)
            elif e.get("kind") == "leader_session_flat":
                flats.append(e)

    flats_by: dict[str, list] = defaultdict(list)
    for f in flats:
        flats_by[f["mint"]].append(f)
    for m in flats_by:
        flats_by[m].sort(key=lambda x: x.get("blockTime") or 0)

    recs: list[Rec] = []
    used: set[tuple[str, int]] = set()
    seen_buy: set[tuple[str, int]] = set()
    for b in sorted(buys, key=lambda x: x.get("tsMs") or 0):
        d = b.get("dex") if isinstance(b.get("dex"), dict) else {}
        pc = d.get("pc5m", b.get("pc5m"))
        try:
            pc5 = float(pc)
        except (TypeError, ValueError):
            continue
        if pc5 >= 0:
            continue
        ts = int(b.get("tsMs") or (b.get("blockTime") or 0) * 1000)
        keyb = (b["mint"], ts)
        if keyb in seen_buy:
            continue
        seen_buy.add(keyb)

        vol5, liq = d.get("vol5m"), d.get("liq")
        turn = d.get("turnover5mLiq")
        if turn is None and vol5 and liq and float(liq) > 0:
            turn = float(vol5) / float(liq)
        vol1, mcap = d.get("vol1h"), d.get("mcap")
        v2m = float(vol1) / float(mcap) if vol1 and mcap and float(mcap) > 0 else None
        buys5, sells5 = d.get("buys5m"), d.get("sells5m")
        pressure = (
            float(buys5) / float(sells5) if buys5 is not None and sells5 and float(sells5) > 0 else None
        )
        entry = b.get("fillPriceUsd")
        dex_px = d.get("priceUsd")
        try:
            entry_f = float(entry) if entry else None
        except (TypeError, ValueError):
            entry_f = None
        try:
            dex_f = float(dex_px) if dex_px else None
        except (TypeError, ValueError):
            dex_f = None
        econ = entry_f if entry_f and entry_f > 0 else dex_f
        slip = pct(dex_f, entry_f) if entry_f and dex_f else None
        if slip is not None and abs(slip) > 30:
            econ = dex_f
            slip = None

        flat = None
        bt = int(b.get("blockTime") or ts // 1000)
        for f in flats_by.get(b["mint"], []):
            fbt = int(f.get("blockTime") or 0)
            key = (b["mint"], fbt)
            if key in used:
                continue
            if fbt >= bt:
                flat = f
                used.add(key)
                break

        r = Rec(
            mint=b["mint"],
            ts=ts,
            is_add=b.get("isAdd"),
            is_new=b.get("isNewBag"),
            class_=b.get("class"),
            pc5m=pc5,
            dump=-pc5,
            pc1h=float(d["pc1h"]) if d.get("pc1h") is not None else None,
            turn=float(turn) if turn is not None else None,
            vol1h_mcap=v2m,
            pressure=pressure,
            age_h=float(d["ageHours"]) if d.get("ageHours") is not None else None,
            liq=float(liq) if liq is not None else None,
            vol5m=float(vol5) if vol5 is not None else None,
            size=float(b["sizeUsd"]) if b.get("sizeUsd") else None,
            entry=econ,
            dex_px=dex_f,
            slip=slip,
        )
        path = marks.get(b["mint"], [])
        if path and econ:
            pf = path_features(path, ts, econ)
            r.d60 = pf.get("d60")
            r.d120 = pf.get("d120")
            r.d300 = pf.get("d300")
            r.d900 = pf.get("d900")
            r.bounce60 = pf.get("bounce60")
            r.bounce300 = pf.get("bounce300")

        if flat and econ:
            r.close_ts = int(flat.get("blockTime") or 0) * 1000
            r.held_s = float(flat["heldSec"]) if flat.get("heldSec") is not None else None
            try:
                r.exit_px = float(flat["exitPriceUsd"]) if flat.get("exitPriceUsd") else None
            except (TypeError, ValueError):
                r.exit_px = None
            # prefer flat pnlPct if sane (observer's own), else entry/exit
            raw = flat.get("pnlPctApprox")
            imp = pct(econ, r.exit_px)
            if isinstance(raw, (int, float)) and -80 <= float(raw) <= 200:
                r.pnl = float(raw)
            elif imp is not None and -80 <= imp <= 200:
                r.pnl = imp
            if r.close_ts and path:
                during = [px for t, px in path if ts <= t <= r.close_ts]
                if during:
                    mfes = [pct(econ, px) for px in during]
                    mfes = [x for x in mfes if x is not None and -95 < x < 500]
                    if mfes:
                        r.mfe = max(mfes)
                        r.mae = min(mfes)
                    trough = min(during)
                    peak = max(during)
                    if r.exit_px:
                        r.gb_peak = pct(peak, r.exit_px)
                        r.bounce_from_trough = pct(trough, r.exit_px)
                        r.trough_to_entry = pct(econ, trough)
        recs.append(r)
    return recs


def leave_one_mint_coverage(recs: list[Rec], pred) -> dict:
    """For each mint held out: fit nothing (coverage of fixed rule), report mean coverage on held-out mints."""
    by_m: dict[str, list[Rec]] = defaultdict(list)
    for r in recs:
        by_m[r.mint].append(r)
    if len(by_m) < 5:
        return {"n_mints": len(by_m), "mean_te": None}
    scores = []
    for m, arr in by_m.items():
        if not arr:
            continue
        scores.append(sum(1 for r in arr if pred(r)) / len(arr))
    return {
        "n_mints": len(scores),
        "mean_te": sum(scores) / len(scores) if scores else None,
        "p50_te": sorted(scores)[len(scores) // 2] if scores else None,
        "p25_te": sorted(scores)[len(scores) // 4] if scores else None,
    }


def eval_rule(name: str, fam: str, recs: list[Rec], pred, train: list[Rec], test: list[Rec], width=None) -> dict:
    def cov(arr):
        return sum(1 for r in arr if pred(r)) / len(arr) if arr else 0.0

    tr, te = cov(train), cov(test)
    lom = leave_one_mint_coverage(recs, pred)
    return {
        "fam": fam,
        "rule": name,
        "tr": tr,
        "te": te,
        "gap": abs(tr - te),
        "lom_mean": lom.get("mean_te"),
        "lom_p50": lom.get("p50_te"),
        "lom_p25": lom.get("p25_te"),
        "n_mints": lom.get("n_mints"),
        "w": width,
        "n_tr": len(train),
        "n_te": len(test),
    }


def converged(r: dict, te_min=0.70, gap_max=0.08, lom_min=0.60, w_max=12.0) -> bool:
    if r["te"] < te_min:
        return False
    if r["gap"] > gap_max:
        return False
    if r.get("lom_mean") is None or r["lom_mean"] < lom_min:
        return False
    if r.get("w") is not None and r["w"] > w_max:
        return False
    return True


def main() -> None:
    load_env()
    marks = load_marks()
    recs = build_recs(marks)
    print("dip buys", len(recs), "closed_sane", sum(1 for r in recs if r.pnl is not None))
    print(
        "path cov",
        {
            "d60": sum(1 for r in recs if r.d60 is not None),
            "d120": sum(1 for r in recs if r.d120 is not None),
            "d300": sum(1 for r in recs if r.d300 is not None),
            "d900": sum(1 for r in recs if r.d900 is not None),
        },
    )

    # Seed examples: first 5 NEW dip buys with path — show measured depths
    seeds = [r for r in recs if r.is_new and r.d300 is not None][:5]
    if not seeds:
        seeds = [r for r in recs if r.d300 is not None][:5]
    print("\n=== SEED TRADES (measure then generalize) ===")
    for r in seeds:
        print(
            f"  {r.mint[:8]} dump_pc5m={r.dump:.2f} d60={r.d60} d120={r.d120} d300={r.d300} "
            f"bounce300={r.bounce300} turn={r.turn} size={r.size}"
        )

    recs_s = sorted(recs, key=lambda r: r.ts)
    mid = len(recs_s) // 2
    train, test = recs_s[:mid], recs_s[mid:]

    hypotheses: list[dict] = []
    narrative: list[str] = []

    # H1: single dump_pc5m magic number ±2
    narrative.append("H1: single dump depth magic (±2 around candidate)")
    for center in (5, 6, 8, 10, 12, 15, 18, 20):
        lo, hi = center - 2, center + 2
        hypotheses.append(
            eval_rule(
                f"dump≈{center}% (±2 → [{lo},{hi}])",
                "H1_magic_dump",
                recs,
                lambda r, lo=lo, hi=hi: lo <= r.dump <= hi,
                train,
                test,
                width=hi - lo,
            )
        )

    # H2: dump band (progressive narrowing)
    narrative.append("H2: dump band progressive")
    for lo in (2, 3, 4, 5, 6, 8):
        for hi in (10, 12, 15, 18, 20):
            if hi - lo > 15 or hi <= lo:
                continue
            hypotheses.append(
                eval_rule(
                    f"{lo}<=dump_pc5m<={hi}",
                    "H2_dump_band",
                    recs,
                    lambda r, lo=lo, hi=hi: lo <= r.dump <= hi,
                    train,
                    test,
                    width=hi - lo,
                )
            )

    # H3: path depth d300 magic/bands
    narrative.append("H3: marks path depth d300")
    tr_p = [r for r in train if r.d300 is not None]
    te_p = [r for r in test if r.d300 is not None]
    all_p = [r for r in recs if r.d300 is not None]
    for center in (5, 8, 10, 12, 15):
        lo, hi = center - 2.5, center + 2.5
        hypotheses.append(
            eval_rule(
                f"d300≈{center}% (±2.5)",
                "H3_d300_magic",
                all_p,
                lambda r, lo=lo, hi=hi: r.d300 is not None and lo <= r.d300 <= hi,
                tr_p,
                te_p,
                width=5.0,
            )
        )
    for lo, hi in ((3, 12), (3, 15), (5, 15), (5, 18), (8, 18), (4, 14)):
        hypotheses.append(
            eval_rule(
                f"{lo}<=d300<={hi}",
                "H3_d300_band",
                all_p,
                lambda r, lo=lo, hi=hi: r.d300 is not None and lo <= r.d300 <= hi,
                tr_p,
                te_p,
                width=hi - lo,
            )
        )

    # H4: dump + micro-bounce (he buys after small bounce off low, not knife tip)
    narrative.append("H4: dump + bounce-off-low into entry")
    for dlo, dhi in ((5, 20), (8, 25), (3, 15)):
        for blo, bhi in ((0.5, 3), (1, 5), (0.3, 2), (1, 8)):
            def pred(r, dlo=dlo, dhi=dhi, blo=blo, bhi=bhi):
                if r.bounce300 is None:
                    return False
                return dlo <= r.dump <= dhi and blo <= r.bounce300 <= bhi

            pool = [r for r in recs if r.bounce300 is not None]
            hypotheses.append(
                eval_rule(
                    f"{dlo}<=dump<={dhi} & {blo}<=bounce300<={bhi}",
                    "H4_dump_bounce",
                    pool,
                    pred,
                    [r for r in train if r.bounce300 is not None],
                    [r for r in test if r.bounce300 is not None],
                    width=(dhi - dlo) + (bhi - blo),
                )
            )

    # H5: NEW bag only dump band
    narrative.append("H5: NEW bag dump band")
    tr_n = [r for r in train if r.is_new]
    te_n = [r for r in test if r.is_new]
    all_n = [r for r in recs if r.is_new]
    for lo, hi in ((3, 12), (3, 15), (5, 15), (5, 18), (8, 20), (4, 14)):
        hypotheses.append(
            eval_rule(
                f"NEW & {lo}<=dump<={hi}",
                "H5_new_dump",
                all_n,
                lambda r, lo=lo, hi=hi: bool(r.is_new) and lo <= r.dump <= hi,
                tr_n,
                te_n,
                width=hi - lo,
            )
        )

    # H6: dump + turn gate
    narrative.append("H6: dump + turnover")
    for tmin in (0.03, 0.05, 0.08, 0.10, 0.14):
        for lo, hi in ((3, 15), (5, 18), (5, 20), (8, 20)):
            pool = [r for r in recs if r.turn is not None]
            hypotheses.append(
                eval_rule(
                    f"{lo}<=dump<={hi} & turn>={tmin}",
                    "H6_dump_turn",
                    pool,
                    lambda r, lo=lo, hi=hi, tmin=tmin: r.turn is not None
                    and r.turn >= tmin
                    and lo <= r.dump <= hi,
                    [r for r in train if r.turn is not None],
                    [r for r in test if r.turn is not None],
                    width=hi - lo,
                )
            )

    # H7: conditional — high turn shallow / low turn deeper
    narrative.append("H7: turn-conditional dump")
    for tcut in (0.08, 0.12, 0.18):
        for shallow, deep in (
            ((3, 10), (8, 22)),
            ((3, 12), (8, 25)),
            ((4, 12), (10, 25)),
            ((5, 12), (10, 22)),
        ):
            def pred(r, tcut=tcut, shallow=shallow, deep=deep):
                if r.turn is None:
                    return False
                lo, hi = shallow if r.turn >= tcut else deep
                return lo <= r.dump <= hi

            pool = [r for r in recs if r.turn is not None]
            hypotheses.append(
                eval_rule(
                    f"turn>={tcut}? dump{shallow}: dump{deep}",
                    "H7_conditional",
                    pool,
                    pred,
                    [r for r in train if r.turn is not None],
                    [r for r in test if r.turn is not None],
                    width=max(shallow[1] - shallow[0], deep[1] - deep[0]),
                )
            )

    # H8: fit narrowest 70% band on train dump, validate
    narrative.append("H8: data-fit narrowest 70/80% dump band on train")
    for cover in (0.6, 0.7, 0.8):
        band = fit_narrowest([r.dump for r in train], cover)
        if not band:
            continue
        lo, hi = band
        hypotheses.append(
            eval_rule(
                f"fit{cover}: {lo:.2f}<=dump<={hi:.2f}",
                "H8_fitband",
                recs,
                lambda r, lo=lo, hi=hi: lo <= r.dump <= hi,
                train,
                test,
                width=hi - lo,
            )
        )

    # H9: d60 knife — he catches 1-min dump of X%
    narrative.append("H9: 60s path dump")
    tr60 = [r for r in train if r.d60 is not None]
    te60 = [r for r in test if r.d60 is not None]
    all60 = [r for r in recs if r.d60 is not None]
    for lo, hi in ((2, 8), (3, 10), (3, 12), (5, 12), (5, 15), (2, 10)):
        hypotheses.append(
            eval_rule(
                f"{lo}<=d60<={hi}",
                "H9_d60",
                all60,
                lambda r, lo=lo, hi=hi: r.d60 is not None and lo <= r.d60 <= hi,
                tr60,
                te60,
                width=hi - lo,
            )
        )

    # Rank + converged
    def rank(r):
        lom = r["lom_mean"] if r["lom_mean"] is not None else 0
        return (-r["te"], -lom, r["gap"], r.get("w") or 999)

    hypotheses.sort(key=rank)
    conv = [h for h in hypotheses if converged(h)]
    # softer convergence for reporting
    soft = [
        h
        for h in hypotheses
        if h["te"] >= 0.65 and h["gap"] <= 0.10 and (h.get("lom_mean") or 0) >= 0.55
    ]

    print("\n=== ENTRY HYPOTHESIS SEARCH ===")
    print("tested", len(hypotheses), "hard_converged", len(conv), "soft", len(soft))
    show = conv[:12] or soft[:12] or hypotheses[:12]
    for h in show:
        print(
            f"{h['fam']:16s} te={h['te']*100:5.1f}% tr={h['tr']*100:5.1f}% "
            f"lom={None if h['lom_mean'] is None else round(h['lom_mean']*100,1)} "
            f"w={h.get('w')} | {h['rule']}"
        )

    print("\n=== BEST PER FAMILY ===")
    best_fam = {}
    byf = defaultdict(list)
    for h in hypotheses:
        byf[h["fam"]].append(h)
    for fam, arr in byf.items():
        arr.sort(key=rank)
        best_fam[fam] = arr[0]
        h = arr[0]
        print(
            f"{fam:16s} te={h['te']*100:5.1f}% tr={h['tr']*100:5.1f}% "
            f"lom={None if h['lom_mean'] is None else round(h['lom_mean']*100,1)} | {h['rule']}"
        )

    # Distributions
    print("\n=== DUMP DISTS ===")
    print("dump_pc5m", dist([r.dump for r in recs]))
    print("d60", dist([r.d60 for r in recs if r.d60 is not None]))
    print("d300", dist([r.d300 for r in recs if r.d300 is not None]))
    print("bounce300", dist([r.bounce300 for r in recs if r.bounce300 is not None]))
    print("slip", dist([r.slip for r in recs if r.slip is not None]))

    # ---------- EXIT ----------
    closed = [r for r in recs if r.pnl is not None]
    print("\n=== EXIT set n=", len(closed))
    w = [r for r in closed if r.pnl is not None and r.pnl > 0]
    l = [r for r in closed if r.pnl is not None and r.pnl <= 0]
    print("impulse", dist([r.pnl for r in closed]))
    print("winners", dist([r.pnl for r in w]), "hold_m", dist([r.held_s / 60 for r in w if r.held_s]))
    print("losers", dist([r.pnl for r in l]), "hold_m", dist([r.held_s / 60 for r in l if r.held_s]))
    print("mfe", dist([r.mfe for r in closed if r.mfe is not None]))
    print("bounce_from_trough@exit", dist([r.bounce_from_trough for r in closed if r.bounce_from_trough is not None]))

    tr_c = [r for r in train if r.pnl is not None]
    te_c = [r for r in test if r.pnl is not None]
    exit_h = []

    # E1: fixed TP impulse
    for x in (5, 8, 10, 12, 15, 20, 25, 30, 40, 50):
        exit_h.append(
            eval_rule(
                f"TP impulse >= +{x}%",
                "E1_tp",
                closed,
                lambda r, x=x: r.pnl is not None and r.pnl >= x,
                tr_c,
                te_c,
                width=None,
            )
        )

    # E2: TP OR hard time
    for x in (8, 10, 15, 20, 30):
        for tm in (10, 15, 20, 30, 45):
            exit_h.append(
                eval_rule(
                    f"pnl>=+{x} OR hold<={tm}m",
                    "E2_tp_or_time",
                    closed,
                    lambda r, x=x, tm=tm: (r.pnl is not None and r.pnl >= x)
                    or ((r.held_s or 0) <= tm * 60),
                    tr_c,
                    te_c,
                )
            )

    # E3: winners hit +X (coverage among winners only)
    tr_w = [r for r in tr_c if r.pnl and r.pnl > 0]
    te_w = [r for r in te_c if r.pnl and r.pnl > 0]
    all_w = [r for r in closed if r.pnl and r.pnl > 0]
    for x in (8, 10, 15, 20, 25, 30, 40, 50):
        exit_h.append(
            eval_rule(
                f"WINNERS pnl>=+{x}",
                "E3_winner_tp",
                all_w,
                lambda r, x=x: r.pnl is not None and r.pnl >= x,
                tr_w,
                te_w,
            )
        )

    # E4: loser cut at -X
    tr_l = [r for r in tr_c if r.pnl is not None and r.pnl <= 0]
    te_l = [r for r in te_c if r.pnl is not None and r.pnl <= 0]
    all_l = [r for r in closed if r.pnl is not None and r.pnl <= 0]
    for x in (8, 10, 15, 20, 25, 30, 40, 50):
        exit_h.append(
            eval_rule(
                f"LOSERS pnl<=-{x}",
                "E4_loser_cut",
                all_l,
                lambda r, x=x: r.pnl is not None and r.pnl <= -x,
                tr_l,
                te_l,
            )
        )

    # E5: arm MFE then giveback
    tr_g = [r for r in tr_c if r.mfe is not None and r.gb_peak is not None]
    te_g = [r for r in te_c if r.mfe is not None and r.gb_peak is not None]
    all_g = [r for r in closed if r.mfe is not None and r.gb_peak is not None]
    for arm in (8, 10, 15, 20, 30):
        for gb in (5, 8, 10, 15, 20, 30):
            def pred(r, arm=arm, gb=gb):
                if r.mfe is None or r.gb_peak is None:
                    return False
                if r.mfe < arm:
                    return False
                # exit within gb±5 of peak giveback
                return -(gb + 5) <= (r.gb_peak or 0) <= -(gb - 5) if gb >= 5 else False

            exit_h.append(
                eval_rule(
                    f"MFE>={arm} & gb≈-{gb}%",
                    "E5_arm_gb",
                    all_g,
                    pred,
                    tr_g,
                    te_g,
                )
            )

    # E6: bounce from trough — he sells after +X bounce off hold low
    tr_b = [r for r in tr_c if r.bounce_from_trough is not None]
    te_b = [r for r in te_c if r.bounce_from_trough is not None]
    all_b = [r for r in closed if r.bounce_from_trough is not None]
    for x in (10, 15, 20, 30, 40, 50, 80):
        exit_h.append(
            eval_rule(
                f"exit bounce_from_trough>=+{x}",
                "E6_trough_bounce",
                all_b,
                lambda r, x=x: r.bounce_from_trough is not None and r.bounce_from_trough >= x,
                tr_b,
                te_b,
            )
        )

    # E7: fit winner impulse band 70%
    if len(tr_w) >= 15:
        for cover in (0.6, 0.7):
            band = fit_narrowest([r.pnl for r in tr_w if r.pnl is not None], cover)
            if band:
                lo, hi = band
                exit_h.append(
                    eval_rule(
                        f"winner fit{cover}: {lo:.1f}..{hi:.1f}",
                        "E7_winner_fit",
                        all_w,
                        lambda r, lo=lo, hi=hi: r.pnl is not None and lo <= r.pnl <= hi,
                        tr_w,
                        te_w,
                        width=hi - lo,
                    )
                )

    exit_h.sort(key=rank)
    # For exits: "explain his close" — high coverage among relevant subset with train/test align
    exit_conv = [
        h
        for h in exit_h
        if h["fam"] in ("E3_winner_tp", "E4_loser_cut", "E6_trough_bounce", "E7_winner_fit", "E5_arm_gb")
        and h["te"] >= 0.65
        and h["gap"] <= 0.12
        and (h.get("lom_mean") or 0) >= 0.55
    ]

    print("\n=== EXIT HYPOTHESES (subset-aware) ===")
    print("hard-ish converged", len(exit_conv))
    for h in (exit_conv[:15] or exit_h[:15]):
        print(
            f"{h['fam']:16s} te={h['te']*100:5.1f}% tr={h['tr']*100:5.1f}% "
            f"lom={None if h['lom_mean'] is None else round(h['lom_mean']*100,1)} | {h['rule']}"
        )

    print("\n=== BEST EXIT PER FAMILY ===")
    best_ex = {}
    byfe = defaultdict(list)
    for h in exit_h:
        byfe[h["fam"]].append(h)
    for fam, arr in byfe.items():
        arr.sort(key=rank)
        best_ex[fam] = arr[0]
        h = arr[0]
        print(
            f"{fam:16s} te={h['te']*100:5.1f}% tr={h['tr']*100:5.1f}% "
            f"lom={None if h['lom_mean'] is None else round(h['lom_mean']*100,1)} | {h['rule']}"
        )

    # Concrete next assumptions if not converged
    print("\n======== VERDICT ========")
    if conv:
        print("ENTRY HARD CONVERGED:")
        for h in conv[:5]:
            print(" ", h["rule"], f"te={h['te']*100:.1f} lom={h['lom_mean']}")
    else:
        print("ENTRY: no hard converge (te>=70, gap<=8, lom>=60, width<=12).")
        print("Soft candidates:")
        for h in soft[:8]:
            print(" ", h["rule"], f"te={h['te']*100:.1f} lom={h['lom_mean']} w={h.get('w')}")
        d = dist([r.dump for r in recs])
        print(
            f"Raw dump_pc5m is WIDE: p25={d.get('p25'):.2f} p50={d.get('p50'):.2f} p75={d.get('p75'):.2f} "
            f"— not a single hardcoded depth."
        )

    if exit_conv:
        print("EXIT CONVERGED:")
        for h in exit_conv[:5]:
            print(" ", h["rule"], f"te={h['te']*100:.1f}")
    else:
        print("EXIT: no single impulse number explains closes.")
        if w:
            wd = dist([r.pnl for r in w])
            print(f"Winner impulse p25/50/75 = {wd.get('p25'):.1f}/{wd.get('p50'):.1f}/{wd.get('p75'):.1f}")
        if l:
            ld = dist([r.pnl for r in l])
            print(f"Loser impulse p25/50/75 = {ld.get('p25'):.1f}/{ld.get('p50'):.1f}/{ld.get('p75'):.1f}")

    # Per-mint consistency of "best soft entry"
    best_soft = (soft[0] if soft else hypotheses[0])
    print("\nBest soft entry rule:", best_soft["rule"])

    payload = {
        "n_dip": len(recs),
        "n_closed": len(closed),
        "path_cov": {
            "d60": sum(1 for r in recs if r.d60 is not None),
            "d300": sum(1 for r in recs if r.d300 is not None),
        },
        "seeds": [asdict(r) for r in seeds],
        "dump_dist": dist([r.dump for r in recs]),
        "d60_dist": dist([r.d60 for r in recs if r.d60 is not None]),
        "d300_dist": dist([r.d300 for r in recs if r.d300 is not None]),
        "bounce300_dist": dist([r.bounce300 for r in recs if r.bounce300 is not None]),
        "dump_hist": hist([r.dump for r in recs], [3, 5, 8, 10, 12, 15, 20, 25, 35]),
        "entry_hard_converged": conv[:20],
        "entry_soft": soft[:20],
        "entry_best_per_family": best_fam,
        "exit_converged": exit_conv[:20],
        "exit_best_per_family": best_ex,
        "winners": {
            "n": len(w),
            "impulse": dist([r.pnl for r in w]),
            "hold_m": dist([r.held_s / 60 for r in w if r.held_s]),
            "hist": hist([r.pnl for r in w], [5, 10, 15, 20, 30, 50, 80]),
        },
        "losers": {
            "n": len(l),
            "impulse": dist([r.pnl for r in l]),
            "hold_m": dist([r.held_s / 60 for r in l if r.held_s]),
            "hist": hist([r.pnl for r in l], [-50, -30, -20, -15, -10, -5, 0]),
        },
        "narrative": narrative,
    }
    outp = OUT / "8zkg-dip-reverse-v3.json"
    outp.write_text(json.dumps(payload, indent=2))
    print("Wrote", outp)


if __name__ == "__main__":
    main()
