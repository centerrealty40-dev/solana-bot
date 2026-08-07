# RCA — vol-green «reconnect storm» (SPEC handoff)

**Host:** LERA `72.62.152.201` `/opt/lera` PM2 `vol-green-bot`  
**SPEC:** `docs/strategy/release/SPEC_VOL_GREEN_RECONNECT_RCA.md` (PR #621)  
**Sample window:** current PM2 out/error logs ~2026-08-06 → 2026-08-07 UTC  
**Product VERSION after fixes:** `1.11.722`

## Verdict

| Attribution of `sa-stream websocket open` | Count | Share |
|------------------------------------------|------:|------:|
| **Process start / new PID** (near `[vol-green-bot] start`) | 30 | **~79%** |
| **True in-process reconnect** (after `closed` `code:1006` + backoff) | 8 | **~21%** |
| Total opens / unique open PIDs | 38 / 30 | |

**This is not a Helius reconnect storm.** ~4× `1006`/day while a process stays up. The scary open count is **PM2/deploy restart churn** (this agent’s tune/deploy loops + undici repair restarts).

Naive `grep websocket open` without splitting (a) in-process `1006`+backoff vs (b) process restart → false alarm.

## P0 findings

### 1) Who restarts PM2?

- **Agent deploy/tune sessions** on LERA: `git checkout` + `npm ci --omit=dev` + `pm2 restart vol-green-bot` (visible in PM2 “Divergent env” / `created_at`).
- Clusters match SPEC: 06 13:43–13:56, 22:28–23:38; 07 13:18–13:36, 15:24–16:13 UTC.
- No cron storm found on `lera` crontab for vol-green.
- Kill without clean `stop()` → no `websocket closed` from old PID → next open looks like “reconnect”.

**Won’t-fix:** stop deploying mid-candle as a stream “fix”. Operators must not restart to chase opens.

### 2) undici missing → tick hard-fail

- Error log: **38×** `Cannot find package …/undici/index.js`, **47×** `tick error`.
- Root cause: **`npm ci --omit=dev` race / incomplete extract** left `node_modules/undici/package.json` without `index.js` briefly; ad-hoc `npm install undici --no-save` repaired at ~16:13 UTC.
- `undici` **is** in `package.json` deps (`^7.0.0`) / lockfile — not a missing-dep design bug.
- **Fix (1.11.722):**
  - `resolveDexFetch()` — fall back to `globalThis.fetch` if undici import fails (ticks survive).
  - `vol-green-pm2-entry.sh` **fails boot** if `node_modules/undici/index.js` missing (forces real `npm ci`, bans silent `--no-save` as the recovery path).
  - Deploy note: prefer `npm ci` (full) on LERA after checkout; avoid restarting mid-`npm ci`.

### 3) enrich still running >15s

- Last 40 `green_tape enrich done`: **avg ~20s**, **39/40 >15s**, max ~24s.
- Cause: `buyForce=16` every scan inflated `probeMax` to 36–44; Dex global gate @180 RPM serializes (~333ms gap) → wall clock >15s even with conc=10.
- Operators see stall warnings → restart → more WS opens.
- **Fix (1.11.722):**
  - Hard-cap `probeMax ≤ 24` on tape mode.
  - Cap `buyForce` take **8** (was 16); trim ring/priority force width.
  - Budget hard-set **22s** (was 15s).
  - Heartbeat: `enrich_over_budget_count`.

## P1 — Helius plan

| Option | Decision |
|--------|----------|
| Separate Business key for LERA vol-green | **Recommended** when Helius invoice hurts; not required for WS stability (1006 rate already low). |
| Keep shared key with Oscar mild-dip | **Accepted short-term** with documented credit share. |

**Shared-key credit share (expected):**

- Both bots: pump.fun + PumpSwap `logsSubscribe` → ~**½ of stream MB/credits each** if both online continuously (same two-program firehose).
- Green extras on same key: buy-mint-resolve HTTP ≤40 getTx/min + Dex/Jupiter (not Helius stream).
- Noisy-neighbor: possible shared RPS / `sendBundle` pressure; dip side saw no clear 429 storm.
- Turning green off saves credits; does **not** improve dip alpha.

**Action:** keep shared key until ops provisions a dedicated LERA key in `/opt/lera/.env` (`HELIUS_API_KEY` / `HELIUS_RPC_URL` only on that host — never commit). Remeasure `ws_close_1006_count` after split.

## Metrics (heartbeat `data/ops-heartbeats/vol-green-bot.json`)

| Field | Meaning |
|-------|---------|
| `ws_close_1006_count` | In-process abnormal closes only |
| `ws_reconnect_backoff_count` | True in-process reconnects |
| `ws_open_count` | All opens (restart + reconnect) |
| `process_start_count` | `[vol-green-bot] start` / process lifetime |
| `enrich_over_budget_count` | Enrich exceeded budget then awaited finish |
| `tick_error_count` / `tick_errors_by_code` | Tick failures (e.g. MODULE_NOT_FOUND:undici) |

## Out of scope

- Oscar mild-dip params / wallet `2sSu…`
- Pasting secrets
