#!/usr/bin/env python3
"""Summarize cash PnL from data/milddip/trades.jsonl (CF truth, not mark%)."""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--path",
        default="data/milddip/trades.jsonl",
        help="trades.jsonl path",
    )
    ap.add_argument("--since-ms", type=int, default=0)
    args = ap.parse_args()
    p = Path(args.path)
    if not p.exists():
        print(f"missing {p}")
        return

    fills = defaultdict(list)
    rounds = defaultdict(list)
    with p.open(errors="ignore") as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            ts = e.get("ts") or 0
            if ts < args.since_ms:
                continue
            actor = e.get("actor") or "?"
            kind = e.get("kind")
            if kind == "trade_fill":
                fills[actor].append(e)
            elif kind == "trade_roundtrip":
                rounds[actor].append(e)

    print("NOW", datetime.now(tz=timezone.utc).isoformat())
    print("FILE", p)
    for actor in sorted(set(fills) | set(rounds)):
        fl = fills.get(actor) or []
        rt = rounds.get(actor) or []
        buy_n = sum(1 for e in fl if e.get("side") == "buy" and e.get("ok"))
        sell_n = sum(1 for e in fl if e.get("side") == "sell" and e.get("ok"))
        spent = sum(float(e.get("quoteSpentUsd") or 0) for e in fl if e.get("side") == "buy")
        recv = sum(float(e.get("quoteReceivedUsd") or 0) for e in fl if e.get("side") == "sell")
        sell_cash = sum(float(e.get("cashPnlUsd") or 0) for e in fl if e.get("side") == "sell" and e.get("cashPnlUsd") is not None)
        rt_cash = sum(float(e.get("cashPnlUsd") or 0) for e in rt)
        print(f"\n=== actor={actor} ===")
        print(f"  fills buy/sell: {buy_n}/{sell_n}")
        print(f"  quote spent/received: ${spent:.2f} / ${recv:.2f}")
        print(f"  sell cashPnlUsd sum: ${sell_cash:.2f}")
        print(f"  roundtrips: {len(rt)}  cashPnlUsd sum: ${rt_cash:.2f}")
        wallets = sorted({e.get("wallet") or e.get("leader") for e in fl + rt if e.get("wallet") or e.get("leader")})
        print(f"  wallets: {wallets}")


if __name__ == "__main__":
    main()
