#!/usr/bin/env python3
import json
import os
from pathlib import Path

import psycopg2

ROOT = Path("/opt/solana-alpha")
for line in (ROOT / ".env").read_text().splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

LEADER = "8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ"
buys = []
for p in (ROOT / "data/milddip").glob("leader-observer-*.jsonl"):
    for line in p.open():
        e = json.loads(line)
        if e.get("leader") != LEADER or e.get("kind") != "leader_buy_observed":
            continue
        d = e.get("dex") or {}
        pc = d.get("pc5m")
        if pc is None or float(pc) >= 0:
            continue
        buys.append(e)
b = buys[100]
mint = b["mint"]
print("mint", mint, "bt", b.get("blockTime"), "dexId", (b.get("dex") or {}).get("dexId"))
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
for table in ["pumpswap_pair_snapshots", "raydium_pair_snapshots", "meteora_pair_snapshots"]:
    cur.execute(f"select count(*) from {table} where base_mint=%s", (mint,))
    c = cur.fetchone()[0]
    cur.execute(f"select count(*) from {table} where ts > now() - interval '3 days'")
    c3 = cur.fetchone()[0]
    print(table, "mint", c, "last3d", c3)
pa = (b.get("dex") or {}).get("pairAddress")
print("pairAddress", pa)
if pa:
    for table in ["pumpswap_pair_snapshots", "raydium_pair_snapshots"]:
        cur.execute(
            f"select count(*), min(ts), max(ts) from {table} where pair_address=%s",
            (pa,),
        )
        print(table, "by pair", cur.fetchone())

# How many dip mints have ANY snapshot
mints = list({x["mint"] for x in buys[:200]})
cur.execute(
    "select count(distinct base_mint) from pumpswap_pair_snapshots where base_mint = any(%s)",
    (mints,),
)
print("pumpswap hit among 200 dip mints", cur.fetchone()[0], "/", len(mints))
cur.execute(
    "select count(distinct base_mint) from raydium_pair_snapshots where base_mint = any(%s)",
    (mints,),
)
print("raydium hit among 200 dip mints", cur.fetchone()[0], "/", len(mints))

# marks coverage
need = set(mints)
have = set()
with (ROOT / "data/milddip/journal.jsonl").open(errors="ignore") as f:
    for line in f:
        for m in list(need - have):
            if m in line:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("kind") in ("mild_dip_mark", "mark") and e.get("mint") == m:
                    have.add(m)
print("marks hit among 200", len(have), "/", len(need))
