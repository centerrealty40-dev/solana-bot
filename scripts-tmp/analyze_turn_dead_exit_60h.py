#!/usr/bin/env python3
"""Leader exit turn/vol hypothesis + our 60h counterfactual backtest."""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

DATA = Path("data/milddip")


def load_our_roundtrips_60h():
    rts = []
    max_ts = 0
    with open(DATA / "trades.jsonl") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("kind") != "trade_roundtrip" or o.get("actor") != "us":
                continue
            ts = o.get("closedAtMs") or o.get("ts") or 0
            max_ts = max(max_ts, ts)
            rts.append(o)
    tmin = max_ts - 60 * 3600 * 1000
    rts60 = [o for o in rts if (o.get("closedAtMs") or o.get("ts") or 0) >= tmin]
    return rts60, tmin, max_ts


def load_marks(tmin: int):
    marks_by_mint: dict[str, list] = defaultdict(list)
    with open(DATA / "journal.jsonl") as f:
        for line in f:
            if "mild_dip_mark" not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("kind") != "mild_dip_mark":
                continue
            if (o.get("ts") or 0) < tmin - 7_200_000:
                continue
            marks_by_mint[o["mint"]].append(o)
    return marks_by_mint


def cash_pnl(rt) -> float | None:
    buy = rt.get("buyCostUsd") or 0
    sell = rt.get("sellProceedsUsd")
    if not buy or sell is None:
        return None
    return 100.0 * (sell - buy) / buy


def main() -> None:
    rts60, tmin, max_ts = load_our_roundtrips_60h()
    marks_by_mint = load_marks(tmin)
    print(f"OUR roundtrips60={len(rts60)} window_end={max_ts}")

    # --- diagnose vol while red ---
    ratios_red = []
    abs_red = []
    null_when_red = ok_when_red = 0
    trade_stats = []
    for rt in rts60:
        mint = rt["mint"]
        opened = rt.get("openedAtMs") or 0
        closed = rt.get("closedAtMs") or rt.get("ts") or 0
        final = cash_pnl(rt)
        if final is None:
            continue
        series = []
        for o in marks_by_mint.get(mint, []):
            ts = o.get("ts") or 0
            if ts < opened - 5000 or ts > closed + 5000:
                continue
            v = o.get("vol5m")
            ev = o.get("entryVol5m")
            pnl = o.get("pnlPct")
            if pnl is not None and pnl <= -10:
                if v is None:
                    null_when_red += 1
                else:
                    ok_when_red += 1
                    abs_red.append(v)
                    if ev and ev > 0:
                        ratios_red.append(v / ev)
            if v is not None and ev and ev > 0 and pnl is not None:
                series.append((pnl, v / ev, v, ev))
        reds = [x for x in series if x[0] <= -10]
        trade_stats.append(
            {
                "mint": mint[:8],
                "final": final,
                "reason": rt.get("exitReason"),
                "hold": rt.get("holdSec"),
                "n": len(series),
                "n_red": len(reds),
                "min_ratio_red": min((x[1] for x in reds), default=None),
                "min_ratio_any": min((x[1] for x in series), default=None),
                "entry_vol": series[0][3] if series else None,
            }
        )

    print(f"when pnl<=-10: vol_null={null_when_red} vol_ok={ok_when_red}")
    if ratios_red:
        s = sorted(ratios_red)
        n = len(s)
        print(
            "vol/entry while pnl<=-10: "
            f"p10={s[int(0.1*(n-1))]:.3f} p50={s[n//2]:.3f} p90={s[int(0.9*(n-1))]:.3f} "
            f"frac<=0.25={sum(1 for x in s if x<=0.25)/n:.2f} "
            f"frac<=0.5={sum(1 for x in s if x<=0.5)/n:.2f} "
            f"frac<=1={sum(1 for x in s if x<=1)/n:.2f}"
        )
    if abs_red:
        s = sorted(abs_red)
        n = len(s)
        print(
            f"abs vol5m while red: p10={s[int(0.1*(n-1))]:.0f} "
            f"p25={s[int(0.25*(n-1))]:.0f} p50={s[n//2]:.0f}"
        )

    long_loss = sorted(
        [t for t in trade_stats if t["final"] <= -5 and (t["hold"] or 0) >= 300],
        key=lambda x: x["final"],
    )
    print(f"\nlong losses (>=5m, final<=-5): {len(long_loss)}")
    for t in long_loss[:12]:
        print(t)

    # --- leader cash flats ---
    flats = []
    for path in sorted(DATA.glob("leader-observer-2026080*.jsonl")):
        with open(path) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("kind") != "leader_session_flat":
                    continue
                cost = o.get("totalCostUsd")
                cash = o.get("cashPnlUsd")
                if not cost or cost <= 0 or cash is None:
                    continue
                pnl = 100.0 * cash / cost
                td = o.get("exitTurnDump") or {}
                et = o.get("entryTurnDump") or {}
                flats.append(
                    {
                        "pnl": pnl,
                        "turn": td.get("turn"),
                        "entry_turn": et.get("turn"),
                        "held": o.get("heldSec"),
                        "exit_pc": (o.get("exitGates") or {}).get("pc5m"),
                        "leader": (o.get("leader") or "")[:8],
                    }
                )
    with_t = [x for x in flats if x["turn"] is not None]
    print(f"\nLEADER cash flats={len(flats)} with_exit_turn={len(with_t)}")
    for name, cond in [
        ("loss<=-10", lambda x: x["pnl"] <= -10),
        ("win>=10", lambda x: x["pnl"] >= 10),
        ("loss held>=10m", lambda x: x["pnl"] <= -5 and (x["held"] or 0) >= 600),
        ("all", lambda x: True),
    ]:
        arr = [x for x in with_t if cond(x)]
        if not arr:
            print(name, "n=0")
            continue
        turns = sorted(x["turn"] for x in arr)
        n = len(turns)
        print(
            f"{name}: n={n} turn_p25={turns[n//4]:.4f} turn_p50={turns[n//2]:.4f} "
            f"frac_turn<=0.05={sum(1 for x in arr if x['turn']<=0.05)/n:.2f} "
            f"frac_turn<=0.08={sum(1 for x in arr if x['turn']<=0.08)/n:.2f}"
        )

    # entry→exit turn fade on cash flats
    print("\nLEADER exit/entry turn ratio (cash):")
    for name, cond in [("loss", lambda x: x["pnl"] < 0), ("win", lambda x: x["pnl"] > 0)]:
        arr = [
            x
            for x in with_t
            if cond(x) and x.get("entry_turn") and x["entry_turn"] > 0 and x["turn"] is not None
        ]
        if not arr:
            continue
        ratios = sorted(x["turn"] / x["entry_turn"] for x in arr)
        n = len(ratios)
        print(
            f"  {name}: n={n} ratio_p50={ratios[n//2]:.3f} "
            f"frac_ratio<=0.35={sum(1 for r in ratios if r<=0.35)/n:.2f} "
            f"frac_ratio<=0.5={sum(1 for r in ratios if r<=0.5)/n:.2f}"
        )

    # --- our backtests ---
    def backtest(pred, label: str):
        helped = hurt = trig = 0
        usd = 0.0
        deltas = []
        examples = []
        for rt in rts60:
            mint = rt["mint"]
            opened = rt.get("openedAtMs") or 0
            closed = rt.get("closedAtMs") or rt.get("ts") or 0
            final = cash_pnl(rt)
            buy = rt.get("buyCostUsd") or 0
            if final is None:
                continue
            series = [
                o
                for o in marks_by_mint.get(mint, [])
                if opened - 5000 <= (o.get("ts") or 0) <= closed + 5000
            ]
            series.sort(key=lambda o: o.get("ts") or 0)
            tp = pred(series)
            if tp is None:
                continue
            trig += 1
            d = tp - final
            deltas.append(d)
            usd += buy * d / 100.0
            if d > 1:
                helped += 1
            elif d < -1:
                hurt += 1
            examples.append((d, tp, final, rt.get("exitReason"), mint[:8], buy))
        avg = sum(deltas) / len(deltas) if deltas else 0.0
        med = sorted(deltas)[len(deltas) // 2] if deltas else 0.0
        print(
            f"{label}: trig={trig}/{len(rts60)} help={helped} hurt={hurt} "
            f"avgΔ={avg:.1f}pp medΔ={med:.1f}pp USD={usd:+.2f}"
        )
        if examples:
            examples.sort()
            print("  worst:", examples[:2])
            print("  best:", examples[-2:])
        return {
            "label": label,
            "trig": trig,
            "helped": helped,
            "hurt": hurt,
            "avg": avg,
            "med": med,
            "usd": usd,
        }

    results = []

    def make_vol(pt, ratio, mh, need):
        def pred(series):
            consec = 0
            for o in series:
                v = o.get("vol5m")
                ev = o.get("entryVol5m")
                pnl = o.get("pnlPct")
                held = o.get("heldSec") or 0
                if v is None or not ev or ev <= 0 or pnl is None:
                    consec = 0
                    continue
                if held >= mh and pnl <= -pt and v <= ev * ratio:
                    consec += 1
                else:
                    consec = 0
                if consec >= need:
                    return pnl
            return None

        return pred

    def make_abs(pt, floor, mh, need):
        def pred(series):
            consec = 0
            for o in series:
                v = o.get("vol5m")
                pnl = o.get("pnlPct")
                held = o.get("heldSec") or 0
                if v is None or pnl is None:
                    consec = 0
                    continue
                if held >= mh and pnl <= -pt and v <= floor:
                    consec += 1
                else:
                    consec = 0
                if consec >= need:
                    return pnl
            return None

        return pred

    print("\n======== OUR vol/entry fade grid ========")
    for pt in [5, 10, 15, 20]:
        for ratio in [0.25, 0.5, 0.75, 1.0, 1.5]:
            for need in [1, 3, 5]:
                label = f"volFade pnl<=-{pt} vol<=entry×{ratio} held>=180 need={need}"
                r = backtest(make_vol(pt, ratio, 180, need), label)
                if r["trig"] >= 3:
                    results.append(r)

    print("\n======== OUR abs vol floor grid ========")
    for pt in [5, 10, 15]:
        for floor in [300, 500, 1000, 2000, 5000]:
            for need in [1, 3]:
                label = f"absVol pnl<=-{pt} vol<=${floor} held>=300 need={need}"
                r = backtest(make_abs(pt, floor, 300, need), label)
                if r["trig"] >= 3:
                    results.append(r)

    # join leader liq for turn on our marks
    liq_series: dict[str, list] = defaultdict(list)
    for path in sorted(DATA.glob("leader-observer-2026080*.jsonl")):
        with open(path) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("kind") not in (
                    "leader_bag_mark",
                    "leader_buy_observed",
                    "leader_sell_observed",
                ):
                    continue
                d = o.get("dex") or {}
                liq = d.get("liq")
                if not liq:
                    continue
                ts = o.get("tsMs") or (o.get("blockTime") or 0) * 1000
                vol = d.get("vol5m")
                liq_series[o["mint"]].append(
                    (ts, float(liq), float(vol) if vol is not None else None)
                )
    for m in liq_series:
        liq_series[m].sort()

    def nearest_liq(mint, ts, tol=600_000):
        arr = liq_series.get(mint) or []
        best = None
        for t, liq, vol in arr:
            if abs(t - ts) <= tol:
                if best is None or abs(t - ts) < abs(best[0] - ts):
                    best = (t, liq, vol)
            if t > ts + tol:
                break
        return best

    def make_turn(pt, turn_thr, mh, need):
        def pred(series):
            consec = 0
            for o in series:
                pnl = o.get("pnlPct")
                held = o.get("heldSec") or 0
                ts = o.get("ts") or 0
                mint = o.get("mint")
                hit = nearest_liq(mint, ts)
                if hit is None or pnl is None:
                    consec = 0
                    continue
                _t, liq, lvol = hit
                vol = o.get("vol5m")
                if vol is None:
                    vol = lvol
                if vol is None or not liq:
                    consec = 0
                    continue
                turn = vol / liq
                if held >= mh and pnl <= -pt and turn <= turn_thr:
                    consec += 1
                else:
                    consec = 0
                if consec >= need:
                    return pnl
            return None

        return pred

    print("\n======== OUR turn (liq-joined) grid ========")
    for pt in [5, 10, 15]:
        for tt in [0.03, 0.05, 0.08, 0.12]:
            for need in [1, 2, 3]:
                label = f"turnDead pnl<=-{pt} turn<={tt} held>=300 need={need}"
                r = backtest(make_turn(pt, tt, 300, need), label)
                if r["trig"] >= 2:
                    results.append(r)

    print("\n======== BEST by USD ========")
    results.sort(key=lambda r: r["usd"], reverse=True)
    for r in results[:15]:
        print(
            f"  USD={r['usd']:+.2f} help={r['helped']} hurt={r['hurt']} "
            f"avg={r['avg']:.1f} | {r['label']}"
        )

    # vs time exits only
    print("\n======== on TIME-exit trades only ========")
    time_reasons = {"never_arm_timeout", "max_hold_underwater", "never_arm_time_red"}

    def backtest_time(pred, label: str):
        helped = hurt = trig = 0
        usd = 0.0
        for rt in rts60:
            if rt.get("exitReason") not in time_reasons:
                continue
            mint = rt["mint"]
            opened = rt.get("openedAtMs") or 0
            closed = rt.get("closedAtMs") or rt.get("ts") or 0
            final = cash_pnl(rt)
            buy = rt.get("buyCostUsd") or 0
            if final is None:
                continue
            series = [
                o
                for o in marks_by_mint.get(mint, [])
                if opened - 5000 <= (o.get("ts") or 0) <= closed + 5000
            ]
            series.sort(key=lambda o: o.get("ts") or 0)
            tp = pred(series)
            if tp is None:
                continue
            trig += 1
            d = tp - final
            usd += buy * d / 100.0
            if d > 1:
                helped += 1
            elif d < -1:
                hurt += 1
        print(f"{label}: trig={trig} help={helped} hurt={hurt} USD={usd:+.2f}")

    for pt, ratio, need in [(10, 1.0, 1), (10, 0.75, 1), (5, 0.5, 1), (15, 1.0, 1)]:
        backtest_time(
            make_vol(pt, ratio, 180, need),
            f"TIME volFade -{pt}/x{ratio}/n{need}",
        )
    for pt, floor, need in [(10, 1000, 1), (10, 2000, 1), (5, 500, 1)]:
        backtest_time(
            make_abs(pt, floor, 300, need),
            f"TIME absVol -{pt}/vol<=${floor}/n{need}",
        )

    out = {
        "our_n": len(rts60),
        "leader_cash_flats_with_turn": len(with_t),
        "best": results[:20],
        "vol_red_null": null_when_red,
        "vol_red_ok": ok_when_red,
    }
    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/turn-dead-exit-60h.json").write_text(json.dumps(out, indent=2))
    print("\nWrote artifacts/turn-dead-exit-60h.json")


if __name__ == "__main__":
    main()
