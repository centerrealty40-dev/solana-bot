#!/usr/bin/env python3
"""Fit leader buy sizeUsd vs Dex features — last 24h observer tape."""
from __future__ import annotations

import json
import math
import statistics
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path("/opt/solana-alpha/data/milddip")
WINDOW_SEC = 24 * 3600
LEADERS = {
    "8zkg": "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ",
    "7BNax": "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5",
}
MIN_SIZE = 0.5


def fnum(x):
    try:
        if x is None:
            return None
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def load_buys(now_ts: float) -> list[dict]:
    since = now_ts - WINDOW_SEC
    rows = []
    for p in sorted(ROOT.glob("leader-observer-202608*.jsonl")):
        with p.open(encoding="utf-8", errors="ignore") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("kind") != "leader_buy_observed":
                    continue
                bt = o.get("blockTime") or 0
                if bt < since:
                    continue
                size = fnum(o.get("sizeUsd"))
                if size is None or size < MIN_SIZE:
                    continue
                dex = o.get("dex") or {}
                mcap = fnum(dex.get("mcap"))
                liq = fnum(dex.get("liq"))
                vol5 = fnum(dex.get("vol5m"))
                rows.append(
                    {
                        "leader": o.get("leader"),
                        "leaderShort": (o.get("leader") or "")[:8],
                        "sig": o.get("signature"),
                        "blockTime": bt,
                        "mint": o.get("mint"),
                        "sizeUsd": size,
                        "sizeSource": o.get("sizeUsdSource"),
                        "estimated": bool(o.get("sizeUsdEstimated")),
                        "isAdd": bool(o.get("isAdd")),
                        "mcap": mcap,
                        "liq": liq,
                        "vol5m": vol5,
                        "turn": (vol5 / liq) if vol5 and liq and liq > 0 else None,
                        "pc5m": fnum(dex.get("pc5m")),
                        "class": o.get("class"),
                        "quoteUsdDelta": fnum(o.get("quoteUsdDelta")),
                    }
                )
    return rows


def ols(xs: list[float], ys: list[float]) -> dict | None:
    n = len(xs)
    if n < 5:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    if den <= 1e-15:
        return None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
    a = my - b * mx
    pred = [a + b * x for x in xs]
    ss_res = sum((y - p) ** 2 for y, p in zip(ys, pred))
    ss_tot = sum((y - my) ** 2 for y in ys) or 1.0
    mae = statistics.mean([abs(y - p) for y, p in zip(ys, pred)])
    medae = statistics.median([abs(y - p) for y, p in zip(ys, pred)])
    return {"n": n, "a": a, "b": b, "r2": 1 - ss_res / ss_tot, "mae": mae, "medae": medae}


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def fit_models(rows: list[dict]) -> list[dict]:
    """Try explicit sizing formulas; rank by median absolute error."""
    ys = [r["sizeUsd"] for r in rows]
    candidates = []

    def eval_formula(name: str, preds: list[float]):
        err = [abs(y - p) for y, p in zip(ys, preds)]
        candidates.append(
            {
                "name": name,
                "n": len(err),
                "mae": statistics.mean(err),
                "medae": statistics.median(err),
                "p90ae": sorted(err)[int(0.9 * (len(err) - 1))],
                "maxae": max(err),
                "within_5usd": sum(1 for e in err if e <= 5) / len(err),
                "within_10usd": sum(1 for e in err if e <= 10) / len(err),
                "within_25usd": sum(1 for e in err if e <= 25) / len(err),
            }
        )

    # Constant
    for c in [100, 150, 200, 250, 500]:
        eval_formula(f"const_{c}", [float(c)] * len(rows))

    # mcap linear clamp 100-1000
    for lo, hi in [(100, 1000), (100, 500), (50, 1000)]:
        for scale in [0.001, 0.002, 0.003, 0.004, 0.005, 0.01]:
            preds = [clamp(scale * (r["mcap"] or 0), lo, hi) for r in rows if r["mcap"]]
            if len(preds) == len(rows):
                eval_formula(f"clamp({scale}*mcap,{lo},{hi})", preds)

    # liq linear clamp
    for scale in [0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1]:
        if all(r["liq"] for r in rows):
            preds = [clamp(scale * r["liq"], 100, 1000) for r in rows]
            eval_formula(f"clamp({scale}*liq,100,1000)", preds)

    # sqrt mcap
    for k in [0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 10.0]:
        preds = [clamp(k * math.sqrt(max(r["mcap"] or 0, 0)), 100, 1000) for r in rows if r["mcap"]]
        if len(preds) == len(rows):
            eval_formula(f"clamp({k}*sqrt(mcap),100,1000)", preds)

    # log10 mcap
    for a in range(50, 350, 25):
        for b in range(20, 120, 10):
            preds = [
                clamp(a + b * math.log10(max(r["mcap"] or 1, 1)), 100, 1000)
                for r in rows
                if r["mcap"] and r["mcap"] > 0
            ]
            if len(preds) == len(rows):
                eval_formula(f"clamp({a}+{b}*log10(mcap),100,1000)", preds)

    # mcap buckets (step)
    breaks = [25_000, 50_000, 75_000, 100_000, 150_000, 200_000, 300_000, 500_000, 750_000, 1_000_000]
    vals = [100, 150, 200, 250, 300, 400, 500, 600, 750, 1000]
    # coarse grid search on step values at fixed breaks
    for v0 in [100, 150, 200]:
        for v1 in [150, 200, 250, 300]:
            for v2 in [200, 300, 400, 500]:
                for v3 in [300, 400, 500, 750, 1000]:
                    steps = [v0, v1, v2, v3, 1000, 1000, 1000, 1000, 1000, 1000]

                    def step_mcap(m):
                        if m is None:
                            return v0
                        for br, val in zip(breaks, steps):
                            if m < br:
                                return val
                        return 1000

                    preds = [step_mcap(r["mcap"]) for r in rows]
                    eval_formula(f"step_mcap_v0={v0}..", preds)

    candidates.sort(key=lambda x: (x["medae"], x["mae"]))
    return candidates[:25]


def round_analysis(rows: list[dict]):
    """Check if sizes cluster on round USD / SOL amounts."""
    sizes = [r["sizeUsd"] for r in rows]
    round50 = sum(1 for s in sizes if abs(s - round(s / 50) * 50) < 2)
    round25 = sum(1 for s in sizes if abs(s - round(s / 25) * 25) < 2)
    round100 = sum(1 for s in sizes if abs(s - round(s / 100) * 100) < 3)
    ints = sum(1 for s in sizes if abs(s - round(s)) < 1.5)
    print(f"  round to $100 ±3: {100*round100/len(sizes):.1f}%")
    print(f"  round to $50 ±2: {100*round50/len(sizes):.1f}%")
    print(f"  round to $25 ±2: {100*round25/len(sizes):.1f}%")
    print(f"  near integer ±1.5: {100*ints/len(sizes):.1f}%")


def main():
    now = time.time()
    rows = load_buys(now)
    print(f"window=24h buys={len(rows)} since={time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(now - WINDOW_SEC))}")
    quote_only = [r for r in rows if r["sizeSource"] == "quote" and not r["estimated"]]
    print(f"  quote-sized (non-estimated): {len(quote_only)}")
    new_bags = [r for r in rows if not r["isAdd"]]
    adds = [r for r in rows if r["isAdd"]]
    print(f"  new bags={len(new_bags)} adds={len(adds)}")

    for label, subset in [
        ("ALL", rows),
        ("QUOTE_ONLY", quote_only),
        ("NEW_BAG", new_bags),
        ("NEW_BAG_QUOTE", [r for r in new_bags if r["sizeSource"] == "quote" and not r["estimated"]]),
    ]:
        if len(subset) < 10:
            continue
        sizes = sorted(r["sizeUsd"] for r in subset)
        print(f"\n=== {label} n={len(subset)} sizeUsd ===")
        print(
            f"  min=${sizes[0]:.2f} p10=${sizes[len(sizes)//10]:.2f} med=${statistics.median(sizes):.2f} "
            f"p90=${sizes[int(len(sizes)*0.9)]:.2f} max=${sizes[-1]:.2f} mean=${statistics.mean(sizes):.2f}"
        )
        round_analysis(subset)
        at100 = sum(1 for s in sizes if 95 <= s <= 105)
        at1000 = sum(1 for s in sizes if 950 <= s <= 1050)
        print(f"  in [95,105]: {at100} ({100*at100/len(sizes):.1f}%)  in [950,1050]: {at1000} ({100*at1000/len(sizes):.1f}%)")

    # per leader
    by_leader = defaultdict(list)
    for r in quote_only:
        by_leader[r["leaderShort"]].append(r)

    for ls, subset in sorted(by_leader.items()):
        sizes = [r["sizeUsd"] for r in subset]
        print(f"\n--- leader {ls} quote buys n={len(subset)} ---")
        print(f"  med=${statistics.median(sizes):.1f} mean=${statistics.mean(sizes):.1f} min=${min(sizes):.1f} max=${max(sizes):.1f}")

    # correlations OLS on log scale
    print("\n=== OLS log10(size) ~ log10(feature) ===")
    for feat in ("mcap", "liq", "vol5m", "turn"):
        xs, ys = [], []
        for r in quote_only:
            fv = r.get(feat)
            if fv and fv > 0:
                xs.append(math.log10(fv))
                ys.append(math.log10(r["sizeUsd"]))
        fit = ols(xs, ys)
        if fit:
            print(
                f"  {feat}: n={fit['n']} log_size = {fit['a']:.3f} + {fit['b']:.3f}*log10({feat}) "
                f"R²={fit['r2']:.3f} medAE={fit['medae']:.3f} (log10 USD)"
            )

    # OLS linear size ~ mcap
    print("\n=== OLS linear sizeUsd ~ feature (then clamp 100-1000) ===")
    for feat in ("mcap", "liq"):
        xs, ys = [], []
        for r in quote_only:
            fv = r.get(feat)
            if fv and fv > 0:
                xs.append(fv)
                ys.append(r["sizeUsd"])
        fit = ols(xs, ys)
        if fit:
            preds = [clamp(fit["a"] + fit["b"] * x, 100, 1000) for x in xs]
            medae = statistics.median([abs(y - p) for y, p in zip(ys, preds)])
            print(
                f"  clamp(100,1000,{fit['a']:.4f} + {fit['b']:.6f}*{feat}): "
                f"n={fit['n']} R²={fit['r2']:.3f} medAE=${medae:.1f}"
            )

    # mcap bucket medians
    print("\n=== median sizeUsd by mcap bucket (quote-only new bags) ===")
    nbq = [r for r in quote_only if not r["isAdd"] and r["mcap"]]
    buckets = [
        (0, 25_000),
        (25_000, 50_000),
        (50_000, 75_000),
        (75_000, 100_000),
        (100_000, 150_000),
        (150_000, 200_000),
        (200_000, 300_000),
        (300_000, 500_000),
        (500_000, 1_000_000),
        (1_000_000, 10_000_000),
    ]
    for lo, hi in buckets:
        ss = [r for r in nbq if lo <= r["mcap"] < hi]
        if not ss:
            continue
        sizes = [r["sizeUsd"] for r in ss]
        mcaps = [r["mcap"] for r in ss]
        print(
            f"  mcap ${lo/1e3:.0f}k-${hi/1e3:.0f}k: n={len(ss)} "
            f"size med=${statistics.median(sizes):.0f} mean=${statistics.mean(sizes):.0f} "
            f"(mcap med=${statistics.median(mcaps)/1e3:.0f}k)"
        )

    print("\n=== formula search (quote-only new bags) ===")
    nbq = [r for r in quote_only if not r["isAdd"] and r["mcap"] and r["liq"]]
    top = fit_models(nbq)
    for i, c in enumerate(top[:12]):
        print(
            f"  #{i+1} {c['name']}: medAE=${c['medae']:.1f} "
            f"≤$5={100*c['within_5usd']:.0f}% ≤$10={100*c['within_10usd']:.0f}% "
            f"≤$25={100*c['within_25usd']:.0f}%"
        )

    # Best linear mcap fit detailed
    xs = [r["mcap"] for r in nbq]
    ys = [r["sizeUsd"] for r in nbq]
    fit = ols(xs, ys)
    if fit:
        print(f"\n=== BEST FIT detail: size = clamp(100, 1000, {fit['a']:.2f} + {fit['b']*1000:.4f} * (mcap/1000)) ===")
        print(f"  equivalently: size = clamp(100, 1000, {fit['a']:.2f} + {fit['b']:.6f} * mcap_usd)")
        # show sample residuals
        samples = sorted(nbq, key=lambda r: r["mcap"])[:5] + sorted(nbq, key=lambda r: r["mcap"], reverse=True)[:5]
        seen = set()
        print("  samples (mcap → actual vs pred):")
        for r in samples:
            if r["sig"] in seen:
                continue
            seen.add(r["sig"])
            pred = clamp(fit["a"] + fit["b"] * r["mcap"], 100, 1000)
            print(
                f"    mcap=${r['mcap']:,.0f} liq=${r['liq']:,.0f} "
                f"actual=${r['sizeUsd']:.2f} pred=${pred:.1f} err=${r['sizeUsd']-pred:+.1f}"
            )


if __name__ == "__main__":
    main()
