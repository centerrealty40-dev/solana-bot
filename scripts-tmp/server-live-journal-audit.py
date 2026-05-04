#!/usr/bin/env python3
"""One-off server audit: execution_result + slip summary from live JSONL."""
import json
import sys
from collections import Counter

def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "/opt/solana-alpha/data/live/pt1-oscar-live.jsonl"
    hb_status: Counter[str] = Counter()
    hb_skip: Counter[str] = Counter()
    st: Counter[str] = Counter()
    sim_err: Counter[str] = Counter()
    slip_pos_usd = 0.0
    slip_rows = 0
    slip_nonzero = 0
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
            if j.get("kind") == "heartbeat":
                rs = str(j.get("reconcileBootStatus") or "none")
                hb_status[rs] += 1
                sr = j.get("reconcileBootSkipReason")
                if sr:
                    hb_skip[str(sr)[:120]] += 1
                continue
            if j.get("kind") == "execution_result":
                status = str(j.get("status") or "?")
                st[status] += 1
                if status in ("sim_err", "failed"):
                    msg = str((j.get("error") or {}).get("message", ""))[:220]
                    sim_err[msg] += 1
    slip_path = sys.argv[2] if len(sys.argv) > 2 else ""
    if slip_path:
        try:
            rep = json.loads(open(slip_path, encoding="utf-8").read())
            total = float(rep.get("totalSlipUsdApprox") or 0)
            rows = rep.get("rows") or []
            for r in rows:
                su = r.get("slipUsdApprox")
                if isinstance(su, (int, float)) and su > 0:
                    slip_nonzero += 1
                    slip_pos_usd += float(su)
                slip_rows += 1
            print("slippage_report_file:", slip_path)
            print("  totalSlipUsdApprox:", total)
            print("  rows:", len(rows))
            print("  rows slipUsdApprox>0:", slip_nonzero)
            print("  sum(positive slipUsdApprox):", round(slip_pos_usd, 6))
        except OSError as e:
            print("slippage_report_file read failed:", e)

    print("heartbeat reconcileBootStatus:", dict(hb_status))
    print("heartbeat reconcileBootSkipReason (non-empty):", dict(hb_skip.most_common(15)))
    print("live_journal:", path)
    print("execution_result by status:", dict(st))
    print("sim_err/failed messages (top 30):")
    for msg, c in sim_err.most_common(30):
        print(f"  {c}\t{msg}")

    fails_detail: list[str] = []
    with open(path, encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                j = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if j.get("channel") != "live" or j.get("kind") != "execution_result":
                continue
            if j.get("status") != "failed":
                continue
            msg = str((j.get("error") or {}).get("message", ""))[:300]
            sig = str(j.get("txSignature") or "")[:88]
            fails_detail.append(f"  sig={sig} err={msg}")
    if fails_detail:
        print("execution_result status=failed (all):")
        for line in fails_detail:
            print(line)


if __name__ == "__main__":
    main()
