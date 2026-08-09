#!/usr/bin/env python3
"""
Reverse-engineer 8zkg ENTRY (dip-only) and EXIT rules by hypothesis search.

Only dump entries (pc5m < 0). Fit thresholds on half the sessions, validate on holdout.
Uses leader-observer JSONL + optional PG pair_snapshots for pre-buy drawdown.
"""
from __future__ import annotations

import json
import math
import os
import statistics as st
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("MILD_DIP_ROOT", "/opt/solana-alpha"))
DATA = ROOT / "data" / "milddip"
LEADER = "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ"
OUT_DIR = Path(os.environ.get("REVERSE_OUT", "/tmp/leader-reverse"))
OUT_DIR.mkdir(parents=True, exist_ok=True)


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def pct(a: float, b: float) -> float | None:
    if not (a > 0 and b > 0):
        return None
    return (b / a - 1.0) * 100.0


@dataclass
class DipSession:
    mint: str
    open_ts: int
    close_ts: int | None
    entry_px: float | None
    exit_px: float | None
    size_usd: float | None
    cost_usd: float | None
    pc5m: float | None
    pc1h: float | None
    class_: str | None
    turn: float | None
    vol1h_mcap: float | None
    liq: float | None
    age_h: float | None
    pressure: float | None
    fill_vs_dex_slip_pct: float | None  # fill/dex - 1
    dump_pc5m: float | None  # -pc5m when red
    dd5m: float | None  # drawdown from max in 5m before buy (negative)
    dd15m: float | None
    held_sec: float | None
    pnl_pct: float | None
    pnl_usd: float | None
    # exit path features (from snapshots if any)
    mfe_pct: float | None = None
    mae_pct: float | None = None
    giveback_from_peak_pct: float | None = None  # (exit/peak - 1)*100 at exit
    impulse_at_exit_pct: float | None = None  # same as pnl_pct if entry/exit known


def load_observer() -> tuple[list[dict], list[dict], list[dict]]:
    buys, opens, flats = [], [], []
    for p in sorted(DATA.glob("leader-observer-*.jsonl")):
        for line in p.read_text().splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("leader") != LEADER:
                continue
            k = e.get("kind")
            if k == "leader_buy_observed":
                buys.append(e)
            elif k == "leader_session_open":
                opens.append(e)
            elif k == "leader_session_flat":
                flats.append(e)
    return buys, opens, flats


def dex_of(e: dict) -> dict:
    d = e.get("dex")
    return d if isinstance(d, dict) and not d.get("error") else {}


def build_sessions(buys: list[dict], flats: list[dict], *, new_bag_only: bool = False) -> list[DipSession]:
    """Pair dip buys to next flat on mint.

    Default: ALL dip buys (opens + adds into dump) — what user asked.
    new_bag_only=True restricts to isNewBag.
    """
    if new_bag_only:
        new_buys = [b for b in buys if b.get("isNewBag")]
        if len(new_buys) < 20:
            new_buys = [b for b in buys if b.get("isNewBag") is not False]
    else:
        new_buys = list(buys)

    flats_by = defaultdict(list)
    for f in flats:
        flats_by[f["mint"]].append(f)
    for m in flats_by:
        flats_by[m].sort(key=lambda x: x.get("blockTime") or x.get("tsMs") or 0)

    used_flat: set[tuple[str, str]] = set()
    out: list[DipSession] = []
    for b in sorted(new_buys, key=lambda x: x.get("blockTime") or x.get("tsMs") or 0):
        mint = b["mint"]
        ots = int(b.get("blockTime") or 0)
        if not ots:
            ots = int((b.get("tsMs") or 0) / 1000)
        ots_ms = int(b.get("tsMs") or ots * 1000)
        d = dex_of(b)
        pc5 = d.get("pc5m")
        if pc5 is None:
            pc5 = b.get("pc5m")
        try:
            pc5f = float(pc5) if pc5 is not None else None
        except (TypeError, ValueError):
            pc5f = None
        # DIP ONLY
        if pc5f is None or pc5f >= 0:
            continue

        # match flat
        flat = None
        for f in flats_by.get(mint, []):
            fts = int(f.get("blockTime") or 0)
            key = (mint, str(f.get("signature") or fts))
            if key in used_flat:
                continue
            if fts and fts >= ots:
                flat = f
                used_flat.add(key)
                break

        entry = b.get("fillPriceUsd") or b.get("bagEntryPriceUsd") or d.get("priceUsd")
        dex_px = d.get("priceUsd")
        try:
            entry_f = float(entry) if entry else None
        except (TypeError, ValueError):
            entry_f = None
        try:
            dex_f = float(dex_px) if dex_px else None
        except (TypeError, ValueError):
            dex_f = None
        slip = pct(dex_f, entry_f) if entry_f and dex_f else None

        vol5, liq = d.get("vol5m"), d.get("liq")
        turn = d.get("turnover5mLiq")
        if turn is None and vol5 and liq and float(liq) > 0:
            turn = float(vol5) / float(liq)
        vol1, mcap = d.get("vol1h"), d.get("mcap")
        v2m = None
        if vol1 is not None and mcap and float(mcap) > 0:
            v2m = float(vol1) / float(mcap)
        buys5, sells5 = d.get("buys5m"), d.get("sells5m")
        pressure = None
        if buys5 is not None and sells5 is not None and float(sells5) > 0:
            pressure = float(buys5) / float(sells5)

        exit_px = held = pnl_pct = pnl_usd = close_ts = None
        if flat:
            close_ts = int(flat.get("blockTime") or 0) or None
            try:
                exit_px = float(flat["exitPriceUsd"]) if flat.get("exitPriceUsd") else None
            except (TypeError, ValueError):
                exit_px = None
            held = flat.get("heldSec")
            pnl_pct = flat.get("pnlPctApprox")
            if isinstance(pnl_pct, (int, float)):
                pnl_pct = max(-95.0, min(float(pnl_pct), 500.0))
            cost = b.get("bagCostUsd") or b.get("sizeUsd")
            try:
                cost_f = float(cost) if cost else None
            except (TypeError, ValueError):
                cost_f = None
            if cost_f and pnl_pct is not None:
                pnl_usd = cost_f * float(pnl_pct) / 100.0

        try:
            pc1h = float(d["pc1h"]) if d.get("pc1h") is not None else None
        except (TypeError, ValueError):
            pc1h = None
        try:
            age = float(d["ageHours"]) if d.get("ageHours") is not None else None
        except (TypeError, ValueError):
            age = None
        try:
            liq_f = float(liq) if liq is not None else None
        except (TypeError, ValueError):
            liq_f = None
        try:
            size_f = float(b["sizeUsd"]) if b.get("sizeUsd") is not None else None
        except (TypeError, ValueError):
            size_f = None

        out.append(
            DipSession(
                mint=mint,
                open_ts=ots_ms,
                close_ts=close_ts * 1000 if close_ts else None,
                entry_px=entry_f,
                exit_px=exit_px,
                size_usd=size_f,
                cost_usd=float(b["bagCostUsd"]) if b.get("bagCostUsd") else size_f,
                pc5m=pc5f,
                pc1h=pc1h,
                class_=b.get("class"),
                turn=float(turn) if turn is not None else None,
                vol1h_mcap=v2m,
                liq=liq_f,
                age_h=age,
                pressure=pressure,
                fill_vs_dex_slip_pct=slip,
                dump_pc5m=-pc5f if pc5f is not None else None,
                dd5m=None,
                dd15m=None,
                held_sec=float(held) if held is not None else None,
                pnl_pct=float(pnl_pct) if pnl_pct is not None else None,
                pnl_usd=pnl_usd,
                impulse_at_exit_pct=float(pnl_pct) if pnl_pct is not None else None,
            )
        )
    return out


def enrich_snapshots(sessions: list[DipSession]) -> None:
    """Attach dd5m/dd15m/mfe/mae/giveback from PG pair_snapshots when available."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn or not sessions:
        print("PG: skip (no DATABASE_URL or no sessions)")
        return
    try:
        import psycopg  # type: ignore
    except ImportError:
        try:
            import psycopg2 as psycopg  # type: ignore
        except ImportError:
            print("PG: no psycopg")
            return

    mints = sorted({s.mint for s in sessions})
    t0 = min(s.open_ts for s in sessions) - 2 * 3600 * 1000
    t1 = max((s.close_ts or s.open_ts) for s in sessions) + 3600 * 1000
    # snapshots often store ts as timestamptz or ms — probe
    sql_candidates = [
        """
        SELECT mint, (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms, price_usd
        FROM pumpswap_pair_snapshots
        WHERE mint = ANY(%s) AND ts >= to_timestamp(%s/1000.0) AND ts <= to_timestamp(%s/1000.0)
        ORDER BY mint, ts
        """,
        """
        SELECT mint, ts_ms, price_usd
        FROM pumpswap_pair_snapshots
        WHERE mint = ANY(%s) AND ts_ms >= %s AND ts_ms <= %s
        ORDER BY mint, ts_ms
        """,
    ]
    rows = []
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            # list tables
            cur.execute(
                """
                SELECT table_name FROM information_schema.tables
                WHERE table_schema='public' AND table_name LIKE '%snapshot%'
                ORDER BY 1
                """
            )
            tables = [r[0] for r in cur.fetchall()]
            print("PG snapshot tables:", tables[:20])
            # prefer pumpswap / raydium style
            table = None
            for cand in (
                "pumpswap_pair_snapshots",
                "pair_snapshots",
                "raydium_pair_snapshots",
            ):
                if cand in tables:
                    table = cand
                    break
            if not table and tables:
                table = tables[0]
            if not table:
                print("PG: no snapshot table")
                return
            # introspect columns
            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                WHERE table_name=%s
                """,
                (table,),
            )
            cols = {r[0] for r in cur.fetchall()}
            print("PG cols", sorted(cols)[:30], "table", table)
            mint_col = "mint" if "mint" in cols else ("base_mint" if "base_mint" in cols else None)
            px_col = (
                "price_usd"
                if "price_usd" in cols
                else ("priceUsd" if "priceUsd" in cols else ("close" if "close" in cols else None))
            )
            if "ts_ms" in cols:
                ts_expr = "ts_ms"
                q = f"""
                SELECT {mint_col}, {ts_expr}, {px_col}
                FROM {table}
                WHERE {mint_col} = ANY(%s) AND {ts_expr} >= %s AND {ts_expr} <= %s
                ORDER BY 1,2
                """
                cur.execute(q, (mints, t0, t1))
            elif "ts" in cols:
                q = f"""
                SELECT {mint_col}, (EXTRACT(EPOCH FROM ts)*1000)::bigint, {px_col}
                FROM {table}
                WHERE {mint_col} = ANY(%s)
                  AND ts >= to_timestamp(%s/1000.0)
                  AND ts <= to_timestamp(%s/1000.0)
                ORDER BY 1,2
                """
                cur.execute(q, (mints, t0, t1))
            else:
                print("PG: cannot find ts column")
                return
            rows = cur.fetchall()
    print("PG rows", len(rows))
    by_mint: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for mint, ts_ms, px in rows:
        if px is None:
            continue
        try:
            by_mint[str(mint)].append((int(ts_ms), float(px)))
        except Exception:
            continue
    for mint in by_mint:
        by_mint[mint].sort()

    for s in sessions:
        path = by_mint.get(s.mint, [])
        if not path:
            continue
        t = s.open_ts
        pre5 = [px for ts, px in path if t - 300_000 <= ts <= t]
        pre15 = [px for ts, px in path if t - 900_000 <= ts <= t]
        if pre5 and s.entry_px:
            peak = max(pre5)
            s.dd5m = pct(peak, s.entry_px)
        if pre15 and s.entry_px:
            peak = max(pre15)
            s.dd15m = pct(peak, s.entry_px)
        if s.close_ts and s.entry_px:
            during = [px for ts, px in path if s.open_ts <= ts <= s.close_ts]
            if during:
                mfe = max(pct(s.entry_px, px) or -999 for px in during)
                mae = min(pct(s.entry_px, px) or 999 for px in during)
                s.mfe_pct = mfe if mfe > -900 else None
                s.mae_pct = mae if mae < 900 else None
                peak = max(during)
                if s.exit_px and peak > 0:
                    s.giveback_from_peak_pct = pct(peak, s.exit_px)


def summarize_dist(xs: list[float], name: str) -> dict:
    if not xs:
        return {"name": name, "n": 0}
    xs = sorted(xs)
    n = len(xs)
    return {
        "name": name,
        "n": n,
        "p10": xs[int(0.1 * (n - 1))],
        "p25": xs[int(0.25 * (n - 1))],
        "p50": xs[n // 2],
        "p75": xs[int(0.75 * (n - 1))],
        "p90": xs[int(0.9 * (n - 1))],
        "mean": sum(xs) / n,
    }


def fit_band(values: list[float], cover: float = 0.70) -> tuple[float, float] | None:
    """Narrowest band covering `cover` fraction of values."""
    if len(values) < 10:
        return None
    xs = sorted(values)
    n = len(xs)
    need = max(1, int(math.ceil(cover * n)))
    best = None
    for i in range(0, n - need + 1):
        lo, hi = xs[i], xs[i + need - 1]
        width = hi - lo
        if best is None or width < best[0]:
            best = (width, lo, hi)
    assert best
    return best[1], best[2]


def coverage(values: list[float], lo: float, hi: float) -> float:
    if not values:
        return 0.0
    return sum(1 for v in values if lo <= v <= hi) / len(values)


def entry_hypotheses(train: list[DipSession], test: list[DipSession]) -> list[dict]:
    """Search dump-depth / structure rules; score = test coverage of his dip buys + tightness."""
    results = []

    def vals(sess: list[DipSession], key: str) -> list[float]:
        out = []
        for s in sess:
            v = getattr(s, key)
            if v is None:
                continue
            out.append(float(v))
        return out

    # 1) dump_pc5m (= -pc5m) single threshold bands
    for cover in (0.5, 0.6, 0.7, 0.8):
        tr = vals(train, "dump_pc5m")
        band = fit_band(tr, cover)
        if not band:
            continue
        lo, hi = band
        results.append(
            {
                "family": "dump_pc5m_band",
                "rule": f"{lo:.2f} <= dump_pc5m <= {hi:.2f}",
                "fit_cover": cover,
                "train_cov": coverage(tr, lo, hi),
                "test_cov": coverage(vals(test, "dump_pc5m"), lo, hi),
                "width": hi - lo,
                "lo": lo,
                "hi": hi,
                "n_train": len(tr),
                "n_test": len(vals(test, "dump_pc5m")),
            }
        )

    # 2) fixed round thresholds people encode: dump >= X and dump <= Y
    dump_tr = vals(train, "dump_pc5m")
    dump_te = vals(test, "dump_pc5m")
    for lo in (3, 5, 6, 8, 10, 12, 15):
        for hi in (8, 10, 12, 15, 18, 20, 25, 30, 40):
            if hi <= lo:
                continue
            results.append(
                {
                    "family": "dump_pc5m_grid",
                    "rule": f"{lo} <= dump_pc5m <= {hi}",
                    "train_cov": coverage(dump_tr, lo, hi),
                    "test_cov": coverage(dump_te, lo, hi),
                    "width": hi - lo,
                    "lo": float(lo),
                    "hi": float(hi),
                    "n_train": len(dump_tr),
                    "n_test": len(dump_te),
                }
            )

    # 3) dd5m from snapshots (more causal dump depth)
    dd_tr = vals(train, "dd5m")
    dd_te = vals(test, "dd5m")
    if len(dd_tr) >= 15:
        for cover in (0.6, 0.7, 0.8):
            # dd is negative; band on magnitude
            mags = [-x for x in dd_tr]
            band = fit_band(mags, cover)
            if not band:
                continue
            lo_m, hi_m = band
            # rule: -hi_m <= dd5m <= -lo_m
            lo, hi = -hi_m, -lo_m
            results.append(
                {
                    "family": "dd5m_band",
                    "rule": f"{lo:.2f} <= dd5m <= {hi:.2f}",
                    "fit_cover": cover,
                    "train_cov": coverage(dd_tr, lo, hi),
                    "test_cov": coverage(dd_te, lo, hi),
                    "width": hi - lo,
                    "lo": lo,
                    "hi": hi,
                    "n_train": len(dd_tr),
                    "n_test": len(dd_te),
                }
            )

    # 4) combo: dump band + turnover floor
    for turn_min in (0.05, 0.09, 0.14, 0.2):
        for lo, hi in ((5, 15), (8, 20), (5, 12), (8, 15), (10, 25)):
            def ok(s: DipSession, lo=lo, hi=hi, turn_min=turn_min) -> bool:
                if s.dump_pc5m is None or s.turn is None:
                    return False
                return lo <= s.dump_pc5m <= hi and s.turn >= turn_min

            tr_n = sum(1 for s in train if s.dump_pc5m is not None and s.turn is not None)
            te_n = sum(1 for s in test if s.dump_pc5m is not None and s.turn is not None)
            if tr_n < 10:
                continue
            results.append(
                {
                    "family": "dump+turnover",
                    "rule": f"{lo}<=dump_pc5m<={hi} & turn>={turn_min}",
                    "train_cov": sum(1 for s in train if ok(s)) / tr_n,
                    "test_cov": sum(1 for s in test if ok(s)) / te_n if te_n else 0,
                    "width": hi - lo,
                    "lo": float(lo),
                    "hi": float(hi),
                    "turn_min": turn_min,
                    "n_train": tr_n,
                    "n_test": te_n,
                }
            )

    # 5) slip-aware: dump mid, allow fill worse by slip
    slips = [s.fill_vs_dex_slip_pct for s in train if s.fill_vs_dex_slip_pct is not None]
    slip_med = st.median(slips) if slips else 0.0
    for lo, hi in ((5, 15), (8, 18), (6, 12), (10, 20)):
        # effective: dump_pc5m in band (dex), slip separately reported
        results.append(
            {
                "family": "dump_with_slip_context",
                "rule": f"{lo}<=dump_pc5m<={hi}; train_med_slip={slip_med:.2f}%",
                "train_cov": coverage(dump_tr, lo, hi),
                "test_cov": coverage(dump_te, lo, hi),
                "width": hi - lo,
                "med_slip_train": slip_med,
                "lo": float(lo),
                "hi": float(hi),
                "n_train": len(dump_tr),
                "n_test": len(dump_te),
            }
        )

    # rank: high test coverage, then narrower width, prefer stable train≈test
    def score(r: dict) -> tuple:
        gap = abs(r["train_cov"] - r["test_cov"])
        return (-r["test_cov"], gap, r.get("width") or 999)

    results.sort(key=score)
    return results


def exit_hypotheses(train: list[DipSession], test: list[DipSession]) -> list[dict]:
    """Only closed dip sessions with pnl/held."""
    tr = [s for s in train if s.pnl_pct is not None and s.held_sec is not None]
    te = [s for s in test if s.pnl_pct is not None and s.held_sec is not None]
    results = []
    if len(tr) < 15:
        return [{"family": "exit", "error": "too_few_closed", "n": len(tr)}]

    # A) take-profit at impulse >= X (does his exit pnl cluster above X?)
    # Measure: fraction of exits with pnl >= X (he sold in profit band)
    for x in (2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50):
        results.append(
            {
                "family": "exit_tp_impulse",
                "rule": f"sell when impulse>=+{x}% (desccribes his exits)",
                "train_cov": sum(1 for s in tr if s.pnl_pct is not None and s.pnl_pct >= x) / len(tr),
                "test_cov": sum(1 for s in te if s.pnl_pct is not None and s.pnl_pct >= x) / len(te) if te else 0,
                "n_train": len(tr),
                "n_test": len(te),
                "x": x,
            }
        )

    # B) time stop: held <= T
    for t_m in (5, 10, 15, 20, 30, 45, 60):
        t = t_m * 60
        results.append(
            {
                "family": "exit_time",
                "rule": f"flat by {t_m}m",
                "train_cov": sum(1 for s in tr if (s.held_sec or 0) <= t) / len(tr),
                "test_cov": sum(1 for s in te if (s.held_sec or 0) <= t) / len(te) if te else 0,
                "n_train": len(tr),
                "n_test": len(te),
                "t_m": t_m,
            }
        )

    # C) OR: tp OR time (classic scalp)
    for x in (5, 8, 10, 15, 20):
        for t_m in (10, 15, 20, 30, 45):
            t = t_m * 60

            def hit(s: DipSession, x=x, t=t) -> bool:
                return (s.pnl_pct is not None and s.pnl_pct >= x) or ((s.held_sec or 0) <= t)

            # This over-covers; better: among winners, TP; among losers, time
            results.append(
                {
                    "family": "exit_tp_or_time",
                    "rule": f"impulse>=+{x}% OR hold<={t_m}m",
                    "train_cov": sum(1 for s in tr if hit(s)) / len(tr),
                    "test_cov": sum(1 for s in te if hit(s)) / len(te) if te else 0,
                    "n_train": len(tr),
                    "n_test": len(te),
                }
            )

    # D) split winners/losers — different rules
    tr_w = [s for s in tr if (s.pnl_pct or 0) > 0]
    tr_l = [s for s in tr if (s.pnl_pct or 0) <= 0]
    te_w = [s for s in te if (s.pnl_pct or 0) > 0]
    te_l = [s for s in te if (s.pnl_pct or 0) <= 0]
    if tr_w:
        band = fit_band([s.pnl_pct for s in tr_w if s.pnl_pct is not None], 0.7)
        if band:
            lo, hi = band
            results.append(
                {
                    "family": "exit_winner_impulse_band",
                    "rule": f"winners: {lo:.1f}% <= impulse <= {hi:.1f}%",
                    "train_cov": coverage([s.pnl_pct for s in tr_w if s.pnl_pct is not None], lo, hi),
                    "test_cov": coverage([s.pnl_pct for s in te_w if s.pnl_pct is not None], lo, hi) if te_w else 0,
                    "n_train": len(tr_w),
                    "n_test": len(te_w),
                    "lo": lo,
                    "hi": hi,
                }
            )
    if tr_l:
        # loser exit: how deep when he cuts
        band = fit_band([s.pnl_pct for s in tr_l if s.pnl_pct is not None], 0.7)
        if band:
            lo, hi = band
            results.append(
                {
                    "family": "exit_loser_impulse_band",
                    "rule": f"losers: {lo:.1f}% <= impulse <= {hi:.1f}%",
                    "train_cov": coverage([s.pnl_pct for s in tr_l if s.pnl_pct is not None], lo, hi),
                    "test_cov": coverage([s.pnl_pct for s in te_l if s.pnl_pct is not None], lo, hi) if te_l else 0,
                    "n_train": len(tr_l),
                    "n_test": len(te_l),
                    "lo": lo,
                    "hi": hi,
                }
            )
        hold_band = fit_band([s.held_sec / 60 for s in tr_l if s.held_sec], 0.7)
        if hold_band:
            lo, hi = hold_band
            results.append(
                {
                    "family": "exit_loser_hold_band_m",
                    "rule": f"losers hold minutes [{lo:.1f},{hi:.1f}]",
                    "train_cov": coverage([s.held_sec / 60 for s in tr_l if s.held_sec], lo, hi),
                    "test_cov": coverage([s.held_sec / 60 for s in te_l if s.held_sec], lo, hi) if te_l else 0,
                    "n_train": len(tr_l),
                    "n_test": len(te_l),
                }
            )

    # E) giveback from peak if enriched
    tr_g = [s for s in tr if s.giveback_from_peak_pct is not None and s.mfe_pct is not None]
    te_g = [s for s in te if s.giveback_from_peak_pct is not None and s.mfe_pct is not None]
    if len(tr_g) >= 12:
        for arm in (5, 8, 10, 12, 15, 20):
            for gb in (3, 4, 5, 6, 8, 10):
                def hit(s: DipSession, arm=arm, gb=gb) -> bool:
                    # sold after armed and giveback ~ gb (exit within band of -gb from peak)
                    if s.mfe_pct is None or s.giveback_from_peak_pct is None:
                        return False
                    if s.mfe_pct < arm:
                        return False
                    # giveback_from_peak is negative when exit < peak
                    return -gb - 2 <= (s.giveback_from_peak_pct or 0) <= -gb + 2

                results.append(
                    {
                        "family": "exit_arm_giveback",
                        "rule": f"arm>+{arm}% then giveback~{gb}%",
                        "train_cov": sum(1 for s in tr_g if hit(s)) / len(tr_g),
                        "test_cov": sum(1 for s in te_g if hit(s)) / len(te_g) if te_g else 0,
                        "n_train": len(tr_g),
                        "n_test": len(te_g),
                        "arm": arm,
                        "gb": gb,
                    }
                )

    results.sort(key=lambda r: (-(r.get("test_cov") or 0), abs((r.get("train_cov") or 0) - (r.get("test_cov") or 0))))
    return results


def main() -> None:
    load_env()
    buys, opens, flats = load_observer()
    print(f"8zkg buys={len(buys)} opens={len(opens)} flats={len(flats)}")
    sessions_all = build_sessions(buys, flats, new_bag_only=False)
    sessions_new = build_sessions(buys, flats, new_bag_only=True)
    print(f"DIP buys all (pc5m<0): {len(sessions_all)} | new_bag_only: {len(sessions_new)}")
    # Primary: all dip buys (opens+adds on dump)
    sessions = sessions_all
    closed = [s for s in sessions if s.pnl_pct is not None]
    print(f"closed dip (matched flat): {len(closed)}")
    print(f"new_bag closed: {sum(1 for s in sessions_new if s.pnl_pct is not None)}")

    enrich_snapshots(sessions)
    enrich_snapshots(sessions_new)
    dd_n = sum(1 for s in sessions if s.dd5m is not None)
    print(f"with dd5m from PG: {dd_n}")

    # distributions
    dists = [
        summarize_dist([s.dump_pc5m for s in sessions if s.dump_pc5m is not None], "dump_pc5m"),
        summarize_dist([s.dd5m for s in sessions if s.dd5m is not None], "dd5m"),
        summarize_dist([s.dd15m for s in sessions if s.dd15m is not None], "dd15m"),
        summarize_dist(
            [s.fill_vs_dex_slip_pct for s in sessions if s.fill_vs_dex_slip_pct is not None],
            "fill_vs_dex_slip_pct",
        ),
        summarize_dist([s.turn for s in sessions if s.turn is not None], "turn5m"),
        summarize_dist([s.pnl_pct for s in closed if s.pnl_pct is not None], "exit_impulse_pct"),
        summarize_dist([s.held_sec / 60 for s in closed if s.held_sec], "held_min"),
        summarize_dist([s.mfe_pct for s in closed if s.mfe_pct is not None], "mfe_pct"),
        summarize_dist(
            [s.giveback_from_peak_pct for s in closed if s.giveback_from_peak_pct is not None],
            "giveback_from_peak_pct",
        ),
    ]
    print("\n=== DISTRIBUTIONS (dip-only) ===")
    for d in dists:
        if d["n"] == 0:
            print(f"{d['name']}: n=0")
            continue
        print(
            f"{d['name']}: n={d['n']} p10={d['p10']:.2f} p25={d['p25']:.2f} "
            f"p50={d['p50']:.2f} p75={d['p75']:.2f} p90={d['p90']:.2f} mean={d['mean']:.2f}"
        )

    # time-ordered split
    sessions_sorted = sorted(sessions, key=lambda s: s.open_ts)
    mid = len(sessions_sorted) // 2
    train, test = sessions_sorted[:mid], sessions_sorted[mid:]
    print(f"\nsplit train={len(train)} test={len(test)}")

    entry = entry_hypotheses(train, test)
    print("\n=== TOP ENTRY HYPOTHESES (by test coverage, then stability) ===")
    # filter junk: test_cov >= 0.55 and train-test gap < 0.15
    good_e = [
        r
        for r in entry
        if (r.get("test_cov") or 0) >= 0.55 and abs((r.get("train_cov") or 0) - (r.get("test_cov") or 0)) <= 0.2
    ]
    show = good_e[:25] if good_e else entry[:25]
    for r in show:
        print(
            f"{r['family']:22s} test={r.get('test_cov',0)*100:5.1f}% train={r.get('train_cov',0)*100:5.1f}% "
            f"w={r.get('width')} | {r['rule']}"
        )

    # convergence check: top dump grid where test>=70% and width minimal
    grid = [r for r in entry if r["family"] == "dump_pc5m_grid" and r["test_cov"] >= 0.7]
    grid.sort(key=lambda r: (r["width"], -r["test_cov"], abs(r["train_cov"] - r["test_cov"])))
    print("\n=== CONVERGED ENTRY (dump_pc5m grid, test_cov>=70%, narrowest) ===")
    for r in grid[:10]:
        print(
            f"  [{r['lo']:.0f},{r['hi']:.0f}] test={r['test_cov']*100:.1f}% train={r['train_cov']*100:.1f}% width={r['width']}"
        )

    exit_h = exit_hypotheses(train, test)
    print("\n=== TOP EXIT HYPOTHESES ===")
    for r in exit_h[:30]:
        if "error" in r:
            print(r)
            continue
        print(
            f"{r['family']:26s} test={r.get('test_cov',0)*100:5.1f}% train={r.get('train_cov',0)*100:5.1f}% | {r['rule']}"
        )

    # Winner/loser medians (concrete)
    w = [s for s in closed if (s.pnl_pct or 0) > 0]
    l = [s for s in closed if (s.pnl_pct or 0) <= 0]
    print("\n=== EXIT split ===")
    print(f"winners n={len(w)} med_impulse={st.median([s.pnl_pct for s in w]) if w else None} "
          f"med_hold_m={st.median([s.held_sec/60 for s in w if s.held_sec]) if w else None}")
    print(f"losers  n={len(l)} med_impulse={st.median([s.pnl_pct for s in l]) if l else None} "
          f"med_hold_m={st.median([s.held_sec/60 for s in l if s.held_sec]) if l else None}")

    # Slippage on dip entries
    slips = [s.fill_vs_dex_slip_pct for s in sessions if s.fill_vs_dex_slip_pct is not None]
    print(f"\nSLIP fill vs dex mid: n={len(slips)} med={st.median(slips) if slips else None}")

    payload = {
        "leader": LEADER,
        "n_dip_sessions": len(sessions),
        "n_closed": len(closed),
        "distributions": dists,
        "entry_top": show,
        "entry_converged_grid": grid[:15],
        "exit_top": exit_h[:40],
        "winners": {
            "n": len(w),
            "med_impulse": st.median([s.pnl_pct for s in w]) if w else None,
            "med_hold_m": st.median([s.held_sec / 60 for s in w if s.held_sec]) if w else None,
        },
        "losers": {
            "n": len(l),
            "med_impulse": st.median([s.pnl_pct for s in l]) if l else None,
            "med_hold_m": st.median([s.held_sec / 60 for s in l if s.held_sec]) if l else None,
        },
        "slip_med": st.median(slips) if slips else None,
        "sessions_sample": [asdict(s) for s in sessions_sorted[:5] + sessions_sorted[-5:]],
    }
    out = OUT_DIR / "8zkg-dip-reverse.json"
    out.write_text(json.dumps(payload, indent=2, default=str))
    print("\nWrote", out)


if __name__ == "__main__":
    main()
