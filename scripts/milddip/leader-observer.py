#!/usr/bin/env python3
"""
Shadow logger for mild-dip leader wallets.

Polls leader signatures, detects token buys AND sells, derives fill size from
quote-leg deltas, snapshots DexScreener, classifies the 5m tape, records whether
current mild-dip gates would have taken the name, and maintains a per-leader
bag ledger for session open/flat events. Does not trade.

Dense exit tape (1.11.790): while bags are open, emits `leader_bag_tick` every
~1s with Jupiter mark price + cached Dex tape features and precomputed
exit-formula fields (mfe/mae/giveback/bounce/armed proxies/DUR counters) so
overnight RE can recover per-wallet exit rules without 65s mark sparsity.

Env:
  LEADER_OBSERVER_RPC_URL   — required unless mild-dip-bot pm2 env is readable
  LEADER_OBSERVER_LEADERS   — comma wallets (default: 8zkg + 7BNax)
  LEADER_OBSERVER_OUT_DIR   — default data/milddip
  LEADER_OBSERVER_POLL_SEC  — signature poll interval (default 5; floor 1)
  LEADER_OBSERVER_LOOKBACK_SEC — ignore older sigs (default 1800)
  LEADER_OBSERVER_SIG_LIMIT — getSignaturesForAddress limit (default 80)
  LEADER_OBSERVER_MAX_HOURS — 0 = run forever (default 72)
  LEADER_OBSERVER_SEED_PATH — sidecar for mild-dip discover (default <out>/leader-seed.json)
  LEADER_OBSERVER_SEED_MAX  — max mints in sidecar (default 40)
  LEADER_OBSERVER_SEED_MAX_AGE_SEC — drop older seed hits (default 7200)
  LEADER_OBSERVER_LOG_SELLS — 1 (default) log leader_sell_observed
  LEADER_OBSERVER_LOG_MARKS — 1 (default) slow Dex bag marks while open
  LEADER_OBSERVER_MARK_MIN_GAP_SEC — min seconds between Dex marks (default 15; floor 1)
  LEADER_OBSERVER_DENSE_TICKS — 1 (default) emit 1Hz leader_bag_tick
  LEADER_OBSERVER_DENSE_GAP_SEC — dense tick cadence (default 1; floor 1)
  LEADER_OBSERVER_DEX_REFRESH_SEC — refresh Dex features on open bags (default 15)
  LEADER_OBSERVER_DENSE_ONLY_TD — 1 = dense ticks only for TD entry bags (default 0 = all open)
  LEADER_OBSERVER_PRICE_URL — Jupiter price v3 base (default https://api.jup.ag/price/v3)
  JUPITER_API_KEY — optional; forwarded as x-api-key for price v3
"""

from __future__ import annotations

import datetime as dt
import email.utils
import json
import math
import os
import subprocess
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

DEFAULT_LEADERS = [
    "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ",
    # 1.11.712 — correct pubkey (typo was 7BNaxx6KdUYrAC… without `j`)
    "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5",
]
WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
QUOTE_MINTS = {WSOL, USDC, USDT}
# mint -> (fetched_at, usd price), for valuing the far side of a swap.
COUNTER_PX_CACHE: dict[str, tuple[float, float]] = {}
COUNTER_PX_TTL_SEC = 300.0
# Backstop cap on remembered signatures; the real bound is age (see _save_state).
SEEN_SIGNATURE_CAP = 20_000
# Quote delta below this share of the DEX-implied notional = not the counterparty.
QUOTE_PLAUSIBLE_MIN_RATIO = 0.2

# Dust bag after sell → treat as flat.
FLAT_UI_EPS = 1e-6


def env_num(name: str, default: float) -> float:
    v = os.environ.get(name, "").strip()
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def utc_iso(ts: float | None = None) -> str:
    t = dt.datetime.utcfromtimestamp(ts if ts is not None else time.time())
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_rpc() -> str:
    direct = (
        os.environ.get("LEADER_OBSERVER_RPC_URL")
        or os.environ.get("MILD_DIP_RPC_URL")
        or os.environ.get("LIVE_RPC_HTTP_URL")
        or os.environ.get("SA_RPC_HTTP_URL")
        or ""
    ).strip()
    if direct:
        return direct
    try:
        apps = json.loads(subprocess.check_output(["pm2", "jlist"], text=True))
        app = next((a for a in apps if a.get("name") == "mild-dip-bot"), None)
        env = (app or {}).get("pm2_env") or {}
        for k in ("MILD_DIP_RPC_URL", "LIVE_RPC_HTTP_URL", "SA_RPC_HTTP_URL"):
            if env.get(k):
                return str(env[k])
    except Exception:
        pass
    raise SystemExit("leader-observer: no RPC URL (set LEADER_OBSERVER_RPC_URL)")


def rpc_call(rpc: str, method: str, params: list[Any]) -> Any:
    req = urllib.request.Request(
        rpc,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        j = json.loads(r.read().decode())
    if "error" in j:
        raise RuntimeError(j["error"])
    return j.get("result")


def ui_amt(b: dict[str, Any] | None) -> float:
    if not b:
        return 0.0
    v = (b.get("uiTokenAmount") or {}).get("uiAmount")
    return float(v or 0)


# 1.11.811 — the observer called DexScreener outside the trading bot's rate
# gate and starved it: 274 of 344 leader buys logged `HTTP 429`.
# 1.11.819 — the real waste was one HTTP call per mint. DexScreener accepts up
# to 30 comma-separated addresses per request, so a poll over 60 open bags is
# 2 calls, not 60. Add a short-lived per-mint cache on top (leaders add to the
# same names repeatedly).
_DEX_MIN_GAP_MS = env_num("LEADER_OBSERVER_DEX_MIN_GAP_MS", 400.0)
_DEX_BACKOFF_MS = env_num("LEADER_OBSERVER_DEX_BACKOFF_MS", 30_000.0)
_DEX_CACHE_MS = env_num("LEADER_OBSERVER_DEX_CACHE_MS", 20_000.0)
_DEX_BATCH_MAX = int(env_num("LEADER_OBSERVER_DEX_BATCH_MAX", 30.0))
_TELEMETRY_BATCH_MAX = 40
_dex_last_call_ms = 0.0
_dex_backoff_until_ms = 0.0
_dex_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def retry_after_ms(value: str | None, now_ms: float) -> float | None:
    """Parse Retry-After seconds or HTTP-date, rejecting stale/malformed values."""
    if not value:
        return None
    raw = value.strip()
    try:
        seconds = float(raw)
        if math.isfinite(seconds) and seconds > 0:
            return seconds * 1000.0
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(raw)
        if parsed is None:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        delay = parsed.timestamp() * 1000.0 - now_ms
        return delay if delay > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def next_dex_cooldown(
    now_ms: float,
    retry_after: str | None,
    consecutive_429: int,
    *,
    base_ms: float = 5000.0,
    max_ms: float = 120000.0,
) -> tuple[float, int]:
    """Return (cooldown end, incremented streak) using shared gate semantics."""
    streak = max(0, int(consecutive_429)) + 1
    parsed = retry_after_ms(retry_after, now_ms)
    raw_delay = parsed if parsed is not None else base_ms * (2 ** (streak - 1))
    ceiling = max(1000.0, float(max_ms))
    delay = min(ceiling, max(1000.0, raw_delay))
    return now_ms + delay, streak


def next_dex_slot_at(
    now_ms: float,
    next_allowed_ms: float,
    cooldown_until_ms: float = 0.0,
    *,
    min_gap_ms: float = 1000.0,
    max_backlog_ms: float = 30000.0,
) -> float:
    """Return the next shared-gate slot, honoring a bounded active cooldown."""
    del min_gap_ms  # The caller reserves the returned slot plus one gap.
    backlog = max(0.0, float(max_backlog_ms))
    if next_allowed_ms - now_ms > backlog:
        next_allowed_ms = now_ms
    cooldown = min(max(0.0, cooldown_until_ms), now_ms + 120000.0)
    return max(now_ms, next_allowed_ms, cooldown)


def _dex_gate_path() -> Path | None:
    enabled = os.environ.get("DEXSCREENER_GLOBAL_RATE_LIMIT", "1").strip()
    raw = os.environ.get("DEXSCREENER_GLOBAL_GATE_PATH", "").strip()
    return Path(raw) if enabled != "0" and raw else None


def _read_dex_gate(path: Path) -> dict[str, float | int]:
    state: dict[str, float | int] = {
        "nextAllowedMs": 0.0,
        "cooldownUntilMs": 0.0,
        "consecutive429": 0,
        "total429": 0,
        "last429AtMs": 0.0,
    }
    try:
        raw = json.loads(path.read_text())
        if isinstance(raw, dict):
            for key in state:
                value = raw.get(key)
                if isinstance(value, (int, float)) and math.isfinite(float(value)):
                    state[key] = value
    except (OSError, ValueError, TypeError):
        pass
    return state


def _write_dex_gate(path: Path, state: dict[str, float | int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{int(time.time() * 1000)}")
    tmp.write_text(json.dumps(state))
    os.replace(tmp, path)


@contextmanager
def _dex_gate_lock(path: Path):
    lock = Path(f"{path}.lock")
    deadline = time.time() + 15.0
    fd: int | None = None
    while time.time() < deadline:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            time.sleep(0.01)
    if fd is None:
        raise TimeoutError("DexScreener gate lock timeout")
    try:
        yield
    finally:
        os.close(fd)
        try:
            lock.unlink()
        except OSError:
            pass


def _acquire_shared_dex_slot(max_wait_ms: float | None = None) -> bool | None:
    path = _dex_gate_path()
    if path is None:
        return None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _dex_gate_lock(path):
            now_ms = time.time() * 1000.0
            state = _read_dex_gate(path)
            rpm = max(1.0, min(120.0, env_num("DEXSCREENER_GLOBAL_MAX_RPM", 42.0)))
            gap = 60_000.0 / rpm
            max_backlog = max(
                0.0,
                min(300_000.0, env_num("DEXSCREENER_GLOBAL_MAX_BACKLOG_MS", 30_000.0)),
            )
            grant = next_dex_slot_at(
                now_ms,
                float(state["nextAllowedMs"]),
                float(state["cooldownUntilMs"]),
                min_gap_ms=gap,
                max_backlog_ms=max_backlog,
            )
            state["nextAllowedMs"] = grant + gap
            _write_dex_gate(path, state)
        if grant > now_ms:
            wait_ms = grant - now_ms
            if max_wait_ms is not None and wait_ms > max(0.0, max_wait_ms):
                return False
            time.sleep(wait_ms / 1000.0)
        return True
    except (OSError, TimeoutError, ValueError, TypeError):
        return None


def _record_shared_dex_response(status: int, retry_after: str | None = None) -> None:
    path = _dex_gate_path()
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _dex_gate_lock(path):
            now_ms = time.time() * 1000.0
            state = _read_dex_gate(path)
            if status == 429:
                until, streak = next_dex_cooldown(
                    now_ms,
                    retry_after,
                    int(state["consecutive429"]),
                    base_ms=env_num("DEXSCREENER_429_BACKOFF_BASE_MS", 5000.0),
                    max_ms=env_num("DEXSCREENER_429_BACKOFF_MAX_MS", 120000.0),
                )
                state["cooldownUntilMs"] = until
                state["consecutive429"] = streak
                state["total429"] = int(state["total429"]) + 1
                state["last429AtMs"] = now_ms
            elif 200 <= status < 300:
                state["consecutive429"] = 0
                state["cooldownUntilMs"] = 0.0
            _write_dex_gate(path, state)
    except (OSError, TimeoutError, ValueError, TypeError):
        pass
# Keep in sync with src/core/constants.ts DEX_PROGRAMS and
# src/parser/allowlisted-dex-swap.ts (base58 IDs are case-sensitive).
_AGGREGATOR_PROGRAM_IDS = {
    "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
}
_CLOSED_ENTRY_MAX_AGE_SEC = 7 * 86_400
_CLOSED_ENTRY_CAP = 20_000


def _finite_number(value: Any, *, positive: bool = False) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or (positive and number <= 0):
        return None
    return number


def _pct_ratio(numerator: Any, denominator: Any) -> float | None:
    n = _finite_number(numerator)
    d = _finite_number(denominator, positive=True)
    if n is None or n < 0 or d is None:
        return None
    return n / d * 100.0


def _sum_positive(values: list[Any]) -> float | None:
    parsed = [_finite_number(v, positive=True) for v in values]
    known = [v for v in parsed if v is not None]
    return sum(known) if known else None


def _transaction_metadata(tx: dict[str, Any] | None) -> dict[str, Any]:
    """Extract already-fetched transaction metadata without affecting processing."""
    if not isinstance(tx, dict):
        return {
            "slot": None,
            "feeLamports": None,
            "computeUnitsConsumed": None,
            "topLevelProgramIds": None,
            "viaAggregator": None,
            "topLevelInstructionCount": None,
        }
    meta = tx.get("meta") if isinstance(tx.get("meta"), dict) else {}
    transaction = tx.get("transaction") if isinstance(tx.get("transaction"), dict) else {}
    message = transaction.get("message") if isinstance(transaction.get("message"), dict) else {}
    instructions = message.get("instructions")
    program_ids: list[str] = []
    if isinstance(instructions, list):
        for instruction in instructions:
            if not isinstance(instruction, dict):
                continue
            program_id = instruction.get("programId")
            if isinstance(program_id, str) and program_id and program_id not in program_ids:
                program_ids.append(program_id)
    aggregator = True if any(pid in _AGGREGATOR_PROGRAM_IDS for pid in program_ids) else None
    return {
        "slot": tx.get("slot") if isinstance(tx.get("slot"), (int, float)) else None,
        "feeLamports": _finite_number(meta.get("fee")),
        "computeUnitsConsumed": (
            _finite_number(meta.get("computeUnitsConsumed"))
            if meta.get("computeUnitsConsumed") is not None
            else None
        ),
        "topLevelProgramIds": program_ids or None,
        "viaAggregator": aggregator,
        "topLevelInstructionCount": len(instructions) if isinstance(instructions, list) else None,
    }


def _pair_to_dex(
    p: dict[str, Any],
    all_pairs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    liq = (p.get("liquidity") or {}).get("usd")
    vol5m = (p.get("volume") or {}).get("m5")
    created = p.get("pairCreatedAt")
    age_h = None
    created_num = _finite_number(created, positive=True)
    if created_num is not None:
        age_h = max(0.0, (time.time() * 1000 - created_num) / 3_600_000)
    turnover = None
    liq_num = _finite_number(liq, positive=True)
    vol5m_num = _finite_number(vol5m)
    if liq_num is not None and vol5m_num is not None:
        turnover = vol5m_num / liq_num
    pairs = all_pairs or [p]
    total_liq = _sum_positive(
        [((pair.get("liquidity") or {}).get("usd")) for pair in pairs]
    )
    selected_liq = _finite_number(liq, positive=True)
    deepest: dict[str, Any] | None = None
    deepest_liq: float | None = None
    for pair in pairs:
        candidate_liq = _finite_number((pair.get("liquidity") or {}).get("usd"), positive=True)
        if candidate_liq is not None and (deepest_liq is None or candidate_liq > deepest_liq):
            deepest = pair
            deepest_liq = candidate_liq
    quote_symbol = ((p.get("quoteToken") or {}).get("symbol"))
    return {
        "dexId": p.get("dexId"),
        "pairAddress": p.get("pairAddress"),
        "priceUsd": _finite_number(p.get("priceUsd"), positive=True),
        "pc5m": _finite_number((p.get("priceChange") or {}).get("m5")),
        "pc1h": _finite_number((p.get("priceChange") or {}).get("h1")),
        "vol5m": vol5m_num,
        "vol1h": _finite_number((p.get("volume") or {}).get("h1")),
        "liq": liq_num,
        "mcap": _finite_number(p.get("marketCap")) or _finite_number(p.get("fdv")),
        "fdv": _finite_number(p.get("fdv")),
        "quoteSymbol": quote_symbol if isinstance(quote_symbol, str) else None,
        "buys5m": _finite_number(((p.get("txns") or {}).get("m5") or {}).get("buys")),
        "sells5m": _finite_number(((p.get("txns") or {}).get("m5") or {}).get("sells")),
        "pc6h": _finite_number((p.get("priceChange") or {}).get("h6")),
        "pc24h": _finite_number((p.get("priceChange") or {}).get("h24")),
        "vol6h": _finite_number((p.get("volume") or {}).get("h6")),
        "vol24h": _finite_number((p.get("volume") or {}).get("h24")),
        "buys1h": _finite_number(((p.get("txns") or {}).get("h1") or {}).get("buys")),
        "sells1h": _finite_number(((p.get("txns") or {}).get("h1") or {}).get("sells")),
        "buys6h": _finite_number(((p.get("txns") or {}).get("h6") or {}).get("buys")),
        "sells6h": _finite_number(((p.get("txns") or {}).get("h6") or {}).get("sells")),
        "buys24h": _finite_number(((p.get("txns") or {}).get("h24") or {}).get("buys")),
        "sells24h": _finite_number(((p.get("txns") or {}).get("h24") or {}).get("sells")),
        "pairCreatedAt": created_num,
        "ageHours": age_h,
        "turnover5mLiq": turnover,
        "pairCount": len(pairs),
        "deepestPairAddress": deepest.get("pairAddress") if deepest else None,
        "deepestPairDexId": deepest.get("dexId") if deepest else None,
        "deepestPairLiq": deepest_liq,
        "totalLiq": total_liq,
        "selectedPairLiqShare": (
            selected_liq / total_liq if selected_liq is not None and total_liq and total_liq > 0 else None
        ),
    }


def _pick_pair(pairs: list[dict[str, Any]]) -> dict[str, Any] | None:
    sol = [p for p in pairs if p.get("chainId") == "solana"]
    if not sol:
        return None
    return next((x for x in sol if x.get("dexId") == "pumpswap"), sol[0])


def fetch_dex_batch(
    mints: list[str],
    *,
    priority: bool = False,
    max_wait_ms: float | None = None,
    timeout_sec: float = 15.0,
) -> dict[str, dict[str, Any] | None]:
    """One HTTP call per ≤30 mints. Returns mint -> snapshot (or error dict)."""
    global _dex_last_call_ms, _dex_backoff_until_ms
    out: dict[str, dict[str, Any] | None] = {}
    now_ms = time.time() * 1000
    pending = []
    for m in mints:
        hit = _dex_cache.get(m)
        if hit and now_ms - hit[0] < _DEX_CACHE_MS:
            out[m] = hit[1]
        elif m not in pending:
            pending.append(m)
    if not pending:
        return out
    shared_gate = _dex_gate_path() is not None
    if not shared_gate and now_ms < _dex_backoff_until_ms and not priority:
        for m in pending:
            out[m] = {"error": "throttled_local", "retryInMs": int(_dex_backoff_until_ms - now_ms)}
        return out
    if not shared_gate and now_ms < _dex_backoff_until_ms and priority:
        wait_s = max(0.0, (_dex_backoff_until_ms - now_ms) / 1000.0)
        if wait_s > 0:
            time.sleep(min(wait_s, 5.0))
        now_ms = time.time() * 1000

    for i in range(0, len(pending), _DEX_BATCH_MAX):
        chunk = pending[i : i + _DEX_BATCH_MAX]
        shared_slot = _acquire_shared_dex_slot(max_wait_ms=max_wait_ms)
        if shared_slot is False:
            for m in chunk:
                out[m] = {
                    "error": "telemetry_budget",
                    "retryInMs": int(max(0.0, max_wait_ms or 0.0)),
                }
            continue
        if shared_slot is None:
            local_now_ms = time.time() * 1000
            if local_now_ms < _dex_backoff_until_ms and not priority:
                for m in chunk:
                    out[m] = {
                        "error": "throttled_local",
                        "retryInMs": int(_dex_backoff_until_ms - local_now_ms),
                    }
                continue
            if local_now_ms < _dex_backoff_until_ms and priority:
                wait_ms = min(_dex_backoff_until_ms - local_now_ms, 5000.0)
                if max_wait_ms is not None and wait_ms > max_wait_ms:
                    for m in chunk:
                        out[m] = {"error": "telemetry_budget"}
                    continue
                time.sleep(wait_ms / 1000.0)
            gap = _DEX_MIN_GAP_MS - (time.time() * 1000 - _dex_last_call_ms)
            if gap > 0:
                if max_wait_ms is not None and gap > max_wait_ms:
                    for m in chunk:
                        out[m] = {"error": "telemetry_budget"}
                    continue
                time.sleep(min(gap, _DEX_MIN_GAP_MS) / 1000.0)
        _dex_last_call_ms = time.time() * 1000
        try:
            req = urllib.request.Request(
                "https://api.dexscreener.com/latest/dex/tokens/" + ",".join(chunk),
                headers={
                    "user-agent": "Mozilla/5.0 mild-dip-leader-observer",
                    "accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=max(0.1, timeout_sec)) as r:
                status = int(getattr(r, "status", 200))
                body = r.read().decode()
            if status == 429:
                _record_shared_dex_response(status, None)
                for m in chunk:
                    out[m] = {"error": "HTTP Error 429: Too Many Requests"}
                continue
            _record_shared_dex_response(status)
            j = json.loads(body)
            by_mint: dict[str, list[dict[str, Any]]] = {}
            for p in j.get("pairs") or []:
                base = ((p.get("baseToken") or {}).get("address") or "").strip()
                if base:
                    by_mint.setdefault(base, []).append(p)
            stamp = time.time() * 1000
            for m in chunk:
                pairs = by_mint.get(m) or []
                pair = _pick_pair(pairs)
                snap = _pair_to_dex(pair, pairs) if pair else None
                _dex_cache[m] = (stamp, snap)
                out[m] = snap
        except HTTPError as e:
            msg = str(e)
            if e.code == 429:
                retry_after = e.headers.get("Retry-After") if e.headers else None
                _record_shared_dex_response(e.code, retry_after)
                _dex_backoff_until_ms = time.time() * 1000 + _DEX_BACKOFF_MS
            for m in chunk:
                out[m] = {"error": msg}
        except Exception as e:
            msg = str(e)
            if "429" in msg:
                _dex_backoff_until_ms = time.time() * 1000 + _DEX_BACKOFF_MS
            for m in chunk:
                out[m] = {"error": msg}
    # keep the cache from growing without bound
    if len(_dex_cache) > 4000:
        cutoff = time.time() * 1000 - _DEX_CACHE_MS
        for m in [k for k, v in _dex_cache.items() if v[0] < cutoff]:
            _dex_cache.pop(m, None)
    return out


def fetch_dex(
    mint: str,
    *,
    priority: bool = False,
    max_wait_ms: float | None = None,
    timeout_sec: float = 15.0,
) -> dict[str, Any] | None:
    return fetch_dex_batch(
        [mint],
        priority=priority,
        max_wait_ms=max_wait_ms,
        timeout_sec=timeout_sec,
    ).get(mint)


def fetch_jupiter_prices(
    mints: list[str],
    price_url: str,
    timeout_sec: float = 8.0,
) -> dict[str, float]:
    """Batch Jupiter price v3. Returns mint -> usdPrice for hits only."""
    out: dict[str, float] = {}
    ids = [m for m in mints if m and len(m) >= 32]
    if not ids:
        return out
    # API accepts comma-separated ids; chunk to keep URLs sane.
    key = (os.environ.get("JUPITER_API_KEY") or "").strip()
    headers = {"accept": "application/json", "user-agent": "mild-dip-leader-observer"}
    if key:
        headers["x-api-key"] = key
    base = (price_url or "https://api.jup.ag/price/v3").rstrip("?&")
    for i in range(0, len(ids), 40):
        chunk = ids[i : i + 40]
        url = f"{base}?ids={','.join(chunk)}"
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=max(0.1, timeout_sec)) as r:
                j = json.loads(r.read().decode())
        except Exception:
            continue
        data = j.get("data") if isinstance(j, dict) and isinstance(j.get("data"), dict) else j
        if not isinstance(data, dict):
            continue
        for mint, row in data.items():
            if mint in ("data", "timeTaken", "contextSlot"):
                continue
            if not isinstance(row, dict):
                continue
            try:
                px = float(row.get("usdPrice") if row.get("usdPrice") is not None else row.get("price") or 0)
            except (TypeError, ValueError):
                continue
            if px > 0 and math.isfinite(px):
                out[str(mint)] = px
    return out


def entry_is_td(bag: dict[str, Any]) -> bool:
    """TD entry = non-green class or turnDump branch/main/shallow gates."""
    cls = bag.get("entryClass")
    if cls and cls != "green" and cls != "unknown":
        if cls in ("shallow", "mild_shallow", "mild_deep", "deep_knife", "rug_knife"):
            return True
    td = bag.get("entryTurnDump") or {}
    if isinstance(td, dict):
        if td.get("inMain") or td.get("inShallow"):
            return True
        if td.get("branch") in ("main", "shallow"):
            return True
    gates = bag.get("entryGates") or {}
    if isinstance(gates, dict) and gates.get("main") is True:
        return True
    return False


MARK_OUTLIER_RATIO = env_num("LEADER_OBSERVER_MARK_MAX_RATIO", 20.0)


def plausible_mark(px: float, bag: dict[str, Any], entry: float) -> bool:
    """
    1.11.811 — reject absurd marks before they poison mfe/giveback.

    A single bogus Jupiter print (e.g. $0.0016 on a $0.000037 entry) wrote
    `mfePct=4184` and `peakPriceUsd` 42× entry, which made 291 of 368 sessions
    unusable for exit research. Compare against entry and the running peak.
    """
    if not (px > 0) or not (entry > 0):
        return False
    ratio = max(MARK_OUTLIER_RATIO, 2.0)
    if px > entry * ratio or px < entry / ratio:
        return False
    peak = bag.get("peakPriceUsd")
    if isinstance(peak, (int, float)) and float(peak) > 0 and px > float(peak) * ratio:
        return False
    return True


def apply_path_metrics(bag: dict[str, Any], px: float, entry: float) -> dict[str, float]:
    """Update bag peak/trough/mfe/mae and return derived exit-formula fields."""
    pnl = (px / entry - 1.0) * 100.0
    peak = float(bag.get("peakPriceUsd") or entry)
    trough = float(bag.get("troughPriceUsd") or entry)
    if px > peak:
        peak = px
        bag["peakAtMs"] = int(time.time() * 1000)
    if px < trough:
        trough = px
    bag["peakPriceUsd"] = peak
    bag["troughPriceUsd"] = trough
    mfe = max(float(bag.get("mfePct") or 0.0), pnl)
    mae = min(float(bag.get("maePct") or 0.0), pnl)
    bag["mfePct"] = mfe
    bag["maePct"] = mae
    giveback = (px / peak - 1.0) * 100.0 if peak > 0 else 0.0
    bounce = (px / trough - 1.0) * 100.0 if trough > 0 else 0.0
    dd_from_peak = mfe - pnl
    max_bounce = max(float(bag.get("maxBouncePct") or 0.0), bounce)
    bag["maxBouncePct"] = max_bounce
    # Armed proxies (sticky once true).
    for thr, key in ((5.0, "armedMfe5"), (8.0, "armedMfe8"), (10.0, "armedMfe10"), (12.0, "armedMfe12")):
        if mfe >= thr:
            bag[key] = True
            if not bag.get(f"{key}AtMs"):
                bag[f"{key}AtMs"] = int(time.time() * 1000)
    # DUR-style consecutive red counters at common SL thresholds (mark/tick samples).
    for sl in (8, 10, 12, 15, 20, 25):
        k = f"durNeg{sl}"
        if pnl <= -float(sl):
            bag[k] = int(bag.get(k) or 0) + 1
        else:
            bag[k] = 0
    return {
        "pnlPct": pnl,
        "mfePct": mfe,
        "maePct": mae,
        "givebackPct": giveback,
        "bouncePct": bounce,
        "ddFromPeakPct": dd_from_peak,
        "maxBouncePct": max_bounce,
        "peakPriceUsd": peak,
        "troughPriceUsd": trough,
    }


def classify(pc: Any) -> str:
    if pc is None:
        return "unknown"
    try:
        pc = float(pc)
    except (TypeError, ValueError):
        return "unknown"
    if pc > 0:
        return "green"
    if pc <= -50:
        return "rug_knife"
    if pc <= -20:
        return "deep_knife"
    if pc <= -10:
        return "mild_deep"
    if pc <= -5:
        return "mild_shallow"
    return "shallow"


def turn_dump_snapshot(dex: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    Attach MAIN + SHALLOW turn→dump preds at observe time (formula RE aid).
    MAIN: -5.08+6.86·log1p(turn·100); SHALLOW: -8.83+4.23·log1p(turn·100).
    """
    if not isinstance(dex, dict) or dex.get("error"):
        return None
    try:
        pc = float(dex["pc5m"]) if dex.get("pc5m") is not None else None
        vol = float(dex.get("vol5m") or 0)
        liq = float(dex.get("liq") or 0)
    except (TypeError, ValueError):
        return None
    if pc is None or not (pc < 0) or not (liq > 0) or not (vol >= 0):
        return None
    turn = vol / liq
    if not (turn > 0):
        return None

    dump = -pc
    pred_main = -5.08 + 6.86 * math.log1p(turn * 100)
    pred_shallow = -8.83 + 4.23 * math.log1p(turn * 100)
    resid_main = dump - pred_main
    resid_shallow = dump - pred_shallow
    in_main = (pred_main - 10) <= dump <= (pred_main + 12)
    in_shallow = (pred_shallow - 8) <= dump <= (pred_shallow + 8)
    return {
        "turn": turn,
        "dump": dump,
        "predMain": pred_main,
        "residMain": resid_main,
        "inMain": in_main,
        "predShallow": pred_shallow,
        "residShallow": resid_shallow,
        "inShallow": in_shallow,
        "branch": "main" if in_main else ("shallow" if in_shallow else None),
    }


def gate_fit(d: dict[str, Any] | None) -> dict[str, Any]:
    """
    Compare Dex snapshot vs current live mild-dip entry stack (1.11.775).
    Live main band: pc5m ∈ (−25, −2]; h1_red_shallow: h1≤−15 and pc5m ∈ (−10, −3].
    """
    if not d or d.get("error"):
        return {
            "main": False,
            "h1_red_shallow": False,
            "knife_watch": False,
            "structural_ok": False,
            "reason": "no_dex",
        }
    pc = d.get("pc5m")
    h1 = d.get("pc1h")
    vol = float(d.get("vol5m") or 0)
    liq = float(d.get("liq") or 0)
    mcap = float(d.get("mcap") or 0)
    age = d.get("ageHours")

    # Align with mild-dip live floors (1.11.780 leader-like).
    min_mcap = env_num(
        "LEADER_OBSERVER_MIN_MCAP_USD",
        env_num("MILD_DIP_MIN_MCAP_USD", 5_000.0),
    )
    min_liq = env_num(
        "LEADER_OBSERVER_MIN_LIQUIDITY_USD",
        env_num("MILD_DIP_MIN_LIQUIDITY_USD", 5_000.0),
    )
    min_vol = env_num(
        "LEADER_OBSERVER_MIN_VOL5M_USD",
        env_num("MILD_DIP_MIN_VOLUME_5M_USD", 300.0),
    )
    structural = (
        vol >= min_vol
        and liq >= min_liq
        and mcap >= min_mcap
        and (age is None or float(age) >= 0.5)
    )
    try:
        pc_f = float(pc) if pc is not None else None
    except (TypeError, ValueError):
        pc_f = None
    try:
        h1_f = float(h1) if h1 is not None else None
    except (TypeError, ValueError):
        h1_f = None

    main = bool(structural and pc_f is not None and -25 < pc_f <= -2)
    h1s = bool(
        structural
        and h1_f is not None
        and pc_f is not None
        and h1_f <= -15
        and -10 < pc_f <= -3
    )
    knife = bool(structural and pc_f is not None and -50 < pc_f <= -20)
    return {
        "main": main,
        "h1_red_shallow": h1s,
        "knife_watch": knife,
        "structural_ok": structural,
        "pc5m": pc_f,
        "pc1h": h1_f,
    }


def sol_usd_from_dex_cache(cache: dict[str, Any], price_url: str = "") -> float | None:
    """
    SOL in USD, from Jupiter first and DexScreener only as a fallback.

    This one price decides whether a SOL-denominated fill is readable at all:
    `quote_leg_deltas` multiplies the lamport delta by it, so when it is missing
    the whole leg silently becomes zero. It used to come from DexScreener alone -
    the same saturated quota that answers 429 - and that is why 16,434 leader sell
    fills carry no proceeds. Verified on chain: three of them had paid +0.62,
    +2.96 and +2.01 SOL into the wallet, plainly readable, and were dropped only
    because SOL itself had no price at that moment.

    A stale SOL price is far better than none, so a cached value is served for
    five minutes and, if every source is failing, up to an hour.
    """
    px = cache.get("solUsd")
    fetched_at = float(cache.get("solUsdAt") or 0)
    if isinstance(px, (int, float)) and px > 0 and time.time() - fetched_at < 300:
        return float(px)
    try:
        jup = fetch_jupiter_prices([WSOL], price_url)
        jp = jup.get(WSOL)
        if jp and jp > 0:
            cache["solUsd"] = float(jp)
            cache["solUsdAt"] = time.time()
            return float(jp)
    except Exception:
        pass
    try:
        req = urllib.request.Request(
            f"https://api.dexscreener.com/latest/dex/tokens/{WSOL}",
            headers={"user-agent": "Mozilla/5.0 mild-dip-leader-observer", "accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.loads(r.read().decode())
        pairs = [p for p in (j.get("pairs") or []) if p.get("chainId") == "solana"]
        best = None
        for p in pairs:
            if (p.get("quoteToken") or {}).get("address") in (USDC, USDT):
                best = p
                break
        if not best and pairs:
            best = pairs[0]
        if best and best.get("priceUsd"):
            px = float(best["priceUsd"])
            cache["solUsd"] = px
            cache["solUsdAt"] = time.time()
            return px
    except Exception:
        pass
    # Both sources are down. An hour-old SOL price still reads a fill correctly
    # to within its own drift; dropping the leg loses it completely.
    if isinstance(px, (int, float)) and px > 0 and time.time() - fetched_at < 3600:
        return float(px)
    return None


def native_sol_delta(leader: str, tx: dict[str, Any] | None) -> tuple[float | None, bool]:
    """
    Leader's native lamport delta, gross of the tx fee when the leader paid it.

    This is the leg the observer used to miss entirely. `wrapAndUnwrapSol` swaps
    receive WSOL into a temporary account and close it in the same transaction,
    so the payout never appears in `postTokenBalances` — only in the native
    balance. Verified on chain: four sells the observer logged with zero proceeds
    had actually paid +1.1517, +1.2977, +4.6310 and +0.9675 SOL.
    """
    if not isinstance(tx, dict):
        return None, False
    meta = tx.get("meta") or {}
    msg = (tx.get("transaction") or {}).get("message") or {}
    keys = [k.get("pubkey") if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
    try:
        idx = keys.index(leader)
    except ValueError:
        return None, False
    pre_l = meta.get("preBalances") or []
    post_l = meta.get("postBalances") or []
    if idx >= len(pre_l) or idx >= len(post_l):
        return None, False
    try:
        delta = (int(post_l[idx]) - int(pre_l[idx])) / 1e9
    except (TypeError, ValueError):
        return None, False
    is_payer = idx == 0
    if is_payer:
        # Fee is not part of the swap — add it back for a gross fill amount.
        try:
            delta += int(meta.get("fee") or 0) / 1e9
        except (TypeError, ValueError):
            pass
    return delta, is_payer


def quote_leg_deltas(
    leader: str,
    pre: list[dict[str, Any]],
    post: list[dict[str, Any]],
    sol_usd: float | None,
    tx: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Sum the leader's SOL/USDC/USDT movement across the tx.

    SOL is counted as `native + WSOL-SPL`, which is correct for every routing
    shape: a wrap moves native → WSOL (nets ~0), an unwrap moves WSOL → native,
    and a payout straight to native shows up only in the native leg. Residual
    noise is ATA rent (~0.00204 SOL per account created or closed) — immaterial
    against the $200–900 fills seen here, and both components are reported so a
    consumer can judge for itself.
    """
    keys: dict[tuple[Any, str], list[Any]] = {}
    for b in pre:
        if b.get("owner") == leader and b.get("mint") in QUOTE_MINTS:
            keys[(b.get("accountIndex"), b.get("mint"))] = [b, None]
    for b in post:
        if b.get("owner") == leader and b.get("mint") in QUOTE_MINTS:
            k = (b.get("accountIndex"), b.get("mint"))
            keys.setdefault(k, [None, None])[1] = b

    sol_d = 0.0
    usdc_d = 0.0
    usdt_d = 0.0
    for (_idx, mint), (a, b) in keys.items():
        d = ui_amt(b) - ui_amt(a)
        if mint == WSOL:
            sol_d += d
        elif mint == USDC:
            usdc_d += d
        elif mint == USDT:
            usdt_d += d

    sol_spl_d = sol_d
    native_d, is_payer = native_sol_delta(leader, tx)
    if native_d is not None:
        sol_d += native_d

    quote_usd = usdc_d + usdt_d
    if sol_usd and sol_usd > 0 and abs(sol_d) > 0:
        quote_usd += sol_d * sol_usd
    return {
        "quoteSolDelta": sol_d if abs(sol_d) > 0 else 0.0,
        "quoteSolSplDelta": sol_spl_d if abs(sol_spl_d) > 0 else 0.0,
        "quoteSolNativeDelta": native_d,
        "quoteSolNativeReadable": native_d is not None,
        "quoteFeePayer": is_payer,
        "quoteUsdcDelta": usdc_d if abs(usdc_d) > 0 else 0.0,
        "quoteUsdtDelta": usdt_d if abs(usdt_d) > 0 else 0.0,
        "quoteUsdDelta": quote_usd if abs(quote_usd) > 0 else 0.0,
    }


def counter_leg_deltas(
    leader: str,
    pre: list[dict[str, Any]],
    post: list[dict[str, Any]],
    traded_mint: str,
) -> dict[str, float]:
    """
    The other side of a token-for-token swap.

    `quote_leg_deltas` only follows SOL, USDC and USDT, so a route that pays out
    in some third SPL token moves none of them and the leg lands with no readable
    proceeds at all. Over the corpus that is 26-32% of leader sell legs, and the
    gap is not uniform: a name sold once loses its whole proceeds while a name
    sold a hundred times loses a third of them, which biases any per-mint P&L
    along exactly the axis we want to measure.

    Returns every non-quote mint whose balance moved for this wallet, excluding
    the mint being traded, as a signed UI amount. Positive means received.
    """
    seen: dict[tuple[Any, str], list[Any]] = {}
    for b in pre:
        m = b.get("mint")
        if b.get("owner") == leader and m and m not in QUOTE_MINTS and m != traded_mint:
            seen[(b.get("accountIndex"), m)] = [b, None]
    for b in post:
        m = b.get("mint")
        if b.get("owner") == leader and m and m not in QUOTE_MINTS and m != traded_mint:
            seen.setdefault((b.get("accountIndex"), m), [None, None])[1] = b
    out: dict[str, float] = {}
    for (_idx, m), (a, b) in seen.items():
        d = ui_amt(b) - ui_amt(a)
        if d:
            out[m] = out.get(m, 0.0) + d
    return {m: d for m, d in out.items() if abs(d) > 0}


def fill_metrics(
    token_delta: float,
    quote: dict[str, Any],
    dex_px: float | None,
) -> dict[str, Any]:
    """
    Derive sizeUsd / fillPriceUsd.
    Buy: tokens ↑, quote usually ↓ → sizeUsd ≈ −quoteUsdDelta.
    Sell: tokens ↓, quote usually ↑ → sizeUsd ≈ +quoteUsdDelta.
    """
    q = float(quote.get("quoteUsdDelta") or 0)
    size_from_quote = abs(q) if abs(q) > 0 else None
    fill_from_quote = None
    if size_from_quote and abs(token_delta) > 0:
        fill_from_quote = size_from_quote / abs(token_delta)
    size_from_dex = None
    if dex_px and dex_px > 0 and abs(token_delta) > 0:
        size_from_dex = abs(token_delta) * dex_px

    # A quote delta far below the DEX-implied notional means the SOL/USDC leg was
    # not the counterparty: token-for-token routes leave no quote movement at all,
    # so what we captured is rent noise. Live: 97% of legs carrying both a quote
    # fill price and a DEX price disagreed by more than 3x (median 43x), and only
    # 3% of those ratios sat on a power of ten, so this is not a decimals bug.
    # Worst cases were $0.20 of SOL noise against ~9.2M tokens, inventing a fill
    # price 2822x below market. Such a leg is unusable rather than imprecise, so
    # drop the quote basis and fall back to the DEX estimate, flagged estimated.
    if size_from_quote and size_from_dex and size_from_dex > 0:
        if size_from_quote < size_from_dex * QUOTE_PLAUSIBLE_MIN_RATIO:
            size_from_quote = None
            fill_from_quote = None

    size_usd = size_from_quote if size_from_quote else size_from_dex
    fill_px = fill_from_quote if fill_from_quote else (dex_px if dex_px and dex_px > 0 else None)
    size_source = "quote" if size_from_quote else ("dex" if size_from_dex else None)
    # 1.11.803 — tokenDelta×dexPrice on a stale pair invents proceeds (a $27 buy
    # logged a $1148 sell). Flag it so PnL aggregates can drop the leg instead of
    # silently treating a guess as a fill.
    return {
        "sizeUsd": size_usd,
        "fillPriceUsd": fill_px,
        "sizeUsdSource": size_source,
        "sizeUsdEstimated": size_source != "quote",
        "fillPriceSource": "quote" if fill_from_quote else ("dex" if fill_px else None),
    }


class Observer:
    def __init__(self) -> None:
        self.rpc = resolve_rpc()
        raw = os.environ.get("LEADER_OBSERVER_LEADERS", "").strip()
        self.leaders = [x.strip() for x in raw.split(",") if x.strip()] or list(DEFAULT_LEADERS)
        self.out_dir = Path(os.environ.get("LEADER_OBSERVER_OUT_DIR", "data/milddip"))
        self.out_dir.mkdir(parents=True, exist_ok=True)
        # 1.11.790 — 1Hz dense ticks; signature poll can stay a few seconds.
        self.poll_sec = max(1, int(env_num("LEADER_OBSERVER_POLL_SEC", 5)))
        self.lookback_sec = max(60, int(env_num("LEADER_OBSERVER_LOOKBACK_SEC", 1800)))
        self.sig_limit = max(20, min(100, int(env_num("LEADER_OBSERVER_SIG_LIMIT", 80))))
        self.catchup_pages = max(1, min(100, int(env_num("LEADER_OBSERVER_CATCHUP_PAGES", 12))))
        self.signature_cursor: dict[str, str] = {}
        self.max_hours = env_num("LEADER_OBSERVER_MAX_HOURS", 72)
        seed_env = os.environ.get("LEADER_OBSERVER_SEED_PATH", "").strip()
        self.seed_path = Path(seed_env) if seed_env else self.out_dir / "leader-seed.json"
        self.seed_max = max(1, int(env_num("LEADER_OBSERVER_SEED_MAX", 40)))
        self.seed_max_age_sec = max(60, int(env_num("LEADER_OBSERVER_SEED_MAX_AGE_SEC", 7200)))
        self.log_sells = env_bool("LEADER_OBSERVER_LOG_SELLS", True)
        self.log_marks = env_bool("LEADER_OBSERVER_LOG_MARKS", True)
        self.mark_min_gap_sec = max(1, int(env_num("LEADER_OBSERVER_MARK_MIN_GAP_SEC", 15)))
        self.dense_ticks = env_bool("LEADER_OBSERVER_DENSE_TICKS", False)
        self.dense_gap_sec = max(1, int(env_num("LEADER_OBSERVER_DENSE_GAP_SEC", 1)))
        self.dex_refresh_sec = max(5, int(env_num("LEADER_OBSERVER_DEX_REFRESH_SEC", 15)))
        self.dense_only_td = env_bool("LEADER_OBSERVER_DENSE_ONLY_TD", False)
        self.telemetry_budget_ms = max(
            100, int(env_num("LEADER_OBSERVER_TELEMETRY_BUDGET_MS", 1800))
        )
        self.telemetry_dead_bag_sec = max(
            60, int(env_num("LEADER_OBSERVER_TELEMETRY_DEAD_BAG_SEC", 21600))
        )
        self.holders_enabled = env_bool("LEADER_OBSERVER_HOLDERS_ENABLED", False)
        self.holders_min_gap_sec = max(
            60, int(env_num("LEADER_OBSERVER_HOLDERS_MIN_GAP_SEC", 3600))
        )
        self.price_url = (
            os.environ.get("LEADER_OBSERVER_PRICE_URL", "").strip()
            or "https://api.jup.ag/price/v3"
        )
        self.state_path = self.out_dir / "leader-observer-state.json"
        # signature -> blockTime (sec). A set truncated by slicing dropped recent
        # signatures at random, so the same tx was re-processed on every poll for
        # the whole lookback window — see `_save_state`.
        self.seen: dict[str, int] = {}
        # leader -> mint -> bag state
        self.bags: dict[str, dict[str, dict[str, Any]]] = {}
        self.last_closed_by_mint: dict[str, dict[str, dict[str, Any]]] = {}
        self.last_trade_at_ms: dict[str, int] = {}
        self.last_trade_by_mint_ms: dict[str, dict[str, int]] = {}
        self.leader_entry_times_ms: dict[str, list[int]] = {}
        self._sol_cache: dict[str, Any] = {}
        self._load_state()
        self.out_path = self._out_path_for_today()
        self.dense_path = self._dense_path_for_today()
        self._last_sig_poll_at = 0.0
        self._last_state_save_at = 0.0
        self._telemetry_cursor: tuple[str, str] | None = None
        self._last_cycle_emit_at = 0.0
        # 1.11.786 — dual-write cash trade rows next to mild-dip fills.
        trades_env = os.environ.get("LEADER_OBSERVER_TRADES_PATH", "").strip()
        self.trades_path = (
            Path(trades_env) if trades_env else self.out_dir / "trades.jsonl"
        )

    def _out_path_for_today(self) -> Path:
        day = dt.datetime.utcnow().strftime("%Y%m%d")
        return self.out_dir / f"leader-observer-{day}.jsonl"

    def _dense_path_for_today(self) -> Path:
        day = dt.datetime.utcnow().strftime("%Y%m%d")
        return self.out_dir / f"leader-dense-{day}.jsonl"

    def counter_leg_usd(
        self,
        deltas: dict[str, float],
        want_received: bool,
    ) -> tuple[float | None, list[str]]:
        """
        Value the other side of a token-for-token swap, in USD.

        Prices come from Jupiter, which is a separate quota from the DexScreener
        budget the bot needs and prices almost any tradeable SPL token. Cached per
        mint because the same counter tokens recur across a leader's routes.
        """
        wanted = {
            m: d
            for m, d in (deltas or {}).items()
            if (d > 0 if want_received else d < 0)
        }
        if not wanted:
            return None, []
        now = time.time()
        missing = [
            m for m in wanted
            if not (
                m in COUNTER_PX_CACHE
                and now - COUNTER_PX_CACHE[m][0] <= COUNTER_PX_TTL_SEC
            )
        ]
        if missing:
            try:
                fetched = fetch_jupiter_prices(missing, self.price_url)
            except Exception:
                fetched = {}
            for m in missing:
                px = fetched.get(m)
                if px and px > 0:
                    COUNTER_PX_CACHE[m] = (now, float(px))
        total = 0.0
        priced: list[str] = []
        for m, d in wanted.items():
            hit = COUNTER_PX_CACHE.get(m)
            if not hit or now - hit[0] > COUNTER_PX_TTL_SEC:
                continue
            total += abs(d) * hit[1]
            priced.append(m)
        if not priced or total <= 0:
            return None, []
        return total, priced

    def emit_trade(self, payload: dict[str, Any]) -> None:
        """Canonical trade_fill / trade_roundtrip into shared trades.jsonl."""
        try:
            self.trades_path.parent.mkdir(parents=True, exist_ok=True)
            row = {"ts": int(time.time() * 1000), "v": 1, **payload}
            with self.trades_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def _load_state(self) -> None:
        try:
            raw = json.loads(self.state_path.read_text())
            sigs = raw.get("seenSignatures") or []
            if isinstance(sigs, dict):
                self.seen = {str(k): int(v or 0) for k, v in sigs.items() if k}
            else:
                # Legacy list form: no timestamps, so age them out on first prune.
                self.seen = {str(x): 0 for x in sigs if x}
            cursors = raw.get("signatureCursor") or {}
            if isinstance(cursors, dict):
                self.signature_cursor = {
                    str(k): str(v) for k, v in cursors.items() if k and v
                }
            bags = raw.get("bags") or {}
            if isinstance(bags, dict):
                self.bags = bags  # type: ignore[assignment]
            closed = raw.get("lastClosedByMint") or {}
            if isinstance(closed, dict):
                self.last_closed_by_mint = closed  # type: ignore[assignment]
            last_trade = raw.get("lastTradeAtMs") or {}
            if isinstance(last_trade, dict):
                self.last_trade_at_ms = {
                    str(k): int(v)
                    for k, v in last_trade.items()
                    if k and isinstance(v, (int, float))
                }
            last_by_mint = raw.get("lastTradeByMintMs") or {}
            if isinstance(last_by_mint, dict):
                self.last_trade_by_mint_ms = {
                    str(leader): {
                        str(mint): int(ts)
                        for mint, ts in (by_mint or {}).items()
                        if mint and isinstance(ts, (int, float))
                    }
                    for leader, by_mint in last_by_mint.items()
                    if isinstance(by_mint, dict)
                }
            entry_times = raw.get("leaderEntryTimesMs") or {}
            if isinstance(entry_times, dict):
                self.leader_entry_times_ms = {
                    str(leader): [
                        int(ts)
                        for ts in (timestamps or [])
                        if isinstance(ts, (int, float))
                    ]
                    for leader, timestamps in entry_times.items()
                    if isinstance(timestamps, list)
                }
        except Exception:
            self.seen = {}
            self.bags = {}
            self.last_closed_by_mint = {}
            self.last_trade_at_ms = {}
            self.last_trade_by_mint_ms = {}
            self.leader_entry_times_ms = {}

    def _save_state(self) -> None:
        """
        Prune seen signatures by age, not by slicing.

        `list(a_set)[-5000:]` keeps an arbitrary 5000 — sets have no order — so
        recent signatures were dropped at random and the poller re-processed them
        on every pass until they fell out of the 1800s lookback. Measured on
        2026-08-12: **45 006 emitted legs from 924 distinct transactions**, one
        signature re-emitted 348 times over 29.7 minutes at a 5.1s cadence (the
        poll interval). 98% of the observer's reported USD volume was that echo,
        which inflated leader turnover roughly 48x.

        A signature older than the lookback can never come back, so age is the
        correct bound. The count cap stays as a backstop, applied newest-first.
        """
        horizon = max(int(self.lookback_sec) * 3, 7_200)
        floor_bt = int(time.time()) - horizon
        kept = {sig: bt for sig, bt in self.seen.items() if bt >= floor_bt}
        if len(kept) > SEEN_SIGNATURE_CAP:
            newest = sorted(kept.items(), key=lambda kv: kv[1], reverse=True)
            kept = dict(newest[:SEEN_SIGNATURE_CAP])
        self.seen = kept
        # Bound bag ledger: drop flats older than 48h
        cutoff = int(time.time()) - 172_800
        slim: dict[str, dict[str, dict[str, Any]]] = {}
        for leader, by_mint in self.bags.items():
            keep: dict[str, dict[str, Any]] = {}
            for mint, bag in (by_mint or {}).items():
                if not isinstance(bag, dict):
                    continue
                if float(bag.get("tokenUi") or 0) <= FLAT_UI_EPS:
                    opened = int(bag.get("openedBlockTime") or 0)
                    if opened and opened < cutoff:
                        continue
                keep[mint] = bag
            if keep:
                slim[leader] = keep
        self.bags = slim
        closed_cutoff_ms = int(time.time() * 1000) - _CLOSED_ENTRY_MAX_AGE_SEC * 1000
        closed: dict[str, dict[str, dict[str, Any]]] = {}
        for leader, by_mint in self.last_closed_by_mint.items():
            keep: dict[str, dict[str, Any]] = {}
            for mint, record in (by_mint or {}).items():
                if not isinstance(record, dict):
                    continue
                closed_at = int(record.get("exitTimeMs") or 0)
                if closed_at and closed_at < closed_cutoff_ms:
                    continue
                keep[mint] = record
            if keep:
                closed[leader] = keep
        if sum(len(v) for v in closed.values()) > _CLOSED_ENTRY_CAP:
            ordered = sorted(
                (
                    (leader, mint, record)
                    for leader, by_mint in closed.items()
                    for mint, record in by_mint.items()
                ),
                key=lambda x: int(x[2].get("exitTimeMs") or 0),
                reverse=True,
            )[:_CLOSED_ENTRY_CAP]
            closed = {}
            for leader, mint, record in ordered:
                closed.setdefault(leader, {})[mint] = record
        self.last_closed_by_mint = closed
        trade_cutoff_ms = int(time.time() * 1000) - _CLOSED_ENTRY_MAX_AGE_SEC * 1000
        self.last_trade_at_ms = {
            leader: int(ts)
            for leader, ts in self.last_trade_at_ms.items()
            if isinstance(ts, (int, float)) and int(ts) >= trade_cutoff_ms
        }
        self.last_trade_by_mint_ms = {
            leader: {
                mint: int(ts)
                for mint, ts in (by_mint or {}).items()
                if isinstance(ts, (int, float)) and int(ts) >= trade_cutoff_ms
            }
            for leader, by_mint in self.last_trade_by_mint_ms.items()
            if isinstance(by_mint, dict)
            and any(
                isinstance(ts, (int, float)) and int(ts) >= trade_cutoff_ms
                for ts in by_mint.values()
            )
        }
        entry_cutoff_ms = int(time.time() * 1000) - 3_600_000
        self.leader_entry_times_ms = {
            leader: [int(ts) for ts in times if int(ts) >= entry_cutoff_ms][-5000:]
            for leader, times in self.leader_entry_times_ms.items()
            if isinstance(times, list) and any(int(ts) >= entry_cutoff_ms for ts in times)
        }
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "seenSignatures": self.seen,
                    "signatureCursor": self.signature_cursor,
                    "bags": self.bags,
                    "lastClosedByMint": self.last_closed_by_mint,
                    "lastTradeAtMs": self.last_trade_at_ms,
                    "lastTradeByMintMs": self.last_trade_by_mint_ms,
                    "leaderEntryTimesMs": self.leader_entry_times_ms,
                    "updatedAt": utc_iso(),
                }
            )
            + "\n"
        )
        tmp.replace(self.state_path)

    def emit(self, payload: dict[str, Any]) -> None:
        today = self._out_path_for_today()
        if today != self.out_path:
            self.out_path = today
        payload.setdefault("tsMs", int(time.time() * 1000))
        payload.setdefault("iso", utc_iso())
        with self.out_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def emit_dense(self, payload: dict[str, Any]) -> None:
        """Write dense ticks to dedicated daily jsonl (keeps main tape readable)."""
        today = self._dense_path_for_today()
        if today != self.dense_path:
            self.dense_path = today
        payload.setdefault("tsMs", int(time.time() * 1000))
        payload.setdefault("iso", utc_iso())
        with self.dense_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def upsert_seed(
        self,
        mint: str,
        leader: str,
        signature: str,
        ts_ms: int,
        *,
        fill_price_usd: float | None = None,
        size_usd: float | None = None,
        cls: str | None = None,
        block_time: int | None = None,
        is_add: bool | None = None,
        dex: dict[str, Any] | None = None,
    ) -> None:
        """Atomic sidecar for mild-dip `leaders` discover source."""
        hits: list[dict[str, Any]] = []
        try:
            raw = json.loads(self.seed_path.read_text(encoding="utf-8"))
            if isinstance(raw.get("hits"), list):
                hits = list(raw["hits"])
        except Exception:
            hits = []
        cutoff = ts_ms - self.seed_max_age_sec * 1000
        by_mint_leader: dict[tuple[str, str], dict[str, Any]] = {}
        for h in hits:
            if not isinstance(h, dict):
                continue
            m = str(h.get("mint") or "")
            h_leader = str(h.get("leader") or "")
            last = h.get("lastSeenAtMs")
            if len(m) < 32 or not isinstance(last, (int, float)):
                continue
            if int(last) < cutoff:
                continue
            key = (m, h_leader)
            by_mint_leader[key] = dict(h)
            by_mint_leader[key]["mint"] = m
            by_mint_leader[key]["lastSeenAtMs"] = int(last)
        key = (mint, leader)
        prev = by_mint_leader.get(key) or {}
        hit = {
            "mint": mint,
            "lastSeenAtMs": max(int(prev.get("lastSeenAtMs") or 0), ts_ms),
            "leader": leader,
            "signature": signature,
        }
        if fill_price_usd and fill_price_usd > 0:
            hit["fillPriceUsd"] = fill_price_usd
        if size_usd and size_usd > 0:
            hit["sizeUsd"] = size_usd
        if cls:
            hit["class"] = cls
        if block_time:
            hit["blockTime"] = int(block_time)
        if is_add is not None:
            hit["isAdd"] = bool(is_add)
        # 1.11.775 — pass observer Dex so mild-dip can buy without re-fetch.
        if isinstance(dex, dict) and not dex.get("error"):
            for src_key, dst_key in (
                ("priceUsd", "priceUsd"),
                ("pc5m", "pc5m"),
                ("pc1h", "pc1h"),
                ("vol5m", "vol5m"),
                ("liq", "liq"),
                ("mcap", "mcap"),
                ("ageHours", "ageHours"),
                ("turnover5mLiq", "turnover5mLiq"),
                ("dexId", "dexId"),
            ):
                v = dex.get(src_key)
                if v is not None:
                    hit[dst_key] = v
        by_mint_leader[key] = hit
        merged = sorted(
            by_mint_leader.values(),
            key=lambda x: int(x.get("lastSeenAtMs") or 0),
            reverse=True,
        )[: self.seed_max]
        self.seed_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.seed_path.with_suffix(f".tmp.{os.getpid()}.{ts_ms}")
        tmp.write_text(
            json.dumps({"updatedAtMs": ts_ms, "hits": merged}, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        tmp.replace(self.seed_path)

    def _bag(self, leader: str, mint: str) -> dict[str, Any] | None:
        return (self.bags.get(leader) or {}).get(mint)

    def _set_bag(self, leader: str, mint: str, bag: dict[str, Any] | None) -> None:
        if leader not in self.bags:
            self.bags[leader] = {}
        if bag is None:
            self.bags[leader].pop(mint, None)
            if not self.bags[leader]:
                self.bags.pop(leader, None)
        else:
            self.bags[leader][mint] = bag

    def reconcile_open_bags(self) -> None:
        """Reconcile restored bags against current balances without inventing fills."""
        now_ms = int(time.time() * 1000)
        for leader, by_mint in list(self.bags.items()):
            for mint, bag in list((by_mint or {}).items()):
                if not isinstance(bag, dict) or float(bag.get("tokenUi") or 0) <= FLAT_UI_EPS:
                    continue
                try:
                    result = rpc_call(
                        self.rpc,
                        "getTokenAccountsByOwner",
                        [leader, {"mint": mint}, {"encoding": "jsonParsed"}],
                    )
                    if not isinstance(result, dict) or not isinstance(result.get("value"), list):
                        raise RuntimeError("malformed token account RPC result")
                    balance_ui = 0.0
                    for row in (result.get("value") or []):
                        try:
                            amount = ((row.get("account") or {}).get("data") or {}).get("parsed", {}).get("info", {}).get("tokenAmount", {})
                            if not isinstance(amount, dict):
                                raise ValueError("malformed token amount")
                            raw = int(amount.get("amount") or 0)
                            decimals = int(amount.get("decimals") or 0)
                            if raw < 0 or decimals < 0:
                                raise ValueError("invalid token amount")
                            balance_ui += raw / (10 ** decimals)
                        except (AttributeError, TypeError, ValueError, ZeroDivisionError) as exc:
                            raise RuntimeError(f"malformed token account: {exc}") from exc
                    prior_ui = float(bag.get("tokenUi") or 0)
                    if balance_ui >= prior_ui - FLAT_UI_EPS:
                        continue
                    rec_sig = f"reconcile_{leader[:8]}_{mint[:8]}_{now_ms}"
                    info = self._update_bag_sell(
                        leader,
                        mint,
                        token_ui=max(0.0, balance_ui),
                        size_usd=None,
                        fill_px=None,
                        block_time=None,
                        signature=rec_sig,
                    )
                    sess = info.get("session") or {}
                    common = {
                        "leader": leader,
                        "mint": mint,
                        "signature": None,
                        "reconciliation": True,
                        "reconciliationReason": "startup_onchain_balance",
                        "observedSignature": None,
                        "blockTime": None,
                        "isFlat": bool(info.get("isFlat")),
                        "isPartial": bool(info.get("isPartial")),
                        "bagTokenUi": balance_ui,
                        "soldUi": sess.get("soldUi"),
                        "entryPriceUsd": sess.get("entryPriceUsd"),
                        "exitPriceUsd": None,
                    }
                    self.emit({"kind": "leader_sell_observed", **common})
                    if info.get("isFlat"):
                        self.emit({
                            "kind": "leader_session_flat",
                            **common,
                            "openedSignature": sess.get("openedSignature"),
                            "openedBlockTime": sess.get("openedBlockTime"),
                            "pnlPctApprox": None,
                            "heldSec": None,
                            "sizeUsdProceeds": None,
                            "totalCostUsd": sess.get("totalCostUsd"),
                            "totalProceedsUsd": sess.get("totalProceedsUsd"),
                            "cashPnlUsd": None,
                        })
                    self.emit({
                        "kind": "leader_observer_reconciliation",
                        "leader": leader,
                        "mint": mint,
                        "previousTokenUi": prior_ui,
                        "actualTokenUi": balance_ui,
                        "isFlat": bool(info.get("isFlat")),
                    })
                except Exception as exc:
                    self.emit({
                        "kind": "leader_observer_reconciliation_error",
                        "leader": leader,
                        "mint": mint,
                        "reason": str(exc)[:300],
                        "failClosed": True,
                    })
        self._save_state()

    def _trade_context(self, leader: str, mint: str, side: str, now_ms: int) -> dict[str, Any]:
        previous_any = self.last_trade_at_ms.get(leader)
        previous_mint = (self.last_trade_by_mint_ms.get(leader) or {}).get(mint)
        self.last_trade_at_ms[leader] = now_ms
        self.last_trade_by_mint_ms.setdefault(leader, {})[mint] = now_ms
        entry_times = self.leader_entry_times_ms.setdefault(leader, [])
        if side == "buy":
            entry_times.append(now_ms)
        cutoff_5m = now_ms - 300_000
        cutoff_60m = now_ms - 3_600_000
        entry_times[:] = [ts for ts in entry_times if ts >= cutoff_60m]
        return {
            "msSincePreviousTrade": max(0, now_ms - previous_any) if previous_any else None,
            "msSincePreviousMintTrade": max(0, now_ms - previous_mint) if previous_mint else None,
            "leaderEntries5m": sum(ts >= cutoff_5m for ts in entry_times),
            "leaderEntries60m": sum(ts >= cutoff_60m for ts in entry_times),
        }

    def _open_capital(self) -> tuple[int, float | None]:
        open_bags = self._open_bags()
        values = [
            _finite_number(bag.get("costUsd"), positive=True)
            for _leader, _mint, bag in open_bags
        ]
        known = [value for value in values if value is not None]
        return len(open_bags), sum(known) if known else None

    def _holder_metrics(self, mint: str, now_ms: int) -> dict[str, Any]:
        if not self.holders_enabled:
            return {
                "largestHolderSharePct": None,
                "top10HolderSharePct": None,
                "holderAccountCount": None,
            }
        last = getattr(self, "_holder_last_call_ms", {}).get(mint, 0)
        if now_ms - last < self.holders_min_gap_sec * 1000:
            return {
                "largestHolderSharePct": None,
                "top10HolderSharePct": None,
                "holderAccountCount": None,
            }
        if not hasattr(self, "_holder_last_call_ms"):
            self._holder_last_call_ms = {}
        self._holder_last_call_ms[mint] = now_ms
        try:
            supply = rpc_call(self.rpc, "getTokenSupply", [mint])
            largest = rpc_call(self.rpc, "getTokenLargestAccounts", [mint])
            supply_value = _finite_number(
                ((supply or {}).get("value") or {}).get("amount"), positive=True
            )
            accounts = ((largest or {}).get("value") or [])
            amounts = [
                _finite_number(account.get("amount"), positive=True)
                for account in accounts
                if isinstance(account, dict)
            ]
            amounts = [amount for amount in amounts if amount is not None]
            if supply_value is None or not amounts:
                return {
                    "largestHolderSharePct": None,
                    "top10HolderSharePct": None,
                    "holderAccountCount": len(accounts) if isinstance(accounts, list) else None,
                }
            return {
                "largestHolderSharePct": _pct_ratio(max(amounts), supply_value),
                "top10HolderSharePct": _pct_ratio(sum(sorted(amounts, reverse=True)[:10]), supply_value),
                "holderAccountCount": len(accounts) if isinstance(accounts, list) else None,
            }
        except Exception:
            return {
                "largestHolderSharePct": None,
                "top10HolderSharePct": None,
                "holderAccountCount": None,
            }

    def _update_bag_buy(
        self,
        leader: str,
        mint: str,
        *,
        token_ui: float,
        fill_px: float | None,
        size_usd: float | None,
        block_time: int | None,
        signature: str,
        size_estimated: bool = False,
    ) -> dict[str, Any]:
        prev = self._bag(leader, mint)
        is_new = prev is None or float(prev.get("tokenUi") or 0) <= FLAT_UI_EPS
        if is_new:
            cost = float(size_usd or 0)
            entry0 = float(fill_px) if isinstance(fill_px, (int, float)) and fill_px > 0 else None
            bag = {
                "tokenUi": token_ui,
                "costUsd": cost,
                "totalCostUsd": cost,
                "totalProceedsUsd": 0.0,
                "entryPriceUsd": fill_px,
                "openedBlockTime": block_time,
                "openedSignature": signature,
                "lastBuySignature": signature,
                "lastBuyBlockTime": block_time,
                "buys": 1,
                "sells": 0,
                "mfePct": 0.0,
                "maePct": 0.0,
                "peakPriceUsd": entry0,
                "troughPriceUsd": entry0,
                "peakAtMs": int(block_time) * 1000 if block_time else None,
                "maxBouncePct": 0.0,
                "armedMfe5": False,
                "armedMfe8": False,
                "armedMfe10": False,
                "armedMfe12": False,
                "lastMarkAtMs": 0,
                "lastDenseAtMs": 0,
                "lastDexAtMs": 0,
                "lastDex": None,
                "costEstimatedLegs": 1 if size_estimated else 0,
                "proceedsEstimatedLegs": 0,
            }
            self._set_bag(leader, mint, bag)
            return {"isNewBag": True, "isAdd": False, "bag": bag}
        # add
        prev_ui = float(prev.get("tokenUi") or 0)
        prev_cost = float(prev.get("costUsd") or 0)
        new_ui = token_ui
        add_tokens = max(0.0, new_ui - prev_ui)
        add_cost = float(size_usd or 0)
        bag = dict(prev)
        bag["tokenUi"] = new_ui
        bag["costUsd"] = prev_cost + add_cost
        bag["totalCostUsd"] = float(prev.get("totalCostUsd") or prev_cost) + add_cost
        bag.setdefault("totalProceedsUsd", float(prev.get("totalProceedsUsd") or 0))
        if new_ui > 0 and bag["costUsd"] > 0:
            bag["entryPriceUsd"] = bag["costUsd"] / new_ui
        bag["lastBuySignature"] = signature
        bag["lastBuyBlockTime"] = block_time
        bag["buys"] = int(bag.get("buys") or 0) + 1
        if size_estimated:
            bag["costEstimatedLegs"] = int(bag.get("costEstimatedLegs") or 0) + 1
        self._set_bag(leader, mint, bag)
        return {"isNewBag": False, "isAdd": add_tokens > 0, "bag": bag}

    def _update_bag_sell(
        self,
        leader: str,
        mint: str,
        *,
        token_ui: float,
        size_usd: float | None,
        fill_px: float | None,
        block_time: int | None,
        signature: str,
        size_estimated: bool = False,
    ) -> dict[str, Any]:
        prev = self._bag(leader, mint) or {
            "tokenUi": token_ui - 0,  # unknown prior
            "costUsd": 0,
            "entryPriceUsd": None,
            "openedBlockTime": None,
            "openedSignature": None,
            "buys": 0,
            "sells": 0,
        }
        prev_ui = float(prev.get("tokenUi") or 0)
        sold = max(0.0, prev_ui - token_ui) if prev_ui > 0 else abs(token_ui)
        sell_number = int(prev.get("sells") or 0) + 1
        sold_pct = sold / prev_ui * 100.0 if prev_ui > 0 else None
        entry_px = prev.get("entryPriceUsd")
        pnl_pct = None
        if (
            isinstance(entry_px, (int, float))
            and entry_px > 0
            and isinstance(fill_px, (int, float))
            and fill_px > 0
        ):
            pnl_pct = (fill_px / float(entry_px) - 1) * 100
        is_flat = token_ui <= FLAT_UI_EPS
        held_sec = None
        opened_bt = prev.get("openedBlockTime")
        if opened_bt and block_time:
            held_sec = max(0, int(block_time) - int(opened_bt))
        bag = dict(prev)
        bag["tokenUi"] = token_ui
        bag["lastSellSignature"] = signature
        bag["lastSellBlockTime"] = block_time
        bag["sells"] = int(bag.get("sells") or 0) + 1
        proceeds = float(size_usd or 0)
        bag["totalProceedsUsd"] = float(prev.get("totalProceedsUsd") or 0) + proceeds
        proceeds_est_legs = int(prev.get("proceedsEstimatedLegs") or 0) + (
            1 if size_estimated else 0
        )
        bag["proceedsEstimatedLegs"] = proceeds_est_legs
        # 1.11.811 — an unreadable sell leg used to write proceeds 0, i.e. a
        # fake −100% session. 2634 of 4681 sell legs had no size at all.
        proceeds_missing_legs = int(prev.get("proceedsMissingLegs") or 0) + (
            0 if size_usd is not None else 1
        )
        bag["proceedsMissingLegs"] = proceeds_missing_legs
        cost_basis = 0.0
        if prev_ui > 0 and sold > 0:
            # reduce cost pro-rata
            frac = min(1.0, sold / prev_ui)
            prev_cost = float(prev.get("costUsd") or 0)
            cost_basis = prev_cost * frac
            bag["costUsd"] = max(0.0, prev_cost * (1 - frac))
        cash_pnl = proceeds - cost_basis if proceeds or cost_basis else None
        if is_flat:
            total_cost = float(prev.get("totalCostUsd") or prev.get("costUsd") or 0)
            total_proceeds = float(bag.get("totalProceedsUsd") or proceeds)
            session = {
                "isFlat": True,
                "soldUi": sold,
                "pnlPctApprox": pnl_pct,
                "heldSec": held_sec,
                "entryPriceUsd": entry_px,
                "exitPriceUsd": fill_px,
                "openedSignature": prev.get("openedSignature"),
                "openedBlockTime": opened_bt,
                "sizeUsdProceeds": size_usd,
                "costBasisUsd": cost_basis,
                "cashPnlUsd": cash_pnl,
                "totalCostUsd": total_cost,
                "totalProceedsUsd": total_proceeds,
                "entryClass": prev.get("entryClass"),
                "entryGates": prev.get("entryGates"),
                "entryTurnDump": prev.get("entryTurnDump"),
                "mfePct": prev.get("mfePct"),
                "maePct": prev.get("maePct"),
                "peakPriceUsd": prev.get("peakPriceUsd"),
                "peakAtMs": prev.get("peakAtMs"),
                "troughPriceUsd": prev.get("troughPriceUsd"),
                "mfePctAtExit": prev.get("mfePct"),
                "soldPctThisSell": sold_pct,
                "sellNumber": sell_number,
                "secondsFromPeakToSell": (
                    max(0.0, (int(block_time) * 1000 - int(prev["peakAtMs"])) / 1000.0)
                    if block_time and prev.get("peakAtMs")
                    else None
                ),
                "maxBouncePct": prev.get("maxBouncePct"),
                "armedMfe5": bool(prev.get("armedMfe5")),
                "armedMfe8": bool(prev.get("armedMfe8")),
                "armedMfe10": bool(prev.get("armedMfe10")),
                "armedMfe12": bool(prev.get("armedMfe12")),
                "givebackPctAtExit": (
                    ((float(fill_px) / float(prev["peakPriceUsd"])) - 1.0) * 100.0
                    if isinstance(fill_px, (int, float))
                    and fill_px > 0
                    and isinstance(prev.get("peakPriceUsd"), (int, float))
                    and float(prev["peakPriceUsd"]) > 0
                    else None
                ),
                "bouncePctAtExit": (
                    ((float(fill_px) / float(prev["troughPriceUsd"])) - 1.0) * 100.0
                    if isinstance(fill_px, (int, float))
                    and fill_px > 0
                    and isinstance(prev.get("troughPriceUsd"), (int, float))
                    and float(prev["troughPriceUsd"]) > 0
                    else None
                ),
                "isTdEntry": entry_is_td(prev),
                "buys": prev.get("buys"),
                "sells": sell_number,
                # 1.11.803 — any leg priced off dex instead of the quote delta
                # makes cash PnL a guess; downstream must exclude these.
                "costEstimatedLegs": int(prev.get("costEstimatedLegs") or 0),
                "proceedsEstimatedLegs": proceeds_est_legs,
                "proceedsMissingLegs": proceeds_missing_legs,
                "cashPnlReliable": (
                    int(prev.get("costEstimatedLegs") or 0) == 0
                    and proceeds_est_legs == 0
                    and proceeds_missing_legs == 0
                ),
                "pathReliable": abs(float(prev.get("mfePct") or 0)) <= 300,
            }
            self._set_bag(leader, mint, None)
            self.last_closed_by_mint.setdefault(leader, {})[mint] = {
                "exitPriceUsd": fill_px,
                "exitTimeMs": int(block_time) * 1000 if block_time else int(time.time() * 1000),
                "pnlPct": pnl_pct,
            }
            return {"isFlat": True, "isPartial": False, "bag": None, "session": session}
        self._set_bag(leader, mint, bag)
        return {
            "isFlat": False,
            "isPartial": True,
            "bag": bag,
            "session": {
                "isFlat": False,
                "soldUi": sold,
                "pnlPctApprox": pnl_pct,
                "heldSec": held_sec,
                "entryPriceUsd": entry_px,
                "exitPriceUsd": fill_px,
                "peakPriceUsd": bag.get("peakPriceUsd"),
                "peakAtMs": bag.get("peakAtMs"),
                "mfePctAtExit": bag.get("mfePct"),
                "soldPctThisSell": sold_pct,
                "sellNumber": sell_number,
                "secondsFromPeakToSell": (
                    max(0.0, (int(block_time) * 1000 - int(bag["peakAtMs"])) / 1000.0)
                    if block_time and bag.get("peakAtMs")
                    else None
                ),
                "sizeUsdProceeds": size_usd,
                "costBasisUsd": cost_basis,
                "cashPnlUsd": cash_pnl,
                "proceedsEstimatedLegs": proceeds_est_legs,
                "proceedsMissingLegs": proceeds_missing_legs,
            },
        }

    def observe_leader(self, leader: str) -> None:
        sigs: list[dict[str, Any]] = []
        before: str | None = None
        cursor = self.signature_cursor.get(leader)
        for _ in range(self.catchup_pages):
            opts: dict[str, Any] = {"limit": self.sig_limit, "commitment": "confirmed"}
            if before:
                opts["before"] = before
            page = rpc_call(
                self.rpc,
                "getSignaturesForAddress",
                [leader, opts],
            ) or []
            if not isinstance(page, list) or not page:
                break
            sigs.extend(x for x in page if isinstance(x, dict))
            page_sigs = [x.get("signature") for x in page if isinstance(x, dict) and x.get("signature")]
            if cursor and cursor in page_sigs:
                break
            if len(page) < self.sig_limit:
                break
            before = str(page_sigs[-1]) if page_sigs else None
            if not before:
                break
        if sigs:
            newest = sigs[0].get("signature")
            if newest:
                self.signature_cursor[leader] = str(newest)
        cutoff = time.time() - self.lookback_sec
        # Process oldest→newest so bag ledger is chronological within the poll batch.
        ordered = list(reversed(sigs))
        sol_usd = sol_usd_from_dex_cache(self._sol_cache, self.price_url)
        for s in ordered:
            sig = s.get("signature")
            if not sig or sig in self.seen:
                continue
            bt = int(s.get("blockTime") or 0)
            # Remember with its blockTime so pruning can be age-based.
            stamp = bt if bt > 0 else int(time.time())
            if bt and bt < cutoff:
                self.seen[sig] = stamp
                continue
            self.seen[sig] = stamp
            tx = rpc_call(
                self.rpc,
                "getTransaction",
                [
                    sig,
                    {
                        "encoding": "jsonParsed",
                        "maxSupportedTransactionVersion": 0,
                        "commitment": "confirmed",
                    },
                ],
            )
            if not tx or (tx.get("meta") or {}).get("err") is not None:
                continue
            pre = (tx.get("meta") or {}).get("preTokenBalances") or []
            post = (tx.get("meta") or {}).get("postTokenBalances") or []
            block_time = tx.get("blockTime")
            observe_lag_ms = None
            if block_time:
                observe_lag_ms = max(0, int(time.time() * 1000) - int(block_time) * 1000)

            quote = quote_leg_deltas(leader, pre, post, sol_usd, tx)

            keys: dict[tuple[Any, str], list[Any]] = {}
            for b in pre:
                if b.get("owner") == leader:
                    keys[(b.get("accountIndex"), b.get("mint"))] = [b, None]
            for b in post:
                if b.get("owner") == leader:
                    k = (b.get("accountIndex"), b.get("mint"))
                    keys.setdefault(k, [None, None])[1] = b

            for (_idx, mint), (a, b) in keys.items():
                if not mint or mint in QUOTE_MINTS:
                    continue
                pre_ui = ui_amt(a)
                post_ui = ui_amt(b)
                delta = post_ui - pre_ui
                if abs(delta) <= FLAT_UI_EPS:
                    continue

                side = "buy" if delta > 0 else "sell"
                if side == "sell" and not self.log_sells:
                    continue

                if side == "sell":
                    # The canonical sell feed must see the RPC event before any
                    # Dex/holder enrichment below can block or fail.
                    rpc_fills = fill_metrics(delta, quote, None)
                    qdelta = quote.get("quoteUsdDelta")
                    received_from_rpc = (
                        abs(float(qdelta))
                        if isinstance(qdelta, (int, float)) and abs(float(qdelta)) > 0
                        else rpc_fills.get("sizeUsd")
                    )
                    self.emit_trade(
                        {
                            "kind": "trade_fill",
                            "actor": "leader",
                            "wallet": leader,
                            "leader": leader,
                            "mint": mint,
                            "side": "sell",
                            "ok": True,
                            "signature": sig,
                            "sizeUsdIntent": rpc_fills.get("sizeUsd"),
                            "quoteSpentUsd": None,
                            "quoteReceivedUsd": received_from_rpc,
                            "cashDeltaUsd": (
                                float(received_from_rpc)
                                if received_from_rpc
                                else None
                            ),
                            "fillPriceUsd": rpc_fills.get("fillPriceUsd"),
                            "cashSource": "observed_delta" if qdelta else "quote",
                            "counterLegMints": None,
                            "source": "leader_observer",
                            "blockTime": block_time,
                        }
                    )
                dex = fetch_dex(
                    mint,
                    max_wait_ms=1000,
                    timeout_sec=2.0,
                )
                dex_px = None
                if isinstance(dex, dict) and not dex.get("error"):
                    try:
                        dex_px = float(dex.get("priceUsd") or 0) or None
                    except (TypeError, ValueError):
                        dex_px = None
                pc = (dex or {}).get("pc5m") if isinstance(dex, dict) else None
                gates = gate_fit(dex if isinstance(dex, dict) else None)
                td = turn_dump_snapshot(dex if isinstance(dex, dict) else None)
                fills = fill_metrics(delta, quote, dex_px)
                ts_ms = int(time.time() * 1000)
                cls = classify(pc)
                trade_ctx = self._trade_context(leader, mint, side, ts_ms)
                tx_meta = _transaction_metadata(tx)
                buys5m = dex.get("buys5m") if isinstance(dex, dict) else None
                sells5m = dex.get("sells5m") if isinstance(dex, dict) else None
                txns5m = (
                    _finite_number(buys5m) + _finite_number(sells5m)
                    if _finite_number(buys5m) is not None and _finite_number(sells5m) is not None
                    else None
                )
                size_usd = fills.get("sizeUsd")
                vol5m = dex.get("vol5m") if isinstance(dex, dict) else None
                liq = dex.get("liq") if isinstance(dex, dict) else None
                fill_dex_delta = (
                    (float(fills["fillPriceUsd"]) / float(dex_px) - 1) * 100
                    if _finite_number(fills.get("fillPriceUsd"), positive=True)
                    and dex_px
                    and dex_px > 0
                    else None
                )
                trade_derived = {
                    "sizePctOfLiq": _pct_ratio(size_usd, liq),
                    "sizePctOfVol5m": _pct_ratio(size_usd, vol5m),
                    "txns5m": txns5m,
                    "buyShare5m": (
                        _finite_number(buys5m) / txns5m
                        if _finite_number(buys5m) is not None and txns5m and txns5m > 0
                        else None
                    ),
                    "txnsImbalance5m": (
                        _finite_number(buys5m) - _finite_number(sells5m)
                        if _finite_number(buys5m) is not None and _finite_number(sells5m) is not None
                        else None
                    ),
                    "fillVsDexMidPct": fill_dex_delta,
                }

                base = {
                    "leader": leader,
                    "signature": sig,
                    "blockTime": block_time,
                    "blockIso": utc_iso(block_time) if block_time else None,
                    "observeLagMs": observe_lag_ms,
                    "mint": mint,
                    "side": side,
                    "tokenDelta": delta,
                    "tokenPreUi": pre_ui,
                    "tokenPostUi": post_ui,
                    "quoteSolDelta": quote.get("quoteSolDelta"),
                    "quoteSolNativeDelta": quote.get("quoteSolNativeDelta"),
                    "quoteSolSplDelta": quote.get("quoteSolSplDelta"),
                    "quoteSolNativeReadable": quote.get("quoteSolNativeReadable"),
                    "quoteUsdcDelta": quote.get("quoteUsdcDelta"),
                    "quoteUsdDelta": quote.get("quoteUsdDelta"),
                    "sizeUsd": fills.get("sizeUsd"),
                    "fillPriceUsd": fills.get("fillPriceUsd"),
                    "sizeUsdSource": fills.get("sizeUsdSource"),
                    "sizeUsdEstimated": fills.get("sizeUsdEstimated"),
                    "fillPriceSource": fills.get("fillPriceSource"),
                    "dexPriceUsd": dex_px,
                    "dex": dex,
                    "class": cls,
                    "gates": gates,
                    "turnDump": td,
                    **tx_meta,
                    **trade_derived,
                }

                if side == "buy":
                    previous_closed = (
                        (self.last_closed_by_mint.get(leader) or {}).get(mint)
                    )
                    bag_info = self._update_bag_buy(
                        leader,
                        mint,
                        token_ui=post_ui,
                        fill_px=fills.get("fillPriceUsd"),
                        size_usd=fills.get("sizeUsd"),
                        block_time=block_time,
                        signature=sig,
                        size_estimated=bool(fills.get("sizeUsdEstimated")),
                    )
                    bag = bag_info.get("bag") or {}
                    open_count, open_capital = self._open_capital()
                    if bag_info["isNewBag"] and bag:
                        bag["entryClass"] = cls
                        bag["entryGates"] = gates
                        bag["entryTurnDump"] = td
                        self._set_bag(leader, mint, bag)
                    base.update(
                        {
                            "kind": "leader_buy_observed",
                            "isNewBag": bag_info["isNewBag"],
                            "isAdd": bag_info["isAdd"],
                            "bagTokenUi": post_ui,
                            "bagEntryPriceUsd": bag.get("entryPriceUsd"),
                            "bagCostUsd": bag.get("costUsd"),
                            **trade_ctx,
                            "openBagCount": open_count,
                            "openCapitalUsd": open_capital,
                            "buyNumberInSession": bag.get("buys"),
                            "previousLeaderExitPriceUsd": (
                                previous_closed.get("exitPriceUsd")
                                if previous_closed
                                else None
                            ),
                            "msSincePreviousLeaderExit": (
                                max(0, ts_ms - int(previous_closed.get("exitTimeMs")))
                                if previous_closed and previous_closed.get("exitTimeMs")
                                else None
                            ),
                            "entryVsPreviousLeaderExitPct": (
                                (float(fills["fillPriceUsd"]) / float(previous_closed["exitPriceUsd"]) - 1) * 100
                                if previous_closed
                                and fills.get("fillPriceUsd")
                                and _finite_number(previous_closed.get("exitPriceUsd"), positive=True)
                                else None
                            ),
                            "isReentry": previous_closed is not None,
                            **(
                                self._holder_metrics(mint, ts_ms)
                                if bag_info["isNewBag"]
                                else {
                                    "largestHolderSharePct": None,
                                    "top10HolderSharePct": None,
                                    "holderAccountCount": None,
                                }
                            ),
                        }
                    )
                    self.emit(base)
                    qdelta = quote.get("quoteUsdDelta")
                    spent = (
                        abs(float(qdelta))
                        if isinstance(qdelta, (int, float)) and abs(float(qdelta)) > 0
                        else fills.get("sizeUsd")
                    )
                    # 1.11.902 — same gap on the way in: a token-for-token buy
                    # pays with a third SPL token, so cost is what they gave up.
                    counter_src = None
                    if not spent:
                        cl = counter_leg_deltas(leader, pre, post, mint)
                        spent, priced = self.counter_leg_usd(cl, False)
                        if spent:
                            counter_src = ",".join(m[:8] for m in priced)
                    self.emit_trade(
                        {
                            "kind": "trade_fill",
                            "actor": "leader",
                            "wallet": leader,
                            "leader": leader,
                            "mint": mint,
                            "side": "buy",
                            "ok": True,
                            "signature": sig,
                            "sizeUsdIntent": fills.get("sizeUsd"),
                            "quoteSpentUsd": spent,
                            "quoteReceivedUsd": None,
                            # Buy always spends quote — force negative cash delta.
                            "cashDeltaUsd": (-float(spent) if spent else None),
                            "fillPriceUsd": fills.get("fillPriceUsd"),
                            "cashSource": (
                                "observed_delta"
                                if qdelta
                                else ("counter_leg" if counter_src else "quote")
                            ),
                            "counterLegMints": counter_src,
                            "source": "leader_observer",
                            "blockTime": block_time,
                        }
                    )
                    if bag_info["isNewBag"]:
                        self.emit(
                            {
                                "kind": "leader_session_open",
                                "leader": leader,
                                "mint": mint,
                                "signature": sig,
                                "blockTime": block_time,
                                "blockIso": utc_iso(block_time) if block_time else None,
                                "entryPriceUsd": fills.get("fillPriceUsd"),
                                "sizeUsd": fills.get("sizeUsd"),
                                "tokenUi": post_ui,
                                "class": cls,
                                "gates": gates,
                                "turnDump": td,
                            }
                        )
                    try:
                        self.upsert_seed(
                            mint,
                            leader,
                            sig,
                            ts_ms,
                            fill_price_usd=fills.get("fillPriceUsd"),
                            size_usd=fills.get("sizeUsd"),
                            cls=cls,
                            block_time=block_time,
                            is_add=bool(bag_info.get("isAdd")),
                            dex=dex if isinstance(dex, dict) else None,
                        )
                    except Exception as e:
                        self.emit(
                            {
                                "kind": "leader_observer_seed_error",
                                "mint": mint,
                                "error": str(e)[:200],
                            }
                        )
                else:
                    bag_info = self._update_bag_sell(
                        leader,
                        mint,
                        token_ui=post_ui,
                        size_usd=fills.get("sizeUsd"),
                        fill_px=fills.get("fillPriceUsd"),
                        block_time=block_time,
                        signature=sig,
                        size_estimated=bool(fills.get("sizeUsdEstimated")),
                    )
                    sess = bag_info.get("session") or {}
                    base.update(
                        {
                            "kind": "leader_sell_observed",
                            "isFlat": bag_info.get("isFlat"),
                            "isPartial": bag_info.get("isPartial"),
                            "bagTokenUi": post_ui,
                            "soldUi": sess.get("soldUi"),
                            "pnlPctApprox": sess.get("pnlPctApprox"),
                            "heldSec": sess.get("heldSec"),
                            "entryPriceUsd": sess.get("entryPriceUsd"),
                            "exitPriceUsd": sess.get("exitPriceUsd") or fills.get("fillPriceUsd"),
                            **trade_ctx,
                            "openBagCount": self._open_capital()[0],
                            "openCapitalUsd": self._open_capital()[1],
                            "soldPctThisSell": sess.get("soldPctThisSell"),
                            "sellNumber": sess.get("sellNumber"),
                            "peakPriceUsd": sess.get("peakPriceUsd"),
                            "troughPriceUsd": sess.get("troughPriceUsd"),
                            "mfePct": sess.get("mfePct"),
                            "maePct": sess.get("maePct"),
                            "buys": sess.get("buys"),
                            "sells": sess.get("sells"),
                            "mfePctAtExit": sess.get("mfePctAtExit"),
                            "secondsFromPeakToSell": sess.get("secondsFromPeakToSell"),
                        }
                    )
                    qdelta = quote.get("quoteUsdDelta")
                    received = (
                        abs(float(qdelta))
                        if isinstance(qdelta, (int, float)) and abs(float(qdelta)) > 0
                        else fills.get("sizeUsd")
                    )
                    # 1.11.902 — a route that paid out in a third SPL token moves
                    # no quote leg, and if the sold mint has no Dex price either
                    # the proceeds were simply lost. Value what they received.
                    counter_src = None
                    if not received:
                        cl = counter_leg_deltas(leader, pre, post, mint)
                        received, priced = self.counter_leg_usd(cl, True)
                        if received:
                            counter_src = ",".join(m[:8] for m in priced)
                    base.update(
                        {
                            "markPnlPct": sess.get("pnlPctApprox"),
                            "cashPnlUsd": sess.get("cashPnlUsd"),
                            "costBasisUsd": sess.get("costBasisUsd"),
                            "quoteReceivedUsd": received,
                            "cashSource": (
                                "observed_delta"
                                if qdelta
                                else ("counter_leg" if counter_src else "quote")
                            ),
                            "counterLegMints": counter_src,
                        }
                    )
                    self.emit(base)
                    if bag_info.get("isFlat"):
                        self.emit(
                            {
                                "kind": "leader_session_flat",
                                "leader": leader,
                                "mint": mint,
                                "signature": sig,
                                "blockTime": block_time,
                                "blockIso": utc_iso(block_time) if block_time else None,
                                "openedSignature": sess.get("openedSignature"),
                                "openedBlockTime": sess.get("openedBlockTime"),
                                "entryPriceUsd": sess.get("entryPriceUsd"),
                                "exitPriceUsd": sess.get("exitPriceUsd") or fills.get("fillPriceUsd"),
                                "pnlPctApprox": sess.get("pnlPctApprox"),
                                "heldSec": sess.get("heldSec"),
                                "sizeUsdProceeds": sess.get("sizeUsdProceeds"),
                                "totalCostUsd": sess.get("totalCostUsd"),
                                "totalProceedsUsd": sess.get("totalProceedsUsd"),
                                "cashPnlUsd": (
                                    (sess.get("totalProceedsUsd") or 0)
                                    - (sess.get("totalCostUsd") or 0)
                                    if sess.get("totalCostUsd") is not None
                                    else sess.get("cashPnlUsd")
                                ),
                                "entryClass": sess.get("entryClass"),
                                "entryGates": sess.get("entryGates"),
                                "entryTurnDump": sess.get("entryTurnDump"),
                                "exitClass": cls,
                                "exitGates": gates,
                                "exitTurnDump": td,
                                "mfePct": sess.get("mfePct"),
                                "maePct": sess.get("maePct"),
                                "peakPriceUsd": sess.get("peakPriceUsd"),
                                "mfePctAtExit": sess.get("mfePctAtExit"),
                                "soldPctThisSell": sess.get("soldPctThisSell"),
                                "sellNumber": sess.get("sellNumber"),
                                "secondsFromPeakToSell": sess.get("secondsFromPeakToSell"),
                                "peakAtMs": sess.get("peakAtMs"),
                                "troughPriceUsd": sess.get("troughPriceUsd"),
                                "maxBouncePct": sess.get("maxBouncePct"),
                                "givebackPctAtExit": sess.get("givebackPctAtExit"),
                                "bouncePctAtExit": sess.get("bouncePctAtExit"),
                                "armedMfe5": sess.get("armedMfe5"),
                                "armedMfe8": sess.get("armedMfe8"),
                                "armedMfe10": sess.get("armedMfe10"),
                                "armedMfe12": sess.get("armedMfe12"),
                                "isTdEntry": sess.get("isTdEntry"),
                                "buys": sess.get("buys"),
                                "sells": sess.get("sells"),
                            }
                        )
                        buy_cost = float(sess.get("totalCostUsd") or 0)
                        sell_proceeds = float(sess.get("totalProceedsUsd") or 0)
                        self.emit_trade(
                            {
                                "kind": "trade_roundtrip",
                                "actor": "leader",
                                "wallet": leader,
                                "leader": leader,
                                "mint": mint,
                                "buyCostUsd": round(buy_cost, 6),
                                "sellProceedsUsd": round(sell_proceeds, 6),
                                "cashPnlUsd": round(sell_proceeds - buy_cost, 6),
                                "holdSec": sess.get("heldSec"),
                                "openedAtMs": (
                                    int(sess["openedBlockTime"]) * 1000
                                    if sess.get("openedBlockTime")
                                    else None
                                ),
                                "closedAtMs": int(block_time) * 1000 if block_time else None,
                                "source": "leader_observer",
                                "signature": sig,
                            }
                        )

    def _open_bags(self) -> list[tuple[str, str, dict[str, Any]]]:
        out: list[tuple[str, str, dict[str, Any]]] = []
        for leader, by_mint in list(self.bags.items()):
            for mint, bag in list((by_mint or {}).items()):
                if not isinstance(bag, dict):
                    continue
                if float(bag.get("tokenUi") or 0) <= FLAT_UI_EPS:
                    continue
                out.append((leader, mint, bag))
        return out

    def _telemetry_bags(self) -> list[tuple[str, str, dict[str, Any]]]:
        now_ms = int(time.time() * 1000)
        cutoff_ms = now_ms - self.telemetry_dead_bag_sec * 1000
        out = []
        for leader, mint, bag in self._open_bags():
            last_trade = max(
                int((self.last_trade_by_mint_ms.get(leader) or {}).get(mint) or 0),
                int(bag.get("lastBuyBlockTime") or 0) * 1000,
                int(bag.get("lastSellBlockTime") or 0) * 1000,
                int(bag.get("openedBlockTime") or 0) * 1000,
            )
            if last_trade and last_trade < cutoff_ms:
                continue
            out.append((leader, mint, bag))
        return sorted(out, key=lambda item: (item[0], item[1]))

    def _rotating_telemetry_bags(self) -> list[tuple[str, str, dict[str, Any]]]:
        bags = self._telemetry_bags()
        if not bags:
            return []
        if self._telemetry_cursor is None:
            return bags
        for index, (leader, mint, _bag) in enumerate(bags):
            if (leader, mint) > self._telemetry_cursor:
                return bags[index:] + bags[:index]
        return bags

    def _refresh_dex_cache(self, mint: str, bag: dict[str, Any], now_ms: int, force: bool = False) -> dict[str, Any] | None:
        last = int(bag.get("lastDexAtMs") or 0)
        cached = bag.get("lastDex") if isinstance(bag.get("lastDex"), dict) else None
        if (
            not force
            and cached
            and not cached.get("error")
            and last
            and now_ms - last < self.dex_refresh_sec * 1000
        ):
            return cached
        dex = fetch_dex(mint)
        if isinstance(dex, dict):
            bag["lastDex"] = dex
            bag["lastDexAtMs"] = now_ms
        return dex if isinstance(dex, dict) else cached

    def _exit_feature_row(
        self,
        *,
        kind: str,
        leader: str,
        mint: str,
        bag: dict[str, Any],
        px: float | None,
        price_source: str,
        dex: dict[str, Any] | None,
        path: dict[str, float] | None,
        now_ms: int,
    ) -> dict[str, Any]:
        entry = bag.get("entryPriceUsd")
        opened_bt = bag.get("openedBlockTime")
        held_sec = max(0, int(time.time()) - int(opened_bt)) if opened_bt else None
        held_ms = max(0, now_ms - int(opened_bt) * 1000) if opened_bt else None
        pc = None
        if isinstance(dex, dict) and not dex.get("error"):
            pc = dex.get("pc5m")
        td_entry = bag.get("entryTurnDump") if isinstance(bag.get("entryTurnDump"), dict) else None
        dex_ok = isinstance(dex, dict) and not dex.get("error")
        row: dict[str, Any] = {
            "kind": kind,
            "leader": leader,
            "mint": mint,
            "tokenUi": bag.get("tokenUi"),
            "entryPriceUsd": entry,
            "markPriceUsd": px,
            "priceSource": price_source,
            "pnlPctApprox": path.get("pnlPct") if path else None,
            "pnlPct": path.get("pnlPct") if path else None,
            "mfePct": bag.get("mfePct"),
            "maePct": bag.get("maePct"),
            "peakPriceUsd": bag.get("peakPriceUsd"),
            "troughPriceUsd": bag.get("troughPriceUsd"),
            "givebackPct": path.get("givebackPct") if path else None,
            "bouncePct": path.get("bouncePct") if path else None,
            "ddFromPeakPct": path.get("ddFromPeakPct") if path else None,
            "maxBouncePct": bag.get("maxBouncePct"),
            "armedMfe5": bool(bag.get("armedMfe5")),
            "armedMfe8": bool(bag.get("armedMfe8")),
            "armedMfe10": bool(bag.get("armedMfe10")),
            "armedMfe12": bool(bag.get("armedMfe12")),
            "armedMfe5AtMs": bag.get("armedMfe5AtMs"),
            "armedMfe8AtMs": bag.get("armedMfe8AtMs"),
            "armedMfe10AtMs": bag.get("armedMfe10AtMs"),
            "armedMfe12AtMs": bag.get("armedMfe12AtMs"),
            "durNeg8": int(bag.get("durNeg8") or 0),
            "durNeg10": int(bag.get("durNeg10") or 0),
            "durNeg12": int(bag.get("durNeg12") or 0),
            "durNeg15": int(bag.get("durNeg15") or 0),
            "durNeg20": int(bag.get("durNeg20") or 0),
            "durNeg25": int(bag.get("durNeg25") or 0),
            "heldSec": held_sec,
            "heldMs": held_ms,
            "openedBlockTime": opened_bt,
            "costUsd": bag.get("costUsd"),
            "entryClass": bag.get("entryClass"),
            "entryBranch": (td_entry or {}).get("branch") if td_entry else None,
            "isTdEntry": entry_is_td(bag),
            "class": classify(pc),
            "pc5m": dex.get("pc5m") if dex_ok else None,
            "pc1h": dex.get("pc1h") if dex_ok else None,
            "vol5m": dex.get("vol5m") if dex_ok else None,
            "vol1h": dex.get("vol1h") if dex_ok else None,
            "liq": dex.get("liq") if dex_ok else None,
            "mcap": dex.get("mcap") if dex_ok else None,
            "turn": dex.get("turnover5mLiq") if dex_ok else None,
            "ageHours": dex.get("ageHours") if dex_ok else None,
            "buys5m": dex.get("buys5m") if dex_ok else None,
            "sells5m": dex.get("sells5m") if dex_ok else None,
            "dexAgeSec": (
                max(0.0, (now_ms - int(bag.get("lastDexAtMs") or now_ms)) / 1000.0)
                if bag.get("lastDexAtMs")
                else None
            ),
            "gates": gate_fit(dex if dex_ok else None),
            "turnDump": turn_dump_snapshot(dex if dex_ok else None),
            "dex": dex if kind == "leader_bag_mark" else None,
        }
        if kind == "leader_bag_tick":
            row.pop("dex", None)
        return row

    def emit_bag_marks(self, deadline: float | None = None) -> int:
        if not self.log_marks:
            return 0
        now_ms = int(time.time() * 1000)
        gap_ms = self.mark_min_gap_sec * 1000
        due = []
        for leader, mint, bag in self._rotating_telemetry_bags():
            if deadline is not None and time.time() >= deadline:
                break
            if (
                int(bag.get("lastMarkAtMs") or 0)
                and now_ms - int(bag.get("lastMarkAtMs") or 0) < gap_ms
            ):
                self._telemetry_cursor = (leader, mint)
                continue
            due.append((leader, mint, bag))
            if len(due) >= _TELEMETRY_BATCH_MAX:
                break
        # 1.11.819 — one batched call for the whole pass instead of one per bag.
        if due:
            remaining_ms = (
                max(0.0, (deadline - time.time()) * 1000)
                if deadline is not None
                else None
            )
            fetched = fetch_dex_batch(
                sorted({mint for _l, mint, _b in due}),
                max_wait_ms=remaining_ms,
                timeout_sec=max(0.1, (remaining_ms or 15_000) / 1000),
            )
        else:
            fetched = {}
        processed = 0
        for leader, mint, bag in due:
            if deadline is not None and time.time() >= deadline:
                break
            entry = bag.get("entryPriceUsd")
            dex = fetched.get(mint)
            if isinstance(dex, dict):
                bag["lastDex"] = dex
                bag["lastDexAtMs"] = now_ms
            px = None
            if isinstance(dex, dict) and not dex.get("error"):
                try:
                    px = float(dex.get("priceUsd") or 0) or None
                except (TypeError, ValueError):
                    px = None
            path = None
            if (
                isinstance(entry, (int, float))
                and entry > 0
                and px
                and plausible_mark(float(px), bag, float(entry))
            ):
                path = apply_path_metrics(bag, px, float(entry))
            bag["lastMarkAtMs"] = now_ms
            self._set_bag(leader, mint, bag)
            self._telemetry_cursor = (leader, mint)
            self.emit(
                self._exit_feature_row(
                    kind="leader_bag_mark",
                    leader=leader,
                    mint=mint,
                    bag=bag,
                    px=px,
                    price_source="dex",
                    dex=dex,
                    path=path,
                    now_ms=now_ms,
                )
            )
            processed += 1
        return processed

    def emit_dense_ticks(self, deadline: float | None = None) -> int:
        if not self.dense_ticks:
            return 0
        now_ms = int(time.time() * 1000)
        gap_ms = self.dense_gap_sec * 1000
        open_bags = self._rotating_telemetry_bags()
        if not open_bags:
            return 0
        due: list[tuple[str, str, dict[str, Any]]] = []
        for leader, mint, bag in open_bags:
            if deadline is not None and time.time() >= deadline:
                break
            if self.dense_only_td and not entry_is_td(bag):
                self._telemetry_cursor = (leader, mint)
                continue
            last = int(bag.get("lastDenseAtMs") or 0)
            if last and now_ms - last < gap_ms:
                self._telemetry_cursor = (leader, mint)
                continue
            due.append((leader, mint, bag))
            if len(due) >= _TELEMETRY_BATCH_MAX:
                break
        if not due:
            return 0
        mints = sorted({mint for _, mint, _ in due})
        remaining_ms = (
            max(0.0, (deadline - time.time()) * 1000)
            if deadline is not None
            else None
        )
        jup = fetch_jupiter_prices(
            mints,
            self.price_url,
            timeout_sec=max(0.1, (remaining_ms or 8_000) / 1000),
        )
        # 1.11.819 — warm the batch cache once; the per-bag call below is a hit.
        stale = [
            m
            for m in mints
            if not (
                (b := next((bg for _l, mt, bg in due if mt == m), None))
                and isinstance(b.get("lastDex"), dict)
                and not b["lastDex"].get("error")
                and int(b.get("lastDexAtMs") or 0)
                and now_ms - int(b.get("lastDexAtMs") or 0) < self.dex_refresh_sec * 1000
            )
        ]
        if stale:
            dex_fetched = fetch_dex_batch(
                stale,
                max_wait_ms=(
                    max(0.0, (deadline - time.time()) * 1000)
                    if deadline is not None
                    else None
                ),
                timeout_sec=max(
                    0.1,
                    (
                        max(0.0, (deadline - time.time()) * 1000)
                        if deadline is not None
                        else 15_000
                    )
                    / 1000,
                ),
            )
            for leader, mint, bag in due:
                dex = dex_fetched.get(mint)
                if isinstance(dex, dict):
                    bag["lastDex"] = dex
                    bag["lastDexAtMs"] = now_ms
        processed = 0
        for leader, mint, bag in due:
            if deadline is not None and time.time() >= deadline:
                break
            entry = bag.get("entryPriceUsd")
            dex = bag.get("lastDex") if isinstance(bag.get("lastDex"), dict) else None
            px = jup.get(mint)
            price_source = "jupiter"
            if not px or px <= 0:
                if isinstance(dex, dict) and not dex.get("error"):
                    try:
                        px = float(dex.get("priceUsd") or 0) or None
                    except (TypeError, ValueError):
                        px = None
                    price_source = "dex"
                else:
                    px = None
                    price_source = "none"
            path = None
            if (
                isinstance(entry, (int, float))
                and float(entry) > 0
                and px
                and plausible_mark(float(px), bag, float(entry))
            ):
                path = apply_path_metrics(bag, float(px), float(entry))
            bag["lastDenseAtMs"] = now_ms
            self._set_bag(leader, mint, bag)
            self._telemetry_cursor = (leader, mint)
            row = self._exit_feature_row(
                kind="leader_bag_tick",
                leader=leader,
                mint=mint,
                bag=bag,
                px=px,
                price_source=price_source,
                dex=dex,
                path=path,
                now_ms=now_ms,
            )
            self.emit_dense(row)
            processed += 1
        return processed

    def run(self) -> None:
        end = None if self.max_hours <= 0 else time.time() + self.max_hours * 3600
        self.emit(
            {
                "kind": "leader_observer_start",
                "leaders": self.leaders,
                "outPath": str(self.out_path),
                "densePath": str(self.dense_path),
                "seedPath": str(self.seed_path),
                "pollSec": self.poll_sec,
                "lookbackSec": self.lookback_sec,
                "sigLimit": self.sig_limit,
                "maxHours": self.max_hours,
                "logSells": self.log_sells,
                "logMarks": self.log_marks,
                "markMinGapSec": self.mark_min_gap_sec,
                "denseTicks": self.dense_ticks,
                "denseGapSec": self.dense_gap_sec,
                "dexRefreshSec": self.dex_refresh_sec,
                "denseOnlyTd": self.dense_only_td,
                "telemetryBudgetMs": self.telemetry_budget_ms,
                "telemetryDeadBagSec": self.telemetry_dead_bag_sec,
                "priceUrl": self.price_url,
                "version": "1.11.790",
            }
        )
        print(
            f"[leader-observer] start leaders={len(self.leaders)} out={self.out_path} "
            f"dense={self.dense_path} seed={self.seed_path} poll={self.poll_sec}s "
            f"sigLimit={self.sig_limit} sells={int(self.log_sells)} marks={int(self.log_marks)} "
            f"markGap={self.mark_min_gap_sec}s dense={int(self.dense_ticks)}/"
            f"{self.dense_gap_sec}s dexRefresh={self.dex_refresh_sec}s "
            f"maxHours={self.max_hours}",
            flush=True,
        )
        try:
            self.reconcile_open_bags()
        except Exception as exc:
            self.emit({
                "kind": "leader_observer_reconciliation_error",
                "reason": str(exc)[:300],
                "failClosed": True,
            })
        while end is None or time.time() < end:
            loop_t0 = time.time()
            poll_interval_ms = None
            if loop_t0 - self._last_sig_poll_at >= self.poll_sec:
                if self._last_sig_poll_at:
                    poll_interval_ms = int(
                        max(0.0, loop_t0 - self._last_sig_poll_at) * 1000
                    )
                for leader in self.leaders:
                    try:
                        self.observe_leader(leader)
                    except Exception as e:
                        self.emit(
                            {
                                "kind": "leader_observer_error",
                                "leader": leader,
                                "error": str(e)[:300],
                            }
                        )
                self._last_sig_poll_at = loop_t0
            telemetry_deadline = loop_t0 + self.telemetry_budget_ms / 1000.0
            bags_processed = 0
            try:
                bags_processed += self.emit_bag_marks(telemetry_deadline)
            except Exception as e:
                self.emit({"kind": "leader_observer_error", "error": f"marks:{str(e)[:200]}"})
            try:
                if time.time() < telemetry_deadline:
                    bags_processed += self.emit_dense_ticks(telemetry_deadline)
            except Exception as e:
                self.emit({"kind": "leader_observer_error", "error": f"dense:{str(e)[:200]}"})
            # Persist often enough for crash recovery, not every tick.
            if loop_t0 - self._last_state_save_at >= max(2.0, float(self.poll_sec)):
                self._save_state()
                self._last_state_save_at = loop_t0
            cycle_due = loop_t0 - self._last_cycle_emit_at >= 30.0
            poll_late = (
                poll_interval_ms is not None
                and poll_interval_ms >= self.poll_sec * 2000
            )
            if cycle_due or poll_late:
                self.emit(
                    {
                        "kind": "leader_observer_cycle",
                        "bagsProcessed": bags_processed,
                        "cycleDurationMs": int(max(0.0, time.time() - loop_t0) * 1000),
                        "signaturePollIntervalMs": poll_interval_ms,
                    }
                )
                self._last_cycle_emit_at = loop_t0
            # Sleep until next dense tick (or poll if dense off / no bags).
            open_n = len(self._open_bags())
            if self.dense_ticks and open_n > 0:
                target = float(self.dense_gap_sec)
            else:
                target = float(self.poll_sec)
            elapsed = time.time() - loop_t0
            time.sleep(max(0.05, target - elapsed))
        self._save_state()
        self.emit({"kind": "leader_observer_done", "outPath": str(self.out_path), "densePath": str(self.dense_path)})
        print("[leader-observer] done", flush=True)


if __name__ == "__main__":
    Observer().run()
