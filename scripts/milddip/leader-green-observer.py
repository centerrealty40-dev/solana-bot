#!/usr/bin/env python3
"""
Green-entry universe sampler for the leader wallets.

Why a second observer instead of more fields on the first one
------------------------------------------------------------
`leader-observer` is a position tracker: it sees a mint only *after* a leader
bought it, and its dense ticks only cover bags already held. That is enough to
describe what leaders bought and useless for learning what they *chose*, which is
where the previous green analysis stalled — `leader-green-entry-formula.md` reaches
≥80% recall on both wallets but tops out at ~28% precision, because every row in
its corpus is a positive. Without matched negatives nothing can separate "green
coin a leader took" from "green coin a leader ignored", and green is ~32% of their
buys.

So this process samples a *universe* on a fixed cadence and records every
candidate whether or not a leader touches it. Labels are deliberately not written
here: `leader-observer` already logs `leader_buy_observed` with `blockTime`, so a
positive is an offline join (mint sampled at T, leader bought within +N minutes)
and every other mint in the same cycle is a negative at the same timestamp.

Where the data comes from, and why not all from DexScreener
-----------------------------------------------------------
DexScreener is saturated. Measured on this host: a single-mint probe returns HTTP
429 three times in a row while the bot's own gate paces itself to a healthy 10
marks/min per position. The bot's mark cadence is what the exit trail runs on
(1.11.827), so a third heavy consumer there is not available.

Split by how fast each field actually moves:

- **Price — Jupiter price v3.** Separate quota, 40 ids per request, measured at
  40 prices in 0.09s with no key and no throttling. Price is the whole point of a
  green-candle signal, so it gets the high cadence and yields the fine-grained
  tape the old spec wanted.
- **Structure — DexScreener, rationed.** Liquidity, market cap, pair age and 5m
  volume move slowly, so each mint is refreshed at most once per `STRUCT_TTL_SEC`
  under a hard ceiling of `MAX_DEX_REQ_PER_MIN` (default 2 of the bot's ~120).
  Discovery lists are pulled on their own slow timer for the same reason.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent


def _load_observer_helpers() -> Any:
    """Reuse the batch fetch, rate limiter and snapshot shape from the tracker."""
    path = Path(os.environ.get("LEADER_GREEN_OBSERVER_LIB", str(_HERE / "leader-observer.py")))
    spec = importlib.util.spec_from_file_location("_leader_observer_helpers", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


OBS = _load_observer_helpers()

BOOSTS_URL = "https://api.dexscreener.com/token-boosts/top/v1"
PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1"
JUPITER_URL = "https://api.jup.ag/price/v3"
JUPITER_BATCH = 40
# Free tier is 1 RPS, so batches are paced rather than fired as a burst.
_jup_min_gap_ms = 1100.0
_jup_last_call_ms = 0.0


def env_num(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def fetch_discovery(url: str) -> list[str]:
    """Solana mints from a DexScreener discovery list. Never raises."""
    try:
        req = urllib.request.Request(
            url,
            headers={
                "user-agent": "Mozilla/5.0 mild-dip-leader-green-observer",
                "accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
    except Exception:
        return []
    rows = data if isinstance(data, list) else (data.get("data") or [])
    out: list[str] = []
    for row in rows:
        if not isinstance(row, dict) or row.get("chainId") != "solana":
            continue
        mint = (row.get("tokenAddress") or "").strip()
        if mint:
            out.append(mint)
    return out


def fetch_jupiter_prices(mints: list[str]) -> dict[str, float]:
    """
    Batch price v3. Returns mint -> usdPrice for hits only. Never raises.

    Paced to ~1 request/sec: without a key `api.jup.ag` is free tier at 1 RPS, and
    a 400-mint universe is 10 batches, which as a burst would be 10x over.
    """
    out: dict[str, float] = {}
    key = (os.environ.get("JUPITER_API_KEY") or "").strip()
    headers = {"accept": "application/json", "user-agent": "mild-dip-leader-green-observer"}
    if key:
        headers["x-api-key"] = key
    global _jup_last_call_ms
    ids = [m for m in mints if m and len(m) >= 32]
    for i in range(0, len(ids), JUPITER_BATCH):
        chunk = ids[i : i + JUPITER_BATCH]
        gap = _jup_min_gap_ms - (time.time() * 1000 - _jup_last_call_ms)
        if gap > 0:
            time.sleep(min(gap, _jup_min_gap_ms) / 1000.0)
        _jup_last_call_ms = time.time() * 1000
        try:
            req = urllib.request.Request(
                f"{JUPITER_URL}?ids={','.join(chunk)}", headers=headers
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                j = json.loads(r.read().decode())
        except Exception:
            continue
        data = j.get("data") if isinstance(j, dict) and isinstance(j.get("data"), dict) else j
        if not isinstance(data, dict):
            continue
        for mint, row in data.items():
            px = None
            if isinstance(row, dict):
                px = row.get("usdPrice") if row.get("usdPrice") is not None else row.get("price")
            elif isinstance(row, (int, float)):
                px = row
            try:
                pxf = float(px)
            except (TypeError, ValueError):
                continue
            if pxf > 0:
                out[mint] = pxf
    return out


def seed_mints(path: Path, max_age_ms: float) -> list[str]:
    """Mints the leaders touched recently — guarantees positives get sampled."""
    try:
        data = json.loads(path.read_text())
    except Exception:
        return []
    now_ms = time.time() * 1000
    out: list[str] = []
    for hit in data.get("hits") or []:
        if not isinstance(hit, dict):
            continue
        mint = (hit.get("mint") or "").strip()
        if not mint:
            continue
        seen = hit.get("lastSeenAtMs")
        if max_age_ms > 0 and isinstance(seen, (int, float)) and now_ms - float(seen) > max_age_ms:
            continue
        out.append(mint)
    return out


def ret_pct(tape: list[tuple[int, float]], now_ms: int, window_ms: int) -> float | None:
    """Return over `window_ms` from the oldest sample still inside the window."""
    ref = None
    for ts, px in tape:
        if now_ms - ts <= window_ms:
            ref = px
            break
    if ref is None or ref <= 0 or not tape:
        return None
    last = tape[-1][1]
    return (last / ref - 1) * 100


class GreenObserver:
    def __init__(self) -> None:
        self.out_dir = Path(os.environ.get("LEADER_GREEN_OUT_DIR", "data/milddip"))
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.seed_path = Path(
            os.environ.get("LEADER_GREEN_SEED_PATH", str(self.out_dir / "leader-seed.json"))
        )
        self.sample_sec = max(5, int(env_num("LEADER_GREEN_SAMPLE_SEC", 20)))
        self.max_universe = max(30, int(env_num("LEADER_GREEN_MAX_UNIVERSE", 320)))
        self.seed_max_age_ms = env_num("LEADER_GREEN_SEED_MAX_AGE_MS", 6 * 3_600_000)
        self.max_hours = env_num("LEADER_GREEN_MAX_HOURS", 0.0)
        self.stats_sec = max(30, int(env_num("LEADER_GREEN_STATS_SEC", 300)))
        self.tape_keep_ms = env_num("LEADER_GREEN_TAPE_KEEP_MS", 900_000)

        # DexScreener rationing — the bot's marks must not notice this process.
        self.max_dex_req_per_min = max(1, int(env_num("LEADER_GREEN_MAX_DEX_REQ_PER_MIN", 3)))
        self.struct_ttl_sec = max(60, int(env_num("LEADER_GREEN_STRUCT_TTL_SEC", 600)))
        self.discovery_every_sec = max(60, int(env_num("LEADER_GREEN_DISCOVERY_SEC", 300)))
        self.discovery_retry_sec = max(20, int(env_num("LEADER_GREEN_DISCOVERY_RETRY_SEC", 45)))

        # Record the boundary too: a formula needs to know where leaders stop.
        self.min_pc5m = env_num("LEADER_GREEN_MIN_PC5M", -2.0)

        self.path = self._path_for_today()
        self.dex_stamps: list[float] = []
        self.struct: dict[str, tuple[float, dict[str, Any]]] = {}
        self.tape: dict[str, list[tuple[int, float]]] = {}
        self.discovered: list[str] = []
        self.last_discovery = 0.0
        self.discovery_calls = 0
        self.discovery_fails = 0
        self.cycles = 0
        self.rows = 0
        self.started = time.time()
        self.last_stats = 0.0
        self.last_cycle: dict[str, Any] = {}

    def _path_for_today(self) -> Path:
        return self.out_dir / f"leader-green-{time.strftime('%Y%m%d', time.gmtime())}.jsonl"

    def emit(self, payload: dict[str, Any]) -> None:
        today = self._path_for_today()
        if today != self.path:
            self.path = today
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def dex_budget(self, want: int) -> bool:
        now = time.time()
        self.dex_stamps = [t for t in self.dex_stamps if now - t < 60]
        return len(self.dex_stamps) + want <= self.max_dex_req_per_min

    def note_dex(self, n: int) -> None:
        self.dex_stamps.extend([time.time()] * max(0, n))

    def refresh_discovery(self) -> None:
        """Trending pool on a slow timer — two DexScreener calls, not per cycle."""
        if time.time() - self.last_discovery < self.discovery_every_sec:
            return
        # Not charged against the structure budget: two calls per
        # `discovery_every_sec` is 0.4 req/min at the default, already negligible,
        # and charging it here starved structure entirely (measured: structKnown 0).
        self.discovery_calls += 2
        found: list[str] = []
        for url in (BOOSTS_URL, PROFILES_URL):
            found.extend(fetch_discovery(url))
        if not found:
            # DexScreener throttles even these two calls when the bot is busy, and
            # `fetch_discovery` swallows that. Retry soon instead of burning the
            # full timer on a failure, or the universe stays seed-only.
            self.discovery_fails += 1
            self.last_discovery = time.time() - self.discovery_every_sec + self.discovery_retry_sec
            return
        seen = set()
        merged = []
        for mint in found + self.discovered:
            if mint not in seen:
                seen.add(mint)
                merged.append(mint)
        self.discovered = merged[: self.max_universe * 2]
        self.last_discovery = time.time()

    def universe(self) -> tuple[list[str], dict[str, str]]:
        origin: dict[str, str] = {}
        out: list[str] = []
        for mint in seed_mints(self.seed_path, self.seed_max_age_ms):
            if mint not in origin:
                origin[mint] = "leader_seed"
                out.append(mint)
        for mint in self.discovered:
            if mint not in origin:
                origin[mint] = "discovery"
                out.append(mint)
        return out[: self.max_universe], origin

    def refresh_structure(self, mints: list[str]) -> int:
        """One rationed DexScreener batch for whichever mints went stale."""
        now = time.time()
        stale = [
            m
            for m in mints
            if m not in self.struct or now - self.struct[m][0] > self.struct_ttl_sec
        ]
        if not stale or not self.dex_budget(1):
            return 0
        self.note_dex(1)
        chunk = stale[:30]
        snaps = OBS.fetch_dex_batch(chunk)
        got = 0
        for mint, snap in snaps.items():
            if isinstance(snap, dict) and not snap.get("error"):
                self.struct[mint] = (now, snap)
                got += 1
        return got

    def cycle(self) -> None:
        self.refresh_discovery()
        mints, origin = self.universe()
        if not mints:
            return
        struct_got = self.refresh_structure(mints)

        prices = fetch_jupiter_prices(mints)
        ts_ms = int(time.time() * 1000)
        cutoff = ts_ms - int(self.tape_keep_ms)
        emitted = 0
        drop = {"no_price": 0, "no_struct": 0, "below_min_pc5m": 0}

        for mint in mints:
            px = prices.get(mint)
            if not px:
                drop["no_price"] += 1
                continue
            tape = self.tape.setdefault(mint, [])
            tape.append((ts_ms, px))
            while tape and tape[0][0] < cutoff:
                tape.pop(0)

            st = self.struct.get(mint)
            if not st:
                drop["no_struct"] += 1
                continue
            snap = st[1]
            pc5m = snap.get("pc5m")
            try:
                pc5m_f = float(pc5m) if pc5m is not None else None
            except (TypeError, ValueError):
                pc5m_f = None
            if pc5m_f is not None and pc5m_f < self.min_pc5m:
                drop["below_min_pc5m"] += 1
                continue

            row: dict[str, Any] = {
                "kind": "leader_green_sample",
                "mint": mint,
                "origin": origin.get(mint),
                "tsMs": ts_ms,
                "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts_ms / 1000)),
                "priceUsd": px,
                "priceSource": "jupiter",
                "tapeLen": len(tape),
                # Fine-grained momentum from our own cadence — this is the part the
                # old single-snapshot corpus could not provide.
                "ret30s": ret_pct(tape, ts_ms, 30_000),
                "ret1m": ret_pct(tape, ts_ms, 60_000),
                "ret3m": ret_pct(tape, ts_ms, 180_000),
                "ret5m": ret_pct(tape, ts_ms, 300_000),
                "structAgeSec": int(time.time() - st[0]),
            }
            for k in (
                "dexId",
                "pairAddress",
                "pc5m",
                "pc1h",
                "vol5m",
                "vol1h",
                "liq",
                "mcap",
                "buys5m",
                "sells5m",
                "ageHours",
                "turnover5mLiq",
            ):
                row[k] = snap.get(k)
            b5, s5 = snap.get("buys5m"), snap.get("sells5m")
            if isinstance(b5, (int, float)) and isinstance(s5, (int, float)) and (b5 + s5) > 0:
                row["buyShare5m"] = float(b5) / (float(b5) + float(s5))
            self.emit(row)
            emitted += 1

        if len(self.tape) > self.max_universe * 4:
            self.tape = {m: t for m, t in self.tape.items() if t and t[-1][0] >= cutoff}
        if len(self.struct) > self.max_universe * 4:
            now = time.time()
            self.struct = {
                m: v for m, v in self.struct.items() if now - v[0] <= self.struct_ttl_sec * 3
            }

        self.cycles += 1
        self.rows += emitted
        self.last_cycle = {
            "universe": len(mints),
            "priced": len(prices),
            "structRefreshed": struct_got,
            "structKnown": len(self.struct),
            "emitted": emitted,
            **drop,
        }

    def maybe_stats(self) -> None:
        now = time.time()
        if now - self.last_stats < self.stats_sec:
            return
        self.last_stats = now
        self.emit(
            {
                "kind": "leader_green_stats",
                "cycles": self.cycles,
                "rows": self.rows,
                "dexStructReqLastMin": len(self.dex_stamps),
                "dexDiscoveryCalls": self.discovery_calls,
                "dexDiscoveryFails": self.discovery_fails,
                "discoveredMints": len(self.discovered),
                "maxDexReqPerMin": self.max_dex_req_per_min,
                "tapedMints": len(self.tape),
                "upSec": int(now - self.started),
                "lastCycle": self.last_cycle,
                "tsMs": int(now * 1000),
            }
        )

    def run(self) -> None:
        self.emit(
            {
                "kind": "leader_green_start",
                "outPath": str(self.path),
                "sampleSec": self.sample_sec,
                "maxUniverse": self.max_universe,
                "maxDexReqPerMin": self.max_dex_req_per_min,
                "structTtlSec": self.struct_ttl_sec,
                "discoverySec": self.discovery_every_sec,
                "minPc5m": self.min_pc5m,
                "tsMs": int(time.time() * 1000),
            }
        )
        print(
            f"[leader-green] price tape via Jupiter every {self.sample_sec}s, "
            f"universe ≤{self.max_universe}, DexScreener ≤{self.max_dex_req_per_min} req/min",
            flush=True,
        )
        deadline = self.started + self.max_hours * 3600 if self.max_hours > 0 else None
        while True:
            if deadline and time.time() >= deadline:
                break
            try:
                self.cycle()
                self.maybe_stats()
            except Exception as exc:  # never let one bad cycle kill the sampler
                self.emit(
                    {
                        "kind": "leader_green_error",
                        "error": str(exc)[:300],
                        "tsMs": int(time.time() * 1000),
                    }
                )
            time.sleep(self.sample_sec)
        print("[leader-green] done", flush=True)


if __name__ == "__main__":
    GreenObserver().run()
