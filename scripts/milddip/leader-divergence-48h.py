#!/usr/bin/env python3
"""
48h divergence report: our mild-dip fills vs leader buy/sell on the same mints.

Uses:
  - data/milddip/journal.jsonl (our copy_buy / copy_sell / mild_dip_sell / marks)
  - data/milddip/leader-observer-*.jsonl (buys; sells if 1.11.760+)
  - RPC replay of leader wallets on overlapping mints when sells are missing

Run on VPS:
  cd /opt/solana-alpha && python3 scripts/milddip/leader-divergence-48h.py
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("MILD_DIP_ROOT", "/opt/solana-alpha"))
DATA = ROOT / "data" / "milddip"
OUR = "2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc"
LEADERS = [
    "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ",
    "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5",
]
WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
STABLE = {WSOL, USDC, USDT}
HOURS = float(os.environ.get("DIVERGENCE_HOURS", "48"))
WINDOW_MS = int(HOURS * 3600 * 1000)


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k, v.strip().strip('"').strip("'"))


def rpc() -> str:
    return (
        os.environ.get("SOLANA_RPC_URL")
        or os.environ.get("HELIUS_RPC_URL")
        or os.environ.get("MILD_DIP_RPC_URL")
        or os.environ.get("LEADER_OBSERVER_RPC_URL")
        or ""
    )


def rpc_call(method: str, params: list[Any]) -> Any:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(rpc(), data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as r:
        j = json.loads(r.read())
    if j.get("error"):
        raise RuntimeError(j["error"])
    return j.get("result")


def fmt(ts: float | int | None) -> str:
    if not ts:
        return "?"
    if ts > 1e12:
        ts = ts / 1000
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%m-%d %H:%M:%S")


def ui_amt(b: dict | None) -> float:
    if not b:
        return 0.0
    return float(((b.get("uiTokenAmount") or {}).get("uiAmount")) or 0)


def load_our_cycles(now_ms: int) -> list[dict[str, Any]]:
    """Pair copy_buy → next full copy_sell per mint (FIFO)."""
    buys: list[dict[str, Any]] = []
    sells: list[dict[str, Any]] = []
    mild_sell_by_sig: dict[str, dict[str, Any]] = {}
    marks_by_mint: dict[str, list[tuple[int, float]]] = defaultdict(list)

    cutoff = now_ms - WINDOW_MS - 6 * 3600_000  # pad for open legs
    with (DATA / "journal.jsonl").open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            ts = e.get("ts") or 0
            if ts < cutoff:
                continue
            k = e.get("kind")
            mint = e.get("mint")
            if k == "copy_buy" and e.get("ok") and mint:
                buys.append(e)
            elif k == "copy_sell" and e.get("ok") and mint:
                sells.append(e)
            elif k == "mild_dip_sell" and mint:
                sig = e.get("signature") or ""
                if sig:
                    mild_sell_by_sig[sig] = e
            elif k == "mild_dip_mark" and mint:
                px = e.get("px") or e.get("priceUsd")
                if px:
                    marks_by_mint[mint].append((ts, float(px)))

    # FIFO match
    open_by_mint: dict[str, list[dict[str, Any]]] = defaultdict(list)
    cycles: list[dict[str, Any]] = []
    for b in sorted(buys, key=lambda x: x["ts"]):
        open_by_mint[b["mint"]].append(b)
    for s in sorted(sells, key=lambda x: x["ts"]):
        mint = s["mint"]
        if s["ts"] < now_ms - WINDOW_MS:
            # only keep sells in window; still consume matching buys
            pass
        q = open_by_mint.get(mint) or []
        buy = None
        while q:
            cand = q.pop(0)
            if cand["ts"] <= s["ts"]:
                buy = cand
                break
        if not buy:
            continue
        if s["ts"] < now_ms - WINDOW_MS and buy["ts"] < now_ms - WINDOW_MS:
            continue
        md = mild_sell_by_sig.get(s.get("txSignature") or "") or {}
        frac = s.get("sellFraction")
        if frac is not None and frac < 1:
            # put buy back for remainder matching (simplified: only full exits)
            open_by_mint[mint].insert(0, buy)
            continue
        entry = float(buy.get("priceUsd") or md.get("entryPx") or 0)
        exit_px = float(s.get("exitPriceUsd") or md.get("exitPx") or 0)
        marks = [m for m in marks_by_mint.get(mint, []) if buy["ts"] <= m[0] <= s["ts"]]
        peak = max((m[1] for m in marks), default=entry)
        mfe = (peak / entry - 1) * 100 if entry > 0 and peak > 0 else None
        cycles.append(
            {
                "mint": mint,
                "symbol": (s.get("symbol") or md.get("symbol") or mint[:6]),
                "buyTs": buy["ts"],
                "sellTs": s["ts"],
                "entryPx": entry,
                "exitPx": exit_px,
                "pnlPct": s.get("pnlPct") if s.get("pnlPct") is not None else md.get("realizedPct"),
                "reason": md.get("reason")
                or (s.get("leaderSignature") or "").replace("milddip_exit_", "").rsplit("_", 1)[0],
                "mfePct": md.get("mfePct") if md.get("mfePct") is not None else mfe,
                "holdSec": md.get("holdSec")
                or int((s["ts"] - buy["ts"]) / 1000),
                "buySig": buy.get("txSignature"),
                "sellSig": s.get("txSignature"),
                "sizeUsd": buy.get("sizeUsd") or s.get("sizeUsd"),
                "armed": md.get("armed"),
            }
        )
    return cycles


def load_observer_events(now_ms: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cutoff_bt = (now_ms - WINDOW_MS) / 1000 - 3600
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        with p.open(errors="ignore") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                k = e.get("kind")
                if k not in (
                    "leader_buy_observed",
                    "leader_sell_observed",
                    "leader_session_open",
                    "leader_session_flat",
                ):
                    continue
                bt = e.get("blockTime") or 0
                if bt and bt < cutoff_bt:
                    continue
                out.append(e)
    return out


def leader_swaps_via_rpc(
    leader: str,
    mints: set[str],
    since_bt: int,
) -> list[dict[str, Any]]:
    """Best-effort sell/buy recovery for overlapping mints when observer lacked sells."""
    events: list[dict[str, Any]] = []
    before = None
    scanned = 0
    while scanned < 400:
        params: dict[str, Any] = {"limit": 100}
        if before:
            params["before"] = before
        sigs = rpc_call("getSignaturesForAddress", [leader, params]) or []
        if not sigs:
            break
        for s in sigs:
            scanned += 1
            bt = s.get("blockTime") or 0
            if bt and bt < since_bt:
                return events
            sig = s.get("signature")
            if not sig:
                continue
            try:
                tx = rpc_call(
                    "getTransaction",
                    [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}],
                )
            except Exception:
                continue
            if not tx or (tx.get("meta") or {}).get("err"):
                continue
            pre = (tx.get("meta") or {}).get("preTokenBalances") or []
            post = (tx.get("meta") or {}).get("postTokenBalances") or []
            keys: dict[tuple[Any, str], list[Any]] = {}
            for b in pre:
                if b.get("owner") == leader:
                    keys[(b.get("accountIndex"), b.get("mint"))] = [b, None]
            for b in post:
                if b.get("owner") == leader:
                    k = (b.get("accountIndex"), b.get("mint"))
                    keys.setdefault(k, [None, None])[1] = b
            for (_i, mint), (a, b) in keys.items():
                if mint not in mints or mint in STABLE:
                    continue
                d = ui_amt(b) - ui_amt(a)
                if abs(d) < 1e-9:
                    continue
                events.append(
                    {
                        "kind": "leader_buy_observed" if d > 0 else "leader_sell_observed",
                        "source": "rpc_replay",
                        "leader": leader,
                        "signature": sig,
                        "blockTime": bt,
                        "mint": mint,
                        "tokenDelta": d,
                        "tokenPreUi": ui_amt(a),
                        "tokenPostUi": ui_amt(b),
                        "isFlat": d < 0 and ui_amt(b) < 1e-6,
                    }
                )
        before = sigs[-1].get("signature")
        if len(sigs) < 100:
            break
        time.sleep(0.05)
    return events


def main() -> None:
    os.chdir(ROOT)
    load_env()
    now_ms = int(time.time() * 1000)
    print(f"=== mild-dip × leader divergence last {HOURS:.0f}h ===")
    print(f"now={fmt(now_ms)} root={ROOT}")

    cycles = load_our_cycles(now_ms)
    print(f"our full-exit cycles in window: {len(cycles)}")

    obs = load_observer_events(now_ms)
    obs_buys = [e for e in obs if e.get("kind") == "leader_buy_observed"]
    obs_sells = [e for e in obs if e.get("kind") == "leader_sell_observed"]
    print(f"observer buys={len(obs_buys)} sells={len(obs_sells)} (sells need 1.11.760+)")

    our_mints = {c["mint"] for c in cycles}
    # also mints we bought but maybe still open — from recent buys
    with (DATA / "journal.jsonl").open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") == "copy_buy" and e.get("ok") and (e.get("ts") or 0) >= now_ms - WINDOW_MS:
                our_mints.add(e["mint"])

    leader_mints = {e["mint"] for e in obs_buys if e.get("mint")}
    overlap = our_mints & leader_mints
    print(f"overlap mints (we traded ∩ leader bought): {len(overlap)}")

    # RPC-enrich sells for overlap if observer sells thin
    since_bt = int((now_ms - WINDOW_MS) / 1000)
    rpc_events: list[dict[str, Any]] = []
    if len(obs_sells) < 5 and overlap:
        print("RPC-replaying leader wallets on overlap mints (observer sells missing)…")
        for leader in LEADERS:
            try:
                ev = leader_swaps_via_rpc(leader, overlap, since_bt)
                rpc_events.extend(ev)
                print(f"  {leader[:8]}… events={len(ev)}")
            except Exception as ex:
                print(f"  {leader[:8]}… ERR {ex}")

    all_leader = obs + rpc_events
    by_mint: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in all_leader:
        if e.get("mint"):
            by_mint[e["mint"]].append(e)
    for mint in by_mint:
        by_mint[mint].sort(key=lambda x: x.get("blockTime") or 0)

    # Critical divergence buckets
    crit: list[str] = []
    rows: list[dict[str, Any]] = []

    for c in sorted(cycles, key=lambda x: x["sellTs"]):
        mint = c["mint"]
        if mint not in by_mint:
            continue
        lev = by_mint[mint]
        buy_bt = c["buyTs"] / 1000
        sell_bt = c["sellTs"] / 1000
        leaders_buy_before = [
            e
            for e in lev
            if e.get("kind") == "leader_buy_observed" and (e.get("blockTime") or 0) <= buy_bt + 120
        ]
        leaders_buy_during = [
            e
            for e in lev
            if e.get("kind") == "leader_buy_observed"
            and buy_bt < (e.get("blockTime") or 0) < sell_bt
        ]
        leaders_buy_after = [
            e
            for e in lev
            if e.get("kind") == "leader_buy_observed"
            and sell_bt < (e.get("blockTime") or 0) <= sell_bt + 3600
        ]
        leaders_sell_before_our_exit = [
            e
            for e in lev
            if e.get("kind") == "leader_sell_observed"
            and buy_bt <= (e.get("blockTime") or 0) <= sell_bt
        ]
        leaders_sell_after = [
            e
            for e in lev
            if e.get("kind") == "leader_sell_observed"
            and sell_bt < (e.get("blockTime") or 0) <= sell_bt + 7200
        ]

        # Did any leader still buy after we sold (we sold into their entry)?
        sold_then_leader_bought = bool(leaders_buy_after)
        # Did leader sell before us (we held the bag they dumped)?
        leader_dumped_first = bool(leaders_sell_before_our_exit)
        # Leader bought while we held (confirmation we ignored / opposite of exit)
        leader_bought_while_we_held = bool(leaders_buy_during)

        tags = []
        if sold_then_leader_bought:
            tags.append("WE_SOLD_LEADER_BOUGHT_AFTER")
        if leader_dumped_first:
            tags.append("LEADER_SOLD_BEFORE_OUR_EXIT")
        if leader_bought_while_we_held and (c.get("pnlPct") or 0) < -5:
            tags.append("LEADER_BOUGHT_OUR_DUMP")

        if not tags:
            continue

        row = {
            **c,
            "tags": tags,
            "leaderBuysDuring": len(leaders_buy_during),
            "leaderBuysAfter1h": len(leaders_buy_after),
            "leaderSellsDuring": len(leaders_sell_before_our_exit),
            "leaderSellsAfter2h": len(leaders_sell_after),
            "sampleBuyAfter": None,
            "sampleSellDuring": None,
        }
        if leaders_buy_after:
            b = leaders_buy_after[0]
            row["sampleBuyAfter"] = {
                "t": fmt(b.get("blockTime")),
                "leader": (b.get("leader") or "")[:8],
                "px": (b.get("fillPriceUsd") or (b.get("dex") or {}).get("priceUsd")),
                "sig": (b.get("signature") or "")[:20],
            }
        if leaders_sell_before_our_exit:
            s = leaders_sell_before_our_exit[0]
            row["sampleSellDuring"] = {
                "t": fmt(s.get("blockTime")),
                "leader": (s.get("leader") or "")[:8],
                "flat": s.get("isFlat"),
                "sig": (s.get("signature") or "")[:20],
            }
        rows.append(row)
        crit.append(
            f"{fmt(c['sellTs'])} {c['symbol']} pnl={c.get('pnlPct')} reason={c.get('reason')} "
            f"tags={','.join(tags)} mfe={c.get('mfePct')}"
        )

    print(f"\n=== CRITICAL divergences: {len(rows)} ===")
    for r in rows:
        print(
            f"\n{fmt(r['buyTs'])}→{fmt(r['sellTs'])} {r['symbol']} mint={r['mint'][:12]}… "
            f"pnl={r.get('pnlPct')}% mfe={r.get('mfePct')} reason={r.get('reason')} "
            f"hold={r.get('holdSec')}s"
        )
        print(f"  tags: {', '.join(r['tags'])}")
        print(
            f"  leader buys during hold={r['leaderBuysDuring']} after1h={r['leaderBuysAfter1h']} "
            f"sells during={r['leaderSellsDuring']} after2h={r['leaderSellsAfter2h']}"
        )
        if r.get("sampleBuyAfter"):
            print(f"  leader buy after our sell: {r['sampleBuyAfter']}")
        if r.get("sampleSellDuring"):
            print(f"  leader sell during our hold: {r['sampleSellDuring']}")

    # Aggregate
    tag_counts: dict[str, int] = defaultdict(int)
    pnl_by_tag: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        for t in r["tags"]:
            tag_counts[t] += 1
            if r.get("pnlPct") is not None:
                pnl_by_tag[t].append(float(r["pnlPct"]))
    print("\n=== tag totals ===")
    for t, n in sorted(tag_counts.items(), key=lambda x: -x[1]):
        xs = pnl_by_tag[t]
        avg = sum(xs) / len(xs) if xs else 0
        print(f"  {t}: n={n} avgPnl={avg:+.1f}%")

    # Data gaps section
    print("\n=== DATA GAPS (what this report lacked) ===")
    print(
        f"- observer sells in window: {len(obs_sells)} "
        f"({'OK' if obs_sells else 'MISSING — used RPC replay; deploy 1.11.760 logger'})"
    )
    missing_fill = sum(1 for e in obs_buys if e.get("fillPriceUsd") is None and e.get("sizeUsd") is None)
    print(f"- observer buys without sizeUsd/fillPriceUsd: {missing_fill}/{len(obs_buys)}")
    print("- no continuous leader bag marks historically (optional LEADER_OBSERVER_LOG_MARKS=1)")
    print("- our leaderSignature is synthetic — cannot join by leader tx id")
    print("- Dex mid at observe time ≠ true fill (fixed going forward via quote-leg deltas)")

    out_path = DATA / "leader-divergence-48h-latest.json"
    out_path.write_text(
        json.dumps(
            {
                "generatedAt": fmt(now_ms),
                "hours": HOURS,
                "cycles": len(cycles),
                "overlapMints": len(overlap),
                "critical": rows,
                "tagCounts": dict(tag_counts),
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
        + "\n"
    )
    print(f"\nwrote {out_path}")


if __name__ == "__main__":
    main()
