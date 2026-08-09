#!/usr/bin/env python3
"""
Proper 60h CF of two-branch leader exit on OUR mild-dip trades.

Rebuilds holds from mild_dip_sell + mild_dip_mark path.
Compares actual exit pnlPct vs first fire of dual policy on the mark path.
"""
from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

DATA = Path("data/milddip")
HOURS = 60


@dataclass
class Policy:
    name: str
    arm: float
    gb: float
    tp: float | None
    down_held: float
    down_sl: float
    down_pc: float | None = None
    down_need: int = 1


def pct(xs, q):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    s = sorted(xs)
    return s[int(q * (len(s) - 1))]


def fire(series, pol: Policy):
    armed = False
    down_c = 0
    for o in series:
        held = o.get("heldSec")
        pnl = o.get("pnlPct")
        mfe = o.get("mfePct")
        gb = o.get("givebackPct")
        pc = o.get("pc5m")
        if held is None or pnl is None:
            continue
        held = float(held)
        pnl = float(pnl)
        if mfe is not None and float(mfe) >= pol.arm:
            armed = True
        if armed:
            if pol.tp is not None and pnl >= pol.tp:
                return pnl, "up_tp", held
            if gb is not None and float(gb) <= -pol.gb:
                return pnl, "up_trail", held
        else:
            ok = held >= pol.down_held and pnl <= -pol.down_sl
            if ok and pol.down_pc is not None:
                if pc is None or float(pc) > pol.down_pc:
                    ok = False
            down_c = down_c + 1 if ok else 0
            if down_c >= pol.down_need:
                return pnl, "down", held
    return None, None, None


def load_pc_index():
    idx = defaultdict(list)
    for p in sorted(DATA.glob("leader-observer*.jsonl")):
        with open(p) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("kind") not in (
                    "leader_bag_mark",
                    "leader_sell_observed",
                    "leader_buy_observed",
                ):
                    continue
                mint = o.get("mint")
                d = o.get("dex") or {}
                g = o.get("gates") or {}
                pc = g.get("pc5m") if g.get("pc5m") is not None else d.get("pc5m")
                if mint is None or pc is None:
                    continue
                ts = o.get("tsMs") or ((o.get("blockTime") or 0) * 1000)
                if ts:
                    idx[mint].append((int(ts), float(pc)))
    for k in idx:
        idx[k].sort()
    return idx


def nearest_pc(idx, mint, ts):
    arr = idx.get(mint)
    if not arr:
        return None
    best = None
    best_dt = 10**18
    for t, pc in arr:
        if t <= ts and (ts - t) < best_dt:
            best_dt = ts - t
            best = pc
        elif t > ts:
            dt = t - ts
            if dt < 180_000 and dt < best_dt:
                best = pc
                best_dt = dt
            break
    return best


def main():
    print("scanning journal for sells + marks...")
    sells_all = []
    marks_by = defaultdict(list)
    max_ts = 0
    with open(DATA / "journal.jsonl") as f:
        for line in f:
            if "mild_dip_" not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            k = o.get("kind")
            ts = o.get("ts") or 0
            if ts:
                max_ts = max(max_ts, ts)
            if k == "mild_dip_sell":
                sells_all.append(o)
            elif k == "mild_dip_mark":
                marks_by[o["mint"]].append(o)

    for mint in marks_by:
        marks_by[mint].sort(key=lambda o: o.get("ts") or 0)

    tmin = max_ts - HOURS * 3600 * 1000
    sells = [o for o in sells_all if (o.get("ts") or 0) >= tmin]
    print(f"window_end={max_ts} sells60={len(sells)} mark_mints={len(marks_by)}")
    print(
        "sell fields: holdMs/holdSec",
        sum(1 for o in sells if o.get("holdMs") is not None or o.get("holdSec") is not None),
        "pnl/realized",
        sum(1 for o in sells if o.get("pnlPct") is not None or o.get("realizedPct") is not None),
        "ok_false",
        sum(1 for o in sells if o.get("ok") is False),
        "scaleOut",
        sum(1 for o in sells if o.get("scaleOut") is True),
    )
    print("reasons", Counter(o.get("reason") for o in sells).most_common(12))

    pc_idx = load_pc_index()
    print(f"pc5m index mints={len(pc_idx)}")

    def sell_final(o):
        # new schema: realizedPct; old: pnlPct
        for k in ("realizedPct", "pnlPct"):
            if o.get(k) is not None:
                try:
                    return float(o[k])
                except (TypeError, ValueError):
                    pass
        entry = o.get("entryPx") or o.get("entryPriceUsd")
        exitp = o.get("exitPx") or o.get("exitPriceUsd")
        try:
            entry = float(entry) if entry is not None else None
            exitp = float(exitp) if exitp is not None else None
        except (TypeError, ValueError):
            return None
        if entry and exitp and entry > 0:
            return (exitp / entry - 1) * 100
        return None

    def sell_hold_ms(o):
        if o.get("holdMs") is not None:
            try:
                return int(o["holdMs"])
            except (TypeError, ValueError):
                pass
        if o.get("holdSec") is not None:
            try:
                return int(float(o["holdSec"]) * 1000)
            except (TypeError, ValueError):
                pass
        return None

    # Build trade paths
    trades = []
    stats = Counter()
    for s in sells:
        if s.get("ok") is False:
            stats["ok_false"] += 1
            continue
        # skip partial scale-outs — CF needs full bag path to flat
        if s.get("scaleOut") is True and (s.get("fraction") or 1) < 0.999:
            stats["partial_skip"] += 1
            continue
        mint = s.get("mint")
        closed = s.get("ts") or 0
        final = sell_final(s)
        hold_ms = sell_hold_ms(s)
        if not mint or final is None:
            stats["missing_basic"] += 1
            continue
        if not hold_ms or hold_ms <= 0:
            arr = marks_by.get(mint, [])
            near = [
                m
                for m in arr
                if (closed - 6 * 3600 * 1000) <= (m.get("ts") or 0) <= closed + 5000
            ]
            if not near:
                stats["no_hold_no_marks"] += 1
                continue
            last = near[-1]
            hs = last.get("heldSec")
            if hs is None:
                stats["no_hold_bad_marks"] += 1
                continue
            hold_ms = int(float(hs) * 1000)
            opened = closed - hold_ms
            stats["hold_from_mark"] += 1
        else:
            opened = closed - int(hold_ms)
            stats["hold_from_sell"] += 1

        series = []
        for m in marks_by.get(mint, []):
            ts = m.get("ts") or 0
            if ts < opened - 5000 or ts > closed + 5000:
                continue
            item = {
                "ts": ts,
                "heldSec": m.get("heldSec"),
                "pnlPct": m.get("pnlPct"),
                "mfePct": m.get("mfePct"),
                "givebackPct": m.get("givebackPct"),
                "pc5m": m.get("pc5m"),
                "armed": m.get("armed"),
            }
            if item["heldSec"] is None:
                item["heldSec"] = max(0, (ts - opened) / 1000)
            if (
                item["givebackPct"] is None
                and item["mfePct"] is not None
                and item["pnlPct"] is not None
            ):
                mfe = float(item["mfePct"])
                pnl = float(item["pnlPct"])
                if mfe > -99:
                    item["givebackPct"] = ((1 + pnl / 100) / (1 + mfe / 100) - 1) * 100
            if item["pc5m"] is None:
                item["pc5m"] = nearest_pc(pc_idx, mint, ts)
            if item["pnlPct"] is None:
                continue
            series.append(item)
        if len(series) < 3:
            stats["short_series"] += 1
            continue
        trades.append(
            {
                "mint": mint,
                "opened": opened,
                "closed": closed,
                "hold_ms": hold_ms,
                "final": float(final),
                "reason": s.get("reason") or s.get("sellReason"),
                "series": series,
                "entry": s.get("entryPx") or s.get("entryPriceUsd"),
                "exit": s.get("exitPx") or s.get("exitPriceUsd"),
                "quote": s.get("quoteReceivedUsd"),
            }
        )
        stats["ok_trade"] += 1

    print("build stats", dict(stats))
    print(f"usable trades60={len(trades)}")
    if not trades:
        print("NO TRADES — abort")
        return

    finals = [t["final"] for t in trades]
    print(
        f"actual: n={len(trades)} winrate={sum(1 for x in finals if x>0)/len(finals):.2f} "
        f"pnl50={pct(finals,0.5):.1f} pnl_avg={sum(finals)/len(finals):.1f} "
        f"pnl10={pct(finals,0.1):.1f} pnl90={pct(finals,0.9):.1f}"
    )

    policies = [
        Policy("ACTUAL(baseline)", 999, 999, None, 10**9, 999),  # never fires early — handled separately
        Policy("UP tp12|a8/g12 + DN h600/sl20", 8, 12, 12, 600, 20, None),
        Policy("UP tp12|a8/g12 + DN h300/sl15", 8, 12, 12, 300, 15, None),
        Policy("UP tp12|a8/g12 + DN h300/sl15/pc-5", 8, 12, 12, 300, 15, -5),
        Policy("UP tp20|a8/g12 + DN h300/sl15", 8, 12, 20, 300, 15, None),
        Policy("UP a8/g15 + DN h300/sl15", 8, 15, None, 300, 15, None),
        Policy("UP a8/g15 + DN h300/sl15/pc-5", 8, 15, None, 300, 15, -5),
        Policy("UP tp12|a5/g10 + DN h300/sl15", 5, 10, 12, 300, 15, None),
        Policy("UP tp15|a8/g10 + DN h600/sl15", 8, 10, 15, 600, 15, None),
        Policy("DOWN-only h300/sl15", 999, 999, None, 300, 15, None),
        Policy("DOWN-only h600/sl20", 999, 999, None, 600, 20, None),
        Policy("UP-only tp12|a8/g12", 8, 12, 12, 10**9, 999, None),
        Policy("UP-only a8/g15", 8, 15, None, 10**9, 999, None),
    ]

    results = []
    print("\n======== 60h CF (mark% vs actual sell pnlPct) ========")
    for pol in policies:
        rows = []
        for t in trades:
            if pol.name.startswith("ACTUAL"):
                cf = t["final"]
                branch = "actual"
                held = t["hold_ms"] / 1000
            else:
                cf, branch, held = fire(t["series"], pol)
                if cf is None:
                    # no early fire → same as actual
                    cf = t["final"]
                    branch = "no_fire=actual"
            delta = cf - t["final"]
            rows.append(
                {
                    "final": t["final"],
                    "cf": cf,
                    "delta": delta,
                    "branch": branch,
                    "mint": t["mint"][:8],
                    "reason": t["reason"],
                    "held": held,
                }
            )

        # For non-baseline: also report only-triggered subset
        deltas = [r["delta"] for r in rows]
        cfs = [r["cf"] for r in rows]
        helped = sum(1 for d in deltas if d > 1)
        hurt = sum(1 for d in deltas if d < -1)
        trig = [r for r in rows if r["branch"] not in ("actual", "no_fire=actual")]
        print(
            f"\n{pol.name}: ALL n={len(rows)} "
            f"cf_avg={sum(cfs)/len(cfs):.1f} act_avg={sum(finals)/len(finals):.1f} "
            f"avgΔ={sum(deltas)/len(deltas):.1f} medΔ={pct(deltas,0.5):.1f} "
            f"help={helped} hurt={hurt} "
            f"cf_win={sum(1 for x in cfs if x>0)/len(cfs):.2f} "
            f"act_win={sum(1 for x in finals if x>0)/len(finals):.2f}"
        )
        if trig:
            td = [r["delta"] for r in trig]
            print(
                f"  triggered early: n={len(trig)}/{len(rows)} "
                f"avgΔ={sum(td)/len(td):.1f} medΔ={pct(td,0.5):.1f} "
                f"help={sum(1 for d in td if d>1)} hurt={sum(1 for d in td if d<-1)}"
            )
            by = defaultdict(list)
            for r in trig:
                by[r["branch"]].append(r["delta"])
            for b, ds in sorted(by.items()):
                print(
                    f"    {b}: n={len(ds)} avgΔ={sum(ds)/len(ds):.1f} "
                    f"help={sum(1 for d in ds if d>1)} hurt={sum(1 for d in ds if d<-1)}"
                )
        # sum of pnl (equal-weight per trade) — proxy edge
        print(
            f"  SUM pnl: actual={sum(finals):.0f} cf={sum(cfs):.0f} "
            f"Δsum={sum(cfs)-sum(finals):+.0f}"
        )
        results.append(
            {
                "name": pol.name,
                "n": len(rows),
                "trig": len(trig),
                "avg_delta": sum(deltas) / len(deltas),
                "med_delta": pct(deltas, 0.5),
                "cf_avg": sum(cfs) / len(cfs),
                "act_avg": sum(finals) / len(finals),
                "cf_sum": sum(cfs),
                "act_sum": sum(finals),
                "helped": helped,
                "hurt": hurt,
                "cf_win": sum(1 for x in cfs if x > 0) / len(cfs),
            }
        )

    print("\n======== RANK by Δsum pnl (equal weight) ========")
    ranked = sorted(results, key=lambda r: -(r["cf_sum"] - r["act_sum"]))
    for r in ranked:
        print(
            f"  {r['name']}: Δsum={r['cf_sum']-r['act_sum']:+.0f} "
            f"cf_avg={r['cf_avg']:.1f} avgΔ={r['avg_delta']:.1f} "
            f"trig={r['trig']}/{r['n']} help={r['helped']} hurt={r['hurt']}"
        )

    # Sanity: if formula is "their exits", early fire should be NEAR actual (small |delta|)
    print("\n======== Fit check: |cf-actual|<5pp among early triggers ========")
    for pol in policies:
        if pol.name.startswith("ACTUAL"):
            continue
        near = early = 0
        for t in trades:
            cf, branch, _ = fire(t["series"], pol)
            if cf is None:
                continue
            early += 1
            if abs(cf - t["final"]) < 5:
                near += 1
        print(
            f"  {pol.name}: near={near}/{early} ({100*near/early if early else 0:.0f}%)"
        )

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/cf_td_two_branch_60h.json").write_text(
        json.dumps(
            {
                "hours": HOURS,
                "n_trades": len(trades),
                "actual_avg": sum(finals) / len(finals),
                "actual_sum": sum(finals),
                "results": results,
            },
            indent=2,
        )
    )
    print("\nWrote artifacts/cf_td_two_branch_60h.json")


if __name__ == "__main__":
    main()
