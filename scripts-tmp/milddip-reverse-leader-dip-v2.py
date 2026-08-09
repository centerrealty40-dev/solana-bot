#!/usr/bin/env python3
"""
8zkg ONLY. DIP entries only (pc5m < 0).

Hypothesis search until entry/exit numbers converge on train/test.
Path features from our mild_dip marks (+ PG snapshots when present).
"""
from __future__ import annotations

import json
import math
import os
import statistics as st
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

ROOT = Path("/opt/solana-alpha")
DATA = ROOT / "data/milddip"
LEADER = "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ"
OUT = Path("/tmp/leader-reverse")
OUT.mkdir(parents=True, exist_ok=True)


def load_env() -> None:
    for line in (ROOT / ".env").read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def pct(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or not (a > 0 and b > 0):
        return None
    return (b / a - 1.0) * 100.0


@dataclass
class Rec:
    mint: str
    ts: int
    is_add: bool | None
    is_new: bool | None
    pc5m: float
    dump: float  # -pc5m
    pc1h: float | None
    turn: float | None
    vol1h_mcap: float | None
    pressure: float | None
    age_h: float | None
    liq: float | None
    size: float | None
    entry: float | None
    dex_px: float | None
    slip: float | None
    fill_src: str | None
    class_: str | None
    dd5m: float | None = None  # entry vs max mark in 5m before
    dd15m: float | None = None
    # exit
    close_ts: int | None = None
    exit_px: float | None = None
    held_s: float | None = None
    pnl: float | None = None  # sane impulse %
    mfe: float | None = None
    mae: float | None = None
    gb_peak: float | None = None  # exit vs peak during hold %


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


def load_pg_paths(mints: list[str], t0: int, t1: int) -> dict[str, list[tuple[int, float]]]:
    out: dict[str, list[tuple[int, float]]] = defaultdict(list)
    try:
        import psycopg2
    except ImportError:
        return out
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return out
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()
    for table in ("pumpswap_pair_snapshots", "raydium_pair_snapshots", "meteora_pair_snapshots"):
        try:
            cur.execute(
                f"""
                SELECT base_mint, (EXTRACT(EPOCH FROM ts)*1000)::bigint, price_usd
                FROM {table}
                WHERE base_mint = ANY(%s)
                  AND ts >= to_timestamp(%s/1000.0)
                  AND ts <= to_timestamp(%s/1000.0)
                  AND price_usd IS NOT NULL
                """,
                (mints, t0, t1),
            )
            rows = cur.fetchall()
            print(f"PG {table} rows", len(rows))
            for mint, ts, px in rows:
                out[str(mint)].append((int(ts), float(px)))
        except Exception as e:
            conn.rollback()
            print("PG fail", table, e)
    conn.close()
    for m in out:
        out[m].sort()
    return out


def merge_paths(
    a: dict[str, list[tuple[int, float]]], b: dict[str, list[tuple[int, float]]]
) -> dict[str, list[tuple[int, float]]]:
    out: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for src in (a, b):
        for m, pts in src.items():
            out[m].extend(pts)
    for m in out:
        out[m].sort()
        # dedupe near
        compact: list[tuple[int, float]] = []
        for ts, px in out[m]:
            if compact and abs(ts - compact[-1][0]) < 500 and abs(px / compact[-1][1] - 1) < 0.002:
                compact[-1] = (ts, px)
            else:
                compact.append((ts, px))
        out[m] = compact
    return out


def build_recs(marks: dict[str, list[tuple[int, float]]]) -> list[Rec]:
    buys = []
    flats = []
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        for line in p.open():
            e = json.loads(line)
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
    for b in sorted(buys, key=lambda x: x.get("tsMs") or 0):
        d = b.get("dex") if isinstance(b.get("dex"), dict) else {}
        pc = d.get("pc5m", b.get("pc5m"))
        try:
            pc5 = float(pc)
        except (TypeError, ValueError):
            continue
        if pc5 >= 0:
            continue  # DIP ONLY
        ts = int(b.get("tsMs") or (b.get("blockTime") or 0) * 1000)
        vol5, liq = d.get("vol5m"), d.get("liq")
        turn = d.get("turnover5mLiq")
        if turn is None and vol5 and liq and float(liq) > 0:
            turn = float(vol5) / float(liq)
        vol1, mcap = d.get("vol1h"), d.get("mcap")
        v2m = float(vol1) / float(mcap) if vol1 and mcap and float(mcap) > 0 else None
        buys5, sells5 = d.get("buys5m"), d.get("sells5m")
        pressure = float(buys5) / float(sells5) if buys5 is not None and sells5 and float(sells5) > 0 else None
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
        # prefer dex mid as economic entry if fill missing/garbage
        econ = entry_f if entry_f and entry_f > 0 else dex_f
        slip = pct(dex_f, entry_f) if entry_f and dex_f else None
        # insane slip => ignore fill, use dex
        if slip is not None and abs(slip) > 30:
            econ = dex_f
            slip = None

        # match flat after this buy
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
            pc5m=pc5,
            dump=-pc5,
            pc1h=float(d["pc1h"]) if d.get("pc1h") is not None else None,
            turn=float(turn) if turn is not None else None,
            vol1h_mcap=v2m,
            pressure=pressure,
            age_h=float(d["ageHours"]) if d.get("ageHours") is not None else None,
            liq=float(liq) if liq is not None else None,
            size=float(b["sizeUsd"]) if b.get("sizeUsd") else None,
            entry=econ,
            dex_px=dex_f,
            slip=slip,
            fill_src=b.get("fillPriceSource") or b.get("sizeUsdSource"),
            class_=b.get("class"),
        )

        path = marks.get(b["mint"], [])
        if path and econ:
            pre5 = [px for t, px in path if ts - 300_000 <= t <= ts]
            pre15 = [px for t, px in path if ts - 900_000 <= t <= ts]
            if len(pre5) >= 2:
                r.dd5m = pct(max(pre5), econ)
            if len(pre15) >= 2:
                r.dd15m = pct(max(pre15), econ)

        if flat and econ:
            r.close_ts = int(flat.get("blockTime") or 0) * 1000
            r.held_s = float(flat["heldSec"]) if flat.get("heldSec") is not None else None
            try:
                r.exit_px = float(flat["exitPriceUsd"]) if flat.get("exitPriceUsd") else None
            except (TypeError, ValueError):
                r.exit_px = None
            # impulse from econ entry/exit; reject garbage
            imp = pct(econ, r.exit_px)
            raw = flat.get("pnlPctApprox")
            if imp is not None and -80 <= imp <= 200:
                r.pnl = imp
            elif isinstance(raw, (int, float)) and -80 <= float(raw) <= 200:
                r.pnl = float(raw)
            # mfe/mae from marks during hold
            if r.close_ts and path:
                during = [px for t, px in path if ts <= t <= r.close_ts]
                if during:
                    r.mfe = max(pct(econ, px) or -999 for px in during)
                    r.mae = min(pct(econ, px) or 999 for px in during)
                    if r.mfe is not None and r.mfe < -900:
                        r.mfe = None
                    if r.mae is not None and r.mae > 900:
                        r.mae = None
                    peak = max(during)
                    if r.exit_px:
                        r.gb_peak = pct(peak, r.exit_px)
        recs.append(r)
    return recs


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


def hist(xs: list[float], edges: list[float]) -> list[tuple[str, int, float]]:
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
    return [(lab, c, 100 * c / n) for lab, c in zip(labels, counts)]


def cov(xs: list[float], lo: float, hi: float) -> float:
    if not xs:
        return 0.0
    return sum(1 for v in xs if lo <= v <= hi) / len(xs)


def fit_band(xs: list[float], cover: float) -> tuple[float, float] | None:
    if len(xs) < 12:
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


def main() -> None:
    load_env()
    marks = load_marks()
    # preliminary recs without pg
    recs = build_recs(marks)
    print("dip buys", len(recs), "closed_sane", sum(1 for r in recs if r.pnl is not None))
    print("with dd5m(marks)", sum(1 for r in recs if r.dd5m is not None))

    # try PG enrich
    mints = list({r.mint for r in recs})
    t0 = min(r.ts for r in recs) - 3600_000
    t1 = max((r.close_ts or r.ts) for r in recs) + 3600_000
    pg = load_pg_paths(mints, t0, t1)
    if pg:
        marks2 = merge_paths(marks, pg)
        recs = build_recs(marks2)
        print("after PG: dd5m", sum(1 for r in recs if r.dd5m is not None))

    dumps = [r.dump for r in recs]
    dd5 = [-(r.dd5m) for r in recs if r.dd5m is not None]  # positive depth
    print("\n=== DUMP DEPTH dist ===")
    print("dump=-pc5m", dist(dumps))
    print("depth5m=-dd5m(marks)", dist(dd5))
    print("\nHIST dump_pc5m %:")
    for lab, c, p in hist(dumps, [3, 5, 8, 10, 12, 15, 20, 25, 35]):
        print(f"  {lab:16s} n={c:4d} ({p:5.1f}%)")
    if dd5:
        print("\nHIST depth5m(marks) %:")
        for lab, c, p in hist(dd5, [3, 5, 8, 10, 12, 15, 20, 25, 35]):
            print(f"  {lab:16s} n={c:4d} ({p:5.1f}%)")

    # train/test
    recs_s = sorted(recs, key=lambda r: r.ts)
    mid = len(recs_s) // 2
    train, test = recs_s[:mid], recs_s[mid:]

    print("\n=== ENTRY hypotheses ===")
    results = []
    # A single-parameter dump bands
    for lo in (2, 3, 4, 5, 6, 8, 10):
        for hi in (8, 10, 12, 15, 18, 20, 25, 30):
            if hi <= lo:
                continue
            tr = [r.dump for r in train]
            te = [r.dump for r in test]
            results.append(
                {
                    "fam": "dump",
                    "rule": f"{lo}<=dump<= {hi}",
                    "tr": cov(tr, lo, hi),
                    "te": cov(te, lo, hi),
                    "w": hi - lo,
                    "lo": lo,
                    "hi": hi,
                }
            )
    # B dump + turn
    for turn_min in (0.03, 0.05, 0.09, 0.14):
        for lo, hi in ((3, 12), (3, 15), (5, 15), (5, 20), (8, 20), (8, 25)):
            def ok(r: Rec, lo=lo, hi=hi, turn_min=turn_min) -> bool:
                return r.turn is not None and r.turn >= turn_min and lo <= r.dump <= hi

            tr_n = [r for r in train if r.turn is not None]
            te_n = [r for r in test if r.turn is not None]
            results.append(
                {
                    "fam": "dump+turn",
                    "rule": f"{lo}<=dump<={hi} & turn>={turn_min}",
                    "tr": sum(1 for r in tr_n if ok(r)) / len(tr_n) if tr_n else 0,
                    "te": sum(1 for r in te_n if ok(r)) / len(te_n) if te_n else 0,
                    "w": hi - lo,
                    "lo": lo,
                    "hi": hi,
                    "turn": turn_min,
                }
            )
    # C conditional: high-turn shallow vs low-turn deeper
    for tcut in (0.09, 0.14, 0.2):
        for shallow in ((3, 10), (3, 12), (5, 12)):
            for deep in ((8, 20), (10, 25), (8, 25), (5, 20)):
                def ok(r: Rec, tcut=tcut, shallow=shallow, deep=deep) -> bool:
                    if r.turn is None:
                        return False
                    lo, hi = shallow if r.turn >= tcut else deep
                    return lo <= r.dump <= hi

                tr_n = [r for r in train if r.turn is not None]
                te_n = [r for r in test if r.turn is not None]
                results.append(
                    {
                        "fam": "turn_conditional_dump",
                        "rule": f"turn>={tcut}: dump{shallow} else dump{deep}",
                        "tr": sum(1 for r in tr_n if ok(r)) / len(tr_n) if tr_n else 0,
                        "te": sum(1 for r in te_n if ok(r)) / len(te_n) if te_n else 0,
                        "w": max(shallow[1] - shallow[0], deep[1] - deep[0]),
                    }
                )
    # D marks depth5m bands
    tr_dd = [-(r.dd5m) for r in train if r.dd5m is not None]
    te_dd = [-(r.dd5m) for r in test if r.dd5m is not None]
    if len(tr_dd) >= 20:
        for lo in (2, 3, 5, 8):
            for hi in (10, 12, 15, 20, 25):
                if hi <= lo:
                    continue
                results.append(
                    {
                        "fam": "depth5m_marks",
                        "rule": f"{lo}<=depth5m<={hi}",
                        "tr": cov(tr_dd, lo, hi),
                        "te": cov(te_dd, lo, hi),
                        "w": hi - lo,
                        "n_tr": len(tr_dd),
                        "n_te": len(te_dd),
                    }
                )
        for cover in (0.6, 0.7, 0.8):
            band = fit_band(tr_dd, cover)
            if band:
                lo, hi = band
                results.append(
                    {
                        "fam": "depth5m_fitband",
                        "rule": f"{lo:.2f}<=depth5m<={hi:.2f} (cover{cover})",
                        "tr": cov(tr_dd, lo, hi),
                        "te": cov(te_dd, lo, hi),
                        "w": hi - lo,
                    }
                )

    # E new bag only
    tr_new = [r for r in train if r.is_new]
    te_new = [r for r in test if r.is_new]
    if len(tr_new) >= 20:
        for lo, hi in ((3, 15), (5, 15), (5, 20), (8, 20), (3, 12)):
            results.append(
                {
                    "fam": "dump_newbag",
                    "rule": f"NEW & {lo}<=dump<={hi}",
                    "tr": cov([r.dump for r in tr_new], lo, hi),
                    "te": cov([r.dump for r in te_new], lo, hi) if te_new else 0,
                    "w": hi - lo,
                    "n_tr": len(tr_new),
                    "n_te": len(te_new),
                }
            )

    def rank_key(r: dict):
        gap = abs(r["tr"] - r["te"])
        # prefer high test, small gap, narrow width
        return (-r["te"], gap, r.get("w") or 999)

    results.sort(key=rank_key)
    # converged = te>=0.65 and gap<=0.08 and w<=15
    conv = [r for r in results if r["te"] >= 0.65 and abs(r["tr"] - r["te"]) <= 0.08 and (r.get("w") or 999) <= 15]
    print("CONVERGED (te>=65%, gap<=8%, width<=15):", len(conv))
    for r in (conv[:15] or results[:15]):
        print(
            f"{r['fam']:22s} te={r['te']*100:5.1f}% tr={r['tr']*100:5.1f}% w={r.get('w')} | {r['rule']}"
        )

    # Best per family
    print("\n=== BEST per family (te, gap, width) ===")
    by_f: dict[str, list] = defaultdict(list)
    for r in results:
        by_f[r["fam"]].append(r)
    best_per = {}
    for fam, arr in by_f.items():
        arr.sort(key=rank_key)
        best_per[fam] = arr[0]
        r = arr[0]
        print(f"{fam:22s} te={r['te']*100:5.1f}% tr={r['tr']*100:5.1f}% w={r.get('w')} | {r['rule']}")

    # Slip on dip with real quote fills
    slips = [r.slip for r in recs if r.slip is not None]
    print("\nSLIP quote-vs-dex (sane):", dist(slips))

    # EXIT
    closed = [r for r in recs if r.pnl is not None]
    print("\n=== EXIT (sane impulse only) n=", len(closed))
    print("impulse", dist([r.pnl for r in closed if r.pnl is not None]))
    print("held_m", dist([r.held_s / 60 for r in closed if r.held_s]))
    print("mfe", dist([r.mfe for r in closed if r.mfe is not None]))
    print("gb_peak", dist([r.gb_peak for r in closed if r.gb_peak is not None]))
    w = [r for r in closed if r.pnl is not None and r.pnl > 0]
    l = [r for r in closed if r.pnl is not None and r.pnl <= 0]
    print(f"winners n={len(w)} med_imp={st.median([r.pnl for r in w]) if w else None} med_hold={st.median([r.held_s/60 for r in w if r.held_s]) if w else None}")
    print(f"losers  n={len(l)} med_imp={st.median([r.pnl for r in l]) if l else None} med_hold={st.median([r.held_s/60 for r in l if r.held_s]) if l else None}")
    if w:
        print("winner impulse hist:")
        for lab, c, p in hist([r.pnl for r in w if r.pnl is not None], [3, 5, 8, 10, 15, 20, 30, 50, 80]):
            print(f"  {lab:16s} {c:3d} ({p:5.1f}%)")
    if l:
        print("loser impulse hist:")
        for lab, c, p in hist([r.pnl for r in l if r.pnl is not None], [-40, -25, -15, -10, -5, 0]):
            print(f"  {lab:16s} {c:3d} ({p:5.1f}%)")

    tr_c = [r for r in train if r.pnl is not None]
    te_c = [r for r in test if r.pnl is not None]
    exit_res = []
    for x in (3, 5, 8, 10, 12, 15, 20, 25, 30):
        for t_m in (10, 15, 20, 30, 45):
            def hit(r: Rec, x=x, t_m=t_m) -> bool:
                return (r.pnl is not None and r.pnl >= x) or ((r.held_s or 0) <= t_m * 60)

            # better metric: among closed, does rule explain exit event?
            # For reverse eng: fraction of his closes that satisfy (TP hit OR time)
            exit_res.append(
                {
                    "fam": "tp_or_time",
                    "rule": f"pnl>=+{x}% OR hold<={t_m}m",
                    "tr": sum(1 for r in tr_c if hit(r)) / len(tr_c) if tr_c else 0,
                    "te": sum(1 for r in te_c if hit(r)) / len(te_c) if te_c else 0,
                    "x": x,
                    "t": t_m,
                }
            )
    # arm+giveback on those with mfe/gb
    tr_g = [r for r in tr_c if r.mfe is not None and r.gb_peak is not None]
    te_g = [r for r in te_c if r.mfe is not None and r.gb_peak is not None]
    for arm in (5, 8, 10, 15, 20):
        for gb in (3, 4, 5, 6, 8, 10):
            def hit(r: Rec, arm=arm, gb=gb) -> bool:
                if r.mfe is None or r.gb_peak is None:
                    return False
                if r.mfe < arm:
                    return False
                return -gb - 3 <= r.gb_peak <= -gb + 3

            if len(tr_g) < 10:
                continue
            exit_res.append(
                {
                    "fam": "arm_gb",
                    "rule": f"MFE>={arm} & gb_peak~-{gb}%",
                    "tr": sum(1 for r in tr_g if hit(r)) / len(tr_g),
                    "te": sum(1 for r in te_g if hit(r)) / len(te_g) if te_g else 0,
                    "n_tr": len(tr_g),
                    "n_te": len(te_g),
                }
            )
    # loser cut depth
    if l:
        band = fit_band([r.pnl for r in l if r.pnl is not None], 0.7)
        if band:
            print(f"\nLoser cut band (70%): [{band[0]:.1f}%, {band[1]:.1f}%]")
    if w:
        band = fit_band([r.pnl for r in w if r.pnl is not None], 0.7)
        if band:
            print(f"Winner impulse band (70%): [{band[0]:.1f}%, {band[1]:.1f}%]")

    exit_res.sort(key=lambda r: (-r["te"], abs(r["tr"] - r["te"])))
    print("\n=== EXIT top ===")
    for r in exit_res[:20]:
        print(f"{r['fam']:10s} te={r['te']*100:5.1f}% tr={r['tr']*100:5.1f}% | {r['rule']}")

    # Final verdict block
    print("\n======== VERDICT ========")
    if conv:
        print("ENTRY converged candidates:")
        for r in conv[:5]:
            print(" ", r["rule"], f"te={r['te']*100:.1f}% tr={r['tr']*100:.1f}%")
    else:
        print("ENTRY: NO narrow rule converged.")
        print("dump=-pc5m distribution is WIDE: p25/p50/p75 =", dist(dumps).get("p25"), dist(dumps).get("p50"), dist(dumps).get("p75"))
        print("Best overall:", best_per.get("dump") or best_per.get("dump+turn"))
        print("Best conditional:", best_per.get("turn_conditional_dump"))
        print("Best marks depth:", best_per.get("depth5m_marks") or best_per.get("depth5m_fitband"))

    payload = {
        "n_dip": len(recs),
        "n_closed_sane": len(closed),
        "dump_dist": dist(dumps),
        "depth5m_dist": dist(dd5),
        "entry_converged": conv[:20],
        "entry_best_per_family": best_per,
        "exit_top": exit_res[:30],
        "winners": {
            "n": len(w),
            "impulse": dist([r.pnl for r in w if r.pnl is not None]),
            "hold_m": dist([r.held_s / 60 for r in w if r.held_s]),
        },
        "losers": {
            "n": len(l),
            "impulse": dist([r.pnl for r in l if r.pnl is not None]),
            "hold_m": dist([r.held_s / 60 for r in l if r.held_s]),
        },
        "slip": dist(slips),
    }
    (OUT / "8zkg-dip-reverse-v2.json").write_text(json.dumps(payload, indent=2))
    print("Wrote", OUT / "8zkg-dip-reverse-v2.json")


if __name__ == "__main__":
    main()
