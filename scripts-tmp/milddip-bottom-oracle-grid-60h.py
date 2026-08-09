#!/usr/bin/env python3
"""
Mild-dip 60h bottom/reversal oracle + causal entry grid.

Does NOT cut branches. Searches for tighter bottom/reversal filters on top of
the live entry universe (confirmed buys) using journal marks as the mark path.

Inputs: artifacts/milddip-oracle60h/extract.json
Outputs: artifacts/milddip-oracle60h/report.json (+ markdown summary)
"""
from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EXTRACT = ROOT / "artifacts/milddip-oracle60h/extract.json"
OUT_DIR = ROOT / "artifacts/milddip-oracle60h"
DK = "DKxHTQCvDKUke1WpsHgbfueuRiTMqdzXrWeFHPvzpump"

# Simplified live-like exit (matches 1.11.76x defaults used in CF):
ARM_PCT = 5.0
MFE_BANK1 = 8.0
MFE_BANK1_FRAC = 0.4
MFE_BANK2 = 15.0
MFE_BANK2_FRAC = 0.4
SLEEVE_GB = 12.0
HARD_STOP = 15.0
NEVER_ARM_BOUNCE_DUMP = 8.0
NEVER_ARM_BOUNCE = 8.0
FEE_RT_PCT = 1.0  # round-trip friction haircut on simulated PnL


def load() -> dict[str, Any]:
    return json.loads(EXTRACT.read_text())


def build_series(marks: list[dict], buys: list[dict], sells: list[dict]) -> dict[str, list[tuple[int, float]]]:
    by: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for m in marks:
        mint, ts, px = m.get("mint"), m.get("ts"), m.get("px")
        if mint and ts and px and px > 0:
            by[mint].append((int(ts), float(px)))
    for b in buys:
        mint, ts, px = b.get("mint"), b.get("ts"), b.get("priceUsd")
        if mint and ts and px and px > 0:
            by[mint].append((int(ts), float(px)))
    for s in sells:
        mint, ts, px = s.get("mint"), s.get("ts"), s.get("exitPriceUsd")
        if mint and ts and px and px > 0:
            by[mint].append((int(ts), float(px)))
    out: dict[str, list[tuple[int, float]]] = {}
    for mint, pts in by.items():
        pts.sort(key=lambda x: x[0])
        # collapse near-dups
        compact: list[tuple[int, float]] = []
        for ts, px in pts:
            if compact and ts - compact[-1][0] < 800 and abs(px / compact[-1][1] - 1) < 0.003:
                compact[-1] = (ts, px)
            else:
                compact.append((ts, px))
        out[mint] = compact
    return out


def path_after(series: list[tuple[int, float]], t0: int, horizon_ms: int = 3_600_000) -> list[tuple[int, float]]:
    end = t0 + horizon_ms
    return [(t, p) for t, p in series if t0 <= t <= end]


def mfe_mae(path: list[tuple[int, float]], entry: float) -> tuple[float, float, float | None, float | None]:
    if not path or not (entry > 0):
        return 0.0, 0.0, None, None
    peak = entry
    trough = entry
    for _, p in path:
        if p > peak:
            peak = p
        if p < trough:
            trough = p
    mfe = (peak / entry - 1) * 100
    mae = (trough / entry - 1) * 100
    return mfe, mae, peak, trough


def simulate_exit(path: list[tuple[int, float]], entry: float) -> dict[str, Any]:
    """Fraction-aware sleeve sim → realized pnlPct on notional."""
    if not path or not (entry > 0):
        return {"pnlPct": 0.0, "reason": "no_path", "heldMs": 0}
    rem = 1.0
    realized = 0.0
    peak = entry
    trough = entry
    armed = False
    bank1 = bank2 = False
    t0 = path[0][0]
    last_t = t0
    reason = "timeout"
    for t, px in path:
        last_t = t
        if px > peak:
            peak = px
        if px < trough:
            trough = px
        pnl = (px / entry - 1) * 100
        mfe = (peak / entry - 1) * 100
        gb = (px / peak - 1) * 100 if peak > 0 else 0.0

        if pnl <= -HARD_STOP and rem > 0:
            realized += rem * pnl
            rem = 0.0
            reason = "hard_stop"
            break

        if not armed and mfe >= ARM_PCT:
            armed = True

        if armed:
            if not bank1 and mfe >= MFE_BANK1:
                sell = min(rem, MFE_BANK1_FRAC)
                realized += sell * pnl
                rem -= sell
                bank1 = True
                if rem <= 1e-9:
                    reason = "mfe_bank_1"
                    break
            if not bank2 and mfe >= MFE_BANK2:
                sell = min(rem, MFE_BANK2_FRAC)
                realized += sell * pnl
                rem -= sell
                bank2 = True
                if rem <= 1e-9:
                    reason = "mfe_bank_2"
                    break
            if bank1 and rem > 0 and gb <= -SLEEVE_GB:
                realized += rem * pnl
                rem = 0.0
                reason = "mfe_bank_sleeve"
                break
        else:
            # never-arm bounce: dump from entry peak then bounce off trough
            dump_from_peak = (trough / peak - 1) * 100 if peak > 0 else 0.0
            bounce = (px / trough - 1) * 100 if trough > 0 else 0.0
            if dump_from_peak <= -NEVER_ARM_BOUNCE_DUMP and bounce >= NEVER_ARM_BOUNCE and rem > 0:
                # half then rest on second touch approx: sell all at bounce for CF simplicity
                realized += rem * pnl
                rem = 0.0
                reason = "never_arm_bounce"
                break

    if rem > 0:
        last_px = path[-1][1]
        pnl = (last_px / entry - 1) * 100
        realized += rem * pnl
        reason = "path_end"
    # friction
    realized -= FEE_RT_PCT
    return {
        "pnlPct": round(realized, 3),
        "reason": reason,
        "heldMs": last_t - t0,
        "mfePct": round((peak / entry - 1) * 100, 2),
        "maePct": round((trough / entry - 1) * 100, 2),
    }


def oracle_trades(series: list[tuple[int, float]], size_usd: float = 30.0) -> dict[str, Any]:
    """
    Perfect-foresight local bottom/top scalper:
    buy at local min confirmed by next H bars being higher; sell at local max
    before next L bars lower. Non-causal ceiling.
    """
    if len(series) < 20:
        return {"trades": [], "pnlUsd": 0.0, "n": 0}
    xs = series
    # resample to ~5s grid via last price
    # use raw ticks; local extremum with left/right window
    WIN = 8
    FWD = 12
    buys_idx: list[int] = []
    for i in range(WIN, len(xs) - FWD):
        p = xs[i][1]
        left = [xs[j][1] for j in range(i - WIN, i)]
        right = [xs[j][1] for j in range(i + 1, i + 1 + FWD)]
        if p <= min(left) and p <= min(right) * 1.002:
            # local bottom
            buys_idx.append(i)
    trades = []
    pnl = 0.0
    i = 0
    used_until = -1
    for bi in buys_idx:
        if bi <= used_until:
            continue
        entry = xs[bi][1]
        # find best exit in next 90 ticks or until -15%
        best_j = None
        best_px = entry
        for j in range(bi + 1, min(len(xs), bi + 90)):
            px = xs[j][1]
            if px > best_px:
                best_px = px
                best_j = j
            if (px / entry - 1) * 100 <= -HARD_STOP:
                best_j = j
                best_px = px
                break
            # stop when gave back 40% of MFE after arm
            mfe = (best_px / entry - 1) * 100
            if mfe >= 5 and (px / best_px - 1) * 100 <= -8:
                best_j = j
                best_px = px
                break
        if best_j is None:
            continue
        pct = (xs[best_j][1] / entry - 1) * 100 - FEE_RT_PCT
        usd = size_usd * pct / 100.0
        pnl += usd
        trades.append(
            {
                "entryTs": xs[bi][0],
                "exitTs": xs[best_j][0],
                "entryPx": entry,
                "exitPx": xs[best_j][1],
                "pnlPct": round(pct, 2),
                "pnlUsd": round(usd, 2),
            }
        )
        used_until = best_j
        i += 1
    return {"trades": trades, "pnlUsd": round(pnl, 2), "n": len(trades)}


@dataclass
class EntryFilter:
    name: str
    # dump from local peak (negative)
    min_dump: float
    max_dump: float
    min_bounce: float
    max_bounce: float
    trough_min_age_ms: int
    min_below_peak: float
    # confirmation: require price ≥ trough * (1+min_bounce) AND a prior new low
    require_higher_low: bool
    # skip mid-hill: last N marks slope still down
    require_turn: bool
    lookback_ms: int = 300_000


def features_at(
    series: list[tuple[int, float]], t0: int, lookback_ms: int
) -> dict[str, float | None]:
    window = [(t, p) for t, p in series if t0 - lookback_ms <= t <= t0]
    if len(window) < 3:
        return {
            "dump": None,
            "bounce": None,
            "trough_age": None,
            "below_peak": None,
            "turn": None,
            "last": None,
            "peak": None,
            "trough": None,
        }
    peak_t, peak = max(window, key=lambda x: x[1])
    trough_t, trough = min(window, key=lambda x: x[1])
    last_t, last = window[-1]
    dump = (trough / peak - 1) * 100 if peak > 0 else None
    bounce = (last / trough - 1) * 100 if trough > 0 else None
    below = (last / peak - 1) * 100 if peak > 0 else None
    trough_age = last_t - trough_t
    # turn: last 3 ticks rising after trough
    after = [(t, p) for t, p in window if t >= trough_t]
    turn = 0.0
    if len(after) >= 3 and after[-1][1] > after[-2][1] > after[-3][1]:
        turn = 1.0
    # higher low: trough is not at the very end
    return {
        "dump": dump,
        "bounce": bounce,
        "trough_age": float(trough_age),
        "below_peak": below,
        "turn": turn,
        "last": last,
        "peak": peak,
        "trough": trough,
    }


def passes(f: dict[str, float | None], filt: EntryFilter) -> bool:
    dump, bounce = f.get("dump"), f.get("bounce")
    age, below, turn = f.get("trough_age"), f.get("below_peak"), f.get("turn")
    if dump is None or bounce is None or age is None or below is None:
        return False
    if not (filt.min_dump < dump <= filt.max_dump):
        return False
    if not (filt.min_bounce <= bounce <= filt.max_bounce):
        return False
    if age < filt.trough_min_age_ms:
        return False
    if below > -filt.min_below_peak:  # below is negative when under peak
        return False
    if filt.require_turn and not (turn and turn > 0):
        return False
    if filt.require_higher_low:
        # bounce already implies reclaim; require trough age and turn together
        if age < max(filt.trough_min_age_ms, 20_000) or not (turn and turn > 0):
            return False
    return True


def actual_pnl_by_buy(buys: list[dict], sells: list[dict], sell_reasons: list[dict]) -> list[dict]:
    """Greedy match sells to buys per mint FIFO for cycle pnl."""
    sells_by = defaultdict(list)
    for s in sells:
        sells_by[s["mint"]].append(s)
    for m in sells_by:
        sells_by[m].sort(key=lambda x: x["ts"])
    reasons_by = defaultdict(list)
    for r in sell_reasons:
        reasons_by[r["mint"]].append(r)
    for m in reasons_by:
        reasons_by[m].sort(key=lambda x: x["ts"])

    out = []
    cursor = defaultdict(int)
    for b in sorted(buys, key=lambda x: x["ts"]):
        mint = b["mint"]
        size = float(b.get("sizeUsd") or 0)
        entry = float(b.get("priceUsd") or 0)
        # accumulate sells until ~1.0 fraction after this buy, before next buy on mint
        frac = 0.0
        pnl_usd = 0.0
        legs = []
        i = cursor[mint]
        sl = sells_by[mint]
        while i < len(sl) and frac < 0.98:
            s = sl[i]
            if s["ts"] < b["ts"]:
                i += 1
                cursor[mint] = i
                continue
            sf = float(s.get("sellFraction") or 1)
            pct = float(s.get("pnlPct") or 0)
            pnl_usd += size * sf * pct / 100.0
            frac += sf
            legs.append({"ts": s["ts"], "frac": sf, "pnlPct": pct, "exit": s.get("exitPriceUsd")})
            i += 1
            cursor[mint] = i
            if frac >= 0.98:
                break
        out.append(
            {
                "mint": mint,
                "symbol": b.get("symbol"),
                "ts": b["ts"],
                "sizeUsd": size,
                "entryPx": entry,
                "actualPnlUsd": round(pnl_usd, 3),
                "coveredFrac": round(min(frac, 1.0), 3),
                "legs": legs,
            }
        )
    return out


def main() -> None:
    data = load()
    series = build_series(data["marks"], data["buys"], data["sells"])
    attempts_by_tx = {}
    for a in data["attempts"]:
        tx = a.get("txSignature")
        if tx:
            attempts_by_tx[tx] = a
    # map buy -> attempt via near ts+mint
    att_by_mint_ts = defaultdict(list)
    for a in data["attempts"]:
        att_by_mint_ts[a["mint"]].append(a)
    for m in att_by_mint_ts:
        att_by_mint_ts[m].sort(key=lambda x: x["ts"])

    cycles = actual_pnl_by_buy(data["buys"], data["sells"], data["sell_reasons"])
    actual_total = sum(c["actualPnlUsd"] for c in cycles)

    # Enrich cycles with features + sim path
    enriched = []
    for c in cycles:
        mint = c["mint"]
        ser = series.get(mint, [])
        # find attempt near buy
        dip_source = None
        stab_dump = stab_bounce = pc5m = None
        cands = att_by_mint_ts.get(mint, [])
        best = None
        for a in cands:
            if abs(a["ts"] - c["ts"]) <= 15_000:
                best = a
                break
        if best:
            dip_source = best.get("dipSource")
            stab_dump = best.get("mildStabilizeDumpPct")
            stab_bounce = best.get("mildStabilizeBouncePct")
            pc5m = best.get("pc5m")
        feat = features_at(ser, c["ts"], 300_000)
        path = path_after(ser, c["ts"], 3_600_000)
        sim = simulate_exit(path, c["entryPx"]) if c["entryPx"] else {"pnlPct": 0, "reason": "no_entry"}
        # delayed entries: wait for better trough in next 120s then bounce
        delay_sims = {}
        for delay_ms in (15_000, 30_000, 60_000, 120_000):
            window = [(t, p) for t, p in ser if c["ts"] <= t <= c["ts"] + delay_ms]
            if len(window) < 4:
                delay_sims[str(delay_ms)] = None
                continue
            trough_t, trough = min(window, key=lambda x: x[1])
            # enter at first reclaim +2% after trough within delay window end+60s
            entry_px = None
            entry_t = None
            for t, p in ser:
                if t < trough_t:
                    continue
                if t > c["ts"] + delay_ms + 60_000:
                    break
                if (p / trough - 1) * 100 >= 2.0:
                    entry_px, entry_t = p, t
                    break
            if not entry_px:
                delay_sims[str(delay_ms)] = {"pnlPct": 0, "skipped": True}
                continue
            path2 = path_after(ser, entry_t, 3_600_000)
            s2 = simulate_exit(path2, entry_px)
            s2["entryPx"] = entry_px
            s2["delayMs"] = entry_t - c["ts"]
            delay_sims[str(delay_ms)] = s2

        # oracle single-cycle: buy at MAE trough in first 3m if later recovers
        ora = None
        early = [(t, p) for t, p in path if t <= c["ts"] + 180_000]
        if early and c["entryPx"]:
            t_t, t_p = min(early, key=lambda x: x[1])
            path_o = path_after(ser, t_t, 3_600_000)
            ora = simulate_exit(path_o, t_p)
            ora["troughPx"] = t_p
            ora["savedPct"] = round(
                ((c["entryPx"] / t_p - 1) * 100) if t_p else 0, 2
            )

        enriched.append(
            {
                **{k: c[k] for k in ("mint", "symbol", "ts", "sizeUsd", "entryPx", "actualPnlUsd", "coveredFrac")},
                "dipSource": dip_source,
                "pc5m": pc5m,
                "stabDump": stab_dump,
                "stabBounce": stab_bounce,
                "feat": feat,
                "sim": sim,
                "delay": delay_sims,
                "oracleEarlyTrough": ora,
            }
        )

    # DKx oracle
    dk_series = series.get(DK, [])
    dk_oracle = oracle_trades(dk_series, size_usd=10.0)
    dk_cycles = [e for e in enriched if e["mint"] == DK]
    dk_actual = sum(e["actualPnlUsd"] for e in dk_cycles)
    dk_sim = sum(e["sizeUsd"] * e["sim"]["pnlPct"] / 100 for e in dk_cycles)
    dk_ora_early = sum(
        e["sizeUsd"] * e["oracleEarlyTrough"]["pnlPct"] / 100
        for e in dk_cycles
        if e.get("oracleEarlyTrough")
    )

    # Grid of causal filters on live buys (keep if passes; else skip)
    filters: list[EntryFilter] = []
    for min_dump, max_dump in [(-35, -12), (-30, -10), (-25, -10), (-25, -8), (-20, -8), (-20, -12)]:
        for min_b, max_b in [(1.5, 5), (2, 6), (2.5, 8), (3, 6), (1.5, 8)]:
            for age in (10_000, 20_000, 30_000, 45_000):
                for below in (2, 3, 5):
                    for turn in (False, True):
                        for hl in (False, True):
                            if hl and not turn:
                                continue
                            name = (
                                f"dump({min_dump},{max_dump}]_b[{min_b},{max_b}]_"
                                f"age{age//1000}s_bel{below}_turn{int(turn)}_hl{int(hl)}"
                            )
                            filters.append(
                                EntryFilter(
                                    name=name,
                                    min_dump=min_dump,
                                    max_dump=max_dump,
                                    min_bounce=min_b,
                                    max_bounce=max_b,
                                    trough_min_age_ms=age,
                                    min_below_peak=below,
                                    require_higher_low=hl,
                                    require_turn=turn,
                                )
                            )

    # Also source-aware soft grids (don't cut branches — tighten stabilize/h1)
    # Baseline: take all
    def eval_filter(pred) -> dict[str, Any]:
        pnl = 0.0
        n_keep = 0
        n_skip = 0
        by_src = defaultdict(lambda: {"n": 0, "pnl": 0.0})
        for e in enriched:
            keep = pred(e)
            if keep:
                pnl += e["actualPnlUsd"]
                n_keep += 1
                src = e.get("dipSource") or "?"
                by_src[src]["n"] += 1
                by_src[src]["pnl"] += e["actualPnlUsd"]
            else:
                n_skip += 1
        return {
            "pnlUsd": round(pnl, 2),
            "deltaVsActual": round(pnl - actual_total, 2),
            "kept": n_keep,
            "skipped": n_skip,
            "bySource": {k: {"n": v["n"], "pnl": round(v["pnl"], 2)} for k, v in by_src.items()},
        }

    baseline = eval_filter(lambda e: True)

    grid_results = []
    # Feature-based filters only when feat available; if missing keep (don't invent skips)
    for filt in filters:
        def pred(e, filt=filt):
            f = e.get("feat") or {}
            if f.get("dump") is None:
                return True  # no ring → keep (live behavior)
            return passes(f, filt)

        r = eval_filter(pred)
        r["name"] = filt.name
        r["filt"] = asdict(filt)
        grid_results.append(r)

    grid_results.sort(key=lambda x: x["pnlUsd"], reverse=True)
    top = grid_results[:25]
    # diversity: best with kept >= 40% of buys
    min_keep = int(0.4 * len(enriched))
    top_liquid = [g for g in grid_results if g["kept"] >= min_keep][:15]

    # Heuristic grids that don't require full ring (use attempt fields)
    heuristics = []
    for label, pred in [
        ("all", lambda e: True),
        (
            "stabilize_bounce<=4",
            lambda e: not (
                e.get("dipSource") == "mild_stabilize"
                and e.get("stabBounce") is not None
                and e["stabBounce"] > 4
            ),
        ),
        (
            "stabilize_bounce<=3",
            lambda e: not (
                e.get("dipSource") == "mild_stabilize"
                and e.get("stabBounce") is not None
                and e["stabBounce"] > 3
            ),
        ),
        (
            "stabilize_dump<=-12",
            lambda e: not (
                e.get("dipSource") == "mild_stabilize"
                and e.get("stabDump") is not None
                and e["stabDump"] > -12
            ),
        ),
        (
            "stabilize_dump<=-12_bounce<=4",
            lambda e: not (
                e.get("dipSource") == "mild_stabilize"
                and (
                    (e.get("stabDump") is not None and e["stabDump"] > -12)
                    or (e.get("stabBounce") is not None and e["stabBounce"] > 4)
                )
            ),
        ),
        (
            "h1_skip_pc5m>-8",
            lambda e: not (
                e.get("dipSource") == "h1_red_shallow"
                and e.get("pc5m") is not None
                and e["pc5m"] > -8
            ),
        ),
        (
            "h1_skip_pc5m>-10",
            lambda e: not (
                e.get("dipSource") == "h1_red_shallow"
                and e.get("pc5m") is not None
                and e["pc5m"] > -10
            ),
        ),
        (
            "dex_pc5m<=-12",
            lambda e: not (
                e.get("dipSource") in ("dex", "dex+stream", "stream")
                and e.get("pc5m") is not None
                and e["pc5m"] > -12
            ),
        ),
        (
            "any_bounce_feat<=5_if_known",
            lambda e: not (
                e.get("feat", {}).get("bounce") is not None and e["feat"]["bounce"] > 5
            ),
        ),
        (
            "any_dump_feat<=-12_if_known",
            lambda e: not (
                e.get("feat", {}).get("dump") is not None and e["feat"]["dump"] > -12
            ),
        ),
        (
            "require_turn_if_known",
            lambda e: e.get("feat", {}).get("turn") in (None, 1.0)
            or e.get("feat", {}).get("dump") is None,
        ),
        (
            "delay30s_if_better_sim",
            lambda e: True,  # placeholder — handled below
        ),
    ]:
        if label.startswith("delay"):
            continue
        r = eval_filter(pred)
        r["name"] = label
        heuristics.append(r)

    # Delay CF: replace actual with delayed sim when delay sim better
    delay_cf = {}
    for delay_key in ("15000", "30000", "60000", "120000"):
        pnl = 0.0
        n_delay = 0
        for e in enriched:
            d = (e.get("delay") or {}).get(delay_key)
            if d and not d.get("skipped") and d.get("pnlPct") is not None:
                # use delayed sim pnl on size vs actual
                sim_usd = e["sizeUsd"] * d["pnlPct"] / 100
                act = e["actualPnlUsd"]
                if sim_usd > act:
                    pnl += sim_usd
                    n_delay += 1
                else:
                    pnl += act
            else:
                pnl += e["actualPnlUsd"]
        delay_cf[delay_key] = {
            "pnlUsd": round(pnl, 2),
            "deltaVsActual": round(pnl - actual_total, 2),
            "nUpgraded": n_delay,
        }

    # Pure sim replay (all buys, sim exit on marks) vs actual
    sim_all = sum(e["sizeUsd"] * e["sim"]["pnlPct"] / 100 for e in enriched)
    ora_all = sum(
        e["sizeUsd"] * e["oracleEarlyTrough"]["pnlPct"] / 100
        for e in enriched
        if e.get("oracleEarlyTrough")
    )

    # Per-source actual
    by_src = defaultdict(lambda: {"n": 0, "pnl": 0.0})
    for e in enriched:
        s = e.get("dipSource") or "?"
        by_src[s]["n"] += 1
        by_src[s]["pnl"] += e["actualPnlUsd"]

    # DKx detail
    dk_detail = []
    for e in dk_cycles:
        dk_detail.append(
            {
                "ts": e["ts"],
                "dipSource": e["dipSource"],
                "entryPx": e["entryPx"],
                "sizeUsd": e["sizeUsd"],
                "actualPnlUsd": e["actualPnlUsd"],
                "pc5m": e["pc5m"],
                "stabDump": e["stabDump"],
                "stabBounce": e["stabBounce"],
                "feat": e["feat"],
                "sim": e["sim"],
                "oracleEarlyTrough": e["oracleEarlyTrough"],
                "delay30s": (e.get("delay") or {}).get("30000"),
            }
        )

    # Best combined heuristic: stabilize tighten + h1 deepen (no branch cut)
    combo_preds = [
        (
            "stabilize_tight+h1_pc5m<=-10",
            lambda e: (
                not (
                    e.get("dipSource") == "mild_stabilize"
                    and (
                        (e.get("stabDump") is not None and e["stabDump"] > -12)
                        or (e.get("stabBounce") is not None and e["stabBounce"] > 4)
                    )
                )
            )
            and not (
                e.get("dipSource") == "h1_red_shallow"
                and e.get("pc5m") is not None
                and e["pc5m"] > -10
            ),
        ),
        (
            "stabilize_tight+h1_pc5m<=-10+dex<=-12",
            lambda e: (
                not (
                    e.get("dipSource") == "mild_stabilize"
                    and (
                        (e.get("stabDump") is not None and e["stabDump"] > -12)
                        or (e.get("stabBounce") is not None and e["stabBounce"] > 4)
                    )
                )
            )
            and not (
                e.get("dipSource") == "h1_red_shallow"
                and e.get("pc5m") is not None
                and e["pc5m"] > -10
            )
            and not (
                e.get("dipSource") in ("dex", "dex+stream", "stream")
                and e.get("pc5m") is not None
                and e["pc5m"] > -12
            ),
        ),
        (
            "turn_confirm+stabilize_tight+h1<=-10",
            lambda e: (
                (e.get("feat", {}).get("dump") is None or e.get("feat", {}).get("turn") == 1.0)
                and not (
                    e.get("dipSource") == "mild_stabilize"
                    and (
                        (e.get("stabDump") is not None and e["stabDump"] > -12)
                        or (e.get("stabBounce") is not None and e["stabBounce"] > 4)
                    )
                )
                and not (
                    e.get("dipSource") == "h1_red_shallow"
                    and e.get("pc5m") is not None
                    and e["pc5m"] > -10
                )
            ),
        ),
    ]
    for label, pred in combo_preds:
        r = eval_filter(pred)
        r["name"] = label
        heuristics.append(r)
    heuristics.sort(key=lambda x: x["pnlUsd"], reverse=True)

    report = {
        "window": data["summary"],
        "actualTotalPnlUsd": round(actual_total, 2),
        "nCycles": len(enriched),
        "bySourceActual": {
            k: {"n": v["n"], "pnl": round(v["pnl"], 2)} for k, v in sorted(by_src.items())
        },
        "simReplayAllUsd": round(sim_all, 2),
        "oracleEarlyTroughAllUsd": round(ora_all, 2),
        "dk": {
            "marks": len(dk_series),
            "spanH": round((dk_series[-1][0] - dk_series[0][0]) / 3600000, 3) if len(dk_series) > 1 else 0,
            "actualPnlUsd": round(dk_actual, 2),
            "simReplayUsd": round(dk_sim, 2),
            "oracleEarlyTroughUsd": round(dk_ora_early, 2),
            "perfectScalper": dk_oracle,
            "cycles": dk_detail,
        },
        "delayCf": delay_cf,
        "baseline": baseline,
        "heuristicsTop": heuristics[:20],
        "gridTop": top,
        "gridTopLiquid40pct": top_liquid,
        "note": (
            "Grid uses causal ring features at buy time when marks exist in lookback; "
            "missing features → keep trade (no silent branch cut). "
            "Oracle/perfect scalper is non-causal ceiling."
        ),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "report.json").write_text(json.dumps(report, indent=2))

    # Markdown summary
    lines = []
    lines.append("# Mild-dip 60h bottom/reversal oracle + grid")
    lines.append("")
    lines.append(
        f"Window buys={data['summary']['buys']} mints={data['summary']['uniqueMints']} "
        f"actual≈**${actual_total:.2f}**"
    )
    lines.append("")
    lines.append("## By dipSource (actual)")
    for k, v in sorted(by_src.items(), key=lambda x: x[1]["pnl"]):
        lines.append(f"- `{k}`: n={v['n']} pnl=${v['pnl']:.2f}")
    lines.append("")
    lines.append("## DKxHTQ oracle")
    lines.append(
        f"- actual ${dk_actual:.2f} | sim-replay ${dk_sim:.2f} | "
        f"early-trough oracle ${dk_ora_early:.2f} | "
        f"perfect-scalper ${dk_oracle['pnlUsd']:.2f} ({dk_oracle['n']} trades)"
    )
    for t in dk_detail:
        lines.append(
            f"  - {t['dipSource']} entry={t['entryPx']:.6g} actual=${t['actualPnlUsd']:.2f} "
            f"sim={t['sim'].get('pnlPct')}% mae={t['sim'].get('maePct')} "
            f"stabDump={t['stabDump']} stabBounce={t['stabBounce']} pc5m={t['pc5m']}"
        )
    lines.append("")
    lines.append("## Delay CF (upgrade entry when 30–120s wait helps)")
    for k, v in delay_cf.items():
        lines.append(f"- wait≤{k}ms: ${v['pnlUsd']} (Δ {v['deltaVsActual']:+}, upgraded {v['nUpgraded']})")
    lines.append("")
    lines.append("## Heuristics (no branch deletion — tighten gates)")
    for h in heuristics[:12]:
        lines.append(
            f"- `{h['name']}`: ${h['pnlUsd']} (Δ {h['deltaVsActual']:+}) kept={h['kept']} skip={h['skipped']}"
        )
    lines.append("")
    lines.append("## Ring-feature grid top (may skip when features known)")
    for g in top[:10]:
        lines.append(
            f"- `{g['name']}`: ${g['pnlUsd']} (Δ {g['deltaVsActual']:+}) kept={g['kept']}"
        )
    lines.append("")
    lines.append("## Liquid grid (≥40% keeps)")
    for g in top_liquid[:10]:
        lines.append(
            f"- `{g['name']}`: ${g['pnlUsd']} (Δ {g['deltaVsActual']:+}) kept={g['kept']}"
        )
    (OUT_DIR / "REPORT.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:80]))
    print("\nWrote", OUT_DIR / "report.json", OUT_DIR / "REPORT.md")


if __name__ == "__main__":
    main()
