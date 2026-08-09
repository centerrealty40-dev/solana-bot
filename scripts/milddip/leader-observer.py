#!/usr/bin/env python3
"""
Shadow logger for mild-dip leader wallets.

Polls leader signatures, detects token buys AND sells, derives fill size from
quote-leg deltas, snapshots DexScreener, classifies the 5m tape, records whether
current mild-dip gates would have taken the name, and maintains a per-leader
bag ledger for session open/flat events. Does not trade.

Env:
  LEADER_OBSERVER_RPC_URL   — required unless mild-dip-bot pm2 env is readable
  LEADER_OBSERVER_LEADERS   — comma wallets (default: 8zkg + 7BNax)
  LEADER_OBSERVER_OUT_DIR   — default data/milddip
  LEADER_OBSERVER_POLL_SEC  — default 15
  LEADER_OBSERVER_LOOKBACK_SEC — ignore older sigs (default 900)
  LEADER_OBSERVER_MAX_HOURS — 0 = run forever (default 72)
  LEADER_OBSERVER_SEED_PATH — sidecar for mild-dip discover (default <out>/leader-seed.json)
  LEADER_OBSERVER_SEED_MAX  — max mints in sidecar (default 40)
  LEADER_OBSERVER_SEED_MAX_AGE_SEC — drop older seed hits (default 7200)
  LEADER_OBSERVER_LOG_SELLS — 1 (default) log leader_sell_observed
  LEADER_OBSERVER_LOG_MARKS — 0 (default) optional bag marks each poll
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_LEADERS = [
    "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ",
    # 1.11.712 — correct pubkey (typo was 7BNaxx6KdUYrAC… without `j`)
    "7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5",
]
WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
QUOTE_MINTS = {WSOL, USDC, USDT}

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


def fetch_dex(mint: str) -> dict[str, Any] | None:
    try:
        req = urllib.request.Request(
            f"https://api.dexscreener.com/latest/dex/tokens/{mint}",
            headers={
                "user-agent": "Mozilla/5.0 mild-dip-leader-observer",
                "accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=12) as r:
            j = json.loads(r.read().decode())
        pairs = [p for p in (j.get("pairs") or []) if p.get("chainId") == "solana"]
        p = next((x for x in pairs if x.get("dexId") == "pumpswap"), pairs[0] if pairs else None)
        if not p:
            return None
        liq = (p.get("liquidity") or {}).get("usd")
        vol5m = (p.get("volume") or {}).get("m5")
        created = p.get("pairCreatedAt")
        age_h = None
        if created:
            age_h = max(0.0, (time.time() * 1000 - float(created)) / 3_600_000)
        turnover = None
        if liq and float(liq) > 0 and vol5m is not None:
            turnover = float(vol5m) / float(liq)
        return {
            "dexId": p.get("dexId"),
            "pairAddress": p.get("pairAddress"),
            "priceUsd": float(p.get("priceUsd") or 0),
            "pc5m": (p.get("priceChange") or {}).get("m5"),
            "pc1h": (p.get("priceChange") or {}).get("h1"),
            "vol5m": vol5m,
            "vol1h": (p.get("volume") or {}).get("h1"),
            "liq": liq,
            "mcap": p.get("marketCap") or p.get("fdv"),
            "buys5m": ((p.get("txns") or {}).get("m5") or {}).get("buys"),
            "sells5m": ((p.get("txns") or {}).get("m5") or {}).get("sells"),
            "pairCreatedAt": created,
            "ageHours": age_h,
            "turnover5mLiq": turnover,
        }
    except Exception as e:
        return {"error": str(e)}


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

    # Align with mild-dip live floor (1.11.776 → $5k; was hardcoded $50k).
    min_mcap = env_num(
        "LEADER_OBSERVER_MIN_MCAP_USD",
        env_num("MILD_DIP_MIN_MCAP_USD", 5_000.0),
    )
    structural = (
        vol >= 500
        and liq >= 10_000
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


def sol_usd_from_dex_cache(cache: dict[str, Any]) -> float | None:
    px = cache.get("solUsd")
    if isinstance(px, (int, float)) and px > 0:
        if time.time() - float(cache.get("solUsdAt") or 0) < 60:
            return float(px)
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
    return None


def quote_leg_deltas(
    leader: str,
    pre: list[dict[str, Any]],
    post: list[dict[str, Any]],
    sol_usd: float | None,
) -> dict[str, Any]:
    """Sum SOL/USDC/USDT ui deltas for the leader across the tx."""
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

    quote_usd = usdc_d + usdt_d
    if sol_usd and sol_usd > 0 and abs(sol_d) > 0:
        quote_usd += sol_d * sol_usd
    return {
        "quoteSolDelta": sol_d if abs(sol_d) > 0 else 0.0,
        "quoteUsdcDelta": usdc_d if abs(usdc_d) > 0 else 0.0,
        "quoteUsdtDelta": usdt_d if abs(usdt_d) > 0 else 0.0,
        "quoteUsdDelta": quote_usd if abs(quote_usd) > 0 else 0.0,
    }


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
    size_usd = size_from_quote if size_from_quote else size_from_dex
    fill_px = fill_from_quote if fill_from_quote else (dex_px if dex_px and dex_px > 0 else None)
    return {
        "sizeUsd": size_usd,
        "fillPriceUsd": fill_px,
        "sizeUsdSource": "quote" if size_from_quote else ("dex" if size_from_dex else None),
        "fillPriceSource": "quote" if fill_from_quote else ("dex" if fill_px else None),
    }


class Observer:
    def __init__(self) -> None:
        self.rpc = resolve_rpc()
        raw = os.environ.get("LEADER_OBSERVER_LEADERS", "").strip()
        self.leaders = [x.strip() for x in raw.split(",") if x.strip()] or list(DEFAULT_LEADERS)
        self.out_dir = Path(os.environ.get("LEADER_OBSERVER_OUT_DIR", "data/milddip"))
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.poll_sec = max(5, int(env_num("LEADER_OBSERVER_POLL_SEC", 15)))
        self.lookback_sec = max(60, int(env_num("LEADER_OBSERVER_LOOKBACK_SEC", 900)))
        self.max_hours = env_num("LEADER_OBSERVER_MAX_HOURS", 72)
        seed_env = os.environ.get("LEADER_OBSERVER_SEED_PATH", "").strip()
        self.seed_path = Path(seed_env) if seed_env else self.out_dir / "leader-seed.json"
        self.seed_max = max(1, int(env_num("LEADER_OBSERVER_SEED_MAX", 40)))
        self.seed_max_age_sec = max(60, int(env_num("LEADER_OBSERVER_SEED_MAX_AGE_SEC", 7200)))
        self.log_sells = env_bool("LEADER_OBSERVER_LOG_SELLS", True)
        self.log_marks = env_bool("LEADER_OBSERVER_LOG_MARKS", False)
        self.state_path = self.out_dir / "leader-observer-state.json"
        self.seen: set[str] = set()
        # leader -> mint -> bag state
        self.bags: dict[str, dict[str, dict[str, Any]]] = {}
        self._sol_cache: dict[str, Any] = {}
        self._load_state()
        self.out_path = self._out_path_for_today()

    def _out_path_for_today(self) -> Path:
        day = dt.datetime.utcnow().strftime("%Y%m%d")
        return self.out_dir / f"leader-observer-{day}.jsonl"

    def _load_state(self) -> None:
        try:
            raw = json.loads(self.state_path.read_text())
            sigs = raw.get("seenSignatures") or []
            self.seen = {str(s) for s in sigs if s}
            bags = raw.get("bags") or {}
            if isinstance(bags, dict):
                self.bags = bags  # type: ignore[assignment]
        except Exception:
            self.seen = set()
            self.bags = {}

    def _save_state(self) -> None:
        sigs = list(self.seen)[-5000:]
        self.seen = set(sigs)
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
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "seenSignatures": sigs,
                    "bags": self.bags,
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
        by_mint: dict[str, dict[str, Any]] = {}
        for h in hits:
            if not isinstance(h, dict):
                continue
            m = str(h.get("mint") or "")
            last = h.get("lastSeenAtMs")
            if len(m) < 32 or not isinstance(last, (int, float)):
                continue
            if int(last) < cutoff:
                continue
            by_mint[m] = dict(h)
            by_mint[m]["mint"] = m
            by_mint[m]["lastSeenAtMs"] = int(last)
        prev = by_mint.get(mint) or {}
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
        by_mint[mint] = hit
        merged = sorted(
            by_mint.values(),
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
    ) -> dict[str, Any]:
        prev = self._bag(leader, mint)
        is_new = prev is None or float(prev.get("tokenUi") or 0) <= FLAT_UI_EPS
        if is_new:
            bag = {
                "tokenUi": token_ui,
                "costUsd": float(size_usd or 0),
                "entryPriceUsd": fill_px,
                "openedBlockTime": block_time,
                "openedSignature": signature,
                "lastBuySignature": signature,
                "lastBuyBlockTime": block_time,
                "buys": 1,
                "sells": 0,
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
        if new_ui > 0 and bag["costUsd"] > 0:
            bag["entryPriceUsd"] = bag["costUsd"] / new_ui
        bag["lastBuySignature"] = signature
        bag["lastBuyBlockTime"] = block_time
        bag["buys"] = int(bag.get("buys") or 0) + 1
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
        if prev_ui > 0 and sold > 0:
            # reduce cost pro-rata
            frac = min(1.0, sold / prev_ui)
            bag["costUsd"] = max(0.0, float(prev.get("costUsd") or 0) * (1 - frac))
        if is_flat:
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
            }
            self._set_bag(leader, mint, None)
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
                "sizeUsdProceeds": size_usd,
            },
        }

    def observe_leader(self, leader: str) -> None:
        sigs = rpc_call(self.rpc, "getSignaturesForAddress", [leader, {"limit": 40}]) or []
        cutoff = time.time() - self.lookback_sec
        # Process oldest→newest so bag ledger is chronological within the poll batch.
        ordered = list(reversed(sigs))
        sol_usd = sol_usd_from_dex_cache(self._sol_cache)
        for s in ordered:
            sig = s.get("signature")
            if not sig or sig in self.seen:
                continue
            bt = s.get("blockTime") or 0
            if bt and bt < cutoff:
                self.seen.add(sig)
                continue
            self.seen.add(sig)
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

            quote = quote_leg_deltas(leader, pre, post, sol_usd)

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

                dex = fetch_dex(mint)
                dex_px = None
                if isinstance(dex, dict) and not dex.get("error"):
                    try:
                        dex_px = float(dex.get("priceUsd") or 0) or None
                    except (TypeError, ValueError):
                        dex_px = None
                pc = (dex or {}).get("pc5m") if isinstance(dex, dict) else None
                gates = gate_fit(dex if isinstance(dex, dict) else None)
                fills = fill_metrics(delta, quote, dex_px)
                ts_ms = int(time.time() * 1000)

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
                    "quoteUsdcDelta": quote.get("quoteUsdcDelta"),
                    "quoteUsdDelta": quote.get("quoteUsdDelta"),
                    "sizeUsd": fills.get("sizeUsd"),
                    "fillPriceUsd": fills.get("fillPriceUsd"),
                    "sizeUsdSource": fills.get("sizeUsdSource"),
                    "fillPriceSource": fills.get("fillPriceSource"),
                    "dexPriceUsd": dex_px,
                    "dex": dex,
                    "class": classify(pc),
                    "gates": gates,
                }

                if side == "buy":
                    bag_info = self._update_bag_buy(
                        leader,
                        mint,
                        token_ui=post_ui,
                        fill_px=fills.get("fillPriceUsd"),
                        size_usd=fills.get("sizeUsd"),
                        block_time=block_time,
                        signature=sig,
                    )
                    base.update(
                        {
                            "kind": "leader_buy_observed",
                            "isNewBag": bag_info["isNewBag"],
                            "isAdd": bag_info["isAdd"],
                            "bagTokenUi": post_ui,
                            "bagEntryPriceUsd": (bag_info.get("bag") or {}).get("entryPriceUsd"),
                            "bagCostUsd": (bag_info.get("bag") or {}).get("costUsd"),
                        }
                    )
                    self.emit(base)
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
                                "class": classify(pc),
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
                            cls=classify(pc),
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
                            }
                        )

    def emit_bag_marks(self) -> None:
        if not self.log_marks:
            return
        for leader, by_mint in list(self.bags.items()):
            for mint, bag in list(by_mint.items()):
                token_ui = float(bag.get("tokenUi") or 0)
                if token_ui <= FLAT_UI_EPS:
                    continue
                entry = bag.get("entryPriceUsd")
                dex = fetch_dex(mint)
                px = None
                if isinstance(dex, dict) and not dex.get("error"):
                    try:
                        px = float(dex.get("priceUsd") or 0) or None
                    except (TypeError, ValueError):
                        px = None
                pnl = None
                if isinstance(entry, (int, float)) and entry > 0 and px and px > 0:
                    pnl = (px / float(entry) - 1) * 100
                self.emit(
                    {
                        "kind": "leader_bag_mark",
                        "leader": leader,
                        "mint": mint,
                        "tokenUi": token_ui,
                        "entryPriceUsd": entry,
                        "markPriceUsd": px,
                        "pnlPctApprox": pnl,
                        "openedBlockTime": bag.get("openedBlockTime"),
                        "costUsd": bag.get("costUsd"),
                    }
                )

    def run(self) -> None:
        end = None if self.max_hours <= 0 else time.time() + self.max_hours * 3600
        self.emit(
            {
                "kind": "leader_observer_start",
                "leaders": self.leaders,
                "outPath": str(self.out_path),
                "seedPath": str(self.seed_path),
                "pollSec": self.poll_sec,
                "lookbackSec": self.lookback_sec,
                "maxHours": self.max_hours,
                "logSells": self.log_sells,
                "logMarks": self.log_marks,
                "version": "1.11.760",
            }
        )
        print(
            f"[leader-observer] start leaders={len(self.leaders)} out={self.out_path} "
            f"seed={self.seed_path} poll={self.poll_sec}s sells={int(self.log_sells)} "
            f"marks={int(self.log_marks)} maxHours={self.max_hours}",
            flush=True,
        )
        while end is None or time.time() < end:
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
            try:
                self.emit_bag_marks()
            except Exception as e:
                self.emit({"kind": "leader_observer_error", "error": f"marks:{str(e)[:200]}"})
            self._save_state()
            time.sleep(self.poll_sec)
        self.emit({"kind": "leader_observer_done", "outPath": str(self.out_path)})
        print("[leader-observer] done", flush=True)


if __name__ == "__main__":
    Observer().run()
