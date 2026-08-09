#!/usr/bin/env python3
"""
CF on our 60h FIFO buys: keep only entries matching 8zkg turn→dump formula.

Formula (from reverse-eng):
  pred_dump = -5.08 + 6.86 * log1p(turn * 100)
  keep if abs(actual_dump - pred_dump) <= slack
  dump = -pc5m (require pc5m < 0)
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTRACT = ROOT / "artifacts/milddip-oracle60h/extract.json"
OUT_JSON = ROOT / "artifacts/milddip-leader-reverse/cf-turn-dump-formula-60h.json"
OUT_MD = ROOT / "artifacts/milddip-leader-reverse/CF_TURN_DUMP_FORMULA_60H.md"

ALPHA, BETA = -5.08, 6.86


def pred_dump(turn: float) -> float:
    return ALPHA + BETA * math.log1p(turn * 100)


def build_cycles(data: dict) -> list[dict]:
    buys, sells, marks, attempts = data["buys"], data["sells"], data["marks"], data["attempts"]
    series: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for m in marks:
        if m.get("mint") and m.get("ts") and m.get("px") and m["px"] > 0:
            series[m["mint"]].append((int(m["ts"]), float(m["px"])))
    for b in buys:
        if b.get("priceUsd"):
            series[b["mint"]].append((int(b["ts"]), float(b["priceUsd"])))
    for s in sells:
        if s.get("exitPriceUsd"):
            series[s["mint"]].append((int(s["ts"]), float(s["exitPriceUsd"])))
    for mint in series:
        series[mint].sort()

    att_by: dict[str, list] = defaultdict(list)
    for a in attempts:
        att_by[a["mint"]].append(a)
    for m in att_by:
        att_by[m].sort(key=lambda x: x["ts"])

    sells_by: dict[str, list] = defaultdict(list)
    for s in sells:
        sells_by[s["mint"]].append(s)
    for m in sells_by:
        sells_by[m].sort(key=lambda x: x["ts"])

    cycles = []
    cursor: dict[str, int] = defaultdict(int)
    for b in sorted(buys, key=lambda x: x["ts"]):
        mint = b["mint"]
        size = float(b.get("sizeUsd") or 0)
        entry = float(b.get("priceUsd") or 0)
        frac = pnl = 0.0
        legs = []
        reasons = []
        i = cursor[mint]
        sl = sells_by[mint]
        while i < len(sl) and frac < 0.98:
            s = sl[i]
            if s["ts"] < b["ts"]:
                i += 1
                cursor[mint] = i
                continue
            sf = float(s.get("sellFraction") or 1)
            pct = float(s.get("pnlPct") or 0)
            pnl += size * sf * pct / 100.0
            frac += sf
            legs.append(s)
            if s.get("reason"):
                reasons.append(s["reason"])
            i += 1
            cursor[mint] = i
        close_ts = legs[-1]["ts"] if legs else b["ts"]
        mfe = 0.0
        for t, px in series.get(mint, []):
            if b["ts"] <= t <= close_ts and entry > 0:
                mfe = max(mfe, (px - entry) / entry * 100)
        best = None
        for a in att_by.get(mint, []):
            if abs(a["ts"] - b["ts"]) <= 15_000:
                best = a
                break
        vol = float(best["volume5mUsd"]) if best and best.get("volume5mUsd") is not None else None
        liq = float(best["liquidityUsd"]) if best and best.get("liquidityUsd") is not None else None
        turn = (vol / liq) if vol is not None and liq and liq > 0 else None
        pc = float(best["pc5m"]) if best and best.get("pc5m") is not None else None
        dump = (-pc) if pc is not None else None
        pred = pred_dump(turn) if turn is not None and turn > 0 else None
        resid = (dump - pred) if dump is not None and pred is not None else None
        cycles.append(
            {
                "ts": b["ts"],
                "mint": mint,
                "pnl": pnl,
                "size": size,
                "armed": mfe >= 5,
                "pc5m": pc,
                "dump": dump,
                "turn": turn,
                "pred": pred,
                "resid": resid,
                "dipSource": best.get("dipSource") if best else None,
                "lane": best.get("lane") if best else None,
                "has_ctx": turn is not None and turn > 0 and pc is not None,
                "is_dip": pc is not None and pc < 0,
                "reasons": reasons[:3],
            }
        )
    return cycles


def piece_loose_ok(turn: float, dump: float) -> bool:
    if turn < 0.05:
        return 0.5 <= dump <= 12.0
    if turn < 0.15:
        return 2.0 <= dump <= 20.0
    if turn < 0.40:
        return 5.0 <= dump <= 30.0
    return 6.0 <= dump <= 50.0


def summarize(name: str, univ: list[dict], pred) -> dict:
    kept = [c for c in univ if pred(c)]
    skipped = [c for c in univ if not pred(c)]
    base = sum(c["pnl"] for c in univ)
    k = sum(c["pnl"] for c in kept)
    cut_loss = [c for c in skipped if c["pnl"] < 0]
    cut_win = [c for c in skipped if c["pnl"] > 0]
    keep_loss = [c for c in kept if c["pnl"] < 0]
    keep_win = [c for c in kept if c["pnl"] > 0]
    return {
        "name": name,
        "univ_n": len(univ),
        "univ$": round(base, 2),
        "keep_n": len(kept),
        "skip_n": len(skipped),
        "keep$": round(k, 2),
        "Δ": round(k - base, 2),
        "keep_armed$": round(sum(c["pnl"] for c in kept if c["armed"]), 2),
        "keep_never$": round(sum(c["pnl"] for c in kept if not c["armed"]), 2),
        "cut_loss_n": len(cut_loss),
        "cut_loss$": round(sum(c["pnl"] for c in cut_loss), 2),
        "cut_win_n": len(cut_win),
        "cut_win$": round(sum(c["pnl"] for c in cut_win), 2),
        "keep_loss_n": len(keep_loss),
        "keep_loss$": round(sum(c["pnl"] for c in keep_loss), 2),
        "keep_win_n": len(keep_win),
        "keep_win$": round(sum(c["pnl"] for c in keep_win), 2),
        "cut_loss_share_of_all_loss_n": round(
            len(cut_loss) / max(1, sum(1 for c in univ if c["pnl"] < 0)), 3
        ),
        "cut_loss_share_of_all_loss$": round(
            abs(sum(c["pnl"] for c in cut_loss))
            / max(1e-9, abs(sum(c["pnl"] for c in univ if c["pnl"] < 0))),
            3,
        ),
    }


def main() -> None:
    data = json.loads(EXTRACT.read_text())
    cycles = build_cycles(data)
    all_pnl = sum(c["pnl"] for c in cycles)
    ctx = [c for c in cycles if c["has_ctx"]]
    dip = [c for c in ctx if c["is_dip"]]
    print(f"all buys {len(cycles)} ${all_pnl:.2f}")
    print(f"with turn+pc5m {len(ctx)} ${sum(c['pnl'] for c in ctx):.2f}")
    print(f"dip (pc5m<0) {len(dip)} ${sum(c['pnl'] for c in dip):.2f}")

    # residual dist on dip
    res = sorted(c["resid"] for c in dip if c["resid"] is not None)
    n = len(res)
    resid_dist = {
        "n": n,
        "p25": res[n // 4] if n else None,
        "p50": res[n // 2] if n else None,
        "p75": res[3 * n // 4] if n else None,
        "mean": sum(res) / n if n else None,
        "abs_p50": sorted(abs(x) for x in res)[n // 2] if n else None,
        "within_8": sum(1 for x in res if abs(x) <= 8) / n if n else None,
        "within_10": sum(1 for x in res if abs(x) <= 10) / n if n else None,
        "within_12": sum(1 for x in res if abs(x) <= 12) / n if n else None,
    }
    print("resid dump-pred on our dips:", resid_dist)

    rows = []
    # Universe = dip with ctx (fair: formula only defined on dips)
    base_dip = sum(c["pnl"] for c in dip)
    for slack in (6, 8, 10, 12, 15):
        rows.append(
            summarize(
                f"formula±{slack}",
                dip,
                lambda c, s=slack: c["resid"] is not None and abs(c["resid"]) <= s,
            )
        )
    rows.append(summarize("piece_loose", dip, lambda c: piece_loose_ok(c["turn"], c["dump"])))
    # also: skip if TOO DEEP vs formula (resid > +slack) — only cut deeper-than-predicted
    for slack in (6, 8, 10):
        rows.append(
            summarize(
                f"cut_deeper_than_pred+{slack}",
                dip,
                lambda c, s=slack: c["resid"] is not None and c["resid"] <= s,
            )
        )
    # skip if TOO SHALLOW vs formula
    for slack in (6, 8, 10):
        rows.append(
            summarize(
                f"cut_shallower_than_pred-{slack}",
                dip,
                lambda c, s=slack: c["resid"] is not None and c["resid"] >= -s,
            )
        )

    # Also on full ctx (including green pc5m) — formula keep requires dip + match
    rows_ctx = []
    for slack in (8, 10, 12):
        rows_ctx.append(
            summarize(
                f"ctx_keep_dip_formula±{slack}",
                ctx,
                lambda c, s=slack: c["is_dip"]
                and c["resid"] is not None
                and abs(c["resid"]) <= s,
            )
        )

    print("\n=== CF on DIP universe ===")
    for r in rows:
        print(
            f"{r['name']:32s} keep={r['keep_n']:4d}/{r['univ_n']} "
            f"keep$={r['keep$']:+8.2f} Δ={r['Δ']:+8.2f} "
            f"cutLoss$={r['cut_loss$']:+8.2f}(n={r['cut_loss_n']}) "
            f"cutWin$={r['cut_win$']:+8.2f}(n={r['cut_win_n']})"
        )

    print("\n=== CF on all ctx (skip non-dip + non-match) ===")
    for r in rows_ctx:
        print(
            f"{r['name']:32s} keep={r['keep_n']:4d}/{r['univ_n']} "
            f"keep$={r['keep$']:+8.2f} Δ={r['Δ']:+8.2f} "
            f"cutLoss$={r['cut_loss$']:+8.2f} cutWin$={r['cut_win$']:+8.2f}"
        )

    # Worst skipped / kept examples for ±10
    slack = 10
    skipped = [c for c in dip if not (c["resid"] is not None and abs(c["resid"]) <= slack)]
    kept = [c for c in dip if c["resid"] is not None and abs(c["resid"]) <= slack]
    worst_cut = sorted(skipped, key=lambda c: c["pnl"])[:8]
    best_cut = sorted(skipped, key=lambda c: -c["pnl"])[:8]
    print("\nWorst losses CUT by ±10 (good if negative):")
    for c in worst_cut:
        print(
            f"  pnl={c['pnl']:+6.2f} dump={c['dump']:.1f} pred={c['pred']:.1f} "
            f"resid={c['resid']:+.1f} turn={c['turn']:.3f} {c['mint'][:8]} {c.get('dipSource')}"
        )
    print("Best wins CUT by ±10 (bad if large positive):")
    for c in best_cut:
        print(
            f"  pnl={c['pnl']:+6.2f} dump={c['dump']:.1f} pred={c['pred']:.1f} "
            f"resid={c['resid']:+.1f} turn={c['turn']:.3f} {c['mint'][:8]} {c.get('dipSource')}"
        )

    payload = {
        "formula": {"alpha": ALPHA, "beta": BETA, "text": "dump≈-5.08+6.86*log1p(turn*100)"},
        "all": {"n": len(cycles), "pnl": round(all_pnl, 2)},
        "ctx": {"n": len(ctx), "pnl": round(sum(c["pnl"] for c in ctx), 2)},
        "dip": {"n": len(dip), "pnl": round(base_dip, 2)},
        "resid_dist": resid_dist,
        "cf_dip": rows,
        "cf_ctx": rows_ctx,
        "examples_cut_worst": [
            {
                "pnl": round(c["pnl"], 2),
                "dump": c["dump"],
                "pred": c["pred"],
                "resid": c["resid"],
                "turn": c["turn"],
                "mint": c["mint"],
                "dipSource": c.get("dipSource"),
            }
            for c in worst_cut
        ],
        "examples_cut_best": [
            {
                "pnl": round(c["pnl"], 2),
                "dump": c["dump"],
                "pred": c["pred"],
                "resid": c["resid"],
                "turn": c["turn"],
                "mint": c["mint"],
                "dipSource": c.get("dipSource"),
            }
            for c in best_cut
        ],
    }
    OUT_JSON.write_text(json.dumps(payload, indent=2))

    # pick headline ±10
    r10 = next(r for r in rows if r["name"] == "formula±10")
    md = f"""# CF: turn→dump formula on our 60h buys

Formula: `dump ≈ -5.08 + 6.86·log1p(turn·100)`  
Universe: our FIFO buys with attempt ctx and `pc5m < 0` (dips).

## Baseline

| set | n | pnl |
|---|---|---|
| all buys | {len(cycles)} | ${all_pnl:.2f} |
| with turn+pc5m | {len(ctx)} | ${sum(c['pnl'] for c in ctx):.2f} |
| **dip only** | **{len(dip)}** | **${base_dip:.2f}** |

Residual `(actual_dump − pred)` on our dips: p50={resid_dist['p50']}, abs_p50={resid_dist['abs_p50']}, within±10={None if resid_dist['within_10'] is None else round(100*resid_dist['within_10'],1)}%

## Keep if \\|resid\\| ≤ slack

| rule | keep n | keep$ | Δ vs dip | cut loss$ (n) | cut win$ (n) |
|---|---|---|---|---|---|
"""
    for r in rows:
        if not r["name"].startswith("formula") and r["name"] != "piece_loose":
            continue
        md += (
            f"| {r['name']} | {r['keep_n']} | ${r['keep$']:+.2f} | ${r['Δ']:+.2f} | "
            f"${r['cut_loss$']:+.2f} ({r['cut_loss_n']}) | ${r['cut_win$']:+.2f} ({r['cut_win_n']}) |\n"
        )
    md += f"""
### Headline `formula±10`

- keep **{r10['keep_n']}/{r10['univ_n']}** → **${r10['keep$']:+.2f}** (Δ **${r10['Δ']:+.2f}**)
- cut losses: **${r10['cut_loss$']:+.2f}** across {r10['cut_loss_n']} trades
- also cut wins: **${r10['cut_win$']:+.2f}** across {r10['cut_win_n']} trades
- kept armed/never: ${r10['keep_armed$']:+.2f} / ${r10['keep_never$']:+.2f}

## One-sided cuts

"""
    for r in rows:
        if r["name"].startswith("cut_"):
            md += (
                f"- **{r['name']}**: keep ${r['keep$']:+.2f} (Δ ${r['Δ']:+.2f}); "
                f"cutLoss ${r['cut_loss$']:+.2f} / cutWin ${r['cut_win$']:+.2f}\n"
            )
    OUT_MD.write_text(md)
    print("Wrote", OUT_JSON, OUT_MD)


if __name__ == "__main__":
    main()
