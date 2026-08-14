#!/usr/bin/env python3
"""
Wallet-anchored mild-dip exit sweep (72h default).

Truth line: USDC wallet peeks (not roundtrip cashPnlUsd).
Per-bag PnL: mark prices (fair compare between exit rules).
Grid: min_hold × max_loss × optional bounce / never-green filter.
"""
from __future__ import annotations

import json
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from itertools import product

TRADES = "/opt/solana-alpha/data/milddip/trades.jsonl"
JOURNAL = "/opt/solana-alpha/data/milddip/journal.jsonl"
WALLET = "2sSu7dSwux8sKUYEgDtchx679YzuWG6Sbq54Db8vzswc"
HOURS = 72


@dataclass
class Mark:
    ts: int
    px: float
    held_sec: float
    pnl_pct: float
    mfe_pct: float
    entry_px: float


@dataclass
class Bag:
    mint: str
    opened_ms: int
    closed_ms: int
    cost_usd: float
    entry_px: float
    marks: list[Mark] = field(default_factory=list)
    actual_exit_px: float = 0.0
    mfe_max: float = 0.0
    min_pnl: float = 0.0

    def actual_pnl_usd(self) -> float:
        if self.entry_px <= 0 or self.actual_exit_px <= 0:
            return 0.0
        return self.cost_usd * (self.actual_exit_px / self.entry_px - 1)

    def sim_pnl_usd(
        self,
        min_hold_sec: float,
        max_loss_pct: float,
        bounce_pct: float = 0.0,
        max_mfe_pct: float | None = None,
    ) -> tuple[float, float, bool]:
        """Return (pnl_usd, hold_sec, triggered)."""
        trough = self.entry_px
        for m in self.marks:
            if m.px < trough:
                trough = m.px
            if m.held_sec < min_hold_sec:
                continue
            if max_mfe_pct is not None and self.mfe_max > max_mfe_pct + 1e-9:
                continue
            if m.pnl_pct > -max_loss_pct + 1e-9:
                continue
            if bounce_pct > 0 and trough > 0:
                if (m.px / trough - 1) * 100 < bounce_pct - 1e-9:
                    continue
            return (
                self.cost_usd * (m.px / self.entry_px - 1),
                m.held_sec,
                True,
            )
        return self.actual_pnl_usd(), self.marks[-1].held_sec if self.marks else 0, False


def window_ms(hours: float) -> tuple[int, int]:
    latest = 0
    with open(TRADES, errors="ignore") as f:
        for line in f:
            try:
                latest = max(latest, int(json.loads(line).get("ts") or 0))
            except Exception:
                pass
    since = latest - int(hours * 3600 * 1000)
    return since, latest


def wallet_usdc_delta(since: int) -> tuple[float, float, float]:
    peeks = []
    for line in open(TRADES, errors="ignore"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("kind") != "trade_fill":
            continue
        if e.get("wallet") != WALLET or e.get("actor") != "us":
            continue
        if (e.get("ts") or 0) < since:
            continue
        if e.get("usdcBefore") is None or e.get("usdcAfter") is None:
            continue
        peeks.append(e)
    peeks.sort(key=lambda x: x["ts"])
    if not peeks:
        return 0.0, 0.0, 0.0
    a, b = float(peeks[0]["usdcBefore"]), float(peeks[-1]["usdcAfter"])
    return a, b, b - a


def load_bags(since: int) -> list[Bag]:
    bags: list[Bag] = []
    for line in open(TRADES, errors="ignore"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("kind") != "trade_roundtrip":
            continue
        if e.get("actor") != "us" or e.get("wallet") != WALLET:
            continue
        if (e.get("ts") or 0) < since:
            continue
        cost = float(e.get("buyCostUsd") or 0)
        if cost <= 0:
            continue
        bags.append(
            Bag(
                mint=e.get("mint") or "",
                opened_ms=int(e.get("openedAtMs") or e.get("ts") or 0),
                closed_ms=int(e.get("closedAtMs") or e.get("ts") or 0),
                cost_usd=cost,
                entry_px=0.0,
            )
        )

    if not bags:
        return []

    mint_ranges: dict[str, tuple[int, int]] = {}
    for b in bags:
        lo, hi = b.opened_ms, b.closed_ms
        if b.mint in mint_ranges:
            lo = min(lo, mint_ranges[b.mint][0])
            hi = max(hi, mint_ranges[b.mint][1])
        mint_ranges[b.mint] = (lo, hi)

    mint_marks: dict[str, list[Mark]] = {m: [] for m in mint_ranges}
    for line in open(JOURNAL, errors="ignore"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("kind") != "mild_dip_mark" or e.get("quarantined") is True:
            continue
        mint = e.get("mint")
        if mint not in mint_ranges:
            continue
        ts = int(e.get("ts") or 0)
        lo, hi = mint_ranges[mint]
        if ts < lo or ts > hi:
            continue
        px = float(e.get("px") or 0)
        if px <= 0:
            continue
        ep = float(e.get("entryPx") or 0)
        pnl = e.get("pnlPct")
        pnl_f = float(pnl) if pnl is not None else ((px / ep - 1) * 100 if ep > 0 else 0)
        mfe = float(e.get("mfePct") or 0)
        mint_marks[mint].append(
            Mark(
                ts=ts,
                px=px,
                held_sec=float(e.get("heldSec") or 0),
                pnl_pct=pnl_f,
                mfe_pct=mfe,
                entry_px=ep,
            )
        )

    out: list[Bag] = []
    for b in bags:
        ms = [m for m in mint_marks.get(b.mint, []) if b.opened_ms <= m.ts <= b.closed_ms]
        ms.sort(key=lambda x: x.ts)
        if len(ms) < 2:
            continue
        entry = next((m.entry_px for m in ms if m.entry_px > 0), 0.0)
        if entry <= 0 and ms[0].pnl_pct is not None:
            entry = ms[0].px / (1 + ms[0].pnl_pct / 100)
        if entry <= 0:
            continue
        b.entry_px = entry
        b.marks = ms
        b.actual_exit_px = ms[-1].px
        b.mfe_max = max(m.mfe_pct for m in ms)
        b.min_pnl = min(m.pnl_pct for m in ms)
        out.append(b)
    return out


def eval_policy(
    bags: list[Bag],
    min_hold_sec: float,
    max_loss_pct: float,
    bounce_pct: float = 0.0,
    max_mfe_pct: float | None = None,
) -> dict:
    pnls = []
    holds = []
    triggered = 0
    deep_avoided = 0  # would have hit -20% but policy exited earlier
    for b in bags:
        pnl, hold, trig = b.sim_pnl_usd(min_hold_sec, max_loss_pct, bounce_pct, max_mfe_pct)
        pnls.append(pnl)
        holds.append(hold)
        if trig:
            triggered += 1
        if trig and b.min_pnl <= -20 and pnl > b.actual_pnl_usd():
            deep_avoided += 1
    actual = [b.actual_pnl_usd() for b in bags]
    delta = sum(p - a for p, a in zip(pnls, actual))
    losers = [(p, a) for p, a in zip(pnls, actual) if a < -0.01]
    loser_save = sum(a - p for p, a in losers)
    worst = sum(1 for b in bags if b.min_pnl <= -30)
    return {
        "n": len(bags),
        "sum": round(sum(pnls), 2),
        "delta_vs_mark_actual": round(delta, 2),
        "avg_hold": round(statistics.mean(holds), 0),
        "trigger_pct": round(triggered / len(bags) * 100, 1),
        "loser_save": round(loser_save, 2),
        "deep20_avoided": deep_avoided,
        "bags_went_-30": worst,
    }


def main() -> None:
    since, latest = window_ms(HOURS)
    u0, u1, udelta = wallet_usdc_delta(since)
    bags = load_bags(since)

    print("=" * 72)
    print(
        "WALLET-ANCHORED EXIT SWEEP",
        datetime.fromtimestamp(since / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "→",
        datetime.fromtimestamp(latest / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M"),
        f"({HOURS}h)",
    )
    print("=" * 72)
    print(f"USDC WALLET TRUTH:  ${u0:.2f} → ${u1:.2f}   Δ ${udelta:.2f}")
    print(f"bags with mark tape: {len(bags)}")
    act = eval_policy(bags, min_hold_sec=999999, max_loss_pct=100)
    # baseline = actual mark exit (never trigger early)
    actual_sum = sum(b.actual_pnl_usd() for b in bags)
    print(f"mark@actual-exit sum: ${actual_sum:.2f}  (per-bag marks; NOT wallet Δ)")
    print(f"bags min pnl ≤ -20%: {sum(1 for b in bags if b.min_pnl<=-20)}")
    print(f"bags min pnl ≤ -30%: {sum(1 for b in bags if b.min_pnl<=-30)}")
    print(f"bags actual mark loss: {sum(1 for b in bags if b.actual_pnl_usd()<-0.01)}")
    print()

    holds_min = [3, 5, 7, 10]
    losses = [5, 8, 10, 12, 15, 20]
    bounces = [0, 3]
    mfe_caps = [None, 5.0, 3.0]

    rows = []
    for hm, lp, bo, mf in product(holds_min, losses, bounces, mfe_caps):
        r = eval_policy(bags, hm * 60, lp, bo, mf)
        label = f"hold={hm}m loss=-{lp}%"
        if bo:
            label += f" bounce={bo}%"
        if mf is not None:
            label += f" mfe<{mf}%"
        r["label"] = label
        r["hold_min"] = hm
        r["loss_pct"] = lp
        rows.append(r)

    rows.sort(key=lambda x: x["delta_vs_mark_actual"], reverse=True)

    print("## TOP 15 vs mark-actual (higher delta = less bleed on same bags)")
    print(f"{'rule':36} {'sum$':>8} {'Δ$':>8} {'loser+':>8} {'trig%':>6} {'hold':>6} {'-30bags':>7}")
    for r in rows[:15]:
        print(
            f"{r['label']:36} {r['sum']:8.2f} {r['delta_vs_mark_actual']:+8.2f} "
            f"{r['loser_save']:+8.2f} {r['trigger_pct']:5.1f}% {r['avg_hold']:6.0f}s {r['bags_went_-30']:7}"
        )

    # User ask: 5m + 5%
    print("\n## USER RULE variants (5 min + drawdown)")
    picks = [
        ("5m + -5% flat", 300, 5, 0, None),
        ("5m + -5% bounce3", 300, 5, 3, None),
        ("5m + -5% mfe<5", 300, 5, 0, 5.0),
        ("5m + -8%", 300, 8, 0, None),
        ("5m + -10%", 300, 10, 0, None),
        ("3m + -5%", 180, 5, 0, None),
        ("7m + -5%", 420, 5, 0, None),
        ("10m + -5%", 600, 5, 0, None),
        ("CURRENT ~hard-30 bounce3", 0, 30, 3, None),
    ]
    for name, hs, lp, bo, mf in picks:
        r = eval_policy(bags, hs, lp, bo, mf)
        print(
            f"  {name:26} sum=${r['sum']:7.2f} Δ${r['delta_vs_mark_actual']:+7.2f} "
            f"loser_save=${r['loser_save']:+6.2f} trig={r['trigger_pct']:.0f}% avg_hold={r['avg_hold']:.0f}s"
        )

    # Best with mfe filter only
    mf_rows = [r for r in rows if "mfe<" in r["label"] and r["hold_min"] == 5]
    if mf_rows:
        best = mf_rows[0]
        print(f"\n## Best 5m hold with never-green filter: {best['label']}")
        print(f"   Δ${best['delta_vs_mark_actual']:+.2f}  loser_save ${best['loser_save']:+.2f}")

    print("\n## NOTE")
    print("  Wallet Δ is USDC only. Mark-sim compares exit RULES on same bags.")
    print("  Positive Δ = rule exits earlier/safer than what we actually did (mark basis).")
    print("  Re-entry after 30s cooldown NOT modeled here (negligible in prior scan).")


if __name__ == "__main__":
    main()
