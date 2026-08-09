#!/usr/bin/env python3
"""60h CF: apply 8zkg-style entry pattern to mild-dip FIFO buys (not wallet copy)."""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTRACT = ROOT / "artifacts/milddip-oracle60h/extract.json"
OUT = ROOT / "artifacts/milddip-oracle60h/cf-leader-entry-60h.json"


def main() -> None:
    data = json.loads(EXTRACT.read_text())
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
        cycles.append(
            {
                "pnl": pnl,
                "armed": mfe >= 5,
                "pc5m": pc,
                "turn": turn,
                "has_ctx": turn is not None and pc is not None,
            }
        )

    act = sum(c["pnl"] for c in cycles)
    ctx = [c for c in cycles if c["has_ctx"]]

    def cf_rows(univ: list, base: float) -> list[dict]:
        rules = [
            ("baseline", lambda c: True),
            ("turn>=0.09", lambda c: c["turn"] is not None and c["turn"] >= 0.09),
            ("turn>=0.14", lambda c: c["turn"] is not None and c["turn"] >= 0.14),
            ("pc_(-5,-1]", lambda c: c["pc5m"] is not None and -5 < c["pc5m"] <= -1),
            ("pc_(-8,-1]", lambda c: c["pc5m"] is not None and -8 < c["pc5m"] <= -1),
            ("pc>-15", lambda c: c["pc5m"] is not None and c["pc5m"] > -15),
            ("pc>-12", lambda c: c["pc5m"] is not None and c["pc5m"] > -12),
            ("LEADER turn>=0.09 & pc_(-8,-1]", lambda c: c["turn"] is not None and c["turn"] >= 0.09 and c["pc5m"] is not None and -8 < c["pc5m"] <= -1),
            ("LEADER turn>=0.09 & pc_(-15,-5]", lambda c: c["turn"] is not None and c["turn"] >= 0.09 and c["pc5m"] is not None and -15 < c["pc5m"] <= -5),
            ("LEADER turn>=0.09 & pc>-15", lambda c: c["turn"] is not None and c["turn"] >= 0.09 and c["pc5m"] is not None and c["pc5m"] > -15),
            ("LEADER turn>=0.14 & pc>-15", lambda c: c["turn"] is not None and c["turn"] >= 0.14 and c["pc5m"] is not None and c["pc5m"] > -15),
        ]
        out = []
        for name, pred in rules:
            kept = [c for c in univ if pred(c)]
            skipped = [c for c in univ if not pred(c)]
            k = sum(c["pnl"] for c in kept)
            out.append(
                {
                    "name": name,
                    "keep_n": len(kept),
                    "keep$": round(k, 2),
                    "Δ": round(k - base, 2),
                    "keep_armed$": round(sum(c["pnl"] for c in kept if c["armed"]), 2),
                    "keep_never$": round(sum(c["pnl"] for c in kept if not c["armed"]), 2),
                    "cutW": round(sum(c["pnl"] for c in skipped if c["pnl"] > 0), 2),
                    "avoidL": round(sum(c["pnl"] for c in skipped if c["pnl"] <= 0), 2),
                }
            )
        return out

    pcs = sorted(c["pc5m"] for c in ctx)
    turns = sorted(c["turn"] for c in ctx)
    n_best = sum(1 for c in ctx if -5 < c["pc5m"] <= -1)
    n_deep = sum(1 for c in ctx if c["pc5m"] <= -15)
    n_dead = sum(1 for c in ctx if c["turn"] < 0.09)

    payload = {
        "window": "60h FIFO mild-dip buys",
        "actual": round(act, 2),
        "n": len(cycles),
        "with_ctx": len(ctx),
        "missing_features": ["vol1h/mcap — not in extract attempts"],
        "leader_recipe": "turn5m=vol5m/liq ≥ 0.09 AND mild dip (his best pc5m −5…−1; on our book adapt pc > −15)",
        "our_vs_leader": {
            "pc5m_p50": round(pcs[len(pcs) // 2], 2),
            "turn_p50": round(turns[len(turns) // 2], 4),
            "pct_in_leader_best_pc": round(100 * n_best / len(ctx), 1),
            "pct_pc_le_minus15": round(100 * n_deep / len(ctx), 1),
            "pct_turn_lt_0.09": round(100 * n_dead / len(ctx), 1),
        },
        "cf_all": cf_rows(cycles, act),
        "cf_ctx": cf_rows(ctx, sum(c["pnl"] for c in ctx)),
    }
    OUT.write_text(json.dumps(payload, indent=2))
    print(json.dumps({"actual": payload["actual"], "our_vs_leader": payload["our_vs_leader"], "top": payload["cf_all"][-3:]}, indent=2))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
