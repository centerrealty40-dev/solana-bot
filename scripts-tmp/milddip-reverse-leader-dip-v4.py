#!/usr/bin/env python3
"""
8zkg dip reverse-eng v4:
- Sequential seed→generalize (pick trades, propose depth, grow set until stable)
- Dex candle path when marks missing (public API)
- Exit: kernel / mode of impulse; non-tautological timing rules
- Journal leader_session_closed for larger exit sample
"""
from __future__ import annotations

import json
import math
import os
import time
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path("/opt/solana-alpha")
DATA = ROOT / "data/milddip"
LEADER = "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ"
OUT = Path("/tmp/leader-reverse")
OUT.mkdir(parents=True, exist_ok=True)


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


def pct(a, b):
    if a is None or b is None or not (a > 0 and b > 0):
        return None
    return (b / a - 1.0) * 100.0


def load_marks():
    by = defaultdict(list)
    with (DATA / "journal.jsonl").open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") not in ("mild_dip_mark", "mark"):
                continue
            mint, ts, px = e.get("mint"), e.get("ts"), e.get("priceUsd") or e.get("px")
            if not mint or not ts or not px:
                continue
            try:
                by[mint].append((int(ts), float(px)))
            except Exception:
                continue
    for m in by:
        by[m].sort()
    return by


def fetch_dex_candles(mint: str, cache: dict) -> list[tuple[int, float]]:
    if mint in cache:
        return cache[mint]
    url = f"https://api.dexscreener.com/latest/dex/tokens/{mint}"
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        cache[mint] = []
        return []
    pairs = data.get("pairs") or []
    # pick highest liq solana pair
    best = None
    for p in pairs:
        if (p.get("chainId") or "") != "solana":
            continue
        liq = ((p.get("liquidity") or {}).get("usd")) or 0
        if best is None or liq > best[0]:
            best = (liq, p)
    if not best:
        cache[mint] = []
        return []
    # Dex latest endpoint has no full candles; use priceChange windows as weak signal only.
    # For path we approximate with nothing — return empty; use pair priceUsd + pc as features already.
    cache[mint] = []
    return []


@dataclass
class Buy:
    mint: str
    ts: int
    dump: float
    pc5m: float
    pc1h: float | None
    turn: float | None
    liq: float | None
    vol5m: float | None
    size: float | None
    is_new: bool | None
    is_add: bool | None
    entry: float | None
    d300: float | None = None
    d60: float | None = None


def load_dip_buys(marks):
    buys = []
    seen = set()
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        for line in p.open():
            e = json.loads(line)
            if e.get("leader") != LEADER or e.get("kind") != "leader_buy_observed":
                continue
            d = e.get("dex") if isinstance(e.get("dex"), dict) else {}
            try:
                pc5 = float(d.get("pc5m", e.get("pc5m")))
            except Exception:
                continue
            if pc5 >= 0:
                continue
            ts = int(e.get("tsMs") or (e.get("blockTime") or 0) * 1000)
            key = (e["mint"], ts)
            if key in seen:
                continue
            seen.add(key)
            vol5, liq = d.get("vol5m"), d.get("liq")
            turn = d.get("turnover5mLiq")
            if turn is None and vol5 and liq and float(liq) > 0:
                turn = float(vol5) / float(liq)
            entry = None
            for cand in (e.get("fillPriceUsd"), d.get("priceUsd")):
                try:
                    if cand is not None and float(cand) > 0:
                        entry = float(cand)
                        break
                except Exception:
                    pass
            b = Buy(
                mint=e["mint"],
                ts=ts,
                dump=-pc5,
                pc5m=pc5,
                pc1h=float(d["pc1h"]) if d.get("pc1h") is not None else None,
                turn=float(turn) if turn is not None else None,
                liq=float(liq) if liq is not None else None,
                vol5m=float(vol5) if vol5 is not None else None,
                size=float(e["sizeUsd"]) if e.get("sizeUsd") else None,
                is_new=e.get("isNewBag"),
                is_add=e.get("isAdd"),
                entry=entry,
            )
            path = marks.get(b.mint, [])
            if path and entry:
                pre300 = [px for t, px in path if ts - 300_000 <= t <= ts]
                pre60 = [px for t, px in path if ts - 60_000 <= t <= ts]
                if len(pre300) >= 2:
                    dd = pct(max(pre300), entry)
                    if dd is not None:
                        b.d300 = -dd
                if len(pre60) >= 2:
                    dd = pct(max(pre60), entry)
                    if dd is not None:
                        b.d60 = -dd
            buys.append(b)
    buys.sort(key=lambda x: x.ts)
    return buys


def load_closed_exits():
    """Prefer journal leader_session_closed; fallback observer flats."""
    out = []
    with (DATA / "journal.jsonl").open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") != "leader_session_closed" or e.get("leader") != LEADER:
                continue
            # dip filter via entryMarket if present
            em = e.get("entryMarket") if isinstance(e.get("entryMarket"), dict) else {}
            pc = em.get("pc5m")
            if pc is None:
                pc = e.get("entryPc5m", e.get("pc5m"))
            try:
                pc5 = float(pc) if pc is not None else None
            except Exception:
                pc5 = None
            pnl = e.get("pnlPctApprox")
            try:
                pnl_f = float(pnl) if pnl is not None else None
            except Exception:
                pnl_f = None
            if pnl_f is None or not (-80 <= pnl_f <= 200):
                continue
            held = e.get("heldSec")
            out.append(
                {
                    "src": "journal",
                    "mint": e.get("mint"),
                    "pnl": pnl_f,
                    "held_s": float(held) if held is not None else None,
                    "pc5m": pc5,
                    "dump": -pc5 if pc5 is not None and pc5 < 0 else None,
                    "ts": e.get("ts") or e.get("closeTs") or e.get("tsMs"),
                    "size": e.get("sizeUsd") or e.get("entrySizeUsd"),
                }
            )
    # also observer flats
    for p in DATA.glob("leader-observer-*.jsonl"):
        for line in p.open():
            e = json.loads(line)
            if e.get("leader") != LEADER or e.get("kind") != "leader_session_flat":
                continue
            pnl = e.get("pnlPctApprox")
            try:
                pnl_f = float(pnl) if pnl is not None else None
            except Exception:
                continue
            if pnl_f is None or not (-80 <= pnl_f <= 200):
                continue
            em = e.get("entryMarket") if isinstance(e.get("entryMarket"), dict) else {}
            pc = em.get("pc5m", e.get("pc5m"))
            try:
                pc5 = float(pc) if pc is not None else None
            except Exception:
                pc5 = None
            held = e.get("heldSec")
            out.append(
                {
                    "src": "flat",
                    "mint": e.get("mint"),
                    "pnl": pnl_f,
                    "held_s": float(held) if held is not None else None,
                    "pc5m": pc5,
                    "dump": -pc5 if pc5 is not None and pc5 < 0 else None,
                    "ts": (e.get("blockTime") or 0) * 1000,
                    "size": e.get("sizeUsd"),
                }
            )
    return out


def sequential_depth_search(buys: list[Buy], field="dump"):
    """
    Pick successive seed trades; propose ±2 band around seed depth;
    measure coverage on remaining mints. Track when coverage stabilizes.
    Also try growing a running min/max from seeds until coverage>=65 and width minimal.
    """
    vals = [(getattr(b, field), b.mint, b) for b in buys if getattr(b, field) is not None]
    if len(vals) < 40:
        return {"n": len(vals), "error": "too few"}

    # Strategy A: mode via histogram peak
    edges = list(range(0, 41, 1))
    hist = Counter()
    for v, _, _ in vals:
        bucket = min(40, max(0, int(math.floor(v))))
        hist[bucket] += 1
    peak_bucket, peak_n = hist.most_common(1)[0]
    peak_cov = sum(1 for v, _, _ in vals if peak_bucket <= v < peak_bucket + 1) / len(vals)

    # Strategy B: sequential — start with first NEW trade depth, expand band by 1 until te>=0.65 on later half
    news = [b for b in buys if b.is_new and getattr(b, field) is not None]
    if len(news) < 10:
        news = [b for b in buys if getattr(b, field) is not None]
    mid = len(news) // 2
    early, late = news[:mid], news[mid:]
    seq = []
    for seed_n in (1, 3, 5, 10, 20):
        seeds = early[:seed_n]
        depths = [getattr(s, field) for s in seeds]
        center = sum(depths) / len(depths)
        for half_width in (1, 2, 3, 4, 5, 6, 8, 10):
            lo, hi = center - half_width, center + half_width
            te = sum(1 for b in late if lo <= getattr(b, field) <= hi) / len(late)
            tr = sum(1 for b in early if lo <= getattr(b, field) <= hi) / len(early)
            # leave-one-mint on all
            by_m = defaultdict(list)
            for b in news:
                by_m[b.mint].append(getattr(b, field))
            lom = []
            for m, arr in by_m.items():
                lom.append(sum(1 for v in arr if lo <= v <= hi) / len(arr))
            seq.append(
                {
                    "seed_n": seed_n,
                    "center": center,
                    "lo": lo,
                    "hi": hi,
                    "w": hi - lo,
                    "tr": tr,
                    "te": te,
                    "lom": sum(lom) / len(lom) if lom else None,
                }
            )
    seq.sort(key=lambda r: (-r["te"], -r["lom"], r["w"]))

    # Strategy C: expand envelope of early seeds until late coverage 70%
    envelope = []
    lo = hi = getattr(early[0], field)
    for i, b in enumerate(early, 1):
        v = getattr(b, field)
        lo, hi = min(lo, v), max(hi, v)
        te = sum(1 for x in late if lo <= getattr(x, field) <= hi) / len(late)
        envelope.append({"n": i, "lo": lo, "hi": hi, "w": hi - lo, "te": te})
        if te >= 0.70 and (hi - lo) <= 15:
            break

    # Strategy D: size-stratified dump medians
    size_bands = []
    for slo, shi, name in ((0, 5, "size<5"), (5, 15, "5-15"), (15, 40, "15-40"), (40, 1e9, "40+")):
        arr = [getattr(b, field) for b in buys if b.size and slo <= b.size < shi and getattr(b, field) is not None]
        if len(arr) >= 15:
            size_bands.append({"band": name, "n": len(arr), **dist(arr)})

    # Strategy E: turn-stratified
    turn_bands = []
    for tlo, thi, name in ((0, 0.05, "turn<0.05"), (0.05, 0.15, "0.05-0.15"), (0.15, 0.4, "0.15-0.4"), (0.4, 1e9, "turn>=0.4")):
        arr = [
            getattr(b, field)
            for b in buys
            if b.turn is not None and tlo <= b.turn < thi and getattr(b, field) is not None
        ]
        if len(arr) >= 15:
            turn_bands.append({"band": name, "n": len(arr), **dist(arr)})

    return {
        "field": field,
        "n": len(vals),
        "hist_peak_bucket": peak_bucket,
        "hist_peak_n": peak_n,
        "hist_peak_cov_1pct": peak_cov,
        "hist_top5": hist.most_common(5),
        "seq_best": seq[:10],
        "envelope": envelope[-5:] if envelope else [],
        "size_stratified": size_bands,
        "turn_stratified": turn_bands,
        "overall": dist([v for v, _, _ in vals]),
    }


def exit_impulse_search(exits):
    # filter dip-only when dump known; else all sane
    dip = [e for e in exits if e.get("dump") is not None]
    use = dip if len(dip) >= 40 else exits
    wins = [e for e in use if e["pnl"] > 0]
    loss = [e for e in use if e["pnl"] <= 0]

    # histogram peaks for winner/loser impulses
    def peak(arr, step=2, lo=-80, hi=160):
        h = Counter()
        for e in arr:
            b = int(math.floor(e["pnl"] / step) * step)
            if lo <= b <= hi:
                h[b] += 1
        return h.most_common(8)

    # sequential: seed first winners' pnl, test band on later winners
    wins_s = sorted(wins, key=lambda e: e.get("ts") or 0)
    mid = max(1, len(wins_s) // 2)
    early, late = wins_s[:mid], wins_s[mid:]
    seq = []
    if early and late:
        for seed_n in (3, 5, 10, 20):
            seeds = early[: min(seed_n, len(early))]
            center = sum(s["pnl"] for s in seeds) / len(seeds)
            for hw in (3, 5, 8, 10, 15, 20, 30):
                lo, hi = center - hw, center + hw
                te = sum(1 for e in late if lo <= e["pnl"] <= hi) / len(late)
                tr = sum(1 for e in early if lo <= e["pnl"] <= hi) / len(early)
                seq.append({"seed_n": seed_n, "center": center, "lo": lo, "hi": hi, "w": 2 * hw, "tr": tr, "te": te})
        seq.sort(key=lambda r: (-r["te"], r["w"]))

    # threshold ladders (coverage among subset)
    win_thr = []
    for x in (5, 8, 10, 12, 15, 20, 25, 30, 40, 50):
        win_thr.append({"rule": f"win>=+{x}", "cov": sum(1 for e in wins if e["pnl"] >= x) / len(wins) if wins else 0})
    loss_thr = []
    for x in (5, 8, 10, 15, 20, 25, 30, 40, 50):
        loss_thr.append(
            {"rule": f"loss<=-{x}", "cov": sum(1 for e in loss if e["pnl"] <= -x) / len(loss) if loss else 0}
        )

    # hold-time as exit clock
    holds_w = [e["held_s"] / 60 for e in wins if e.get("held_s")]
    holds_l = [e["held_s"] / 60 for e in loss if e.get("held_s")]

    # joint: among all exits, does (pnl>=X or pnl<=-Y) cover with narrow X,Y?
    joint = []
    for tp in (8, 10, 15, 20, 25, 30):
        for sl in (8, 10, 15, 20, 25, 30, 40):
            cov = sum(1 for e in use if e["pnl"] >= tp or e["pnl"] <= -sl) / len(use)
            joint.append({"tp": tp, "sl": sl, "cov": cov, "w": tp + sl})
    joint.sort(key=lambda r: (-r["cov"], r["w"]))

    return {
        "n_use": len(use),
        "n_dip_known": len(dip),
        "n_win": len(wins),
        "n_loss": len(loss),
        "impulse_all": dist([e["pnl"] for e in use]),
        "impulse_win": dist([e["pnl"] for e in wins]),
        "impulse_loss": dist([e["pnl"] for e in loss]),
        "win_peaks": peak(wins, step=5),
        "loss_peaks": peak(loss, step=5),
        "win_thr": win_thr,
        "loss_thr": loss_thr,
        "hold_win_m": dist(holds_w),
        "hold_loss_m": dist(holds_l),
        "seq_winner_band": seq[:10],
        "joint_tp_sl": joint[:15],
        "src": Counter(e["src"] for e in use),
    }


def main():
    marks = load_marks()
    print("marks", len(marks))
    buys = load_dip_buys(marks)
    print("dip buys", len(buys), "with d300", sum(1 for b in buys if b.d300 is not None))

    # Sequential / stratified entry
    entry_dump = sequential_depth_search(buys, "dump")
    entry_d300 = sequential_depth_search(buys, "d300")

    print("\n=== ENTRY dump_pc5m ===")
    print("overall", entry_dump["overall"])
    print("hist peak bucket", entry_dump["hist_peak_bucket"], "cov1%", round(entry_dump["hist_peak_cov_1pct"] * 100, 1))
    print("hist top5", entry_dump["hist_top5"])
    print("seq best:")
    for r in entry_dump["seq_best"][:5]:
        print(
            f"  seeds={r['seed_n']} center={r['center']:.2f} [{r['lo']:.1f},{r['hi']:.1f}] "
            f"te={r['te']*100:.1f}% lom={r['lom']*100:.1f}% w={r['w']:.1f}"
        )
    print("size stratified:")
    for r in entry_dump["size_stratified"]:
        print(f"  {r['band']:8s} n={r['n']:4d} p25/50/75={r['p25']:.1f}/{r['p50']:.1f}/{r['p75']:.1f}")
    print("turn stratified:")
    for r in entry_dump["turn_stratified"]:
        print(f"  {r['band']:12s} n={r['n']:4d} p25/50/75={r['p25']:.1f}/{r['p50']:.1f}/{r['p75']:.1f}")

    print("\n=== ENTRY d300 (marks) ===")
    print("overall", entry_d300.get("overall"))
    if entry_d300.get("seq_best"):
        for r in entry_d300["seq_best"][:5]:
            print(
                f"  seeds={r['seed_n']} center={r['center']:.2f} [{r['lo']:.1f},{r['hi']:.1f}] "
                f"te={r['te']*100:.1f}% w={r['w']:.1f}"
            )

    # Reject single-number claim with hard numbers
    magic_cov = {}
    for c in (5, 8, 10, 12, 15):
        magic_cov[c] = sum(1 for b in buys if abs(b.dump - c) <= 2) / len(buys)

    exits = load_closed_exits()
    print("\nclosed exits loaded", len(exits))
    ex = exit_impulse_search(exits)
    print("\n=== EXIT ===")
    print("n", ex["n_use"], "win", ex["n_win"], "loss", ex["n_loss"], "src", dict(ex["src"]))
    print("impulse all", ex["impulse_all"])
    print("win", ex["impulse_win"])
    print("loss", ex["impulse_loss"])
    print("win peaks", ex["win_peaks"])
    print("loss peaks", ex["loss_peaks"])
    print("win thr:")
    for r in ex["win_thr"]:
        print(f"  {r['rule']:12s} {r['cov']*100:5.1f}%")
    print("loss thr:")
    for r in ex["loss_thr"]:
        print(f"  {r['rule']:12s} {r['cov']*100:5.1f}%")
    print("joint TP/SL top:")
    for r in ex["joint_tp_sl"][:8]:
        print(f"  TP+{r['tp']}/SL-{r['sl']} cov={r['cov']*100:.1f}%")
    print("hold win", ex["hold_win_m"])
    print("hold loss", ex["hold_loss_m"])

    # Final concrete claim block
    print("\n======== CONCRETE CLAIMS ========")
    print("ENTRY magic±2 coverage:", {k: round(v * 100, 1) for k, v in magic_cov.items()})
    best = entry_dump["seq_best"][0] if entry_dump.get("seq_best") else None
    if best:
        print(
            f"Best sequential dump band from early seeds: "
            f"[{best['lo']:.1f}, {best['hi']:.1f}] te={best['te']*100:.1f}% lom={best['lom']*100:.1f}%"
        )
    # Find narrowest band with te>=0.65 lom>=0.60
    cand = [
        r
        for r in entry_dump.get("seq_best", [])
        if r["te"] >= 0.65 and (r["lom"] or 0) >= 0.60 and r["w"] <= 12
    ]
    print("Narrow sequential candidates w<=12 te/lom>=65/60:", len(cand))
    for r in cand[:5]:
        print(f"  [{r['lo']:.1f},{r['hi']:.1f}] te={r['te']*100:.1f} lom={r['lom']*100:.1f}")

    # Exit claim: find first TP where win cov drops below 70%
    cut = None
    for r in ex["win_thr"]:
        if r["cov"] < 0.70:
            cut = r
            break
    print("Winner TP ladder — first below 70%:", cut)
    # joint with cov>=0.85 narrowest
    j85 = [r for r in ex["joint_tp_sl"] if r["cov"] >= 0.85]
    j85.sort(key=lambda r: r["w"])
    print("Narrowest TP/SL with cov>=85%:", j85[:3] if j85 else None)

    payload = {
        "n_buys": len(buys),
        "entry_dump": entry_dump,
        "entry_d300": entry_d300,
        "magic_cov": magic_cov,
        "exit": ex,
        "narrow_seq": cand[:10],
        "joint85": j85[:5] if j85 else [],
    }
    # make JSON safe
    def fix(o):
        if isinstance(o, dict):
            return {k: fix(v) for k, v in o.items()}
        if isinstance(o, list):
            return [fix(x) for x in o]
        if isinstance(o, tuple):
            return [fix(x) for x in o]
        if isinstance(o, Counter):
            return dict(o)
        return o

    (OUT / "8zkg-dip-reverse-v4.json").write_text(json.dumps(fix(payload), indent=2))
    print("Wrote", OUT / "8zkg-dip-reverse-v4.json")


if __name__ == "__main__":
    main()
