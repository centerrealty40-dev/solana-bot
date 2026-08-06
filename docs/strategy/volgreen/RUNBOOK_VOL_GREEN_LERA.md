# Runbook — `vol-green-bot` on LERA

**Host:** `72.62.152.201` (`/opt/lera`, user `lera`)  
**Wallet:** `FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX`  
**Clip:** $5 USDC  
**Entry:** Volume Awakening / green-tape (`MILD_DIP_ENTRY_MODE=awakening`)  
**Exit:** same W9.1 stack as Oscar `mild-dip-bot` (arm +8% / giveback −6% / never-arm / vol-fade)  
**RPC:** Helius from `/opt/lera/.env`

Oscar `mild-dip-bot` on `2sSu…` is **not** touched by this lane.

## Start

```bash
ssh root@72.62.152.201
sudo -u lera -H bash -c 'cd /opt/lera && git fetch origin && git checkout <sha> && npm ci'
# ensure keypair exists (secret, never commit):
# data/live/copy-8zkg.keypair.json → pubkey FxQf…
sudo -u lera -H bash -c 'cd /opt/lera && mkdir -p data/volgreen data/ops-heartbeats && pm2 start ecosystem.vol-green.cjs --only vol-green-bot && pm2 save'
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
