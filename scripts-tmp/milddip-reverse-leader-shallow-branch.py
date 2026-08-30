#!/usr/bin/env python3
"""
Reverse-eng 8zkg (and 7BNax) buys that FAIL the main turn→dump gate —
candidate "shallow branch" separate from dump≈-5.08+6.86·log(turn).
"""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path

DATA = Path("/opt/solana-alpha/data/milddip")
OUT = Path("/tmp/leader-reverse")
OUT.mkdir(parents=True, exist_ok=True)

LEADERS = {
    "L1_8zkg": "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ",
    "L2_7BNax": "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5",
}
ALPHA, BETA = -5.08, 6.86
SHALLOW, DEEP = 10.0, 12.0  # live 1.11.774+


def fnum(x):
    try:
        return None if x is None else float(x)
    except Exception:
        return None


def pred_dump(turn: float) -> float:
    return ALPHA + BETA * math.log1p(turn * 100)


def formula_ok(dump: float, turn: float) -> bool:
    p = pred_dump(turn)
    return (p - SHALLOW) <= dump <= (p + DEEP)


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


def cov(arr, pred):
    return sum(1 for x in arr if pred(x)) / len(arr) if arr else 0.0


def load_buys(wallet: str):
    rows = []
    seen = set()
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        for line in p.open():
            e = json.loads(line)
            if e.get("leader") != wallet:
                continue
            if e.get("kind") not in (None, "leader_buy_observed") and e.get("kind") != "leader_buy_observed":
                # older lines may omit kind
                if e.get("side") and e.get("side") != "buy":
                    continue
                if e.get("kind") and e.get("kind") != "leader_buy_observed":
                    continue
            if e.get("kind") == "leader_session_open":
                continue
            # accept buy observations
            if e.get("side") == "sell":
                continue
            d = e.get("dex") if isinstance(e.get("dex"), dict) else {}
            if d.get("error"):
                continue
            pc = fnum(d.get("pc5m", e.get("pc5m")))
            if pc is None or pc >= 0:
                continue
            vol = fnum(d.get("vol5m"))
            liq = fnum(d.get("liq"))
            turn = fnum(d.get("turnover5mLiq"))
            if turn is None and vol and liq and liq > 0:
                turn = vol / liq
            if not turn or turn <= 0:
                continue
            dump = -pc
            sig = e.get("signature") or ""
            ts = int(e.get("tsMs") or (e.get("blockTime") or 0) * 1000)
            key = (e.get("mint"), sig or ts)
            if key in seen:
                continue
            seen.add(key)
            h1 = fnum(d.get("pc1h"))
            mcap = fnum(d.get("mcap"))
            age = fnum(d.get("ageHours"))
            buys = fnum(d.get("buys5m"))
            sells = fnum(d.get("sells5m"))
            pred = pred_dump(turn)
            resid = dump - pred
            rows.append(
                {
                    "mint": e.get("mint"),
                    "sig": sig,
                    "ts": ts,
                    "dump": dump,
                    "pc5m": pc,
                    "h1": h1,
                    "turn": turn,
                    "vol": vol,
                    "liq": liq,
                    "mcap": mcap,
                    "age": age,
                    "buys": buys,
                    "sells": sells,
                    "bs_ratio": (buys / sells) if buys and sells and sells > 0 else None,
                    "pred": pred,
                    "resid": resid,
                    "formula": formula_ok(dump, turn),
                    "size": fnum(e.get("sizeUsd")),
                    "class": e.get("class"),
                    "is_new": e.get("isNewBag"),
                    "is_add": e.get("isAdd"),
                }
            )
    rows.sort(key=lambda x: x["ts"])
    return rows


def fit_log(rows):
    """OLS dump ~ a + b*log1p(turn*100)"""
    xs, ys = [], []
    for r in rows:
        xs.append(math.log1p(r["turn"] * 100))
        ys.append(r["dump"])
    n = len(xs)
    if n < 8:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    if den <= 0:
        return None
    b = num / den
    a = my - b * mx
    # pearson
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    dx = math.sqrt(den)
    pear = num / (dx * dy) if dx and dy else None
    # coverage ±slack
    covs = {}
    for slack in (4, 6, 8, 10, 12, 15):
        ok = sum(1 for x, y in zip(xs, ys) if abs(y - (a + b * x)) <= slack) / n
        covs[slack] = ok
    return {"alpha": a, "beta": b, "n": n, "pearson": pear, "cov": covs}


def analyze(name: str, rows: list):
    pass_r = [r for r in rows if r["formula"]]
    fail_r = [r for r in rows if not r["formula"]]
    # fail modes
    too_shallow = [r for r in fail_r if r["resid"] < -SHALLOW]
    too_deep = [r for r in fail_r if r["resid"] > DEEP]
    print(f"\n======== {name} ========")
    print(f"dip buys {len(rows)} formula_pass {len(pass_r)} fail {len(fail_r)} shallow_fail {len(too_shallow)} deep_fail {len(too_deep)}")

    mid = max(1, len(too_shallow) // 2)
    tr, te = too_shallow[:mid], too_shallow[mid:]

    out = {
        "n_all": len(rows),
        "n_pass": len(pass_r),
        "n_fail": len(fail_r),
        "n_shallow_fail": len(too_shallow),
        "n_deep_fail": len(too_deep),
        "pass_dump": dist([r["dump"] for r in pass_r]),
        "pass_turn": dist([r["turn"] for r in pass_r]),
        "pass_resid": dist([r["resid"] for r in pass_r]),
        "shallow_fail_dump": dist([r["dump"] for r in too_shallow]),
        "shallow_fail_turn": dist([r["turn"] for r in too_shallow]),
        "shallow_fail_resid": dist([r["resid"] for r in too_shallow]),
        "shallow_fail_h1": dist([r["h1"] for r in too_shallow if r["h1"] is not None]),
        "shallow_fail_vol": dist([r["vol"] for r in too_shallow if r["vol"]]),
        "shallow_fail_liq": dist([r["liq"] for r in too_shallow if r["liq"]]),
        "shallow_fail_mcap": dist([r["mcap"] for r in too_shallow if r["mcap"]]),
        "shallow_fail_age": dist([r["age"] for r in too_shallow if r["age"] is not None]),
        "shallow_fail_size": dist([r["size"] for r in too_shallow if r["size"]]),
        "class_pass": dict(Counter(r["class"] for r in pass_r)),
        "class_shallow_fail": dict(Counter(r["class"] for r in too_shallow)),
    }

    print("shallow_fail dump", out["shallow_fail_dump"])
    print("shallow_fail turn", out["shallow_fail_turn"])
    print("shallow_fail resid", out["shallow_fail_resid"])
    print("shallow_fail h1", out["shallow_fail_h1"])
    print("classes fail", out["class_shallow_fail"])

    # Fit alternate formula on shallow-fail only
    fit_sf = fit_log(too_shallow)
    fit_all = fit_log(rows)
    fit_pass = fit_log(pass_r)
    out["fit_shallow_fail"] = fit_sf
    out["fit_all"] = fit_all
    out["fit_pass"] = fit_pass
    print("fit shallow_fail", fit_sf)
    print("fit pass", fit_pass)

    # Bucket dump p50 by turn on shallow-fail
    buckets = [(-1, 0.05), (0.05, 0.15), (0.15, 0.4), (0.4, 1.0), (1.0, 99)]
    turn_buckets = []
    for a, b in buckets:
        g = [r["dump"] for r in too_shallow if a < r["turn"] <= b]
        turn_buckets.append({"turn": f"({a},{b}]", **dist(g)})
        print(f"  turn ({a},{b}] dump", dist(g))
    out["shallow_fail_dump_by_turn"] = turn_buckets

    # Same for pass (reference)
    pass_buckets = []
    for a, b in buckets:
        g = [r["dump"] for r in pass_r if a < r["turn"] <= b]
        pass_buckets.append({"turn": f"({a},{b}]", **dist(g)})
    out["pass_dump_by_turn"] = pass_buckets

    # Hypothesis coverage on shallow-fail (train/test)
    hyps = []

    def add(name, pred, note=""):
        if not te or not tr:
            return
        te_c, tr_c = cov(te, pred), cov(tr, pred)
        hyps.append(
            {
                "name": name,
                "te": te_c,
                "tr": tr_c,
                "gap": abs(te_c - tr_c),
                "all": cov(too_shallow, pred),
                "note": note,
            }
        )

    # H1: fixed dump band (our h1_red-like)
    for dmin, dmax in [(-10, -3), (-10, -2), (-8, -2), (-8, -3), (-6, -2), (-5, -2), (-12, -2), (-15, -2)]:
        add(
            f"dump_band[{dmin},{-dmax}]",
            lambda r, a=dmin, b=dmax: a < r["pc5m"] <= b,
        )
    # H2: dump band + h1 red
    for h1max in (-5, -8, -10, -12, -15, -20):
        for dmin, dmax in [(-10, -2), (-8, -2), (-6, -2), (-10, -3)]:
            add(
                f"h1<={h1max}_dump({dmin},{-dmax}]",
                lambda r, h=h1max, a=dmin, b=dmax: r["h1"] is not None
                and r["h1"] <= h
                and a < r["pc5m"] <= b,
            )
    # H3: dump >= floor only (any turn) — shallow clip
    for floor in (2, 3, 4, 5, 6, 8):
        add(f"dump>={floor}", lambda r, f=floor: r["dump"] >= f)
        add(f"dump_in[{floor},12]", lambda r, f=floor: f <= r["dump"] <= 12)
        add(f"dump_in[{floor},15]", lambda r, f=floor: f <= r["dump"] <= 15)

    # H4: alternate log fit from shallow-fail itself, with slacks
    if fit_sf:
        a, b = fit_sf["alpha"], fit_sf["beta"]
        for slack in (4, 6, 8, 10, 12):
            add(
                f"alt_fit±{slack}",
                lambda r, a=a, b=b, s=slack: abs(r["dump"] - (a + b * math.log1p(r["turn"] * 100)))
                <= s,
            )
            # one-sided: dump >= pred_alt - slack (allow deeper)
            add(
                f"alt_fit_ge_pred-{slack}",
                lambda r, a=a, b=b, s=slack: r["dump"]
                >= (a + b * math.log1p(r["turn"] * 100)) - s,
            )

    # H5: main formula but much wider shallow slack
    for slack in (12, 15, 18, 20, 25):
        add(
            f"main_shallow_slack_{slack}",
            lambda r, s=slack: r["dump"] >= r["pred"] - s and r["dump"] <= r["pred"] + DEEP,
        )

    # H6: low-turn shallow only (turn gate) + dump band
    for tmax in (0.05, 0.1, 0.15, 0.2, 0.3, 0.4):
        for dmin, dmax in [(2, 12), (2, 10), (3, 10), (3, 8), (4, 12)]:
            add(
                f"turn<={tmax}_dump[{dmin},{dmax}]",
                lambda r, t=tmax, a=dmin, b=dmax: r["turn"] <= t and a <= r["dump"] <= b,
            )

    # H7: high-turn still shallow — "scalp branch": turn high, dump small absolute
    for tmin in (0.1, 0.15, 0.2, 0.25):
        for dmax in (5, 6, 8, 10, 12):
            add(
                f"turn>={tmin}_dump<={dmax}_dump>=2",
                lambda r, t=tmin, d=dmax: r["turn"] >= t and 2 <= r["dump"] <= d,
            )

    # H8: liq/mcap floors (structural) + dump band — almost all should have this
    add(
        "struct_liq10k_mcap50k_vol500_dump[2,15]",
        lambda r: (r["liq"] or 0) >= 10_000
        and (r["mcap"] or 0) >= 50_000
        and (r["vol"] or 0) >= 500
        and 2 <= r["dump"] <= 15,
    )

    # H9: size small micro
    for smax in (5, 10, 15, 20, 25):
        add(
            f"size<={smax}_dump[2,12]",
            lambda r, s=smax: r["size"] is not None and r["size"] <= s and 2 <= r["dump"] <= 12,
        )

    hyps.sort(key=lambda h: (-h["te"], -h["tr"], h["gap"]))
    # prefer te>=0.7 gap<=0.15
    good = [h for h in hyps if h["te"] >= 0.70 and h["gap"] <= 0.15]
    print("\nTOP hyps te>=70 gap<=15:")
    for h in (good[:20] or hyps[:20]):
        print(
            f"  te={h['te']*100:5.1f}% tr={h['tr']*100:5.1f}% gap={h['gap']*100:4.1f}% all={h['all']*100:5.1f}% | {h['name']}"
        )
    out["hyps_top"] = (good[:30] or hyps[:30])

    # Piecewise claim: for shallow-fail, is dump ~ constant?
    # Compare variance explained by constant vs log turn
    out["claim_candidates"] = []
    # Best simple band
    for h in hyps:
        if h["name"].startswith("dump_in[") or h["name"].startswith("dump>="):
            if h["te"] >= 0.75 and h["gap"] <= 0.12:
                out["claim_candidates"].append(h)
    for h in hyps:
        if "alt_fit" in h["name"] and h["te"] >= 0.70:
            out["claim_candidates"].append(h)
    for h in hyps:
        if h["name"].startswith("turn>=") and h["te"] >= 0.55:
            out["claim_candidates"].append(h)

    # Cross: what % of shallow-fail would pass h1_red live band
    h1_live = [
        r
        for r in too_shallow
        if r["h1"] is not None and r["h1"] <= -15 and -10 < r["pc5m"] <= -3
    ]
    out["shallow_fail_in_h1_red_live"] = {
        "n": len(h1_live),
        "share": len(h1_live) / len(too_shallow) if too_shallow else 0,
    }
    print(
        "shallow_fail in live h1_red band:",
        out["shallow_fail_in_h1_red_live"],
    )

    # resid distribution vs pass
    print("pass resid", out["pass_resid"])
    return out, too_shallow, pass_r


def main():
    payload = {}
    for name, wallet in LEADERS.items():
        rows = load_buys(wallet)
        summary, shallow_fail, pass_r = analyze(name, rows)
        payload[name] = summary
        # sample recent shallow fails
        payload[name]["recent_shallow_fail"] = [
            {
                "mint": r["mint"][:12],
                "dump": round(r["dump"], 2),
                "turn": round(r["turn"], 4),
                "pred": round(r["pred"], 2),
                "resid": round(r["resid"], 2),
                "h1": r["h1"],
                "class": r["class"],
                "size": r["size"],
                "vol": r["vol"],
                "liq": r["liq"],
            }
            for r in shallow_fail[-15:]
        ]

    outp = OUT / "leader-shallow-branch.json"
    outp.write_text(json.dumps(payload, indent=2))
    print("\nWrote", outp)


if __name__ == "__main__":
    main()
