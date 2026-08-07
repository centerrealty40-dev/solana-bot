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
**Exit ladder (1.11.710):** arm **5%** → giveback **3%** sells **50%** →
second giveback **−5%** sells the rest (full bag).  
**Jupiter buy (1.11.711):** impact ≤ **2%**, quote premium ≤ **12%** (chase/prebuy still 5%).  
**Noise cut (1.11.712):** liquid mid 10–25 needs bs≥1.4/to≥0.18; `never_arm_stale` 75s/MFE&lt;4%.  
**Leader catch (1.11.714):** rocket vol bypasses age; no ring on rocket; enrich
ultra-fresh ≤20s first; age floor 0.01h; rocket pc≥12 / vol≥$10k / bs≥1.15.  
**Trail (1.11.715):** giveback only after **MFE≥12%** (keeps arm5/gb3/50%/gb2=5).  
**Discovery (1.11.716):** force-enrich first-seen ≤**4/min**; block if ring60s ≤0.  
**Age (1.11.717):** **no max pair age** (`MAX_PAIR_AGE_HOURS=0`).  









**Exit:** same W9.1 stack as Oscar `mild-dip-bot` (arm +8% / giveback −6% / never-arm / vol-fade)  
**RPC:** Helius from `/opt/lera/.env`  
**Coverage (mild-dip active scheme):** force ring-green → Dex-probe 48 → rank by
**vol5m** → full-gate top 20; skips → `entry_skip` / `awaken_skip` in journal

Oscar `mild-dip-bot` on `2sSu…` is **not** touched by this lane.

## Start

```bash
ssh root@72.62.152.201
sudo -u lera -H bash -c 'cd /opt/lera && git fetch origin && git checkout <sha> && npm ci'
# ensure keypair exists (secret, never commit):
# data/live/copy-8zkg.keypair.json → pubkey FxQf…
sudo -u lera -H bash -c 'cd /opt/lera && mkdir -p data/volgreen data/ops-heartbeats && chmod +x scripts/vol-green-pm2-entry.sh && pm2 delete vol-green-bot ecosystem.vol-green 2>/dev/null; pm2 start scripts/vol-green-pm2-entry.sh --name vol-green-bot --interpreter bash && pm2 save'
```

> PM2 6 on LERA may treat `ecosystem.vol-green.cjs` as a script — use the entry shell above.
```

## Verify

```bash
sudo -u lera -H bash -c 'pm2 describe vol-green-bot | head -40'
sudo -u lera -H bash -c 'tail -20 /opt/lera/data/volgreen/journal.jsonl'
# Oscar untouched:
ssh root@187.124.38.242 'sudo -u salpha -H pm2 describe mild-dip-bot | head -20'
```

## Stop / rollback

```bash
sudo -u lera -H bash -c 'pm2 stop vol-green-bot; pm2 delete vol-green-bot; pm2 save'
```
