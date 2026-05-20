# Paper-trader removal plan — 2026-05-20

User goal: live-oscar is the only strategy that matters. All paper-* trading
hypotheses are closed; their code, journals, dashboard cards and PM2 apps
should not be in the way of live-oscar evolution.

## CRITICAL: PAPER_ prefix ≠ paper strategy

`live-oscar` runs **on top of** the `papertrader` engine
(`src/papertrader/*`). Most of its 317 env knobs are named with the
`PAPER_*` prefix (`PAPER_DIP_*`, `PAPER_LIVE_STAGED_ENTRY_*`,
`PAPER_VOLUME_*`, etc.). Removing these by name **would break live-oscar**.

What we remove is:

- the **paper-only PM2 apps** (`paper-oscar-risky/v21/v22`),
- the **paper-only npm-scripts** and **paper-only `paper2-*` files**,
- the **paper-only data writers** (those JSONLs are written nowhere now).

What we keep:

- `src/papertrader/` engine (used by `src/live/*`),
- `src/scripts/live-oscar.ts` (entry point),
- `scripts-tmp/paper2-open-snapshot-enrich.mjs` (used by 5 collectors and dashboard),
- all `PAPER_*` env keys in the `live-oscar` PM2 process.

## Steps (atomic commits, NORM §5 deploy after each)

### Step A — drop 3 paper-only PM2 apps from ecosystem.config.cjs

- Remove blocks for `paper-oscar-risky`, `paper-oscar-v21`, `paper-oscar-v22`
  (lines ~928–1455, ~530 lines of env).
- Remove the `PM2_PAPER_OSCAR_APP_NAMES` set and the
  `PM2_PAPER_OSCAR_APPS_ENABLED` filter (no longer needed).
- The 3 apps are already disabled on VPS via env flag, so PM2 reload
  is a no-op for runtime; we just shrink the config file.

### Step B — purge paper-only npm-scripts

- `package.json`: drop `paper-oscar-risky/v21/v22` plus all `paper2:*`
  scripts that point to files we're about to delete (advisor,
  healthcheck, post-mortem, hourly-report, advisor-digest,
  paper2:dashboard alias, paper2:diagnose-*, paper2:backtest, all
  paper2:*-counterfactual / *-grid / *-optimize / *-sensitivity etc.).
- Keep `dashboard` (live-oscar dashboard alias points to the same file).
- Keep `paper2:analyze-kill-sl` if its target still exists; delete otherwise.

### Step C — delete paper-only TS source

- `src/scripts/papertrader.ts` (entry point only used by 3 PM2 apps removed in step A)
- `src/scripts/paper2-*.ts` (16 backtest/analysis scripts, none imported from `src/live/`)

Verify before commit: `grep -r "from.*src/scripts/papertrader" src/` and same
for each paper2 file — must return zero hits.

### Step D — delete paper-only scripts-tmp files

- `scripts-tmp/paper2-advisor.mjs`
- `scripts-tmp/paper2-healthcheck.mjs`
- `scripts-tmp/paper2-diagnose-*.{ts,mjs}`
- `scripts-tmp/paper2-strategy-diag.mjs`
- `scripts-tmp/paper2-reject-stats.mjs`
- `scripts-tmp/paper2-count-eval-recent.mjs`
- `scripts-tmp/paper2-agg-eval-reasons.mjs`
- `scripts-tmp/paper2-analyze-price-verify-jsonl.mjs`
- `scripts-tmp/paper2-reconcile-pnl.mjs`
- `scripts-tmp/paper2-append-dashboard-reset.mjs` (only if dashboard does not call it)
- `scripts-tmp/paper2-full-analysis-batch.sh`
- `scripts-tmp/paper-triad-last24h.mjs`
- `scripts-tmp/post-mortem-paper-v1.mjs`
- `scripts-tmp/advisor-digest.mjs`
- `scripts-tmp/hourly-telegram-report.mjs` ⚠️ **CHECK** — it's in salpha cron.
  If it still reports paper2 closes — replace with live-oscar version.
  If unused — drop the cron entry too.

KEEP:
- `scripts-tmp/paper2-open-snapshot-enrich.mjs` — used by 5 collectors + dashboard.

### Step E — dashboard cleanup (separate, careful)

- Remove paper-oscar JSONL ingestion from `dashboard-server.ts` (paper cards).
- Remove `DASHBOARD_PAPER_OSCAR_*_JSONL` and related env keys from
  the `live-oscar-dashboard` block in `ecosystem.config.cjs`.
- Keep `STORE_PATH`, `PAPER2_DIR` if `paper2-open-snapshot-enrich.mjs`
  still reads them. Verify.

This step can break the dashboard view if I miss a code path; do it
last, after Steps A–D have shown that prod is stable.

### Step F (optional, end of refactor) — semantic param dive

After dead paper code is gone, revisit the heaviest live-oscar groups
from `ENV_INVENTORY.md`:
- `PAPER_DIP_*` (35 keys) — find legacy from earlier dip experiments.
- `PAPER_VOLUME_*` (20 keys)
- `PAPER_LIVE_STAGED_ENTRY_*` (15 keys)

This is the slow, careful work; one removal per commit, with reasoning.

## Order of operations

A → B → C → D → E → F. After A and B, deploy on VPS; after C, deploy;
after D, deploy. E can be deferred. F is open-ended.

## Cron note

salpha crontab on VPS calls `scripts-tmp/hourly-telegram-report.mjs`. If
that file is removed in step D, the cron line must also be removed
(`crontab -e` → delete the HOURLY_TG_REPORT block). Do not orphan cron.
