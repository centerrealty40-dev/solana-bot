#!/usr/bin/env python3
"""Deep breakdown for exit rules — winners vs losers, -30% saves."""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field

sys.path.insert(0, "/tmp")
from wallet_exit_sweep import (  # noqa: E402
    HOURS,
    load_bags,
    wallet_usdc_delta,
    window_ms,
)


@dataclass
class Rule:
    name: str
    hold_sec: float
    loss_pct: float
    bounce_pct: float = 0.0
    max_mfe_pct: float | None = None


RULES = [
    Rule("ACTUAL (mark exit)", 999999, 100),
    Rule("5m + -5% flat", 300, 5),
    Rule("5m + -5% mfe<5%", 300, 5, max_mfe_pct=5.0),
    Rule("5m + -8% flat", 300, 8),
    Rule("5m + -10% flat", 300, 10),
    Rule("7m + -8% mfe<5%", 420, 8, max_mfe_pct=5.0),
    Rule("hard -30% bounce3 (live-ish)", 0, 30, 3),
]


def analyze(bags, rule: Rule) -> dict:
    win_delta = 0.0
    lose_delta = 0.0
    win_n = lose_n = 0
    trig_win = trig_lose = 0
    saved_30 = 0
    for b in bags:
        pnl, hold, trig = b.sim_pnl_usd(
            rule.hold_sec, rule.loss_pct, rule.bounce_pct, rule.max_mfe_pct
        )
        act = b.actual_pnl_usd()
        d = pnl - act
        if act >= -0.01:
            win_n += 1
            win_delta += d
            if trig:
                trig_win += 1
        else:
            lose_n += 1
            lose_delta += d
            if trig:
                trig_lose += 1
        if b.min_pnl <= -30 and trig and pnl > act + 0.01:
            saved_30 += 1
    return {
        "win_delta": win_delta,
        "lose_delta": lose_delta,
        "win_n": win_n,
        "lose_n": lose_n,
        "trig_win": trig_win,
        "trig_lose": trig_lose,
        "saved_30": saved_30,
    }


def main() -> None:
    since, _ = window_ms(HOURS)
    u0, u1, udelta = wallet_usdc_delta(since)
    bags = load_bags(since)
    deep30 = [b for b in bags if b.min_pnl <= -30]

    print(f"USDC wallet Δ ${udelta:.2f}  |  bags={len(bags)}  deep30={len(deep30)}")
    print()
    print(f"{'rule':32} {'Δwin$':>10} {'Δlose$':>10} {'trigW':>6} {'trigL':>6} {'save30':>7}")
    for rule in RULES:
        r = analyze(bags, rule)
        print(
            f"{rule.name:32} {r['win_delta']:+10.2f} {r['lose_delta']:+10.2f} "
            f"{r['trig_win']:6} {r['trig_lose']:6} {r['saved_30']:7}"
        )

    print("\n## Deep -30% bags (sample stats)")
    for rule in RULES[1:4]:
        pnls = []
        for b in deep30:
            p, _, t = b.sim_pnl_usd(
                rule.hold_sec, rule.loss_pct, rule.bounce_pct, rule.max_mfe_pct
            )
            if t:
                pnls.append((p, b.actual_pnl_usd(), b.min_pnl))
        if not pnls:
            print(f"  {rule.name}: triggers on 0/{len(deep30)} deep bags")
            continue
        avg_p = sum(x[0] for x in pnls) / len(pnls)
        avg_a = sum(x[1] for x in pnls) / len(pnls)
        print(
            f"  {rule.name}: triggers {len(pnls)}/{len(deep30)} "
            f"avg exit ${avg_p:.2f} vs actual ${avg_a:.2f} (min pnl avg {sum(x[2] for x in pnls)/len(pnls):.1f}%)"
        )


if __name__ == "__main__":
    main()
