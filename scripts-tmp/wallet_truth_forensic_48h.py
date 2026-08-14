#!/usr/bin/env python3
"""
Wallet-truth forensic: roundtrip vs USDC, gap by exit/hour, honest counterfactuals.

Run on VPS:
  sudo -u salpha python3 scripts-tmp/wallet_truth_forensic_48h.py
"""
from __future__ import annotations

import json
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone

TRADES = "/opt/solana-alpha/data/milddip/trades.jsonl"
STATE = "/opt/solana-alpha/data/milddip/state.json"
WALLET = "2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc"
HOURS = 48


def load_latest_ms() -> int:
    latest = 0
    with open(TRADES, errors="ignore") as f:
        for line in f:
            try:
                latest = max(latest, int(json.loads(line).get("ts") or 0))
            except Exception:
                pass
    return latest


def load_peeks(since: int) -> list[dict]:
    rows = []
    with open(TRADES, errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") != "trade_fill":
                continue
            if e.get("wallet") != WALLET:
                continue
            if e.get("usdcBefore") is None or e.get("usdcAfter") is None:
                continue
            rows.append(e)
    rows.sort(key=lambda x: x["ts"])
    return rows


def load_fills(since: int) -> list[dict]:
    out = []
    with open(TRADES, errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") != "trade_fill":
                continue
            if (e.get("ts") or 0) < since:
                continue
            out.append(e)
    out.sort(key=lambda x: x["ts"])
    return out


def load_roundtrips(since: int) -> list[dict]:
    out = []
    with open(TRADES, errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") != "trade_roundtrip":
                continue
            if e.get("actor") != "us" or e.get("source") != "mild_dip":
                continue
            if e.get("wallet") != WALLET:
                continue
            if (e.get("ts") or 0) < since:
                continue
            out.append(e)
    return out


@dataclass
class TripWallet:
    mint: str
    opened: int
    closed: int
    exit: str
    rt_pnl: float
    wallet_pnl: float | None
    cost: float
    proceeds_wallet: float
    proceeds_quote: float
    cash_source: str


def chain_ok(prev_after: float, cur_before: float) -> bool:
    return abs(cur_before - prev_after) <= 1.0


def main() -> None:
    latest = load_latest_ms()
    since = latest - HOURS * 3600 * 1000
    since_dt = datetime.fromtimestamp(since / 1000, tz=timezone.utc)
    latest_dt = datetime.fromtimestamp(latest / 1000, tz=timezone.utc)

    all_peeks = load_peeks(0)
    pre = [e for e in all_peeks if e["ts"] < since]
    win_peeks = [e for e in all_peeks if e["ts"] >= since]
    start_usdc = float(pre[-1]["usdcAfter"]) if pre else float(win_peeks[0]["usdcBefore"])
    end_usdc = float(win_peeks[-1]["usdcAfter"]) if win_peeks else start_usdc
    usdc_delta = end_usdc - start_usdc

    fills = load_fills(since)
    rts = load_roundtrips(since)
    rt_sum = sum(float(e.get("cashPnlUsd") or 0) for e in rts)

    print("=" * 72)
    print("WALLET TRUTH FORENSIC")
    print(since_dt.isoformat(), "→", latest_dt.isoformat(), f"({HOURS}h)")
    print("=" * 72)
    print(f"USDC bookend: ${start_usdc:.2f} → ${end_usdc:.2f}  Δ ${usdc_delta:+.2f}")
    print(f"Roundtrip cashPnlUsd sum: ${rt_sum:+.2f}  ({len(rts)} trips)")
    print(f"GAP (roundtrip − USDC): ${rt_sum - usdc_delta:+.2f}")

    # SOL fees
    fee_sol = 0.0
    for e in win_peeks:
        b, a = e.get("feeSolBefore"), e.get("feeSolAfter")
        if b is None or a is None:
            continue
        d = float(a) - float(b)
        if d < -1e-9:
            fee_sol += -d
    print(f"SOL fees (from peeks): {fee_sol:.3f} SOL (~${fee_sol * 180:.0f})")
    print(f"All-in vs start (USDC Δ − fees): ${usdc_delta - fee_sol * 180:+.2f}")

    # cashSource breakdown on mild_dip fills
    by_src = defaultdict(lambda: {"n": 0, "usdc": 0.0, "quote_pnl": 0.0, "wallet_pnl": 0.0})
    for e in fills:
        if e.get("wallet") != WALLET or e.get("source") != "mild_dip" or not e.get("ok"):
            continue
        src = e.get("cashSource") or "none"
        b, a = e.get("usdcBefore"), e.get("usdcAfter")
        usdc_d = float(a) - float(b) if b is not None and a is not None else 0.0
        by_src[src]["n"] += 1
        by_src[src]["usdc"] += usdc_d
        if e.get("side") == "sell" and e.get("cashPnlUsd") is not None:
            by_src[src]["quote_pnl"] += float(e["cashPnlUsd"])

    print("\n## cashSource on ok mild_dip fills")
    for src, v in sorted(by_src.items(), key=lambda x: -x[1]["n"]):
        print(
            f"  {src:16} n={v['n']:5} usdcΔ=${v['usdc']:+.2f} sell_cashPnl=${v['quote_pnl']:+.2f}"
        )

    # Sells where wallet delta negative but quote pnl positive
    bad_sells = []
    for e in fills:
        if e.get("wallet") != WALLET or e.get("source") != "mild_dip":
            continue
        if e.get("side") != "sell" or not e.get("ok"):
            continue
        b, a = e.get("usdcBefore"), e.get("usdcAfter")
        if b is None or a is None:
            continue
        usdc_d = float(a) - float(b)
        pnl = float(e.get("cashPnlUsd") or 0)
        recv_q = float(e.get("quoteReceivedUsd") or 0)
        if pnl > 0.05 and usdc_d < -0.05:
            bad_sells.append(
                {
                    "ts": e["ts"],
                    "mint": (e.get("mint") or "")[:12],
                    "reason": e.get("reason"),
                    "usdc_d": usdc_d,
                    "pnl": pnl,
                    "recv_q": recv_q,
                    "src": e.get("cashSource"),
                }
            )
    print(f"\n## Phantom wins: sell cashPnl>0 but USDC delta<0: {len(bad_sells)}")
    phantom_pnl = sum(x["pnl"] for x in bad_sells)
    phantom_usdc = sum(x["usdc_d"] for x in bad_sells)
    print(f"  sum cashPnlUsd=${phantom_pnl:+.2f}  sum usdcΔ=${phantom_usdc:+.2f}")
    for x in sorted(bad_sells, key=lambda z: z["pnl"], reverse=True)[:8]:
        dt = datetime.fromtimestamp(x["ts"] / 1000, tz=timezone.utc).strftime("%m-%d %H:%M")
        print(
            f"  {dt} {x['mint']} {x['reason']:18} pnl=${x['pnl']:+.2f} usdcΔ=${x['usdc_d']:+.2f} src={x['src']}"
        )

    # Match roundtrips to sell fills (wallet-truth per bag)
    sell_fills = [
        e
        for e in fills
        if e.get("wallet") == WALLET
        and e.get("source") == "mild_dip"
        and e.get("side") == "sell"
        and e.get("ok")
    ]
    buy_fills = [
        e
        for e in fills
        if e.get("wallet") == WALLET
        and e.get("source") == "mild_dip"
        and e.get("side") == "buy"
        and e.get("ok")
    ]

    def nearest_buy(mint: str, closed_ms: int) -> dict | None:
        best = None
        bd = 1e18
        for b in buy_fills:
            if b.get("mint") != mint:
                continue
            d = closed_ms - int(b.get("ts") or 0)
            if 0 <= d < bd:
                best = b
                bd = d
        return best

    trips: list[TripWallet] = []
    for rt in rts:
        mint = rt.get("mint") or ""
        closed = int(rt.get("closedAtMs") or rt.get("ts") or 0)
        opened = int(rt.get("openedAtMs") or closed)
        # find closing sell fill
        sell = None
        for s in sell_fills:
            if s.get("mint") != mint:
                continue
            if abs(int(s.get("ts") or 0) - closed) < 120_000:
                sell = s
                break
        buy = nearest_buy(mint, closed)
        cost_wallet = 0.0
        proceeds_wallet = 0.0
        proceeds_quote = float(rt.get("sellProceedsUsd") or 0)
        cash_src = "?"
        if buy:
            b0, b1 = buy.get("usdcBefore"), buy.get("usdcAfter")
            if b0 is not None and b1 is not None:
                cost_wallet = max(0.0, float(b0) - float(b1))
            else:
                cost_wallet = float(buy.get("quoteSpentUsd") or rt.get("buyCostUsd") or 0)
        if sell:
            s0, s1 = sell.get("usdcBefore"), sell.get("usdcAfter")
            cash_src = sell.get("cashSource") or "?"
            if s0 is not None and s1 is not None:
                proceeds_wallet = max(0.0, float(s1) - float(s0))
            else:
                proceeds_wallet = float(sell.get("quoteReceivedUsd") or 0)
        wallet_pnl = proceeds_wallet - cost_wallet if buy and sell else None
        trips.append(
            TripWallet(
                mint=mint,
                opened=opened,
                closed=closed,
                exit=rt.get("exitReason") or "?",
                rt_pnl=float(rt.get("cashPnlUsd") or 0),
                wallet_pnl=wallet_pnl,
                cost=cost_wallet or float(rt.get("buyCostUsd") or 0),
                proceeds_wallet=proceeds_wallet,
                proceeds_quote=proceeds_quote,
                cash_source=cash_src,
            )
        )

    matched = [t for t in trips if t.wallet_pnl is not None]
    w_sum = sum(t.wallet_pnl for t in matched if t.wallet_pnl is not None)
    print(f"\n## Roundtrip vs wallet (buy+sell peek match, n={len(matched)})")
    print(f"  roundtrip sum: ${sum(t.rt_pnl for t in matched):+.2f}")
    print(f"  wallet peek sum: ${w_sum:+.2f}")
    print(f"  gap: ${sum(t.rt_pnl for t in matched) - w_sum:+.2f}")

    by_exit = defaultdict(lambda: {"n": 0, "rt": 0.0, "wal": 0.0})
    for t in matched:
        ex = t.exit
        by_exit[ex]["n"] += 1
        by_exit[ex]["rt"] += t.rt_pnl
        by_exit[ex]["wal"] += t.wallet_pnl or 0

    print("\n## By exit reason (matched trips)")
    print(f"{'exit':24} {'n':>5} {'roundtrip':>10} {'wallet':>10} {'gap':>10}")
    for ex, v in sorted(by_exit.items(), key=lambda x: x[1]["rt"] - x[1]["wal"], reverse=True):
        gap = v["rt"] - v["wal"]
        print(f"{ex:24} {v['n']:5} ${v['rt']:+9.2f} ${v['wal']:+9.2f} ${gap:+9.2f}")

    # Hourly: cumulative roundtrip vs USDC bookend per hour
    print("\n## Hourly USDC vs roundtrip drift")
    hourly_rt = defaultdict(float)
    for rt in rts:
        h = int((rt.get("openedAtMs") or rt.get("ts") or 0) // 3600000)
        hourly_rt[h] += float(rt.get("cashPnlUsd") or 0)

    hour_peeks = defaultdict(list)
    for e in win_peeks:
        hour_peeks[int(e["ts"] // 3600000)].append(e)

    cum_rt = 0.0
    prev_usdc = start_usdc
    worst_hours = []
    for h in sorted(hour_peeks.keys()):
        peeks_h = hour_peeks[h]
        end_h = float(peeks_h[-1]["usdcAfter"])
        usdc_h = end_h - prev_usdc
        cum_rt += hourly_rt.get(h, 0)
        drift = cum_rt - (end_h - start_usdc)
        worst_hours.append((h, usdc_h, hourly_rt.get(h, 0), end_h - start_usdc, drift))
        prev_usdc = end_h

    print(f"{'hour UTC':14} {'usdcΔ':>8} {'rtΔ':>8} {'cumUSDC':>10} {'cumRT':>10} {'drift':>10}")
    for h, uh, rh, cum_u, drift in worst_hours[-12:]:
        dt = datetime.fromtimestamp(h * 3600, tz=timezone.utc).strftime("%m-%d %H:00")
        print(f"{dt:14} ${uh:+7.2f} ${rh:+7.2f} ${cum_u:+9.2f} ${cum_rt:+9.2f} ${drift:+9.2f}")

    # --- COUNTERFACTUALS on wallet-truth trips ---
    print("\n" + "=" * 72)
    print("COUNTERFACTUALS (wallet PnL on matched trips, not roundtrip fiction)")
    print("=" * 72)
    actual_w = w_sum
    print(f"Baseline wallet PnL (matched): ${actual_w:+.2f}  [USDC bookend ${usdc_delta:+.2f}]")

    # Load entry snapshots from journal for filters
    buys_journal = []
    with open("/opt/solana-alpha/data/milddip/journal.jsonl", errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("kind") != "mild_dip_buy_attempt" or not e.get("ok"):
                continue
            buys_journal.append(e)

    def entry_snap(mint: str, opened: int) -> dict:
        best = {}
        bd = 1e18
        for b in buys_journal:
            if b.get("mint") != mint:
                continue
            d = abs(int(b.get("ts") or 0) - opened)
            if d < bd and d < 180_000:
                best = b.get("entrySnapshot") or {}
                bd = d
        return best

    enriched = []
    for t in matched:
        snap = entry_snap(t.mint, t.opened)
        enriched.append({**t.__dict__, "pc5m": snap.get("pc5m"), "pc1h": snap.get("pc1h")})

    def cf_filter(name: str, pred) -> None:
        kept = [t for t in enriched if pred(t)]
        blocked = [t for t in enriched if not pred(t)]
        kp = sum(t["wallet_pnl"] for t in kept)
        bp = sum(t["wallet_pnl"] for t in blocked)
        print(
            f"  {name:32} block={len(blocked):4} blocked_pnl=${bp:+.2f}  cf=${kp:+.2f}  Δ=${kp-actual_w:+.2f}"
        )

    cf_filter("block shallow pc5m > -4%", lambda t: not (t.get("pc5m") is not None and t["pc5m"] > -4))

    kept3 = []
    blocked3 = []
    by_m = defaultdict(list)
    for t in sorted(enriched, key=lambda x: x["opened"]):
        recent = [x for x in by_m[t["mint"]] if t["opened"] - x < 86400_000]
        if len(recent) >= 3:
            blocked3.append(t)
        else:
            kept3.append(t)
        by_m[t["mint"]].append(t["opened"])
    print(
        f"  {'max 3 entries/mint/24h':32} block={len(blocked3):4} blocked_pnl=${sum(t['wallet_pnl'] for t in blocked3):+.2f}  cf=${sum(t['wallet_pnl'] for t in kept3):+.2f}  Δ=${sum(t['wallet_pnl'] for t in kept3)-actual_w:+.2f}"
    )

    # fee savings proxy: fewer trips => proportional fee cut
    trip_cut = len(blocked3) / max(len(enriched), 1)
    fee_save = fee_sol * 180 * trip_cut
    print(f"  (max3 fee savings est if blocked trips ~{trip_cut*100:.0f}% of fees: ~${fee_save:.0f})")

    # Churn: trips with negative wallet pnl
    losers = [t for t in enriched if t["wallet_pnl"] < -0.01]
    winners = [t for t in enriched if t["wallet_pnl"] > 0.01]
    print(f"\n## Wallet-truth trip distribution (n={len(enriched)})")
    print(f"  winners: {len(winners)} ${sum(t['wallet_pnl'] for t in winners):+.2f}")
    print(f"  losers:  {len(losers)} ${sum(t['wallet_pnl'] for t in losers):+.2f}")
    print(f"  median wallet pnl: ${statistics.median(t['wallet_pnl'] for t in enriched):+.4f}")

    # Root cause summary
    quote_overstate = sum(t.rt_pnl - (t.wallet_pnl or 0) for t in matched)
    print("\n## ROOT CAUSE SUMMARY")
    print(f"  1. USDC bookend {HOURS}h: ${usdc_delta:+.2f} (ground truth)")
    print(f"  2. Roundtrip overstated by ~${rt_sum - usdc_delta:.0f} vs bookend")
    print(f"  3. Matched trip gap (rt−wallet): ${quote_overstate:+.2f}")
    print(f"  4. Phantom sells (pnl>0, usdc↓): {len(bad_sells)} totaling ${phantom_pnl:.0f} fake pnl")
    print(f"  5. SOL fees ~${fee_sol*180:.0f} on top of USDC bleed")
    print(f"  6. Top exit overstating roundtrip:")
    for ex, v in sorted(by_exit.items(), key=lambda x: x[1]["rt"] - x[1]["wal"], reverse=True)[:5]:
        print(f"     {ex}: gap ${v['rt']-v['wal']:+.2f}")

    # Chain-contiguous fills (most reliable fill-level wallet view)
    chain_ok = []
    prev = float(pre[-1]["usdcAfter"]) if pre else None
    for e in win_peeks:
        b = float(e["usdcBefore"])
        if prev is not None and abs(b - prev) <= 1.0:
            chain_ok.append(e)
        prev = float(e["usdcAfter"])
    md = [e for e in chain_ok if e.get("source") == "mild_dip" and e.get("ok")]
    buy_spent = sum(
        float(e["usdcBefore"]) - float(e["usdcAfter"])
        for e in md
        if e.get("side") == "buy" and float(e["usdcAfter"]) < float(e["usdcBefore"])
    )
    sell_recv = sum(
        float(e["usdcAfter"]) - float(e["usdcBefore"])
        for e in md
        if e.get("side") == "sell" and float(e["usdcAfter"]) > float(e["usdcBefore"])
    )
    trade_net = sell_recv - buy_spent
    print("\n## Chain-contiguous mild_dip fills (best fill-level proxy)")
    print(f"  n={len(md)}  buy_spent=${buy_spent:.2f}  sell_recv=${sell_recv:.2f}")
    print(f"  trade net (recv−spent)=${trade_net:+.2f}  vs USDC bookend ${usdc_delta:+.2f}")
    print(f"  roundtrip fiction gap=${rt_sum - trade_net:+.2f}")

    print("\n## ACTIONABLE counterfactual (wallet basis)")
    fee_per_trip = fee_sol * 180 / max(len(rts), 1)
    trip_cut = len(blocked3) / max(len(enriched), 1)
    est_fee_save = fee_sol * 180 * trip_cut
    est_trade_save = -sum(t["wallet_pnl"] for t in blocked3) if blocked3 else 0
    print(f"  max3/24h: cut ~{trip_cut*100:.0f}% trips")
    print(f"    est fee save ~${est_fee_save:.0f}")
    print(f"    est wallet PnL on blocked trips ${sum(t['wallet_pnl'] for t in blocked3):+.2f}")
    print(f"    rough USDC improvement ~${est_trade_save + est_fee_save:+.0f} (vs bookend ${usdc_delta:+.0f})")
    print(f"  shallow pc5m>-4%: blocks winners on wallet — skip")
    print(f"  fix: trade-journal stale peek must not use Jupiter quote as proceeds (deployed in code fix)")


if __name__ == "__main__":
    main()
