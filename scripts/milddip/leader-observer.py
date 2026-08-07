#!/usr/bin/env python3
"""
Shadow logger for mild-dip leader wallets.

Polls leader signatures, detects token buys, snapshots DexScreener at observe
time, classifies the 5m tape, and records whether current mild-dip gates would
have taken the name. Does not trade.

Env:
  LEADER_OBSERVER_RPC_URL   — required unless mild-dip-bot pm2 env is readable
  LEADER_OBSERVER_LEADERS   — comma wallets (default: 8zkg + 7BNax)
  LEADER_OBSERVER_OUT_DIR   — default data/milddip
  LEADER_OBSERVER_POLL_SEC  — default 15
  LEADER_OBSERVER_LOOKBACK_SEC — ignore older sigs (default 900)
  LEADER_OBSERVER_MAX_HOURS — 0 = run forever (default 72)
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_LEADERS = [
    "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ",
    "7BNaxx6KdUYrACNQZ9He26NBFoFxujQMAfNLnArLGH5",
]
QUOTE_MINTS = {
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
}


def env_num(name: str, default: float) -> float:
    v = os.environ.get(name, "").strip()
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        return default


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
        return "mild_deep"  # (-20,-10] our main band lower half / knife-stabilize edge
    if pc <= -5:
        return "mild_shallow"
    return "shallow"


def gate_fit(d: dict[str, Any] | None) -> dict[str, Any]:
    """Compare Dex snapshot vs current live mild-dip entry stack."""
    if not d or d.get("error"):
        return {"main": False, "h1_red_shallow": False, "knife_watch": False, "reason": "no_dex"}
    pc = d.get("pc5m")
    h1 = d.get("pc1h")
    vol = float(d.get("vol5m") or 0)
    liq = float(d.get("liq") or 0)
    mcap = float(d.get("mcap") or 0)
    age = d.get("ageHours")
    turn = d.get("turnover5mLiq")

    structural = (
        vol >= 500
        and liq >= 5000
        and mcap >= 10000
        and (age is None or float(age) >= 0.25)
        and not (turn is not None and float(turn) > 0.8)
    )
    try:
        pc_f = float(pc) if pc is not None else None
    except (TypeError, ValueError):
        pc_f = None
    try:
        h1_f = float(h1) if h1 is not None else None
    except (TypeError, ValueError):
        h1_f = None

    main = bool(structural and pc_f is not None and -20 < pc_f <= -10)
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
        self.state_path = self.out_dir / "leader-observer-state.json"
        self.seen: set[str] = set()
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
        except Exception:
            self.seen = set()

    def _save_state(self) -> None:
        # Keep a bounded ring so restarts do not re-emit recent buys.
        sigs = list(self.seen)[-5000:]
        self.seen = set(sigs)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"seenSignatures": sigs, "updatedAt": utc_iso()}) + "\n")
        tmp.replace(self.state_path)

    def emit(self, payload: dict[str, Any]) -> None:
        # Rotate daily file without restart.
        today = self._out_path_for_today()
        if today != self.out_path:
            self.out_path = today
        payload.setdefault("tsMs", int(time.time() * 1000))
        payload.setdefault("iso", utc_iso())
        with self.out_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def observe_leader(self, leader: str) -> None:
        sigs = rpc_call(self.rpc, "getSignaturesForAddress", [leader, {"limit": 40}]) or []
        cutoff = time.time() - self.lookback_sec
        for s in sigs:
            sig = s.get("signature")
            if not sig or sig in self.seen:
                continue
            bt = s.get("blockTime") or 0
            if bt and bt < cutoff:
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
                delta = ui_amt(b) - ui_amt(a)
                if delta <= 0:
                    continue
                dex = fetch_dex(mint)
                pc = (dex or {}).get("pc5m") if isinstance(dex, dict) else None
                gates = gate_fit(dex if isinstance(dex, dict) else None)
                self.emit(
                    {
                        "kind": "leader_buy_observed",
                        "leader": leader,
                        "signature": sig,
                        "blockTime": tx.get("blockTime"),
                        "blockIso": utc_iso(tx.get("blockTime")) if tx.get("blockTime") else None,
                        "mint": mint,
                        "tokenDelta": delta,
                        "dex": dex,
                        "class": classify(pc),
                        "gates": gates,
                    }
                )

    def run(self) -> None:
        end = None if self.max_hours <= 0 else time.time() + self.max_hours * 3600
        self.emit(
            {
                "kind": "leader_observer_start",
                "leaders": self.leaders,
                "outPath": str(self.out_path),
                "pollSec": self.poll_sec,
                "lookbackSec": self.lookback_sec,
                "maxHours": self.max_hours,
            }
        )
        print(
            f"[leader-observer] start leaders={len(self.leaders)} out={self.out_path} "
            f"poll={self.poll_sec}s maxHours={self.max_hours}",
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
            self._save_state()
            time.sleep(self.poll_sec)
        self.emit({"kind": "leader_observer_done", "outPath": str(self.out_path)})
        print("[leader-observer] done", flush=True)


if __name__ == "__main__":
    Observer().run()
