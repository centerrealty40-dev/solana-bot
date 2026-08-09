#!/usr/bin/env python3
"""
Fresh 8zkg dip buys from leader-observer journal (last N minutes)
vs turn→dump formula. Not our bot fills.
"""
from __future__ import annotations

import json
import math
import time
from collections import defaultdict
from pathlib import Path

DATA = Path("/opt/solana-alpha/data/milddip")
LEADER = "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ"
ALPHA, BETA = -5.08, 6.86
# also own refit from earlier
ALPHA_FIT, BETA_FIT = -5.105, 6.865


def fnum(x):
    try:
        return None if x is None else float(x)
    except Exception:
        return None


def pred(turn, a=ALPHA, b=BETA):
    return a + b * math.log1p(turn * 100)


def main():
    now = int(time.time() * 1000)
    windows = [15, 30, 60, 120]  # minutes

    buys = []
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        # prefer today's daily file; still read all
        for line in p.open():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("leader") != LEADER or e.get("kind") != "leader_buy_observed":
                continue
            d = e.get("dex") if isinstance(e.get("dex"), dict) else {}
            # also flattened fields from newer observer
            pc = fnum(d.get("pc5m", e.get("pc5m")))
            if pc is None or pc >= 0:
                continue  # dip only
            ts = int(e.get("tsMs") or (e.get("blockTime") or 0) * 1000)
            if ts <= 0:
                continue
            vol = fnum(d.get("vol5m", e.get("vol5m")))
            liq = fnum(d.get("liq", e.get("liq")))
            turn = fnum(d.get("turnover5mLiq", e.get("turnover5mLiq")))
            if turn is None and vol is not None and liq and liq > 0:
                turn = vol / liq
            buys.append(
                {
                    "ts": ts,
                    "mint": e.get("mint"),
                    "dump": -pc,
                    "pc5m": pc,
                    "turn": turn,
                    "vol5m": vol,
                    "liq": liq,
                    "size": fnum(e.get("sizeUsd")),
                    "is_new": e.get("isNewBag"),
                    "is_add": e.get("isAdd"),
                    "class": e.get("class"),
                    "file": p.name,
                }
            )

    buys.sort(key=lambda x: x["ts"])
    # dedupe mint+ts
    seen = set()
    uniq = []
    for b in buys:
        key = (b["mint"], b["ts"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(b)
    buys = uniq

    if not buys:
        print("no dip buys found")
        return

    newest = buys[-1]["ts"]
    oldest = buys[0]["ts"]
    print(f"8zkg dip buys total {len(buys)}")
    print(
        f"span age_newest={(now-newest)/60000:.1f}m age_oldest={(now-oldest)/3600000:.1f}h "
        f"newest_iso={time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(newest/1000))}Z"
    )

    # Also check journal for leader_buy if any
    j_extra = 0
    journal = DATA / "journal.jsonl"
    if journal.exists():
        with journal.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 8_000_000))
            raw = f.read().decode("utf-8", errors="ignore")
        for line in raw.splitlines():
            if "leader_buy" not in line and "8zkg" not in line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("leader") != LEADER:
                continue
            if e.get("kind") not in ("leader_buy_observed", "leader_buy", "leader_entry"):
                continue
            ts = int(e.get("ts") or e.get("tsMs") or 0)
            if ts >= now - 30 * 60 * 1000:
                j_extra += 1
        print(f"journal leader buy-like in 30m: {j_extra}")

    payload = {"now": now, "total_dip": len(buys), "windows": {}}

    for mins in windows:
        cut = now - mins * 60 * 1000
        # also relative to newest observer event (in case clock skew / lag)
        cut_rel = newest - mins * 60 * 1000
        for label, c in ((f"wall_{mins}m", cut), (f"since_newest_{mins}m", cut_rel)):
            rows = [b for b in buys if b["ts"] >= c]
            with_turn = [b for b in rows if b["turn"] and b["turn"] > 0]
            print(f"\n=== {label}: n={len(rows)} with_turn={len(with_turn)} ===")
            if not with_turn:
                payload["windows"][label] = {"n": 0}
                continue
            matches = {}
            for slack in (6, 8, 10, 12, 15):
                m = sum(
                    1
                    for b in with_turn
                    if abs(b["dump"] - pred(b["turn"])) <= slack
                )
                matches[slack] = m
                print(f"  L1-formula ±{slack}: {m}/{len(with_turn)} ({100*m/len(with_turn):.0f}%)")
            # own fit
            m10f = sum(
                1
                for b in with_turn
                if abs(b["dump"] - pred(b["turn"], ALPHA_FIT, BETA_FIT)) <= 10
            )
            print(f"  fit-formula ±10: {m10f}/{len(with_turn)} ({100*m10f/len(with_turn):.0f}%)")
            res = sorted(b["dump"] - pred(b["turn"]) for b in with_turn)
            n = len(res)
            print(
                f"  resid p25/50/75 = {res[n//4]:.1f}/{res[n//2]:.1f}/{res[3*n//4]:.1f} "
                f"mean={sum(res)/n:.1f}"
            )
            print("  --- trades (newest first) ---")
            for b in sorted(with_turn, key=lambda x: -x["ts"])[:40]:
                p = pred(b["turn"])
                r = b["dump"] - p
                if abs(r) <= 8:
                    flag = "OK8"
                elif abs(r) <= 10:
                    flag = "OK10"
                elif abs(r) <= 12:
                    flag = "~12"
                else:
                    flag = "NO"
                age = (now - b["ts"]) / 60000
                print(
                    f"  [{flag}] age={age:5.1f}m dump={b['dump']:5.1f} pred={p:5.1f} "
                    f"resid={r:+5.1f} turn={b['turn']:.3f} size={b.get('size')} "
                    f"new={b.get('is_new')} {(b.get('mint') or '')[:8]}"
                )
            payload["windows"][label] = {
                "n": len(rows),
                "n_turn": len(with_turn),
                "matches": matches,
                "fit10": m10f,
                "resid_p50": res[n // 2],
                "rows": [
                    {
                        "age_m": round((now - b["ts"]) / 60000, 2),
                        "ts": b["ts"],
                        "mint": b["mint"],
                        "dump": b["dump"],
                        "turn": b["turn"],
                        "pred": pred(b["turn"]),
                        "resid": b["dump"] - pred(b["turn"]),
                        "size": b.get("size"),
                        "is_new": b.get("is_new"),
                    }
                    for b in sorted(with_turn, key=lambda x: -x["ts"])
                ],
            }

    # How many buys after the previous reverse-eng sample max ts?
    # Previous runs had ~897-923; show last 50 absolute newest regardless of window
    print("\n=== NEWEST 25 dip buys (absolute) vs formula ===")
    last = [b for b in buys if b.get("turn") and b["turn"] > 0][-25:]
    for b in reversed(last):
        p = pred(b["turn"])
        r = b["dump"] - p
        flag = "OK" if abs(r) <= 10 else "NO"
        age = (now - b["ts"]) / 60000
        print(
            f"[{flag}] age={age:6.1f}m dump={b['dump']:5.1f} pred={p:5.1f} resid={r:+5.1f} "
            f"turn={b['turn']:.3f} {(b.get('mint') or '')[:8]}"
        )
    m = sum(1 for b in last if abs(b["dump"] - pred(b["turn"])) <= 10)
    print(f"newest25 ±10: {m}/{len(last)}")

    out = Path("/tmp/leader-reverse/8zkg-fresh-formula.json")
    out.write_text(json.dumps(payload, indent=2))
    print("Wrote", out)


if __name__ == "__main__":
    main()
