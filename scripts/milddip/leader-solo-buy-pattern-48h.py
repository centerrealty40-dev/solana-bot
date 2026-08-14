#!/usr/bin/env python3
"""
Find our mild-dip buys (last 48h) with NO leader buy on the same dip:
  ±LEADER_MATCH_SEC around our fill, fill price within LEADER_PRICE_PCT.

Compare solo vs co-bought patterns using mild_dip_buy_attempt entrySnapshot.

Run on VPS:
  cd /opt/solana-alpha && python3 scripts/milddip/leader-solo-buy-pattern-48h.py
"""

from __future__ import annotations

import json
import os
import statistics
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("MILD_DIP_ROOT", "/opt/solana-alpha"))
DATA = ROOT / "data" / "milddip"

LEADERS = [
    "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ",
    "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5",
]

HOURS = float(os.environ.get("SOLO_HOURS", "48"))
MATCH_SEC = int(os.environ.get("LEADER_MATCH_SEC", "120"))
PRICE_PCT = float(os.environ.get("LEADER_PRICE_PCT", "10")) / 100.0
WINDOW_MS = int(HOURS * 3600 * 1000)


def fmt_ts(ts_ms: int | float | None) -> str:
    if not ts_ms:
        return "?"
    t = ts_ms / 1000 if ts_ms > 1e12 else ts_ms
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def price_close(a: float | None, b: float | None, pct: float) -> bool:
    if a is None or b is None or not (a > 0 and b > 0):
        return False
    rel = abs(a - b) / max(a, b)
    return rel <= pct


def load_our_buys(now_ms: int) -> list[dict[str, Any]]:
    cutoff = now_ms - WINDOW_MS
    buys: list[dict[str, Any]] = []
    with (DATA / "journal.jsonl").open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") != "copy_buy" or not e.get("ok"):
                continue
            ts = e.get("ts") or 0
            if ts < cutoff:
                continue
            buys.append(e)
    return sorted(buys, key=lambda x: x["ts"])


def load_buy_attempts(now_ms: int) -> dict[str, dict[str, Any]]:
    """sig -> mild_dip_buy_attempt (latest per sig)."""
    cutoff = now_ms - WINDOW_MS - 60_000
    by_sig: dict[str, dict[str, Any]] = {}
    with (DATA / "journal.jsonl").open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") != "mild_dip_buy_attempt":
                continue
            ts = e.get("ts") or 0
            if ts < cutoff:
                continue
            sig = e.get("signature")
            if sig:
                by_sig[sig] = e
    return by_sig


def load_leader_buys(now_ms: int) -> list[dict[str, Any]]:
    cutoff_bt = (now_ms - WINDOW_MS) / 1000 - 600
    out: list[dict[str, Any]] = []
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        with p.open(errors="ignore") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("kind") != "leader_buy_observed":
                    continue
                bt = e.get("blockTime") or 0
                if bt and bt < cutoff_bt:
                    continue
                out.append(e)
    return out


def index_leader_buys_by_mint(events: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_mint: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in events:
        mint = e.get("mint")
        if mint:
            by_mint[mint].append(e)
    for mint in by_mint:
        by_mint[mint].sort(key=lambda x: x.get("blockTime") or 0)
    return by_mint


def leader_px(e: dict[str, Any]) -> float | None:
    px = e.get("fillPriceUsd")
    if px and px > 0:
        return float(px)
    dex = e.get("dex") or {}
    p = dex.get("priceUsd")
    return float(p) if p and p > 0 else None


def find_co_buy(
    our: dict[str, Any],
    leader_events: list[dict[str, Any]],
) -> dict[str, Any] | None:
    our_ts = (our.get("ts") or 0) / 1000
    our_px = float(our.get("priceUsd") or 0) or None
    best: dict[str, Any] | None = None
    best_dt = 1e9
    for e in leader_events:
        bt = e.get("blockTime") or 0
        if not bt:
            continue
        dt = abs(bt - our_ts)
        if dt > MATCH_SEC:
            continue
        lpx = leader_px(e)
        if not price_close(our_px, lpx, PRICE_PCT):
            continue
        if dt < best_dt:
            best_dt = dt
            best = {
                "leader": (e.get("leader") or "")[:8],
                "dtSec": round(dt, 1),
                "leaderPx": lpx,
                "ourPx": our_px,
                "sig": e.get("signature"),
                "blockTime": bt,
                "isAdd": e.get("isAdd"),
                "isNewBag": e.get("isNewBag"),
                "class": (e.get("class") or {}).get("name") if isinstance(e.get("class"), dict) else e.get("class"),
                "gates": e.get("gates"),
                "turnDump": e.get("turnDump"),
            }
    return best


def snap_features(attempt: dict[str, Any] | None) -> dict[str, Any]:
    if not attempt:
        return {}
    es = attempt.get("entrySnapshot") or {}
    return {
        "lane": attempt.get("lane"),
        "dipSource": attempt.get("dipSource"),
        "pc5m": es.get("pc5m") or attempt.get("pc5m"),
        "pc1h": es.get("pc1h"),
        "vol5m": es.get("vol5m") or attempt.get("volume5mUsd"),
        "liq": es.get("liq") or attempt.get("liquidityUsd"),
        "mcap": es.get("mcap") or attempt.get("marketCapUsd"),
        "ageHours": es.get("ageHours"),
        "dexId": es.get("dexId"),
        "turn": es.get("turn"),
        "dump": es.get("dump"),
        "tdBranch": es.get("tdBranch"),
        "streamDumpPct": es.get("streamDumpPct"),
        "bounceFromTroughPct": es.get("bounceFromTroughPct"),
        "rugTier": es.get("rugTier"),
        "leaderSig": attempt.get("leaderSignature") or None,
    }


def nearest_leader_buy(
    our_ts_ms: int,
    leader_events: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Closest leader buy on same mint (any time), for context."""
    our_ts = our_ts_ms / 1000
    best = None
    best_dt = None
    for e in leader_events:
        bt = e.get("blockTime") or 0
        if not bt:
            continue
        dt = bt - our_ts
        if best_dt is None or abs(dt) < abs(best_dt):
            best_dt = dt
            best = e
    if best is None or best_dt is None:
        return None
    return {
        "dtSec": round(best_dt, 1),
        "when": "before" if best_dt < 0 else "after",
        "leaderPx": leader_px(best),
        "sig": best.get("signature"),
        "leader": (best.get("leader") or "")[:8],
    }


def pct_bucket(v: float | None, edges: list[float]) -> str:
    if v is None:
        return "null"
    for i, e in enumerate(edges):
        if v <= e:
            return f"<={e}" if i == 0 else f"{edges[i-1]}..{e}"
    return f">{edges[-1]}"


def summarize_group(rows: list[dict[str, Any]], label: str) -> None:
    print(f"\n=== {label} (n={len(rows)}) ===")
    if not rows:
        return
    for key in ("lane", "dipSource", "tdBranch", "dexId", "rugTier"):
        c = Counter(r.get("feat", {}).get(key) for r in rows)
        top = c.most_common(6)
        print(f"  {key}: " + ", ".join(f"{k}={v}" for k, v in top))

    pc5m = [r["feat"].get("pc5m") for r in rows if r["feat"].get("pc5m") is not None]
    if pc5m:
        print(
            f"  pc5m: med={statistics.median(pc5m):.2f}% "
            f"p25={sorted(pc5m)[len(pc5m)//4]:.2f}% "
            f"p75={sorted(pc5m)[3*len(pc5m)//4]:.2f}%"
        )

    # leader memory: did we have ANY leader touch on mint before buy?
    had_prior = sum(1 for r in rows if r.get("nearestLeader") and r["nearestLeader"]["dtSec"] < 0)
    print(f"  had prior leader buy on mint (any age): {had_prior}/{len(rows)}")

    near_after = sum(
        1
        for r in rows
        if r.get("nearestLeader")
        and r["nearestLeader"]["when"] == "after"
        and abs(r["nearestLeader"]["dtSec"]) <= 3600
    )
    print(f"  leader bought within 1h AFTER our solo buy: {near_after}/{len(rows)}")


def lookup_sig(sig: str, our_buys: list[dict], attempts: dict, by_mint: dict) -> None:
    print(f"\n--- deep dive sig={sig[:20]}… ---")
    buy = next((b for b in our_buys if b.get("txSignature") == sig), None)
    if not buy:
        # search attempts
        att = attempts.get(sig)
        if att:
            buy = {"ts": att.get("ts"), "mint": att.get("mint"), "priceUsd": att.get("priceUsd"), "txSignature": sig}
        else:
            print("  not found in our buys")
            return
    mint = buy.get("mint")
    print(f"  mint={mint} ts={fmt_ts(buy.get('ts'))} px={buy.get('priceUsd')}")
    lev = by_mint.get(mint, [])
    co = find_co_buy(buy, lev)
    print(f"  co-buy match ±{MATCH_SEC}s ±{PRICE_PCT*100:.0f}%: {co}")
    near = nearest_leader_buy(buy.get("ts") or 0, lev)
    print(f"  nearest leader buy: {near}")
    # all leader buys on mint in ±30min
    our_ts = (buy.get("ts") or 0) / 1000
    window = [
        e
        for e in lev
        if abs((e.get("blockTime") or 0) - our_ts) <= 1800
    ]
    print(f"  leader buys ±30min ({len(window)}):")
    for e in window:
        bt = e.get("blockTime")
        lpx = leader_px(e)
        print(
            f"    {fmt_ts(bt*1000 if bt else 0)} dt={round((bt or 0)-our_ts,1)}s "
            f"px={lpx} leader={(e.get('leader') or '')[:8]} "
            f"sig={(e.get('signature') or '')[:16]} add={e.get('isAdd')}"
        )
    att = attempts.get(sig)
    if att:
        print(f"  entry: {json.dumps(snap_features(att), ensure_ascii=False)}")


def main() -> None:
    now_ms = int(time.time() * 1000)
    print(f"=== solo-buy pattern last {HOURS:.0f}h ===")
    print(f"match window ±{MATCH_SEC}s, price ±{PRICE_PCT*100:.0f}%")
    print(f"now={fmt_ts(now_ms)}")

    our_buys = load_our_buys(now_ms)
    attempts = load_buy_attempts(now_ms)
    leader_buys = load_leader_buys(now_ms)
    by_mint = index_leader_buys_by_mint(leader_buys)

    print(f"our buys: {len(our_buys)}")
    print(f"leader buys observed: {len(leader_buys)}")

    solo: list[dict[str, Any]] = []
    matched: list[dict[str, Any]] = []

    for b in our_buys:
        mint = b.get("mint")
        sig = b.get("txSignature")
        lev = by_mint.get(mint, [])
        co = find_co_buy(b, lev)
        att = attempts.get(sig or "")
        row = {
            "ts": b.get("ts"),
            "mint": mint,
            "symbol": b.get("symbol"),
            "sig": sig,
            "px": b.get("priceUsd"),
            "sizeUsd": b.get("sizeUsd"),
            "feat": snap_features(att),
            "coBuy": co,
            "nearestLeader": nearest_leader_buy(b.get("ts") or 0, lev),
        }
        if co:
            matched.append(row)
        else:
            solo.append(row)

    print(f"\nco-bought with leader: {len(matched)}")
    print(f"solo (no leader on same dip): {len(solo)}")
    print(f"solo rate: {100*len(solo)/len(our_buys):.1f}%" if our_buys else "")

    summarize_group(matched, "CO-BOUGHT")
    summarize_group(solo, "SOLO")

    # Diff highlights
    print("\n=== SOLO vs CO-BOUGHT diff (top contrasts) ===")
    for key in ("lane", "dipSource", "tdBranch"):
        s = Counter(r["feat"].get(key) for r in solo)
        m = Counter(r["feat"].get(key) for r in matched)
        all_k = set(s) | set(m)
        for k in sorted(all_k, key=lambda x: str(x)):
            sn = len(solo) or 1
            mn = len(matched) or 1
            sp = 100 * s.get(k, 0) / sn
            mp = 100 * m.get(k, 0) / mn
            if abs(sp - mp) >= 8:
                print(f"  {key}={k}: solo {sp:.0f}% vs co {mp:.0f}%")

    # Solo buys where leader bought same mint later within 1h (we front-ran or they skipped this dip)
    front_run: list[dict[str, Any]] = []
    for r in solo:
        nl = r.get("nearestLeader")
        if nl and nl.get("when") == "after" and abs(nl["dtSec"]) <= 3600:
            front_run.append(r)
    print(f"\n=== SOLO but leader bought same mint within 1h after: {len(front_run)} ===")
    for r in sorted(front_run, key=lambda x: x["ts"])[:25]:
        nl = r["nearestLeader"]
        f = r["feat"]
        print(
            f"  {fmt_ts(r['ts'])} {r.get('symbol')} pc5m={f.get('pc5m')} "
            f"lane={f.get('lane')} dip={f.get('dipSource')} "
            f"leader+{nl['dtSec']}s px={nl.get('leaderPx')} sig={r.get('sig','')[:12]}"
        )

    # Full solo list (compact)
    print(f"\n=== ALL SOLO BUYS ({len(solo)}) ===")
    for r in sorted(solo, key=lambda x: x["ts"]):
        f = r["feat"]
        nl = r.get("nearestLeader")
        nl_s = ""
        if nl:
            nl_s = f" nearest_leader={nl['when']} {nl['dtSec']}s"
        print(
            f"  {fmt_ts(r['ts'])} {r.get('symbol','?'):8} "
            f"pc5m={f.get('pc5m')} vol={f.get('vol5m')} turn={f.get('turn')} "
            f"lane={f.get('lane')} dip={f.get('dipSource')} td={f.get('tdBranch')}"
            f"{nl_s} sig={(r.get('sig') or '')[:16]}"
        )

    # User example sigs
    for sig in [
        "4sNjG3Z6frPFU5Td7SaHVxrQzVN9ZTCuS5QMZXWAjFq5ET49md6FdN2kfowKyeT2vqCtL6kZ1jSK6RHifREuHJ4V",
        "5RjizD3boiyXddmgi4T5D2H37SHth1ZxFuNpqghzWobXxApx1Gi3UrxLEw9dhUAKQZweRmeTxxSkddReWSXLL5fn",
    ]:
        lookup_sig(sig, our_buys, attempts, by_mint)

    out = DATA / "leader-solo-buy-pattern-48h.json"
    out.write_text(
        json.dumps(
            {
                "generatedAt": fmt_ts(now_ms),
                "hours": HOURS,
                "matchSec": MATCH_SEC,
                "pricePct": PRICE_PCT,
                "counts": {"ourBuys": len(our_buys), "solo": len(solo), "matched": len(matched)},
                "solo": solo,
                "matched": matched,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
        + "\n"
    )
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
