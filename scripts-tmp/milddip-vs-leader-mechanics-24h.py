#!/usr/bin/env python3
"""Paired 24h mechanics: our mild-dip cycles vs leader buy/sell on same mints."""
from __future__ import annotations

import json
import statistics as st
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/opt/solana-alpha")
DATA = ROOT / "data" / "milddip"


def main() -> None:
    now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    win = 24 * 3600 * 1000
    cut = now_ms - win

    buys: list[dict] = []
    sell_legs: list[dict] = []
    attempt_by_tx: dict[str, dict] = {}
    marks: dict[str, list[tuple[int, float]]] = defaultdict(list)
    kind_c: Counter[str] = Counter()

    with (DATA / "journal.jsonl").open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            ts = e.get("ts") or 0
            if ts < cut - 6 * 3600 * 1000:
                continue
            k = e.get("kind")
            kind_c[k] += 1
            if k == "copy_buy" and ts >= cut:
                buys.append(e)
            elif k == "copy_sell" and ts >= cut - 3600 * 1000:
                sell_legs.append(e)
            elif k == "mild_dip_buy_attempt" and e.get("ok") and e.get("txSignature"):
                attempt_by_tx[e["txSignature"]] = e
            elif k in ("mark", "mild_dip_mark"):
                mint = e.get("mint")
                px = e.get("priceUsd") or e.get("px")
                if mint and px:
                    marks[mint].append((ts, float(px)))

    print("kinds", kind_c.most_common(12))
    print("buys", len(buys), "sell_legs", len(sell_legs))

    sells_by: dict[str, list] = defaultdict(list)
    for s in sell_legs:
        sells_by[s["mint"]].append(s)
    for m in sells_by:
        sells_by[m].sort(key=lambda x: x["ts"])

    cursor: dict[str, int] = defaultdict(int)
    cycles = []
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
            pnl += size * sf * pct / 100
            frac += sf
            legs.append(s)
            i += 1
            cursor[mint] = i
        if not legs:
            continue
        close_ts = legs[-1]["ts"]
        mfe = 0.0
        for t, px in marks.get(mint, []):
            if b["ts"] <= t <= close_ts and entry > 0:
                mfe = max(mfe, (px / entry - 1) * 100)
        att = attempt_by_tx.get(b.get("txSignature") or "")
        cycles.append(
            {
                "mint": mint,
                "ts": b["ts"],
                "close": close_ts,
                "entry": entry,
                "size": size,
                "pnl_usd": pnl,
                "pnl_pct": (pnl / size * 100 if size else 0),
                "hold": (close_ts - b["ts"]) / 1000,
                "mfe": mfe,
                "reason": legs[-1].get("reason"),
                "pc5m": att.get("pc5m") if att else None,
                "dip": att.get("dipSource") if att else None,
                "sym": b.get("symbol"),
            }
        )
    print("cycles", len(cycles), "pnl", round(sum(c["pnl_usd"] for c in cycles), 2))

    lbuy = []
    lsell = []
    lflat = []
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        for line in p.read_text().splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            ts = e.get("tsMs") or (int(e["blockTime"]) * 1000 if e.get("blockTime") else 0)
            if ts < cut - 2 * 3600 * 1000:
                continue
            e["_ts"] = ts
            k = e.get("kind")
            if k == "leader_buy_observed":
                lbuy.append(e)
            elif k == "leader_sell_observed":
                lsell.append(e)
            elif k == "leader_session_flat":
                lflat.append(e)
    print("leader buys/sells/flats", len(lbuy), len(lsell), len(lflat))

    lb_by: dict[str, list] = defaultdict(list)
    for e in lbuy:
        lb_by[e["mint"]].append(e)
    for m in lb_by:
        lb_by[m].sort(key=lambda x: x["_ts"])
    ls_by: dict[str, list] = defaultdict(list)
    for e in lsell:
        ls_by[e["mint"]].append(e)
    for m in ls_by:
        ls_by[m].sort(key=lambda x: x["_ts"])
    lf_by: dict[str, list] = defaultdict(list)
    for e in lflat:
        lf_by[e["mint"]].append(e)

    paired = []
    for c in cycles:
        mint = c["mint"]
        cands = [
            b
            for b in lb_by.get(mint, [])
            if c["ts"] - 30 * 60 * 1000 <= b["_ts"] <= c["ts"] + 5 * 60 * 1000
        ]
        before = [b for b in cands if b["_ts"] <= c["ts"]]
        after = [b for b in cands if b["_ts"] > c["ts"]]
        lb = None
        if before:
            news = [b for b in before if b.get("isNewBag")]
            lb = (news or before)[-1]
        elif after:
            lb = after[0]
        flats = [
            f
            for f in lf_by.get(mint, [])
            if c["ts"] - 5 * 60 * 1000 <= f["_ts"] <= c["close"] + 2 * 3600 * 1000
        ]
        sells_d = [s for s in ls_by.get(mint, []) if c["ts"] <= s["_ts"] <= c["close"]]
        buys_d = [b for b in lb_by.get(mint, []) if c["ts"] <= b["_ts"] <= c["close"]]
        buys_after = [
            b for b in lb_by.get(mint, []) if c["close"] < b["_ts"] <= c["close"] + 3600 * 1000
        ]
        row: dict = {
            "our": c,
            "lb": lb,
            "flats": flats,
            "sells_during": sells_d,
            "buys_during": buys_d,
            "buys_after": buys_after,
        }
        if lb:
            lpx = lb.get("fillPriceUsd") or ((lb.get("dex") or {}).get("priceUsd"))
            if lpx and c["entry"]:
                row["entry_vs_leader_pct"] = (c["entry"] / float(lpx) - 1) * 100
                row["entry_lag_s"] = (c["ts"] - lb["_ts"]) / 1000
            dex = lb.get("dex") if isinstance(lb.get("dex"), dict) else {}
            row["leader_pc5m"] = dex.get("pc5m") if dex else lb.get("pc5m")
            row["leader_class"] = lb.get("class")
            row["leader_is_add"] = lb.get("isAdd")
            row["leader_is_new"] = lb.get("isNewBag")
        if flats:
            f = min(flats, key=lambda x: abs(x["_ts"] - c["close"]))
            row["leader_flat_pct"] = f.get("pnlPctApprox")
            row["leader_held"] = f.get("heldSec")
            row["leader_flat_vs_our_exit_s"] = (f["_ts"] - c["close"]) / 1000
        paired.append(row)

    with_l = [p for p in paired if p.get("lb")]
    print("paired", len(with_l), "/", len(paired))

    def sumpnl(arr: list) -> float:
        return sum(p["our"]["pnl_usd"] for p in arr)

    print("\n=== ENTRY price vs leader fill ===")
    bands = [
        ("we_cheaper_lt-5%", lambda p: (p.get("entry_vs_leader_pct") or 0) < -5),
        ("we_cheaper_-5..-1", lambda p: -5 <= (p.get("entry_vs_leader_pct") or 0) < -1),
        ("near_pm1", lambda p: abs(p.get("entry_vs_leader_pct") or 99) <= 1),
        ("we_worse_1..5", lambda p: 1 < (p.get("entry_vs_leader_pct") or 0) <= 5),
        ("we_worse_gt5", lambda p: (p.get("entry_vs_leader_pct") or 0) > 5),
    ]
    for lab, pred in bands:
        arr = [p for p in with_l if pred(p) and p.get("entry_vs_leader_pct") is not None]
        if not arr:
            continue
        lags = [p["entry_lag_s"] for p in arr if p.get("entry_lag_s") is not None]
        vs = [p["entry_vs_leader_pct"] for p in arr]
        print(
            f"{lab:18s} n={len(arr):3d} our$={sumpnl(arr):+8.1f} "
            f"med_vsL={st.median(vs):+.1f}% med_lag_s={st.median(lags) if lags else 0:.0f}"
        )

    print("\n=== TIMING vs leader buy ===")
    for lab, pred in [
        ("we_earlier_>30s", lambda p: (p.get("entry_lag_s") or 0) < -30),
        ("same_pm30s", lambda p: abs(p.get("entry_lag_s") or 999) <= 30),
        ("we_later_>30s", lambda p: (p.get("entry_lag_s") or 0) > 30),
        ("we_later_>5m", lambda p: (p.get("entry_lag_s") or 0) > 300),
    ]:
        arr = [p for p in with_l if p.get("entry_lag_s") is not None and pred(p)]
        print(f"{lab:16s} n={len(arr):3d} our$={sumpnl(arr):+8.1f}")

    print("\n=== EXIT patterns ===")
    he_sold_first = [
        p for p in paired if p["sells_during"] and any(s.get("isFlat") for s in p["sells_during"])
    ]
    we_sold_he_buys = [p for p in paired if p["buys_after"]]
    he_buys_dump = [p for p in paired if p["buys_during"] and p["our"]["pnl_usd"] < 0]
    print(
        f"he FLAT while we hold: n={len(he_sold_first)} our$={sumpnl(he_sold_first):+.1f} "
        f"our_med_hold_m={st.median([p['our']['hold'] for p in he_sold_first])/60 if he_sold_first else 0:.1f}"
    )
    hf = [p for p in he_sold_first if p.get("leader_held") is not None]
    if hf:
        print(
            f"  his_med_hold_m={st.median([p['leader_held'] for p in hf])/60:.1f} "
            f"our_med_hold_m={st.median([p['our']['hold'] for p in hf])/60:.1f} "
            f"flat_minus_our_exit_med_s={st.median([p['leader_flat_vs_our_exit_s'] for p in hf]):+.0f}"
        )
    print(f"we sell -> he buys <1h: n={len(we_sold_he_buys)} our$={sumpnl(we_sold_he_buys):+.1f}")
    print(f"he buys during our loser: n={len(he_buys_dump)} our$={sumpnl(he_buys_dump):+.1f}")

    print("\nOur reasons when he sold first:", Counter(p["our"].get("reason") or "?" for p in he_sold_first).most_common(8))
    print("Our reasons when we sold he bought after:", Counter(p["our"].get("reason") or "?" for p in we_sold_he_buys).most_common(8))

    print("\n=== His entry class (paired) ===")
    by_c: dict[str, list] = defaultdict(list)
    for p in with_l:
        by_c[str(p.get("leader_class") or "?")].append(p)
    for cls, arr in sorted(by_c.items(), key=lambda x: -len(x[1])):
        later = 100 * sum(1 for p in arr if (p.get("entry_lag_s") or 0) > 30) / len(arr)
        print(f"{cls:12s} n={len(arr):3d} our$={sumpnl(arr):+8.1f} we_later_>30s={later:.0f}%")

    print("\n=== ADD vs NEW bag (his buy we paired) ===")
    for lab, pred in [
        ("his_new_bag", lambda p: p.get("leader_is_new")),
        ("his_add", lambda p: p.get("leader_is_add")),
    ]:
        arr = [p for p in with_l if pred(p)]
        print(f"{lab:12s} n={len(arr):3d} our$={sumpnl(arr):+8.1f}")

    print("\n=== EXAMPLES he +pct / we red ===")
    ex = [
        p
        for p in with_l
        if p.get("leader_flat_pct") is not None
        and p["leader_flat_pct"] > 5
        and p["our"]["pnl_usd"] < -1
    ]
    ex.sort(key=lambda p: p["our"]["pnl_usd"])
    for p in ex[:10]:
        c = p["our"]
        print(
            f"  {c['sym']} our {c['pnl_pct']:+.1f}% hold={c['hold']/60:.1f}m reason={c['reason']} | "
            f"him {p.get('leader_flat_pct'):+.1f}% hold={(p.get('leader_held') or 0)/60:.1f}m | "
            f"vsL={p.get('entry_vs_leader_pct')} lag_s={p.get('entry_lag_s')} "
            f"class={p.get('leader_class')} add={p.get('leader_is_add')}"
        )

    print("\n=== EXIT reason $ attribution (all our cycles) ===")
    by_r: dict[str, list] = defaultdict(list)
    for c in cycles:
        by_r[str(c.get("reason") or "?")].append(c)
    for r, arr in sorted(by_r.items(), key=lambda x: sum(c["pnl_usd"] for c in x[1])):
        print(f"{r:28s} n={len(arr):3d} $={sum(c['pnl_usd'] for c in arr):+8.1f} med_hold_m={st.median([c['hold'] for c in arr])/60:.1f}")

    out = {
        "cycles": len(cycles),
        "pnl": round(sum(c["pnl_usd"] for c in cycles), 2),
        "paired": len(with_l),
        "he_sold_first_n": len(he_sold_first),
        "he_sold_first_$": round(sumpnl(he_sold_first), 2),
        "we_sold_he_buys_n": len(we_sold_he_buys),
        "we_sold_he_buys_$": round(sumpnl(we_sold_he_buys), 2),
        "he_buys_our_dump_n": len(he_buys_dump),
        "he_buys_our_dump_$": round(sumpnl(he_buys_dump), 2),
    }
    Path("/tmp/milddip-vs-leader-mechanics.json").write_text(json.dumps(out, indent=2))
    print("\nSUMMARY", json.dumps(out))


if __name__ == "__main__":
    main()
