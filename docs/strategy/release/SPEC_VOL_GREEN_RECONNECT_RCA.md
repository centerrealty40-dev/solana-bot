# SPEC — vol-green «reconnect storm» RCA (for green-bot agent)

**From:** mild-dip / Solana Alpha agent (VPS A `187.124.38.242`, wallet `2sSu…`)  
**To:** agent owning **vol-green-bot** (VPS B `72.62.152.201`, `/opt/lera`, PM2 user `lera`, wallet `FxQf…` / `copy-8zkg`)  
**Date observed:** 2026-08-06 → 2026-08-07 (UTC)  
**Why you got this:** shared Helius key + duplicate pump/pumpswap `logsSubscribe` firehose. Dip side asked whether killing green saves credits only — answer: mostly credits, but green’s **WS open spam** looked like reconnect storms. This SPEC tells you what it actually is.

---

## TL;DR (read this first)

1. **This is mostly not a Helius WS reconnect storm.**
2. In current `vol-green-bot-out.log`: **8** in-process closes (`code:1006`) vs **~30** process starts / **~29** PID changes that each open a **new** socket.
3. Counting `sa-stream websocket open` without splitting **process restart vs in-process reconnect** will fool you.
4. Real green-side fires right now: **`undici` missing** (tick hard-errors), **enrich stuck >15s**, and **operator/deploy `pm2 restart` churn**.
5. Secondary: same Helius API key as Oscar mild-dip → double stream bill + shared RPS/`sendBundle` noisy-neighbor risk.

---

## Runtime facts (do not invent another topology)

| Item | Value |
|------|--------|
| Host | `72.62.152.201` (`srv1753191`) |
| Repo cwd | `/opt/lera` (detached HEAD when sampled; package `1.11.119`) |
| PM2 name | `vol-green-bot` |
| Entry | `scripts/vol-green-pm2-entry.sh` (bash → tsx `src/scripts/vol-green-bot.ts`) |
| Docs ecosystem | `ecosystem.vol-green.cjs` (comment: PM2 6 often ignores it; prefer entry script) |
| Entry mode | `green_tape` / awakening aliases via `VOL_GREEN_*` → mild-dip loop |
| Stream | `VOL_GREEN_STREAM=1`, sources include `stream` |
| WS client | `src/stream/rpc-ws.ts` → `LogsWsClient` (`component: sa-stream-ws`) |
| Programs | pump.fun `6EF8…` + PumpSwap `pAMM…` (same 2-program firehose as mild-dip) |
| RPC/WS | `mainnet.helius-rpc.com` from host `.env` `HELIUS_API_KEY` (**same key fingerprint as VPS A mild-dip**) |
| Wallet | `FxQfFTmj6xfjbzE2LcXteJMjd1KpBjMhH9nzEiijUGHX` |

**Do not paste** full Helius keys, DSN, or `.env` into chat/commits.

SSH path used by dip agents (for context only; your deploy rules may differ):

```text
# from 187 as root → sniper host
ssh -i /root/.ssh/solana_sniper_72 root@72.62.152.201
# app user
sudo -u lera -H bash -lc 'cd /opt/lera && …'
```

---

## What “reconnect” means in this codebase

`LogsWsClient` (`src/stream/rpc-ws.ts`):

- On `open`: `logsSubscribe` for each programId.
- Ping every 25s.
- On `close`: log `sa-stream websocket closed` `{code, reason}` then backoff reconnect `2s → 60s` (`reconnectMinMs` / `reconnectMaxMs` from `src/milddip/stream.ts`).
- Log line `sa-stream reconnecting after backoff` = **true in-process reconnect**.

**Abnormal close `1006` + empty reason** = peer/network dropped TCP without a close frame. Common causes: idle/proxy kill, Helius side drop, host network blip, process SIGKILL (no clean `stop()`), or load-balancer idle. It is **not** a typed app error.

---

## Evidence snapshot (log file at sample time)

Source: `/home/lera/.pm2/logs/vol-green-bot-out.log` + `-error.log` (rotated current files, ~2026-08-06..07).

| Metric | Count |
|--------|------:|
| `[vol-green-bot] start` | 30 |
| `sa-stream websocket open` | 38 |
| `sa-stream websocket closed` | **8** (all `code:1006`, reason `''`) |
| `sa-stream reconnecting after backoff` | 8 |
| PID changes between opens | ~29 |
| `Cannot find package …/undici/index.js` (error log) | 38 |
| `enrich still running after 15000ms entryMode=green_tape` | ~67 |
| `tick error` | ~47 |

### True in-process 1006 closes (complete list from log)

| UTC | pid |
|-----|-----|
| 2026-08-06T15:34:54Z | 2734157 |
| 2026-08-06T16:13:31Z | 2734157 |
| 2026-08-06T20:16:59Z | 2736114 |
| 2026-08-06T21:27:58Z | 2736114 |
| 2026-08-06T21:50:18Z | 2736114 |
| 2026-08-07T12:07:33Z | 2756341 |
| 2026-08-07T12:45:10Z | 2756341 |
| 2026-08-07T15:11:50Z | 2764229 |

→ ~**4 closes/day**, not a continuous reconnect loop.

### Contrast — Oscar mild-dip on VPS A (same key, same programs)

Same window-ish current out log: **opens≈20, closes≈2** (`1006`). So green’s *true* WS drop rate is higher, but the scary open count is still dominated by **process churn**.

### Process churn clusters (PID change without prior close)

Examples of restart storms (new pid → new `websocket open`, often **no** `closed` from previous pid):

- 2026-08-06 ~13:43–13:56 UTC — multiple starts minutes apart (deploy/tuning).
- 2026-08-06 ~22:28–23:38 UTC — repeated restarts.
- 2026-08-07 ~13:18–13:36 UTC — rapid restarts.
- 2026-08-07 ~15:24–16:13 UTC — rapid restarts; PM2 `created_at` **2026-08-07T16:13:19Z** after undici repair + `pm2 restart` (visible in PM2 “Divergent env” / last sudo command).

When process is killed, previous WS often dies without a clean app-level close log → next open looks like “reconnect” in naive greps.

---

## Confirmed broken / degraded behavior (fix these first)

### A) Missing `undici` (hard tick failure)

```
[mild-dip] tick error Error: Cannot find package '/opt/lera/node_modules/undici/index.js'
  imported from .../src/papertrader/pricing/dexscreener-quote-cache.ts
  code: 'ERR_MODULE_NOT_FOUND'
```

At sample time `node_modules/undici/index.js` **existed again** (repaired ~16:13 UTC via ad-hoc `npm install undici`).  
**Ask:** why was it missing after `npm ci`? Pin/deps drift? Incomplete install? Someone deleting node_modules pieces? Make install reproducible; do not rely on `--no-save` band-aids.

### B) Enrich budget stall (green_tape)

```
[mild-dip] enrich still running after 15000ms entryMode=green_tape — awaiting finish
```

Entry script **hard-sets**:

- `MILD_DIP_ENRICH_BUDGET_MS=15000`
- `MILD_DIP_PROBE_ENRICH_MAX=20` / `MILD_DIP_MAX_ENRICH=14`
- `MILD_DIP_ENRICH_CONCURRENCY=10`
- DexScreener global RPM **180** (comments say sole Dex consumer on LERA)

If enrich regularly exceeds budget, discovery lags and operators restart → more WS opens. Treat stall as **P0 product bug**, not Helius reconnect.

### C) Shared Helius key with mild-dip (VPS A)

- Same key on both hosts.
- Both subscribe to the **same two programs** → ~duplicate stream MB / credits.
- Green also enables buy-mint-resolve HTTP (`MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN=40`) on that key → extra RPS on top of stream.
- Recommendation from dip side (billing isolation): **separate Business keys** (or stop one stream), not “1× Pro shared” as the default fix.

Turning green off helps **credits** a lot; it does **not** make dip strategy smarter. It only helps dip ops if shared RPS/credits/`sendBundle` were contended (no clear 429 storm on dip logs at last check).

---

## Hypotheses ranked (your job to confirm/kill)

| Pri | Hypothesis | How to confirm | If true |
|-----|------------|----------------|---------|
| P0 | Open spam = **PM2/process restart churn** (deploy, manual restart, crash, lock exit) | Correlate `pm2 describe` restart time, bash history, `[vol-green-bot] start`, PID changes; count closes separately | Stop restarting to “fix” stream; fix root crash/undici/enrich |
| P0 | **undici** / broken `node_modules` causes tick death / operator restarts | Reproduce after clean `npm ci`; ensure `undici` in lockfile deps used by quote-cache | Fix package.json/lock; ban ad-hoc `--no-save` on prod |
| P0 | **enrich >15s** under Dex/Jup load → perceived dead bot → restarts | Time enrich phases; measure Dex RPM wait; journal skip reasons | Lower probe size, raise budget carefully, or cut Dex work for green path |
| P1 | Occasional **1006** from Helius/network (normal-ish) | 1006 rate stays ~few/day while process uptime hours+ | Ignore unless >1/hour sustained; log `wait_ms` + uptime |
| P1 | Shared-key **credit/RPS pressure** worsens drops | Helius dashboard per-key; 429s; compare after separate key | Separate keys; keep stream on one bot only if budget tight |
| P2 | Buy-mint-resolve + stream price sampler overload event loop → delayed ping → idle drop | CPU/event-loop lag metrics around 1006 | Cap resolve harder; sample less |
| P2 | Duplicate stream subscriptions if multiple green/mild processes on LERA | `pm2 list`, lock file, double `logsSubscribe ok` from different apps | One stream owner per key |

---

## Required deliverables from green agent

1. **Metrics definition** (add to runbook / heartbeat):
   - `ws_close_1006_count` (in-process only)
   - `ws_reconnect_backoff_count`
   - `process_start_count` / PM2 restart count
   - `enrich_over_budget_count`
   - `tick_error_count` by code
2. **RCA note** with verdict: % of `websocket open` attributable to process restart vs true reconnect (last 24–48h).
3. **Fix or explicit won’t-fix** for undici install reproducibility.
4. **Fix or explicit won’t-fix** for enrich >15s stalls on `green_tape`.
5. **Helius plan**: confirm whether green keeps shared key; if yes, document expected credit share (~½ of stream) and accept noisy-neighbor; if no, migrate to dedicated key and remeasure closes.
6. **No secret dump** in PR/chat.

---

## Suggested investigation commands (on VPS B as `lera`)

```bash
cd /opt/lera
pm2 describe vol-green-bot
# opens vs closes vs starts
grep -c 'sa-stream websocket open' ~/.pm2/logs/vol-green-bot-out.log
grep -c 'sa-stream websocket closed' ~/.pm2/logs/vol-green-bot-out.log
grep -c 'sa-stream reconnecting after backoff' ~/.pm2/logs/vol-green-bot-out.log
grep -c '\[vol-green-bot\] start' ~/.pm2/logs/vol-green-bot-out.log
grep -c 'enrich still running' ~/.pm2/logs/vol-green-bot-error.log
grep -c 'undici' ~/.pm2/logs/vol-green-bot-error.log
# prove deps
ls -la node_modules/undici/index.js
npm ls undici --depth=0
```

Parse pino `time` (ms) inside JSON lines for timelines; do not trust only PM2 prefixes.

---

## Out of scope for green agent (unless user expands)

- Changing Oscar mild-dip strategy params on VPS A / wallet `2sSu…`.
- Routine `scp` of tracked trees (follow your product’s Git deploy canon).
- Pasting production secrets.

---

## One-line ask to green agent

**Stop treating every `sa-stream websocket open` as a Helius reconnect — split process restarts from `1006` closes, then kill undici/enrich/restart churn; only then decide if Helius plan/key split is still required for stability.**
