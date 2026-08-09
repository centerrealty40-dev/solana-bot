#!/usr/bin/env python3
"""
Fit / validate turn→dump formula on BOTH leaders.
Also print last-15m our fills vs formula (deduped).
"""
from __future__ import annotations

import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

DATA = Path("/opt/solana-alpha/data/milddip")
OUT = Path("/tmp/leader-reverse")
OUT.mkdir(parents=True, exist_ok=True)

L1 = "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ"
L2 = "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5"
# known from reverse
ALPHA1, BETA1 = -5.08, 6.86


def fnum(x):
    try:
        return None if x is None else float(x)
    except Exception:
        return None


def pred(turn, alpha, beta):
    return alpha + beta * math.log1p(turn * 100)


def load_leader_dip_buys(leader: str) -> list[dict]:
    buys = []
    seen = set()
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        for line in p.open():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("leader") != leader or e.get("kind") != "leader_buy_observed":
                continue
            d = e.get("dex") if isinstance(e.get("dex"), dict) else {}
            pc = fnum(d.get("pc5m", e.get("pc5m")))
            if pc is None or pc >= 0:
                continue
            ts = int(e.get("tsMs") or (e.get("blockTime") or 0) * 1000)
            key = (e.get("mint"), ts)
            if key in seen:
                continue
            seen.add(key)
            vol = fnum(d.get("vol5m"))
            liq = fnum(d.get("liq"))
            turn = fnum(d.get("turnover5mLiq"))
            if turn is None and vol is not None and liq and liq > 0:
                turn = vol / liq
            if turn is None or turn <= 0:
                continue
            buys.append(
                {
                    "mint": e.get("mint"),
                    "ts": ts,
                    "dump": -pc,
                    "pc5m": pc,
                    "turn": turn,
                    "size": fnum(e.get("sizeUsd")),
                    "is_new": e.get("isNewBag"),
                }
            )
    buys.sort(key=lambda x: x["ts"])
    return buys


def fit_lin(rows: list[dict]) -> tuple[float, float]:
    xs = [math.log1p(r["turn"] * 100) for r in rows]
    ys = [r["dump"] for r in rows]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs) or 1.0
    beta = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
    alpha = my - beta * mx
    return alpha, beta


def pearson(rows: list[dict]) -> float:
    turns = [r["turn"] for r in rows]
    dumps = [r["dump"] for r in rows]
    mt, md = sum(turns) / len(turns), sum(dumps) / len(dumps)
    num = sum((t - mt) * (d - md) for t, d in zip(turns, dumps))
    den = math.sqrt(sum((t - mt) ** 2 for t in turns) * sum((d - md) ** 2 for d in dumps))
    return num / den if den else 0.0


def dist(xs):
    if not xs:
        return {"n": 0}
    xs = sorted(xs)
    n = len(xs)
    return {
        "n": n,
        "p25": xs[n // 4],
        "p50": xs[n // 2],
        "p75": xs[3 * n // 4],
        "mean": sum(xs) / n,
    }


def eval_formula(rows, alpha, beta, slacks=(6, 8, 10, 12)):
    mid = len(rows) // 2
    train, test = rows[:mid], rows[mid:]
    out = {"alpha": alpha, "beta": beta, "n": len(rows), "pearson": pearson(rows)}
    # residuals
    res = [r["dump"] - pred(r["turn"], alpha, beta) for r in rows]
    out["resid"] = dist(res)
    out["abs_resid"] = dist([abs(x) for x in res])
    # coverage
    cov = {}
    for s in slacks:
        cov[s] = sum(1 for x in res if abs(x) <= s) / len(res)
    out["within"] = cov
    # train/test if alpha/beta fitted on train externally — here just coverage split
    te = {}
    for s in slacks:
        te_res = [r["dump"] - pred(r["turn"], alpha, beta) for r in test]
        tr_res = [r["dump"] - pred(r["turn"], alpha, beta) for r in train]
        te[s] = {
            "tr": sum(1 for x in tr_res if abs(x) <= s) / len(tr_res) if tr_res else 0,
            "te": sum(1 for x in te_res if abs(x) <= s) / len(te_res) if te_res else 0,
        }
    out["split"] = te
    # leave-one-mint mean coverage ±10
    by = defaultdict(list)
    for r in rows:
        by[r["mint"]].append(r)
    lom = []
    for arr in by.values():
        lom.append(
            sum(1 for r in arr if abs(r["dump"] - pred(r["turn"], alpha, beta)) <= 10) / len(arr)
        )
    out["lom10"] = sum(lom) / len(lom) if lom else None
    # turn buckets dump p50
    buckets = []
    for tlo, thi in ((0, 0.05), (0.05, 0.15), (0.15, 0.4), (0.4, 1e9)):
        arr = [r["dump"] for r in rows if tlo <= r["turn"] < thi]
        if len(arr) >= 10:
            buckets.append({"turn": [tlo, thi], "n": len(arr), **dist(arr)})
    out["buckets"] = buckets
    return out


def analyze_leader(name: str, leader: str) -> dict:
    rows = load_leader_dip_buys(leader)
    print(f"\n======== {name} {leader[:8]} n={len(rows)} ========")
    if len(rows) < 40:
        print("too few")
        return {"leader": leader, "n": len(rows)}
    mid = len(rows) // 2
    train = rows[:mid]
    a_fit, b_fit = fit_lin(train)
    print(f"pearson={pearson(rows):.4f}")
    print(f"fit_train: dump ≈ {a_fit:.3f} + {b_fit:.3f}*log1p(turn*100)")

    # A) L1 formula on this leader
    e1 = eval_formula(rows, ALPHA1, BETA1)
    print(
        f"L1-formula (±10 cov={e1['within'][10]*100:.1f}% te={e1['split'][10]['te']*100:.1f}% "
        f"lom={e1['lom10']*100:.1f}%) resid_p50={e1['resid']['p50']:.2f}"
    )
    # B) own fit
    e2 = eval_formula(rows, a_fit, b_fit)
    print(
        f"own-fit   (±10 cov={e2['within'][10]*100:.1f}% te={e2['split'][10]['te']*100:.1f}% "
        f"lom={e2['lom10']*100:.1f}%) resid_p50={e2['resid']['p50']:.2f}"
    )
    # C) grid search alpha/beta around L1 (same person, tweaked knobs)
    best = None
    for a in [x / 100 for x in range(-800, -200, 20)]:  # -8..-2
        for b in [x / 100 for x in range(400, 1000, 20)]:  # 4..10
            # score = test within±10, prefer closer to L1
            te_res = [
                r["dump"] - pred(r["turn"], a, b)
                for r in rows[mid:]
            ]
            te = sum(1 for x in te_res if abs(x) <= 10) / len(te_res)
            tr_res = [r["dump"] - pred(r["turn"], a, b) for r in rows[:mid]]
            tr = sum(1 for x in tr_res if abs(x) <= 10) / len(tr_res)
            gap = abs(tr - te)
            score = (te, -gap, -abs(a - ALPHA1) - abs(b - BETA1) * 0.1)
            if best is None or score > best[0]:
                best = (score, a, b, tr, te)
    print(
        f"grid-near-L1 best: a={best[1]:.2f} b={best[2]:.2f} "
        f"tr={best[3]*100:.1f}% te={best[4]*100:.1f}%"
    )
    e3 = eval_formula(rows, best[1], best[2])
    print("buckets dump p50 by turn:")
    for b in e2["buckets"]:
        print(
            f"  turn{b['turn']} n={b['n']} p25/50/75={b['p25']:.1f}/{b['p50']:.1f}/{b['p75']:.1f}"
        )
    return {
        "leader": leader,
        "name": name,
        "n": len(rows),
        "pearson": pearson(rows),
        "fit_train": {"alpha": a_fit, "beta": b_fit},
        "L1_formula": e1,
        "own_fit": e2,
        "grid_best": {"alpha": best[1], "beta": best[2], "tr10": best[3], "te10": best[4]},
        "grid_eval": e3,
    }


def our_last_15m():
    now = int(time.time() * 1000)
    cut = now - 15 * 60 * 1000
    journal = DATA / "journal.jsonl"
    with journal.open("rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 20_000_000))
        raw = f.read().decode("utf-8", errors="ignore")
    entries, attempts = [], []
    for line in raw.splitlines():
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        ts = int(e.get("ts") or e.get("tsMs") or 0)
        if ts < cut - 600_000:
            continue
        k = e.get("kind")
        if k in ("entry", "copy_buy"):
            entries.append(e)
        elif k == "mild_dip_buy_attempt":
            attempts.append(e)
    att_by = defaultdict(list)
    for a in attempts:
        if a.get("mint"):
            att_by[a["mint"]].append(a)
    rows = []
    seen = set()
    for b in sorted(entries, key=lambda x: int(x.get("ts") or 0)):
        ts = int(b.get("ts") or 0)
        if ts < cut:
            continue
        mint = b.get("mint")
        best = None
        for a in att_by.get(mint, []):
            if abs(int(a.get("ts") or 0) - ts) <= 30_000:
                best = a
                break
        if not best:
            continue
        pc = fnum(best.get("pc5m"))
        vol = fnum(best.get("volume5mUsd"))
        liq = fnum(best.get("liquidityUsd"))
        turn = fnum(best.get("turnover5mLiq"))
        if turn is None and vol is not None and liq and liq > 0:
            turn = vol / liq
        if pc is None or turn is None or turn <= 0 or pc >= 0:
            continue
        dump = -pc
        key = (mint, ts // 10_000, round(dump, 1))
        if key in seen:
            continue
        seen.add(key)
        p1 = pred(turn, ALPHA1, BETA1)
        rows.append(
            {
                "age_m": round((now - ts) / 60000, 1),
                "mint": mint,
                "symbol": b.get("symbol") or best.get("symbol"),
                "dump": dump,
                "turn": turn,
                "pred_L1": p1,
                "resid_L1": dump - p1,
                "dipSource": best.get("dipSource"),
                "match8": abs(dump - p1) <= 8,
                "match10": abs(dump - p1) <= 10,
                "match12": abs(dump - p1) <= 12,
            }
        )
    print(f"\n======== OUR last 15m unique dips n={len(rows)} ========")
    if not rows:
        print("none")
        return {"n": 0, "rows": []}
    for s, key in ((8, "match8"), (10, "match10"), (12, "match12")):
        m = sum(1 for r in rows if r[key])
        print(f"L1-formula ±{s}: {m}/{len(rows)} ({100*m/len(rows):.0f}%)")
    by = Counter(r.get("dipSource") or "?" for r in rows)
    print("by source", dict(by))
    for src in sorted(set(r.get("dipSource") or "?" for r in rows)):
        arr = [r for r in rows if (r.get("dipSource") or "?") == src]
        m = sum(1 for r in arr if r["match10"])
        print(f"  {src}: {m}/{len(arr)} ±10")
    print("--- trades ---")
    for r in rows:
        flag = "OK" if r["match10"] else ("~12" if r["match12"] else "NO")
        print(
            f"[{flag}] {r['age_m']:4.1f}m dump={r['dump']:.1f} pred={r['pred_L1']:.1f} "
            f"resid={r['resid_L1']:+.1f} turn={r['turn']:.3f} {r.get('dipSource')} {r['mint'][:8]} {r.get('symbol')}"
        )
    return {"n": len(rows), "match8": sum(1 for r in rows if r["match8"]),
            "match10": sum(1 for r in rows if r["match10"]),
            "match12": sum(1 for r in rows if r["match12"]),
            "rows": rows}


def main():
    # discover leaders
    leaders = Counter()
    for p in DATA.glob("leader-observer-*.jsonl"):
        for line in p.open():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") == "leader_buy_observed" and e.get("leader"):
                leaders[e["leader"]] += 1
    print("leaders in observer:", leaders.most_common())

    fresh = our_last_15m()
    r1 = analyze_leader("L1_8zkg", L1)
    # pick L2: preferred known, else second most common
    l2 = L2 if leaders.get(L2) else (leaders.most_common(2)[1][0] if len(leaders) > 1 else None)
    r2 = analyze_leader("L2", l2) if l2 else {"n": 0}

    # Cross-apply: L2's fitted formula on L1 and vice versa
    cross = {}
    if r1.get("fit_train") and r2.get("n", 0) >= 40:
        rows1 = load_leader_dip_buys(L1)
        rows2 = load_leader_dip_buys(l2)
        a2, b2 = r2["fit_train"]["alpha"], r2["fit_train"]["beta"]
        a1, b1 = r1["fit_train"]["alpha"], r1["fit_train"]["beta"]
        cross["L2fit_on_L1"] = eval_formula(rows1, a2, b2)
        cross["L1fit_on_L2"] = eval_formula(rows2, a1, b1)
        cross["L1canon_on_L2"] = eval_formula(rows2, ALPHA1, BETA1)
        print("\n======== CROSS ========")
        print(
            f"L2-fit on L1 ±10: {cross['L2fit_on_L1']['within'][10]*100:.1f}% "
            f"te={cross['L2fit_on_L1']['split'][10]['te']*100:.1f}%"
        )
        print(
            f"L1-fit on L2 ±10: {cross['L1fit_on_L2']['within'][10]*100:.1f}% "
            f"te={cross['L1fit_on_L2']['split'][10]['te']*100:.1f}%"
        )
        print(
            f"L1-canon on L2 ±10: {cross['L1canon_on_L2']['within'][10]*100:.1f}% "
            f"te={cross['L1canon_on_L2']['split'][10]['te']*100:.1f}%"
        )

    payload = {"fresh15m": fresh, "L1": r1, "L2": r2, "cross": cross}
    # JSON sanitize
    def fix(o):
        if isinstance(o, dict):
            return {k: fix(v) for k, v in o.items()}
        if isinstance(o, list):
            return [fix(x) for x in o]
        if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
            return None
        return o

    path = OUT / "leader-turn-dump-both.json"
    path.write_text(json.dumps(fix(payload), indent=2))
    print("Wrote", path)


if __name__ == "__main__":
    main()
