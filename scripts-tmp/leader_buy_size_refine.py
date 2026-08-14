#!/usr/bin/env python3
import json, math, statistics, time
from pathlib import Path

ROOT = Path("/opt/solana-alpha/data/milddip")
since = time.time() - 86400
rows = []
for p in sorted(ROOT.glob("leader-observer-202608*.jsonl")):
    with p.open(errors="ignore") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("kind") != "leader_buy_observed" or o.get("isAdd"):
                continue
            bt = o.get("blockTime") or 0
            if bt < since:
                continue
            sz = float(o.get("sizeUsd") or 0)
            if sz < 0.5:
                continue
            dex = o.get("dex") or {}
            mcap = float(dex.get("mcap") or 0) or None
            liq = float(dex.get("liq") or 0) or None
            qsol = abs(float(o.get("quoteSolDelta") or 0))
            rows.append(
                {
                    "size": sz,
                    "mcap": mcap,
                    "liq": liq,
                    "qsol": qsol,
                    "leader": (o.get("leader") or "")[:8],
                }
            )


def power_law(xs, ys):
    lx = [math.log10(x) for x in xs]
    ly = [math.log10(y) for y in ys]
    n = len(lx)
    mx, my = sum(lx) / n, sum(ly) / n
    den = sum((x - mx) ** 2 for x in lx)
    b = sum((x - mx) * (y - my) for x, y in zip(lx, ly)) / den
    a = my - b * mx
    k = 10**a
    preds = [k * (x**b) for x in xs]
    medae = statistics.median([abs(y - p) for y, p in zip(ys, preds)])
    return k, b, a, medae


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


both = [r for r in rows if r["mcap"] and r["liq"]]
print(
    f"total={len(rows)} with_mcap={sum(1 for r in rows if r['mcap'])} "
    f"with_liq={sum(1 for r in rows if r['liq'])} both={len(both)}"
)

for feat in ("mcap", "liq"):
    sub = [r for r in rows if r[feat]]
    k, b, a, medae = power_law([r[feat] for r in sub], [r["size"] for r in sub])
    print(
        f"\nPOWER {feat}: size = {k:.4f} * {feat}^{b:.4f}  "
        f"(log10(size) = {a:.4f} + {b:.4f}*log10({feat}))  medAE=${medae:.1f}  n={len(sub)}"
    )

sub = both
best = None
for pct in [0.007, 0.008, 0.009, 0.01, 0.011, 0.012, 0.013, 0.015, 0.02]:
    for lo in [0, 50, 75, 100]:
        for hi in [500, 750, 1000, 1200]:
            preds = [clamp(pct * r["liq"], lo, hi) for r in sub]
            medae = statistics.median([abs(r["size"] - p) for r, p in zip(sub, preds)])
            w10 = sum(1 for r, p in zip(sub, preds) if abs(r["size"] - p) <= 10) / len(sub)
            cand = (medae, -w10, lo, hi, pct, w10)
            if best is None or cand < best:
                best = cand
print(
    f"\nBEST liq linear: clamp({best[2]},{best[3]}, {best[4]} * liq_usd)  "
    f"medAE=${best[0]:.1f}  within $10={100*best[5]:.0f}%  n={len(sub)}"
)

sol_rows = [r for r in rows if r["qsol"] > 0.05]
implied = [r["size"] / r["qsol"] for r in sol_rows]
print(f"\nSOL quote legs n={len(sol_rows)} implied SOL/USD med=${statistics.median(implied):.1f}")

for leader in sorted(set(r["leader"] for r in both)):
    s = [r for r in both if r["leader"] == leader]
    k, b, a, medae = power_law([r["liq"] for r in s], [r["size"] for r in s])
    print(f"{leader}: size = {k:.4f}*liq^{b:.3f}  medAE=${medae:.1f}  n={len(s)}")

sub = [r for r in rows if r["mcap"]]
k, b, a, medae = power_law([r["mcap"] for r in sub], [r["size"] for r in sub])
print(f"\nmcap power raw medAE=${medae:.1f}")
for lo, hi in [(100, 1000), (50, 1000), (0, 1200)]:
    preds = [clamp(k * (r["mcap"] ** b), lo, hi) for r in sub]
    medae = statistics.median([abs(r["size"] - p) for r, p in zip(sub, preds)])
    print(f"  clamp({lo},{hi}, {k:.4f}*mcap^{b:.3f}) medAE=${medae:.1f}")

print("\n=== median size / liq ratio by liq bucket ===")
bs = [
    (0, 5e3),
    (5e3, 10e3),
    (10e3, 15e3),
    (15e3, 20e3),
    (20e3, 30e3),
    (30e3, 50e3),
    (50e3, 80e3),
    (80e3, 150e3),
    (150e3, 300e3),
    (300e3, 1e6),
]
for lo, hi in bs:
    ss = [r for r in both if lo <= r["liq"] < hi]
    if len(ss) >= 5:
        med_sz = statistics.median([r["size"] for r in ss])
        med_liq = statistics.median([r["liq"] for r in ss])
        print(f"  liq ${lo/1e3:.0f}k-${hi/1e3:.0f}k: n={len(ss)} med_size=${med_sz:.0f}  size/liq={med_sz/med_liq:.4f}")
