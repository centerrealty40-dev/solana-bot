#!/usr/bin/env python3
"""
8zkg dip reverse v5 — test turn→dump depth as the latent rule.

Hypothesis from v4 stratification:
  low turn → shallow dump; high turn → deep dump.
Fit piecewise / linear / ratio rules; validate train/test + leave-one-mint.
Then exit impulse on sane flats (+ optional mark MFE at exit).
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

DATA = Path("/opt/solana-alpha/data/milddip")
LEADER = "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ"
OUT = Path("/tmp/leader-reverse")
OUT.mkdir(parents=True, exist_ok=True)


def dist(xs):
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


def load_buys():
    buys = []
    seen = set()
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        for line in p.open():
            e = json.loads(line)
            if e.get("leader") != LEADER or e.get("kind") != "leader_buy_observed":
                continue
            d = e.get("dex") if isinstance(e.get("dex"), dict) else {}
            try:
                pc5 = float(d.get("pc5m", e.get("pc5m")))
            except Exception:
                continue
            if pc5 >= 0:
                continue
            ts = int(e.get("tsMs") or (e.get("blockTime") or 0) * 1000)
            key = (e["mint"], ts)
            if key in seen:
                continue
            seen.add(key)
            vol5, liq = d.get("vol5m"), d.get("liq")
            turn = d.get("turnover5mLiq")
            if turn is None and vol5 and liq and float(liq) > 0:
                turn = float(vol5) / float(liq)
            if turn is None:
                continue
            try:
                turn = float(turn)
            except Exception:
                continue
            buys.append(
                {
                    "mint": e["mint"],
                    "ts": ts,
                    "dump": -pc5,
                    "turn": turn,
                    "liq": float(liq) if liq is not None else None,
                    "vol5m": float(vol5) if vol5 is not None else None,
                    "size": float(e["sizeUsd"]) if e.get("sizeUsd") else None,
                    "is_new": e.get("isNewBag"),
                    "is_add": e.get("isAdd"),
                    "pc1h": float(d["pc1h"]) if d.get("pc1h") is not None else None,
                }
            )
    buys.sort(key=lambda x: x["ts"])
    return buys


def load_flats():
    out = []
    for p in DATA.glob("leader-observer-*.jsonl"):
        for line in p.open():
            e = json.loads(line)
            if e.get("leader") != LEADER or e.get("kind") != "leader_session_flat":
                continue
            pnl = e.get("pnlPctApprox")
            try:
                pnl = float(pnl)
            except Exception:
                continue
            if not (-80 <= pnl <= 200):
                continue
            held = e.get("heldSec")
            em = e.get("entryMarket") if isinstance(e.get("entryMarket"), dict) else {}
            pc = em.get("pc5m")
            try:
                pc5 = float(pc) if pc is not None else None
            except Exception:
                pc5 = None
            out.append(
                {
                    "mint": e.get("mint"),
                    "pnl": pnl,
                    "held_s": float(held) if held is not None else None,
                    "dump": -pc5 if pc5 is not None and pc5 < 0 else None,
                    "ts": (e.get("blockTime") or 0) * 1000,
                }
            )
    return out


def lom_cov(rows, pred):
    by = defaultdict(list)
    for r in rows:
        by[r["mint"]].append(r)
    scores = [sum(1 for x in arr if pred(x)) / len(arr) for arr in by.values() if arr]
    if not scores:
        return None
    scores.sort()
    return {
        "mean": sum(scores) / len(scores),
        "p50": scores[len(scores) // 2],
        "p25": scores[len(scores) // 4],
        "n": len(scores),
    }


def eval_rule(name, rows, pred, train, test):
    def cov(arr):
        return sum(1 for r in arr if pred(r)) / len(arr) if arr else 0.0

    lom = lom_cov(rows, pred)
    return {
        "rule": name,
        "tr": cov(train),
        "te": cov(test),
        "gap": abs(cov(train) - cov(test)),
        "lom": lom["mean"] if lom else None,
        "lom_p50": lom["p50"] if lom else None,
        "n": len(rows),
    }


def main():
    buys = load_buys()
    print("dip buys with turn", len(buys))
    mid = len(buys) // 2
    train, test = buys[:mid], buys[mid:]

    # Correlation dump vs turn
    # simple pearson
    turns = [b["turn"] for b in buys]
    dumps = [b["dump"] for b in buys]
    mt, md = sum(turns) / len(turns), sum(dumps) / len(dumps)
    num = sum((t - mt) * (d - md) for t, d in zip(turns, dumps))
    den = math.sqrt(sum((t - mt) ** 2 for t in turns) * sum((d - md) ** 2 for d in dumps))
    corr = num / den if den else 0
    print("pearson(dump, turn)=", round(corr, 4))

    # ratio dump/turn
    ratios = [b["dump"] / b["turn"] for b in buys if b["turn"] > 0.01]
    print("dump/turn", dist(ratios))

    results = []

    # Piecewise bands from v4 medians ± slack
    # turn<0.05 → dump 1-10; 0.05-0.15 → 3-18; 0.15-0.4 → 6-25; >=0.4 → 8-40
    pieces = [
        # (turn_lo, turn_hi, dump_lo, dump_hi)
        (0.0, 0.05, 1.0, 10.0),
        (0.05, 0.15, 3.0, 18.0),
        (0.15, 0.40, 6.0, 28.0),
        (0.40, 1e9, 8.0, 45.0),
    ]

    def make_piecewise(pieces):
        def pred(r):
            for tlo, thi, dlo, dhi in pieces:
                if tlo <= r["turn"] < thi:
                    return dlo <= r["dump"] <= dhi
            return False

        return pred

    # grid around piecewise
    grids = []
    # base
    grids.append(("piece_v4med", pieces))
    # tighter shallow / tighter deep
    grids.append(
        (
            "piece_tight",
            [
                (0.0, 0.05, 1.5, 8.0),
                (0.05, 0.15, 4.0, 15.0),
                (0.15, 0.40, 8.0, 22.0),
                (0.40, 1e9, 10.0, 40.0),
            ],
        )
    )
    grids.append(
        (
            "piece_loose",
            [
                (0.0, 0.05, 0.5, 12.0),
                (0.05, 0.15, 2.0, 20.0),
                (0.15, 0.40, 5.0, 30.0),
                (0.40, 1e9, 6.0, 50.0),
            ],
        )
    )
    # 3-bucket
    grids.append(
        (
            "piece_3bucket",
            [
                (0.0, 0.08, 1.0, 12.0),
                (0.08, 0.25, 4.0, 22.0),
                (0.25, 1e9, 8.0, 40.0),
            ],
        )
    )
    grids.append(
        (
            "piece_3bucket_tight",
            [
                (0.0, 0.08, 2.0, 10.0),
                (0.08, 0.25, 5.0, 18.0),
                (0.25, 1e9, 10.0, 35.0),
            ],
        )
    )

    for name, pcs in grids:
        results.append(eval_rule(name, buys, make_piecewise(pcs), train, test))

    # Linear band: dump in [a*turn+b ± slack] but turn can be large — use dump vs log(turn)
    # Fit on train: dump ≈ alpha + beta * log1p(turn*100)
    def fit_lin(rows):
        xs = [math.log1p(r["turn"] * 100) for r in rows]
        ys = [r["dump"] for r in rows]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        beta = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sum((x - mx) ** 2 for x in xs) or 1)
        alpha = my - beta * mx
        return alpha, beta

    alpha, beta = fit_lin(train)
    print(f"lin fit train: dump ≈ {alpha:.3f} + {beta:.3f}*log1p(turn*100)")

    for slack in (4, 5, 6, 8, 10, 12):
        def pred(r, slack=slack, alpha=alpha, beta=beta):
            pred_d = alpha + beta * math.log1p(r["turn"] * 100)
            return abs(r["dump"] - pred_d) <= slack

        results.append(eval_rule(f"lin_logturn±{slack}", buys, pred, train, test))

    # dump/turn ratio band
    for lo, hi in ((20, 200), (30, 250), (40, 300), (15, 150), (25, 180), (10, 120)):
        def pred(r, lo=lo, hi=hi):
            if r["turn"] <= 0:
                return False
            ratio = r["dump"] / r["turn"]
            return lo <= ratio <= hi

        results.append(eval_rule(f"dump/turn in [{lo},{hi}]", buys, pred, train, test))

    # Absolute dump floor/ceiling only (baseline)
    for lo, hi in ((2, 20), (3, 18), (3, 15), (2, 15), (5, 25)):
        results.append(
            eval_rule(
                f"plain {lo}<=dump<={hi}",
                buys,
                lambda r, lo=lo, hi=hi: lo <= r["dump"] <= hi,
                train,
                test,
            )
        )

    # Conditional: if turn high require deeper min dump
    for tcut, dmin, dmax in (
        (0.10, 5, 25),
        (0.15, 8, 30),
        (0.20, 10, 35),
        (0.08, 4, 22),
    ):
        def pred(r, tcut=tcut, dmin=dmin, dmax=dmax):
            if r["turn"] >= tcut:
                return dmin <= r["dump"] <= dmax
            return 1 <= r["dump"] <= 15

        results.append(eval_rule(f"if turn>={tcut}: dump[{dmin},{dmax}] else [1,15]", buys, pred, train, test))

    # Score: prefer high te, lom, small gap; piece rules preferred if te>=0.7
    def rank(r):
        return (-(r["te"]), -(r["lom"] or 0), r["gap"])

    results.sort(key=rank)

    print("\n=== ENTRY RULES TOP ===")
    for r in results[:20]:
        print(
            f"te={r['te']*100:5.1f}% tr={r['tr']*100:5.1f}% lom={None if r['lom'] is None else round(r['lom']*100,1)} "
            f"gap={r['gap']*100:4.1f} | {r['rule']}"
        )

    hard = [
        r
        for r in results
        if r["te"] >= 0.70 and r["gap"] <= 0.08 and (r["lom"] or 0) >= 0.65 and "plain" not in r["rule"]
    ]
    soft = [
        r
        for r in results
        if r["te"] >= 0.65 and r["gap"] <= 0.10 and (r["lom"] or 0) >= 0.60
    ]
    print("\nHARD converged (te>=70 gap<=8 lom>=65, not plain):", len(hard))
    for r in hard[:10]:
        print(" ", r["rule"], f"te={r['te']*100:.1f} lom={r['lom']}")
    print("SOFT:", len(soft))
    for r in soft[:10]:
        print(" ", r["rule"], f"te={r['te']*100:.1f} lom={r['lom']}")

    # Per-bucket residual if we use piece_v4med
    print("\n=== piece_v4med residuals by bucket ===")
    for tlo, thi, dlo, dhi in pieces:
        arr = [b for b in buys if tlo <= b["turn"] < thi]
        inside = [b for b in arr if dlo <= b["dump"] <= dhi]
        print(
            f"turn[{tlo},{thi}) n={len(arr)} cov={100*len(inside)/len(arr) if arr else 0:.1f}% "
            f"dump_dist={dist([b['dump'] for b in arr])}"
        )

    # Fit exact p10-p90 per turn bucket on TRAIN, validate TEST
    print("\n=== TRAIN-fit p10-p90 bands per turn bucket → TEST ===")
    cuts = [0.0, 0.05, 0.15, 0.40, 1e9]
    fit_pieces = []
    for i in range(len(cuts) - 1):
        tlo, thi = cuts[i], cuts[i + 1]
        arr = sorted(b["dump"] for b in train if tlo <= b["turn"] < thi)
        if len(arr) < 20:
            continue
        dlo, dhi = arr[int(0.1 * (len(arr) - 1))], arr[int(0.9 * (len(arr) - 1))]
        fit_pieces.append((tlo, thi, dlo, dhi))
        print(f"  train turn[{tlo},{thi}) → dump[{dlo:.2f},{dhi:.2f}] n={len(arr)}")
    rfit = eval_rule("train_p10p90_turn_buckets", buys, make_piecewise(fit_pieces), train, test)
    print(
        f"  VALIDATE te={rfit['te']*100:.1f}% tr={rfit['tr']*100:.1f}% lom={rfit['lom']*100:.1f}%"
    )
    results.append(rfit)

    # p25-p75 tighter
    fit2 = []
    for i in range(len(cuts) - 1):
        tlo, thi = cuts[i], cuts[i + 1]
        arr = sorted(b["dump"] for b in train if tlo <= b["turn"] < thi)
        if len(arr) < 20:
            continue
        dlo, dhi = arr[int(0.25 * (len(arr) - 1))], arr[int(0.75 * (len(arr) - 1))]
        # expand a bit
        pad = 2.0
        fit2.append((tlo, thi, max(0.5, dlo - pad), dhi + pad))
    rfit2 = eval_rule("train_p25p75±2_turn_buckets", buys, make_piecewise(fit2), train, test)
    print(
        f"p25-p75±2 VALIDATE te={rfit2['te']*100:.1f}% tr={rfit2['tr']*100:.1f}% lom={rfit2['lom']*100:.1f}%"
    )
    for tlo, thi, dlo, dhi in fit2:
        print(f"  turn[{tlo},{thi}) dump[{dlo:.2f},{dhi:.2f}]")
    results.append(rfit2)

    # EXIT
    flats = load_flats()
    print("\n=== EXIT flats sane", len(flats))
    wins = [f for f in flats if f["pnl"] > 0]
    loss = [f for f in flats if f["pnl"] <= 0]
    print("win", dist([f["pnl"] for f in wins]))
    print("loss", dist([f["pnl"] for f in loss]))

    # Find TP/SL that converge: among all, coverage of |pnl| crossing thresholds
    # Better: mode — winners rarely exit below +X
    print("Winner: fraction with pnl in band")
    for lo, hi in ((10, 40), (15, 60), (20, 80), (25, 100), (30, 120), (40, 150)):
        cov = sum(1 for f in wins if lo <= f["pnl"] <= hi) / len(wins) if wins else 0
        print(f"  win in [{lo},{hi}]: {cov*100:.1f}%")
    for lo, hi in ((-70, -20), (-60, -15), (-55, -25), (-80, -30), (-50, -20)):
        cov = sum(1 for f in loss if lo <= f["pnl"] <= hi) / len(loss) if loss else 0
        print(f"  loss in [{lo},{hi}]: {cov*100:.1f}%")

    midf = len(flats) // 2
    ftr, fte = flats[:midf], flats[midf:]
    exit_rules = []
    for tp in (15, 20, 25, 30, 40, 50):
        for sl in (20, 25, 30, 40, 50):
            def pred(r, tp=tp, sl=sl):
                return r["pnl"] >= tp or r["pnl"] <= -sl

            exit_rules.append(eval_rule(f"TP+{tp}|SL-{sl}", flats, pred, ftr, fte))
    # winner-only / loser-only
    wtr = [f for f in ftr if f["pnl"] > 0]
    wte = [f for f in fte if f["pnl"] > 0]
    ltr = [f for f in ftr if f["pnl"] <= 0]
    lte = [f for f in fte if f["pnl"] <= 0]
    for x in (20, 25, 30, 40, 50):
        exit_rules.append(
            eval_rule(
                f"WIN>=+{x}",
                wins,
                lambda r, x=x: r["pnl"] >= x,
                wtr,
                wte,
            )
        )
    for x in (25, 30, 40, 50):
        exit_rules.append(
            eval_rule(
                f"LOSS<=-{x}",
                loss,
                lambda r, x=x: r["pnl"] <= -x,
                ltr,
                lte,
            )
        )
    exit_rules.sort(key=rank)
    print("\n=== EXIT TOP ===")
    for r in exit_rules[:15]:
        print(
            f"te={r['te']*100:5.1f}% tr={r['tr']*100:5.1f}% lom={None if r['lom'] is None else round(r['lom']*100,1)} | {r['rule']}"
        )

    # Verdict
    print("\n======== VERDICT ========")
    best_piece = [r for r in results if r["rule"].startswith("piece") or "turn_bucket" in r["rule"]]
    best_piece.sort(key=rank)
    if best_piece:
        print("BEST turn-conditional:", best_piece[0])
    print("BEST overall:", results[0] if results else None)
    print("TRAIN p10-p90 buckets:", rfit)
    print("TRAIN p25-p75±2:", rfit2)

    payload = {
        "n": len(buys),
        "corr_dump_turn": corr,
        "dump_over_turn": dist(ratios),
        "lin": {"alpha": alpha, "beta": beta},
        "entry_top": results[:30],
        "hard": hard[:15],
        "soft": soft[:15],
        "fit_p10p90": {"pieces": fit_pieces, **rfit},
        "fit_p25p75": {"pieces": fit2, **rfit2},
        "bucket_dist": [
            {
                "turn": [tlo, thi],
                "dump_target": [dlo, dhi],
                "dist": dist([b["dump"] for b in buys if tlo <= b["turn"] < thi]),
            }
            for tlo, thi, dlo, dhi in pieces
        ],
        "exit_top": exit_rules[:20],
        "exit_win": dist([f["pnl"] for f in wins]),
        "exit_loss": dist([f["pnl"] for f in loss]),
    }
    (OUT / "8zkg-dip-reverse-v5.json").write_text(json.dumps(payload, indent=2))
    print("Wrote", OUT / "8zkg-dip-reverse-v5.json")


if __name__ == "__main__":
    main()
