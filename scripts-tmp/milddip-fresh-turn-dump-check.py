#!/usr/bin/env python3
"""Check recent our buys vs turn→dump formula (last N minutes on VPS journal)."""
from __future__ import annotations

import json
import math
import time
from collections import defaultdict
from pathlib import Path

DATA = Path("/opt/solana-alpha/data/milddip")
ALPHA, BETA = -5.08, 6.86
LOOKBACK_MS = 30 * 60 * 1000


def pred_dump(turn: float) -> float:
    return ALPHA + BETA * math.log1p(turn * 100)


def fnum(x):
    try:
        if x is None:
            return None
        return float(x)
    except Exception:
        return None


def main() -> None:
    now = int(time.time() * 1000)
    cut = now - LOOKBACK_MS
    journal = DATA / "journal.jsonl"
    with journal.open("rb") as f:
        f.seek(0, 2)
        size = f.tell()
        chunk = min(size, 20_000_000)
        f.seek(size - chunk)
        raw = f.read().decode("utf-8", errors="ignore")

    kinds = defaultdict(int)
    entries = []
    attempts = []
    sells = []
    for line in raw.splitlines():
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        ts = e.get("ts") or e.get("tsMs")
        if not ts:
            continue
        ts = int(ts)
        k = e.get("kind")
        if ts >= cut:
            kinds[k] += 1
        if ts < cut - 600_000:
            continue
        if k in ("entry", "copy_buy", "mild_dip_buy", "buy"):
            entries.append(e)
        elif k in ("mild_dip_buy_attempt", "mild_dip_entry_attempt", "entry_attempt"):
            attempts.append(e)
        elif k in ("mild_dip_sell", "copy_sell", "sell"):
            sells.append(e)

    print("recent kinds", dict(sorted(kinds.items(), key=lambda x: -x[1])[:40]))
    print("entries", len(entries), "attempts", len(attempts), "sells", len(sells))

    # index attempts by mint
    att_by = defaultdict(list)
    for a in attempts:
        mint = a.get("mint")
        if mint:
            att_by[mint].append(a)
    for m in att_by:
        att_by[m].sort(key=lambda x: int(x.get("ts") or 0))

    # Also try to pull market fields embedded on entry / buy_attempt
    recent = [e for e in entries if int(e.get("ts") or e.get("tsMs") or 0) >= cut]
    print(f"entries in last {LOOKBACK_MS//60000}m: {len(recent)}")

    # show sample keys
    if recent:
        print("entry sample keys", sorted(recent[-1].keys()))
    if attempts:
        ok_atts = [a for a in attempts if int(a.get("ts") or 0) >= cut]
        print("attempts in window", len(ok_atts))
        if ok_atts:
            print("attempt sample keys", sorted(ok_atts[-1].keys()))
            print("attempt sample", {k: ok_atts[-1].get(k) for k in sorted(ok_atts[-1].keys()) if k not in ("raw",)})

    rows = []
    for b in sorted(recent, key=lambda x: int(x.get("ts") or 0)):
        mint = b.get("mint")
        ts = int(b.get("ts") or b.get("tsMs") or 0)
        best = None
        for a in att_by.get(mint, []):
            ats = int(a.get("ts") or 0)
            if abs(ats - ts) <= 30_000:
                best = a
                break
        # gather fields from attempt first, then entry
        srcs = [x for x in (best, b) if x]
        pc = turn = vol = liq = None
        dip_source = None
        for s in srcs:
            if pc is None:
                pc = fnum(s.get("pc5m"))
            if vol is None:
                vol = fnum(s.get("volume5mUsd") or s.get("vol5m"))
            if liq is None:
                liq = fnum(s.get("liquidityUsd") or s.get("liq"))
            if turn is None:
                turn = fnum(s.get("turnover5mLiq") or s.get("turnover"))
            if dip_source is None:
                dip_source = s.get("dipSource") or s.get("lane")
            # nested market
            m = s.get("market") if isinstance(s.get("market"), dict) else None
            if m:
                if pc is None:
                    pc = fnum(m.get("pc5m"))
                if vol is None:
                    vol = fnum(m.get("volume5mUsd") or m.get("vol5m"))
                if liq is None:
                    liq = fnum(m.get("liquidityUsd") or m.get("liq"))
                if turn is None:
                    turn = fnum(m.get("turnover5mLiq"))
        if turn is None and vol is not None and liq and liq > 0:
            turn = vol / liq
        dump = -pc if pc is not None else None
        pred = pred_dump(turn) if turn and turn > 0 else None
        resid = (dump - pred) if dump is not None and pred is not None else None

        # realized pnl if sold
        pnl = None
        for s in sells:
            if s.get("mint") != mint:
                continue
            sts = int(s.get("ts") or 0)
            if sts >= ts:
                pnl = fnum(s.get("pnlPct") or s.get("pnlUsd"))
                # prefer usd if both - check
                if s.get("pnlUsd") is not None:
                    pnl = fnum(s.get("pnlUsd"))
                break

        rows.append(
            {
                "ts": ts,
                "age_m": round((now - ts) / 60000, 1),
                "mint": mint,
                "symbol": b.get("symbol") or (best or {}).get("symbol"),
                "sizeUsd": fnum(b.get("sizeUsd") or (best or {}).get("sizeUsd")),
                "pc5m": pc,
                "dump": dump,
                "turn": turn,
                "pred": pred,
                "resid": resid,
                "match_pm8": resid is not None and abs(resid) <= 8,
                "match_pm10": resid is not None and abs(resid) <= 10,
                "match_pm12": resid is not None and abs(resid) <= 12,
                "dipSource": dip_source,
                "pnlUsd": pnl,
                "has_ctx": resid is not None,
            }
        )

    # If entries lack market, use buy_attempts with ok/success in window as proxy fills
    if sum(1 for r in rows if r["has_ctx"]) < max(1, len(rows) // 2):
        print("Enriching from buy_attempts with fill/ok in window…")
        for a in sorted(attempts, key=lambda x: int(x.get("ts") or 0)):
            ts = int(a.get("ts") or 0)
            if ts < cut:
                continue
            # success-ish
            if a.get("ok") is False:
                continue
            if a.get("txSignature") is None and a.get("ok") is not True:
                # still include reserved/attempt if it looks like a send
                if not a.get("submitted") and not a.get("filled"):
                    continue
            pc = fnum(a.get("pc5m"))
            vol = fnum(a.get("volume5mUsd"))
            liq = fnum(a.get("liquidityUsd"))
            turn = fnum(a.get("turnover5mLiq"))
            if turn is None and vol is not None and liq and liq > 0:
                turn = vol / liq
            if pc is None or turn is None:
                continue
            dump = -pc
            pred = pred_dump(turn)
            resid = dump - pred
            # avoid dup
            if any(r["mint"] == a.get("mint") and abs(r["ts"] - ts) < 15_000 for r in rows):
                # update missing
                for r in rows:
                    if r["mint"] == a.get("mint") and abs(r["ts"] - ts) < 15_000 and not r["has_ctx"]:
                        r.update(
                            {
                                "pc5m": pc,
                                "dump": dump,
                                "turn": turn,
                                "pred": pred,
                                "resid": resid,
                                "match_pm8": abs(resid) <= 8,
                                "match_pm10": abs(resid) <= 10,
                                "match_pm12": abs(resid) <= 12,
                                "dipSource": a.get("dipSource") or r.get("dipSource"),
                                "has_ctx": True,
                            }
                        )
                continue
            rows.append(
                {
                    "ts": ts,
                    "age_m": round((now - ts) / 60000, 1),
                    "mint": a.get("mint"),
                    "symbol": a.get("symbol"),
                    "sizeUsd": fnum(a.get("sizeUsd")),
                    "pc5m": pc,
                    "dump": dump,
                    "turn": turn,
                    "pred": pred,
                    "resid": resid,
                    "match_pm8": abs(resid) <= 8,
                    "match_pm10": abs(resid) <= 10,
                    "match_pm12": abs(resid) <= 12,
                    "dipSource": a.get("dipSource"),
                    "pnlUsd": None,
                    "has_ctx": True,
                    "src": "attempt",
                }
            )

    rows.sort(key=lambda r: r["ts"])
    with_ctx = [r for r in rows if r.get("has_ctx")]
    dips = [r for r in with_ctx if r.get("pc5m") is not None and r["pc5m"] < 0]
    print(f"\nFresh rows {len(rows)} with_ctx {len(with_ctx)} dips {len(dips)}")
    for label, sl in (("±8", 8), ("±10", 10), ("±12", 12)):
        m = sum(1 for r in dips if r.get("resid") is not None and abs(r["resid"]) <= sl)
        print(f"dip match {label}: {m}/{len(dips)}")

    print("\n--- per trade (last 30m) ---")
    for r in rows:
        if r.get("resid") is None:
            flag = "??"
        elif abs(r["resid"]) <= 8:
            flag = "OK8"
        elif abs(r["resid"]) <= 10:
            flag = "OK10"
        elif abs(r["resid"]) <= 12:
            flag = "~12"
        else:
            flag = "NO"
        print(
            f"[{flag}] age={r['age_m']:5.1f}m dump={None if r.get('dump') is None else round(r['dump'],2)} "
            f"pred={None if r.get('pred') is None else round(r['pred'],2)} "
            f"resid={None if r.get('resid') is None else round(r['resid'],2)} "
            f"turn={None if r.get('turn') is None else round(r['turn'],4)} "
            f"pnl$={r.get('pnlUsd')} src={r.get('dipSource')} {(r.get('mint') or '')[:8]} {r.get('symbol')}"
        )

    out = {
        "now": now,
        "lookback_m": LOOKBACK_MS // 60000,
        "kinds": dict(kinds),
        "n": len(rows),
        "n_ctx": len(with_ctx),
        "n_dip": len(dips),
        "dip_match8": sum(1 for r in dips if r.get("resid") is not None and abs(r["resid"]) <= 8),
        "dip_match10": sum(1 for r in dips if r.get("resid") is not None and abs(r["resid"]) <= 10),
        "dip_match12": sum(1 for r in dips if r.get("resid") is not None and abs(r["resid"]) <= 12),
        "rows": rows,
    }
    Path("/tmp/leader-reverse").mkdir(parents=True, exist_ok=True)
    Path("/tmp/leader-reverse/fresh-turn-dump-check.json").write_text(json.dumps(out, indent=2))
    print("Wrote /tmp/leader-reverse/fresh-turn-dump-check.json")


if __name__ == "__main__":
    main()
