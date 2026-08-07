# Runbook — `vol-green-bot` on LERA

**Host:** `72.62.152.201` (`/opt/lera`, user `lera`)  
**Wallet:** `FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX`  
**Clip:** $5 USDC  
**Entry (default):** `green_tape` — liquid / early / rocket paths  
(`MILD_DIP_ENTRY_MODE=awakening` still available)  
**Floors (1.11.708):** liq ≥ $8k (or null if vol5m rocket-tier), mcap ≥ $18k,
pair age ≥ 0.05h, rocket pc5m ≥ 15% / vol5m ≥ $8k  
**Exit harden (1.11.709):** sticky `exitPendingReason` after soft sell fail;
sell pipeline retries `BlockhashNotFound` / rpc sim errors with fresh quote.  
**Exit ladder (1.11.723):** arm **5%** → giveback **5%** peels **50%** →
second giveback **−8%** dumps rest. Unarmed stale **150s** also peels **50%**
first (`never_arm_stale_partial`), full dump at **2×** window — hold for bounce.  
**Jupiter buy (1.11.711):** impact ≤ **2%**, quote premium ≤ **12%** (chase/prebuy still 5%).  
**Noise cut (1.11.712):** liquid mid 10–25 needs bs≥1.4/to≥0.18; `never_arm_stale` 75s/MFE&lt;4%.  
**Leader catch (1.11.714):** rocket vol bypasses age; no ring on rocket; enrich
ultra-fresh ≤20s first; age floor 0.01h; rocket pc≥12 / vol≥$10k / bs≥1.15.  
**Trail (1.11.715):** giveback only after **MFE≥12%** (keeps arm5/gb3/50%/gb2=5).  
**Discovery (1.11.716):** force-enrich first-seen ≤**4/min**; block if ring60s ≤0.  
**Age (1.11.717):** **no max pair age** (`MAX_PAIR_AGE_HOURS=0`).  
**Speed (1.11.718→722):** scan 2s / probe ≤**24** / conc 10 / budget **22s**;
buyForce take **8**; rocket bs **1.1**.  
**Impulse (1.11.724/727):** pc5m≥**18** + bs≥1.2; liquid ≥**12**; early **OFF**;
rocket ≥**25**/vol$15k/bs1.35; pc5m&gt;100 needs bs≥**1.35** (E6cBb6-class).  
**liquid_tape (1.11.726):** liq≥$25k / age≥1h / soft Dex + **ring≥5%**
(Dex-lag on fat runners like WW). No enrich inflate.  
**Buy mint-resolve (1.11.725):** Buy-only getTx ≤40/min, **newest-first**,
queue~1min (no 5min backlog). Force-enrich via `buyForce`. Entry gates unchanged.  
**Dex pick (1.11.721):** prefer **allowed** dex (pumpswap) over higher-liq meteora;
forceEnrich always reaches gates (NEEGY `2y8Ntg` miss).  
**Reconnect RCA (1.11.722):** most `websocket open` = **PM2 restarts**, not Helius.
True `1006` ~4/day. See `RCA_RECONNECT_2026-08-07.md`. Heartbeat counters:
`ws_close_1006_count`, `ws_reconnect_backoff_count`, `process_start_count`,
`enrich_over_budget_count`, `tick_error_count`.  
**Helius:** shared key with Oscar mild-dip accepted short-term (~½ stream credits);
dedicated LERA key recommended when billing hurts — not required for WS stability.

**Exit:** same W9.1 stack as Oscar `mild-dip-bot` (arm +8% / giveback −6% / never-arm / vol-fade)  
**RPC:** Helius from `/opt/lera/.env` (do not paste keys)  
**Coverage:** force → Dex-probe ≤24 → rank vol5m → full-gate top 14; skips journaled

Oscar `mild-dip-bot` on `2sSu…` is **not** touched by this lane.

## Start

```bash
ssh root@72.62.152.201
sudo -u lera -H bash -c 'cd /opt/lera && git fetch solana-bot <branch> && git checkout --force FETCH_HEAD && npm ci'
# ensure keypair exists (secret, never commit):
# data/live/copy-8zkg.keypair.json → pubkey FxQf…
# Prefer full npm ci (not --omit=dev mid-flight). Entry refuses boot if undici/index.js missing.
sudo -u lera -H bash -c 'cd /opt/lera && mkdir -p data/volgreen data/ops-heartbeats && chmod +x scripts/vol-green-pm2-entry.sh && pm2 delete vol-green-bot ecosystem.vol-green 2>/dev/null; pm2 start scripts/vol-green-pm2-entry.sh --name vol-green-bot --interpreter bash && pm2 save'
```

> PM2 6 on LERA may treat `ecosystem.vol-green.cjs` as a script — use the entry shell above.

## Verify

```bash
sudo -u lera -H bash -c 'pm2 describe vol-green-bot | head -40'
sudo -u lera -H bash -c 'cat /opt/lera/data/ops-heartbeats/vol-green-bot.json'
sudo -u lera -H bash -c 'tail -20 /opt/lera/data/volgreen/journal.jsonl'
# Oscar untouched:
ssh root@187.124.38.242 'sudo -u salpha -H pm2 describe mild-dip-bot | head -20'
```

## Stop / rollback

```bash
sudo -u lera -H bash -c 'pm2 stop vol-green-bot; pm2 delete vol-green-bot; pm2 save'
```
