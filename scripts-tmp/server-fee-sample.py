#!/usr/bin/env python3
"""Sample meta.fee (total tx fee lamports) for recent confirmed live swaps. RPC URL read from .env (no URL printed)."""
import json
import sys
import urllib.request


def load_rpc_url(env_path: str) -> str | None:
    for raw in open(env_path, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        if k not in ("SA_RPC_HTTP_URL", "LIVE_RPC_HTTP_URL"):
            continue
        url = v.strip().strip('"').strip("'")
        if url.startswith("http"):
            return url
    return None


def rpc_post(url: str, method: str, params: list) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    env_path = sys.argv[1] if len(sys.argv) > 1 else "/opt/solana-alpha/.env"
    jsonl_path = sys.argv[2] if len(sys.argv) > 2 else "/opt/solana-alpha/data/live/pt1-oscar-live.jsonl"
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 10

    rpc = load_rpc_url(env_path)
    if not rpc:
        print("no SA_RPC_HTTP_URL / LIVE_RPC_HTTP_URL in env file")
        sys.exit(1)

    sigs: list[str] = []
    for ln in open(jsonl_path, encoding="utf-8"):
        ln = ln.strip()
        if not ln:
            continue
        try:
            j = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if j.get("channel") != "live" or j.get("kind") != "execution_result":
            continue
        if j.get("status") != "confirmed":
            continue
        sig = j.get("txSignature")
        if isinstance(sig, str) and len(sig) > 20:
            sigs.append(sig)

    tail = sigs[-n:]
    print(f"sample_n={len(tail)} (meta.fee = total signature fee lamports, incl. base + priority)")
    for sig in tail:
        try:
            out = rpc_post(rpc, "getTransaction", [sig, {"encoding": "json", "maxSupportedTransactionVersion": 0}])
            err = out.get("error")
            if err:
                print(sig[:12], "rpc_err")
                continue
            res = out.get("result")
            fee = (res or {}).get("meta", {}).get("fee")
            print(sig[:12], "fee_lamports=", fee)
        except OSError as e:
            print(sig[:12], "http_err", str(e)[:40])


if __name__ == "__main__":
    main()
