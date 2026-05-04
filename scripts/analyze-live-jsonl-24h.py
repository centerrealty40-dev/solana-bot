#!/usr/bin/env python3
"""One-off: aggregate live channel JSONL for last N hours (server-side path)."""
import json
import sys
import time
from collections import Counter

def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "/opt/solana-alpha/data/live/pt1-oscar-live.jsonl"
    hours = float(sys.argv[2]) if len(sys.argv) > 2 else 24.0
    cutoff = time.time() * 1000 - hours * 3600 * 1000

    kinds = Counter()
    risk_limits = Counter()
    reasons = Counter()
    orphans = 0
    closes = Counter()
    attempts_buy = 0
    attempts_sell = 0
    heart_mismatch = 0
    heart_ok = 0
    n = 0

    with open(path, encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                j = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if j.get("channel") != "live":
                continue
            ts = j.get("ts")
            if not isinstance(ts, (int, float)) or ts < cutoff:
                continue
            n += 1
            k = j.get("kind") or "?"
            kinds[k] += 1

            if k == "risk_block":
                risk_limits[str(j.get("limit", "?"))] += 1
            if k in ("execution_skip", "risk_note"):
                reasons[f"{k}:{j.get('reason', '?')}"[:100]] += 1
            if k == "capital_skip":
                r = j.get("reason", "?")
                reasons[f"capital_skip:{r}"] += 1
            if k == "live_position_close":
                er = (j.get("closedTrade") or {}).get("exitReason") or "?"
                closes[str(er)] += 1
            if k == "live_periodic_self_heal":
                if j.get("ok") is False:
                    reasons[f"self_heal_fail:{j.get('note', '?')}"[:100]] += 1
            if k == "RECONCILE_ORPHAN":
                orphans += 1
            if k == "execution_attempt":
                if j.get("side") == "buy":
                    attempts_buy += 1
                elif j.get("side") == "sell":
                    attempts_sell += 1
            if k == "heartbeat":
                st = (j.get("reconcileBootStatus") or "").lower()
                if st == "mismatch":
                    heart_mismatch += 1
                elif st == "ok":
                    heart_ok += 1

    print(f"path={path} window_h={hours} live_events={n}")
    print("kinds_top", kinds.most_common(30))
    print("risk_block_limits", dict(risk_limits))
    print("exitReason_live_close", dict(closes))
    print("reasons_top", reasons.most_common(40))
    print(f"execution_buy={attempts_buy} execution_sell={attempts_sell}")
    print(f"heartbeat reconcileBootStatus mismatch={heart_mismatch} ok={heart_ok}")


if __name__ == "__main__":
    main()
