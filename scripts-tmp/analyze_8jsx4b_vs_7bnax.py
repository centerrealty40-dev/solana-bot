#!/usr/bin/env python3
import json
import glob
from datetime import datetime, timezone

ROOT = "/opt/solana-alpha"
MINT = "8jsX4bMiKR6Gk6sefc9MiuVX6BabQR49skmW8Ppypump"
LEADER = "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5"


def fmt(ts):
    if not ts:
        return "?"
    if ts > 1e12:
        ts /= 1000
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%m-%d %H:%M:%S")


def load_leader():
    out = []
    for p in sorted(glob.glob(f"{ROOT}/data/milddip/leader-observer-*.jsonl")):
        with open(p) as f:
            for line in f:
                if MINT not in line or LEADER not in line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return sorted(out, key=lambda x: x.get("ts", 0))


def load_ours():
    kinds = {
        "copy_buy",
        "copy_sell",
        "mild_dip_buy_attempt",
        "mild_dip_sell",
        "trail_armed",
        "mild_dip_mark",
        "exit_defer_declined",
    }
    out = []
    with open(f"{ROOT}/data/milddip/journal.jsonl") as f:
        for line in f:
            if MINT not in line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get("kind") in kinds:
                out.append(o)
    return sorted(out, key=lambda x: x.get("ts", 0))


def px(e):
    for k in (
        "priceUsd",
        "fillPriceUsd",
        "price_usd",
        "fillPx",
        "entryPx",
        "exitPx",
        "exitPriceUsd",
        "entryPriceUsd",
    ):
        if e.get(k) is not None:
            return e[k]
    return None


def main():
    leader = load_leader()
    ours = load_ours()

    print("=== LEADER 7BNaxx raw events (first 120 keys sample) ===")
    for e in leader:
        k = e.get("kind") or e.get("event") or "?"
        side = e.get("side") or e.get("action")
        print(
            f"{fmt(e.get('ts'))} kind={k} side={side} px={px(e)} "
            f"sig={(e.get('signature') or e.get('txSignature') or '')[:20]} "
            f"wallet={e.get('wallet','')[:8]}"
        )

    print("\n=== OUR round-trips ===")
    for e in ours:
        k = e.get("kind")
        if k == "copy_buy":
            print(
                f"{fmt(e['ts'])} BUY ok={e.get('ok')} px={e.get('priceUsd')} "
                f"reason={e.get('reason')} sig={(e.get('txSignature') or '')[:20]}"
            )
        elif k == "copy_sell":
            print(
                f"{fmt(e['ts'])} SELL pnl={e.get('pnlPct')}% entry={e.get('entryPriceUsd')} "
                f"exit={e.get('exitPriceUsd')} sig={(e.get('txSignature') or '')[:20]}"
            )
        elif k == "mild_dip_sell":
            print(
                f"{fmt(e['ts'])} SELL reason={e.get('reason')} real={e.get('realizedPct')}% "
                f"entry={e.get('entryPx')} peak={e.get('peakPx')} exit={e.get('exitPx')} "
                f"hold={e.get('holdSec')}s mfe={e.get('mfePct')}"
            )
        elif k == "mild_dip_buy_attempt" and e.get("ok"):
            snap = e.get("entrySnapshot") or {}
            print(
                f"{fmt(e['ts'])} BUY dip={e.get('dipSource')} signal={e.get('signalPriceUsd')} "
                f"fill={e.get('priceUsd')} pc5m={e.get('pc5m')} turn={snap.get('turn')} "
                f"bounce={snap.get('bounceFromTroughPct')}"
            )


if __name__ == "__main__":
    main()
