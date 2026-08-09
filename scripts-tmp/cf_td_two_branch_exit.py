#!/usr/bin/env python3
"""
Counterfactual: two-branch leader TD exit scheme on:
  1) our mild-dip roundtrips (trades.jsonl cash + journal sells mark%)
  2) leader TD path sessions (dex marks)

UP:   if mfe>=arm: sell on pnl>=tp OR giveback<=-gb
DOWN: if never armed: sell on held>=T & pnl<=-sl [& optional pc5m<=pc]
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

DATA = Path("data/milddip")
TD = {"shallow", "mild_shallow", "mild_deep", "deep_knife", "rug_knife"}


def pct(xs, q):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    s = sorted(xs)
    return s[int(q * (len(s) - 1))]


def price(o):
    if not o:
        return None
    p = o.get("dexPriceUsd") or o.get("exitPriceUsd") or o.get("markPriceUsd") or o.get("px")
    if p is None:
        p = (o.get("dex") or {}).get("priceUsd")
    try:
        p = float(p) if p is not None else None
    except (TypeError, ValueError):
        return None
    return p if p and p > 0 else None


def is_td_buy(o):
    if o.get("class") == "green":
        return False
    g = o.get("gates") or {}
    td = o.get("turnDump") or {}
    if g.get("main") is True:
        return True
    if td.get("inMain") or td.get("inShallow") or td.get("branch") in ("main", "shallow"):
        return True
    return o.get("class") in TD


@dataclass
class Policy:
    name: str
    arm: float
    gb: float
    tp: float | None
    down_held: float
    down_sl: float
    down_pc: float | None  # None = ignore pc5m
    down_need: int = 1  # consecutive marks for DOWN


def fire_two_branch(series, pol: Policy):
    """
    series items: dict with heldSec/held, pnlPct/pnl, mfePct/mfe, givebackPct/gb, pc5m?
    Returns pnl at first fire or None.
    """
    armed = False
    down_c = 0
    for o in series:
        held = o.get("heldSec")
        if held is None:
            held = o.get("held")
        pnl = o.get("pnlPct")
        if pnl is None:
            pnl = o.get("pnl")
        mfe = o.get("mfePct")
        if mfe is None:
            mfe = o.get("mfe")
        gb = o.get("givebackPct")
        if gb is None:
            gb = o.get("gb")
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
            # also compute gb from peak if missing — skip
        else:
            ok = held >= pol.down_held and pnl <= -pol.down_sl
            if ok and pol.down_pc is not None:
                if pc is None or float(pc) > pol.down_pc:
                    ok = False
            if ok:
                down_c += 1
            else:
                down_c = 0
            if down_c >= pol.down_need:
                return pnl, "down", held
    return None, None, None


def summarize(rows, label):
    """rows: list of dicts with final, cf, delta, buy, branch"""
    if not rows:
        print(f"{label}: n=0")
        return None
    deltas = [r["delta"] for r in rows]
    helped = sum(1 for d in deltas if d > 1)
    hurt = sum(1 for d in deltas if d < -1)
    usd = sum(r.get("usd", 0.0) for r in rows)
    print(
        f"{label}: n={len(rows)} help={helped} hurt={hurt} "
        f"avgΔ={sum(deltas)/len(deltas):.1f}pp medΔ={pct(deltas,0.5):.1f}pp "
        f"USD={usd:+.2f} "
        f"cf_pnl50={pct([r['cf'] for r in rows],0.5):.1f} "
        f"act_pnl50={pct([r['final'] for r in rows],0.5):.1f}"
    )
    by_b = defaultdict(list)
    for r in rows:
        by_b[r.get("branch") or "?"].append(r["delta"])
    for b, ds in sorted(by_b.items()):
        print(
            f"  branch {b}: n={len(ds)} avgΔ={sum(ds)/len(ds):.1f} "
            f"help={sum(1 for d in ds if d>1)} hurt={sum(1 for d in ds if d<-1)}"
        )
    worst = sorted(rows, key=lambda r: r["delta"])[:3]
    best = sorted(rows, key=lambda r: r["delta"])[-3:]
    print("  worst:", [(round(r["delta"], 1), r.get("mint"), r.get("reason"), round(r["final"], 1), round(r["cf"], 1)) for r in worst])
    print("  best:", [(round(r["delta"], 1), r.get("mint"), r.get("reason"), round(r["final"], 1), round(r["cf"], 1)) for r in best])
    return {
        "label": label,
        "n": len(rows),
        "helped": helped,
        "hurt": hurt,
        "avg": sum(deltas) / len(deltas),
        "med": pct(deltas, 0.5),
        "usd": usd,
    }


# ---------- load our marks ----------
def load_our_marks(tmin_ms: int):
    by = defaultdict(list)
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
            ts = o.get("ts") or 0
            if ts < tmin_ms - 3_600_000:
                continue
            by[o["mint"]].append(o)
    for k in by:
        by[k].sort(key=lambda o: o.get("ts") or 0)
    return by


def load_pc5m_index():
    """mint -> [(tsMs, pc5m)] from leader bag marks + sells."""
    idx = defaultdict(list)
    for p in sorted(DATA.glob("leader-observer*.jsonl")):
        with open(p) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                k = o.get("kind")
                if k not in ("leader_bag_mark", "leader_sell_observed", "leader_buy_observed"):
                    continue
                mint = o.get("mint")
                if not mint:
                    continue
                d = o.get("dex") or {}
                g = o.get("gates") or {}
                pc = g.get("pc5m") if g.get("pc5m") is not None else d.get("pc5m")
                if pc is None:
                    continue
                ts = o.get("tsMs") or ((o.get("blockTime") or 0) * 1000)
                if ts:
                    idx[mint].append((ts, float(pc)))
    for k in idx:
        idx[k].sort()
    return idx


def nearest_pc(idx, mint, ts):
    arr = idx.get(mint)
    if not arr:
        return None
    # last pc at or before ts, else nearest within 3m
    best = None
    best_dt = 10**18
    for t, pc in arr:
        dt = abs(t - ts)
        if t <= ts and (ts - t) < best_dt:
            best_dt = ts - t
            best = pc
        elif t > ts and dt < 180_000 and dt < best_dt:
            best_dt = dt
            best = pc
    return best


def cf_our_cash(policies, marks_by, pc_idx):
    print("\n======== CF OUR trades.jsonl (cash) ========")
    rts = []
    with open(DATA / "trades.jsonl") as f:
        for line in f:
            o = json.loads(line)
            if o.get("kind") == "trade_roundtrip" and o.get("actor") == "us":
                rts.append(o)
    print(f"roundtrips={len(rts)}")
    out = {}
    for pol in policies:
        rows = []
        for rt in rts:
            mint = rt["mint"]
            opened = rt.get("openedAtMs") or 0
            closed = rt.get("closedAtMs") or rt.get("ts") or 0
            buy = rt.get("buyCostUsd") or 0
            sell = rt.get("sellProceedsUsd")
            if not buy or sell is None:
                continue
            final = 100.0 * (sell - buy) / buy
            series = []
            for o in marks_by.get(mint, []):
                ts = o.get("ts") or 0
                if ts < opened - 5000 or ts > closed + 5000:
                    continue
                item = dict(o)
                if item.get("pc5m") is None:
                    item["pc5m"] = nearest_pc(pc_idx, mint, ts)
                # normalize giveback: journal has givebackPct already
                series.append(item)
            if len(series) < 2:
                continue
            cf, branch, _ = fire_two_branch(series, pol)
            if cf is None:
                continue
            delta = cf - final
            rows.append(
                {
                    "final": final,
                    "cf": cf,
                    "delta": delta,
                    "usd": buy * delta / 100.0,
                    "branch": branch,
                    "mint": mint[:8],
                    "reason": rt.get("exitReason"),
                }
            )
        out[pol.name] = summarize(rows, pol.name)
    return out


def cf_our_journal_sells(policies, marks_by, pc_idx, hours=60):
    print(f"\n======== CF OUR mild_dip_sell mark% (last {hours}h) ========")
    sells = []
    # find max ts
    max_ts = 0
    with open(DATA / "journal.jsonl") as f:
        for line in f:
            if "mild_dip_sell" not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("kind") != "mild_dip_sell" or not o.get("ok", True):
                continue
            ts = o.get("ts") or 0
            max_ts = max(max_ts, ts)
            sells.append(o)
    tmin = max_ts - hours * 3600 * 1000
    sells = [o for o in sells if (o.get("ts") or 0) >= tmin]
    print(f"sells={len(sells)} window_end={max_ts}")
    out = {}
    for pol in policies:
        rows = []
        for s in sells:
            mint = s.get("mint")
            closed = s.get("ts") or 0
            hold_ms = s.get("holdMs") or 0
            opened = closed - hold_ms if hold_ms else None
            final = s.get("pnlPct")
            if final is None or opened is None or not mint:
                continue
            series = []
            for o in marks_by.get(mint, []):
                ts = o.get("ts") or 0
                if ts < opened - 5000 or ts > closed + 5000:
                    continue
                item = dict(o)
                if item.get("pc5m") is None:
                    item["pc5m"] = nearest_pc(pc_idx, mint, ts)
                series.append(item)
            if len(series) < 2:
                continue
            cf, branch, _ = fire_two_branch(series, pol)
            if cf is None:
                continue
            delta = cf - float(final)
            rows.append(
                {
                    "final": float(final),
                    "cf": cf,
                    "delta": delta,
                    "usd": 0.0,
                    "branch": branch,
                    "mint": mint[:8],
                    "reason": s.get("reason") or s.get("sellReason"),
                }
            )
        out[pol.name] = summarize(rows, pol.name)
    return out


def cf_leader_td(policies):
    print("\n======== CF LEADER TD paths (vs actual flat) ========")
    buys, sells, marks = [], defaultdict(list), defaultdict(list)
    for p in sorted(DATA.glob("leader-observer*.jsonl")):
        with open(p) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                k = o.get("kind")
                if k == "leader_buy_observed":
                    buys.append(o)
                elif k == "leader_sell_observed":
                    sells[(o.get("leader"), o.get("mint"))].append(o)
                elif k == "leader_bag_mark":
                    marks[(o.get("leader"), o.get("mint"))].append(o)
    for k in sells:
        sells[k].sort(key=lambda x: x.get("blockTime") or 0)
    for k in marks:
        marks[k].sort(key=lambda x: x.get("tsMs") or 0)

    sessions = []
    for b in buys:
        if not is_td_buy(b) or b.get("isAdd"):
            continue
        key = (b.get("leader"), b.get("mint"))
        bt = b.get("blockTime") or 0
        if not bt:
            continue
        sell = None
        for s in sells.get(key, []):
            st = s.get("blockTime") or 0
            if st < bt:
                continue
            if st - bt > 6 * 3600:
                break
            if s.get("isFlat") or s.get("tokenPostUi") == 0:
                sell = s
                break
        if not sell:
            continue
        entry = price(b)
        exitp = price(sell)
        if not entry or not exitp:
            continue
        final = (exitp / entry - 1) * 100
        if not (-95 <= final <= 300):
            continue
        t0 = bt * 1000
        t1 = (sell.get("blockTime") or bt) * 1000
        series = []
        peak = entry
        for m in marks.get(key, []):
            ts = m.get("tsMs") or 0
            if ts < t0 - 5000 or ts >= t1:
                continue
            mark = price(m)
            if not mark:
                continue
            pnl = (mark / entry - 1) * 100
            if not (-95 <= pnl <= 300):
                continue
            if mark > peak:
                peak = mark
            d = m.get("dex") or {}
            g = m.get("gates") or {}
            pc = g.get("pc5m") if g.get("pc5m") is not None else d.get("pc5m")
            series.append(
                {
                    "heldSec": max(0, (ts - t0) / 1000),
                    "pnlPct": pnl,
                    "mfePct": (peak / entry - 1) * 100,
                    "givebackPct": (mark / peak - 1) * 100,
                    "pc5m": float(pc) if pc is not None else None,
                }
            )
        if len(series) < 3:
            continue
        sessions.append(
            {
                "leader": (b.get("leader") or "")[:8],
                "mint": (b.get("mint") or "")[:8],
                "final": final,
                "series": series,
            }
        )
    print(f"leader TD path sessions={len(sessions)}")
    out = {}
    for pol in policies:
        rows = []
        for s in sessions:
            cf, branch, _ = fire_two_branch(s["series"], pol)
            if cf is None:
                continue
            delta = cf - s["final"]
            rows.append(
                {
                    "final": s["final"],
                    "cf": cf,
                    "delta": delta,
                    "usd": 0.0,
                    "branch": branch,
                    "mint": s["mint"],
                    "reason": s["leader"],
                }
            )
        out[pol.name] = summarize(rows, pol.name)
        # per leader
        for lead in sorted(set(s["leader"] for s in sessions)):
            sub = []
            for s in sessions:
                if s["leader"] != lead:
                    continue
                cf, branch, _ = fire_two_branch(s["series"], pol)
                if cf is None:
                    continue
                sub.append(
                    {
                        "final": s["final"],
                        "cf": cf,
                        "delta": cf - s["final"],
                        "usd": 0.0,
                        "branch": branch,
                        "mint": s["mint"],
                        "reason": lead,
                    }
                )
            summarize(sub, f"  {lead} | {pol.name}")
    return out


def main():
    policies = [
        Policy("UP tp20|a8/g12 + DN h300/sl15", 8, 12, 20, 300, 15, None),
        Policy("UP tp20|a8/g12 + DN h300/sl15/pc-5", 8, 12, 20, 300, 15, -5),
        Policy("UP tp12|a8/g12 + DN h300/sl15/pc-5", 8, 12, 12, 300, 15, -5),
        Policy("UP a8/g15 + DN h300/sl15/pc-5", 8, 15, None, 300, 15, -5),
        Policy("UP a8/g15 + DN h900/sl15/pc-5", 8, 15, None, 900, 15, -5),
        Policy("UP tp12|a8/g12 + DN h600/sl20", 8, 12, 12, 600, 20, None),
        Policy("UP tp20|a8/g12 + DN h300/sl15 need2", 8, 12, 20, 300, 15, None, 2),
        Policy("UP tp20|a8/g12 + DN h300/sl15/pc-5 need2", 8, 12, 20, 300, 15, -5, 2),
        # 8zkg-ish / 7BNax-ish
        Policy("8zkg-ish a8/g15 + DN h1800/sl20/pc-5", 8, 15, None, 1800, 20, -5),
        Policy("7BNax-ish tp12|a5/g10 + DN h300/sl15/pc-5", 5, 10, 12, 300, 15, -5),
    ]

    # marks for ~72h
    max_ts = 0
    with open(DATA / "journal.jsonl", "rb") as f:
        f.seek(max(0, os.path.getsize(DATA / "journal.jsonl") - 2_000_000))
        f.readline()
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            ts = o.get("ts") or 0
            max_ts = max(max_ts, ts)
    tmin = max_ts - 72 * 3600 * 1000
    print(f"loading marks from ~{tmin} (72h before {max_ts})")
    marks_by = load_our_marks(tmin)
    print(f"marks mints={len(marks_by)} rows={sum(len(v) for v in marks_by.values())}")
    print("loading pc5m index from leader observer...")
    pc_idx = load_pc5m_index()
    print(f"pc5m mints={len(pc_idx)}")

    cash = cf_our_cash(policies, marks_by, pc_idx)
    journal = cf_our_journal_sells(policies, marks_by, pc_idx, hours=60)
    leader = cf_leader_td(policies)

    # ranking
    print("\n======== RANK our journal60h by avgΔ ========")
    ranked = [(k, v) for k, v in journal.items() if v]
    ranked.sort(key=lambda x: -x[1]["avg"])
    for k, v in ranked:
        print(
            f"  {k}: avgΔ={v['avg']:.1f} medΔ={v['med']:.1f} "
            f"help={v['helped']} hurt={v['hurt']} n={v['n']}"
        )

    print("\n======== RANK leader TD by avgΔ ========")
    ranked = [(k, v) for k, v in leader.items() if v]
    ranked.sort(key=lambda x: -x[1]["avg"])
    for k, v in ranked:
        print(
            f"  {k}: avgΔ={v['avg']:.1f} medΔ={v['med']:.1f} "
            f"help={v['helped']} hurt={v['hurt']} n={v['n']}"
        )

    Path("artifacts").mkdir(exist_ok=True)
    Path("artifacts/cf_td_two_branch_exit.json").write_text(
        json.dumps(
            {
                "cash": cash,
                "journal60h": journal,
                "leader_td": leader,
            },
            indent=2,
            default=str,
        )
    )
    print("\nWrote artifacts/cf_td_two_branch_exit.json")


if __name__ == "__main__":
    main()
