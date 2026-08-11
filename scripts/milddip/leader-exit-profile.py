#!/usr/bin/env python3
"""
Leader exit profile on the turn→dump line.

Answers the three questions we cannot answer from our own book:
  1) how much drawdown do they sit through before it works out
  2) where do they take profit
  3) how wide is the trail they give a runner back from its peak

Reads `leader_session_flat` (closed round trips) and the 1Hz `leader_bag_tick`
dense tape. Only sessions whose cash and path are both trustworthy are counted
(`cashPnlReliable` / `pathReliable` from 1.11.811) — before that flag existed
the observer priced unreadable sell legs off a stale Dex quote and produced
+900% medians.

Usage: python3 scripts/milddip/leader-exit-profile.py [hours]
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "milddip"
TD_CLASSES = {"shallow", "mild_shallow", "mild_deep", "deep_knife", "rug_knife"}


def q(values, p):
    if not values:
        return None
    s = sorted(values)
    return round(s[min(len(s) - 1, int(len(s) * p))], 2)


def observer_files() -> list[Path]:
    return sorted(DATA.glob("leader-observer-*.jsonl"))


def dense_files() -> list[Path]:
    return sorted(DATA.glob("leader-dense-*.jsonl"))


def load_sessions(cut_ms: int) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for p in observer_files():
        try:
            fh = p.open()
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"leader_session_flat"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (o.get("tsMs") or 0) < cut_ms:
                    continue
                key = o.get("openedSignature") or f"{o.get('mint')}:{o.get('openedBlockTime')}"
                if key in seen:
                    continue
                seen.add(key)
                out.append(o)
    return out


def trustworthy(s: dict) -> bool:
    if s.get("cashPnlReliable") is False or s.get("pathReliable") is False:
        return False
    cost = float(s.get("totalCostUsd") or 0)
    if cost <= 0.5:
        return False
    # Pre-1.11.811 rows carry no flags; fall back to a sanity band.
    if abs(float(s.get("mfePct") or 0)) > 300:
        return False
    return True


def main() -> None:
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 12.0
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    cut = now_ms - int(hours * 3600 * 1000)

    sessions = load_sessions(cut)
    usable = [s for s in sessions if trustworthy(s)]
    td = [s for s in usable if (s.get("entryClass") in TD_CLASSES) or s.get("isTdEntry")]

    def profile(rows: list[dict], label: str) -> dict:
        if not rows:
            return {"label": label, "n": 0}
        cost = sum(float(r.get("totalCostUsd") or 0) for r in rows)
        cash = sum(float(r.get("cashPnlUsd") or 0) for r in rows)
        wins = [r for r in rows if float(r.get("cashPnlUsd") or 0) > 0]
        losses = [r for r in rows if float(r.get("cashPnlUsd") or 0) <= 0]
        return {
            "label": label,
            "n": len(rows),
            "usd_in": round(cost, 2),
            "cash": round(cash, 2),
            "roi_pct": round(100 * cash / cost, 1) if cost else None,
            "winrate": round(len(wins) / len(rows), 2),
            # 1) drawdown they sit through
            "mae_pct": {
                "p10": q([float(r.get("maePct") or 0) for r in rows], 0.10),
                "p25": q([float(r.get("maePct") or 0) for r in rows], 0.25),
                "med": q([float(r.get("maePct") or 0) for r in rows], 0.50),
            },
            "mae_of_winners_med": q([float(r.get("maePct") or 0) for r in wins], 0.50),
            "mae_of_losers_med": q([float(r.get("maePct") or 0) for r in losses], 0.50),
            # 2) where they take profit
            "exit_pnl_pct": {
                "p25": q([float(r.get("pnlPctApprox") or 0) for r in rows], 0.25),
                "med": q([float(r.get("pnlPctApprox") or 0) for r in rows], 0.50),
                "p75": q([float(r.get("pnlPctApprox") or 0) for r in rows], 0.75),
                "p90": q([float(r.get("pnlPctApprox") or 0) for r in rows], 0.90),
            },
            "mfe_pct_med": q([float(r.get("mfePct") or 0) for r in rows], 0.50),
            "capture_of_mfe_pct": q(
                [
                    100 * float(r.get("pnlPctApprox") or 0) / float(r.get("mfePct") or 0)
                    for r in rows
                    if float(r.get("mfePct") or 0) > 1
                ],
                0.50,
            ),
            # 3) how much they give back from the peak
            "giveback_at_exit_pct": {
                "p25": q([float(r.get("givebackPctAtExit") or 0) for r in rows], 0.25),
                "med": q([float(r.get("givebackPctAtExit") or 0) for r in rows], 0.50),
                "p75": q([float(r.get("givebackPctAtExit") or 0) for r in rows], 0.75),
            },
            "bounce_at_exit_pct_med": q(
                [float(r.get("bouncePctAtExit") or 0) for r in rows], 0.50
            ),
            "hold_sec": {
                "p25": q([float(r.get("heldSec") or 0) for r in rows], 0.25),
                "med": q([float(r.get("heldSec") or 0) for r in rows], 0.50),
                "p75": q([float(r.get("heldSec") or 0) for r in rows], 0.75),
            },
            "armed_by_mfe": {
                f"mfe{th}": sum(1 for r in rows if r.get(f"armedMfe{th}"))
                for th in (5, 8, 10, 12)
            },
            "entry_class_mix": dict(Counter(r.get("entryClass") for r in rows)),
        }

    # Dense tape: how deep underwater a bag went before it recovered.
    dense_stats: dict = {"ticks": 0}
    per_bag: dict[str, dict] = defaultdict(lambda: {"min": 0.0, "max": 0.0})
    for p in dense_files():
        try:
            fh = p.open()
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"leader_bag_tick"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (o.get("tsMs") or 0) < cut or not o.get("isTdEntry"):
                    continue
                pnl = o.get("pnlPct")
                if pnl is None:
                    continue
                dense_stats["ticks"] += 1
                key = f"{o.get('leader')}:{o.get('mint')}:{o.get('openedBlockTime')}"
                b = per_bag[key]
                b["min"] = min(b["min"], float(pnl))
                b["max"] = max(b["max"], float(pnl))
    if per_bag:
        recovered = [b for b in per_bag.values() if b["min"] <= -10 and b["max"] >= 5]
        dense_stats.update(
            {
                "td_bags": len(per_bag),
                "deepest_drawdown_med": q([b["min"] for b in per_bag.values()], 0.50),
                "deepest_drawdown_p10": q([b["min"] for b in per_bag.values()], 0.10),
                "bags_that_dipped_10_then_made_5": len(recovered),
                "share_recovering_from_10pct_dip": round(
                    len(recovered) / max(1, sum(1 for b in per_bag.values() if b["min"] <= -10)),
                    2,
                ),
            }
        )

    print(
        json.dumps(
            {
                "window_h": hours,
                "sessions_seen": len(sessions),
                "sessions_trustworthy": len(usable),
                "turn_dump": profile(td, "turn_dump"),
                "all_classes": profile(usable, "all"),
                "dense_td_tape": dense_stats,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
