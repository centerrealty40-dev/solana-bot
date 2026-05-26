# Platform Changelog

All notable changes to the multi-product platform contract live here.

This file is **append-only**. Every agent that changes any of:

- `docs/platform/**`
- `docs/agents/**`
- `.cursor/rules/multi-product-platform.mdc`
- `scripts/platform/**`
- `docs/platform/products.yaml`

MUST add a new entry at the top of this file in the same commit and bump
`docs/platform/VERSION` accordingly.

## Versioning Rules (semver-style for platform contracts)

- **MAJOR** (`X.0.0`) — breaking change to product boundaries, DB topology,
  agent contracts, or naming rules. Existing products may need to migrate.
  Examples: renaming an env prefix, splitting a schema, removing a route convention.
- **MINOR** (`1.X.0`) — additive change: new product registered, new platform
  helper script, new optional contract section, new agent doc.
  No existing product is forced to change.
- **PATCH** (`1.1.X`) — clarification, typo fix, doc rewrite without semantic
  change. No agent should need to update its workflow.

## Rollback Protocol

If a platform change turns out to be harmful:

1. Identify the bad version in this changelog.
2. Revert the commit (or revert all files listed in that entry).
3. Append a NEW entry at the top describing the revert (e.g. "Revert 1.2.0:
   reason"), bumping PATCH (e.g. 1.1.0 -> 1.1.1) instead of going back in
   numbers. Versions are monotonically increasing forever — never reused.

## Entry Template

```markdown
## [VERSION] — YYYY-MM-DD — agent: <agent_id_or_human>

### Surface touched
- <files / dirs / contracts changed>

### Change
- <one-paragraph description of WHAT changed>

### Why
- <one-paragraph description of WHY>

### Migration required
- <none | what other products must do>

### Rollback note
- <how to revert this change cleanly>
```

---

## [1.5.2] — 2026-05-04 — agent: cursor (integrator)

### Surface touched
- `docs/platform/VERSION` (1.5.1 → 1.5.2)
- `docs/platform/products.yaml` (`platform_version` → 1.5.2), `PRODUCT_REGISTRY.md` (регенерация)
- `docs/platform/**` (каноническая копия в репозитории solana-bot)
- `docs/agents/**`, `scripts/platform/**`, `.cursor/rules/**` (перенос канона из дерева Ideas)

### Change
- Единый SSOT для платформенных контрактов и Cursor rules **внутри** репозитория продукта; монорепозиторий Ideas должен синхронизироваться с этим деревом, а не наоборот.

### Why
- Убрать расхождение «правки только локально в Ideas без Git»; прод и CI опираются на `solana-bot`.

### Migration required
- Разработчикам с корнем workspace Ideas: после правок платформы копировать/мержить в клон `solana-bot` или открывать корень репозитория Cursor как `solana-alpha`.

### Rollback note
- Удалить добавленные каталоги и вернуть `docs/platform/VERSION` **1.5.1**.

---

## [1.5.1] — 2026-05-04 — agent: cursor

### Surface touched
- `docs/platform/VERSION` (1.5.0 → 1.5.1)
- `docs/platform/PLATFORM_CHANGELOG.md`
- `docs/agents/DOC_INDEX.md` (new)
- `docs/agents/CURSOR_HOOKS_REMINDER.md` (new)
- `docs/agents/TASK_INTAKE_TEMPLATE.md`
- `docs/agents/AGENT_BOOTSTRAP.md`
- `.cursor/rules/server-autodeploy.mdc`
- `.cursor/rules/multi-product-platform.mdc`
- `solana-alpha/docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md` (§4.1)
- `solana-alpha/docs/strategy/release/VERSION`, `CHANGELOG.md` (PATCH док-кларификация)

### Change
- Выравнивание процесса под **Git `v2`**, **CI до merge**, запрет рутинного **`scp`** tracked-кода; **deploy-session** vs обычная задача; **секреты** не в контексте агента по умолчанию; индекс агент-доков; напоминание про Cursor hooks; § branch protection в продуктовом NORM.

### Why
- Единое «чистое» правило работы агента и людей: дифф перед merge, без расхождения GitHub ↔ VPS.

### Migration required
- Нет; мейнтейнеры настраивают branch protection на GitHub вручную по §4.1 NORM.

### Rollback note
- Revert коммита; вернуть `docs/platform/VERSION` **1.5.0** и прежние версии перечисленных файлов.

---

## [1.5.0] — 2026-05-03 — agent: cursor

### Surface touched
- `docs/platform/VERSION` (1.4.0 → 1.5.0)
- `docs/agents/NORM_UNIFIED_RELEASE_AND_RUNTIME.md` (указатель на канон в продукте)
- `docs/agents/AGENT_BOOTSTRAP.md`
- `.cursor/rules/multi-product-platform.mdc`
- `.cursor/rules/server-autodeploy.mdc`

### Change
- Единый норматив по параллельным агентам, semver, GitHub и VPS: **канонический текст** в репозитории Solana Alpha (`solana-alpha/docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`); в Ideas — указатель, обновлены bootstrap и правила платформы; **автодеплой** переведён на приоритет **`git fetch` + `reset --hard` + `npm ci`** для `/opt/solana-alpha`, **`scp`** исключён из рутины для tracked-кода.

### Why
- Устранить противоречие между регламентом «прод = SHA из Git» и практикой «деплой через `scp`», из‑за которой ломались `npm ci` и дерево Git на сервере.

### Migration required
- Нет для других продуктов; агенты Solana Alpha должны читать новый путь к нормативу.

### Rollback note
- Revert коммита; вернуть `docs/platform/VERSION` **`1.4.0`** и прежний текст затронутых правил/агент-доков.

---

## [1.4.0] — 2026-04-25 — agent: cursor (Claude Opus, edge-lab lead-lag paper trader session)

### Surface touched
- `docs/platform/VERSION` (1.3.0 → 1.4.0)
- `docs/platform/products.yaml` (new product `edge_lab`: schema `edge_lab`,
  env_prefix `LEADLAG_` + `LAB_`, systemd_prefix `edge-leadlag-`, route
  `/lead-lag`, repo_dirs `edge-lab` + `meteora-dash/app/lead-lag` +
  `meteora-dash/lib/storage/leadlag.ts`, data_dirs `/opt/edge-lab` +
  `/var/lib/edge_lab`, health `/var/lib/edge_lab/leadlag-heartbeat`
  with HTTP probe on `/lead-lag`)
- `docs/platform/PRODUCT_REGISTRY.md` (regenerated)
- `edge-lab/loaders/leadlag_paper.py` (new — pure paper engine, no I/O)
- `edge-lab/loaders/quote_sources.py` (new — async HL + dYdX REST poll)
- `edge-lab/scripts/10_paper_leadlag.py` (new — long-running paper worker)
- `edge-lab/scripts/11_leadlag_report.py` (new — daily rolling analytics
  + optional verify-on-parquet)
- `edge-lab/tests/test_leadlag_engine.py` (new — engine math regression)
- `edge-lab/deploy/edge-leadlag@.service` (new — long-running template)
- `edge-lab/deploy/edge-leadlag-report.service` (new — oneshot)
- `edge-lab/deploy/edge-leadlag-report.timer` (new — daily 00:30 UTC)
- `edge-lab/PRODUCT_SCOPE.md` (new — per-product scope addendum)
- `edge-lab/.env.example` (added `LEADLAG_*` keys)
- `edge-lab/pyproject.toml` (added httpx + pytest)
- `meteora-dash/lib/storage/leadlag.ts` (new — server-side reader)
- `meteora-dash/app/lead-lag/page.tsx` (new — public live snapshot UI)
- `meteora-dash/app/layout.tsx` (added /lead-lag nav entry)
- `meteora-dash/app/page.tsx` (added /lead-lag link in hero)

### Change
Activated `edge_lab` product end-to-end. Backend: a long-running paper
trader that polls Hyperliquid + dYdX v4 public quote endpoints at ~1Hz,
detects HL→dYdX impulse via z-score on log-returns over a configurable
lag, and simulates entries on dYdX with explicit fee + slippage +
latency models. Starting capital $10,000 (configurable, per-trade
notional defaults to 10% of equity). NEVER places real orders — the
worker imports only `httpx` for GET/POST quotes; systemd hardening
restricts outbound IPs to the two public hosts. State is written to
`/opt/edge-lab/out/leadlag/{state.json,positions.json,equity.jsonl,events.jsonl}`,
heartbeat to `/var/lib/edge_lab/leadlag-heartbeat` (5-min freshness
contract). A daily oneshot timer rolls equity/events into rolling
24h/72h/7d analytics (`report_<DATE>.json`) and optionally cross-checks
the live engine against historical 1Hz mids parquet built by
`02_build_mids.py` (`verify_<DATE>.json`). Frontend: new `/lead-lag`
tab on the mono-Next.js dashboard with explicit "PAPER-ONLY — NO REAL
EXECUTION" badge, live equity card, open positions table, recent closed
trades, and rolling analytics if a daily report exists.

### Why
edge-lab so far was offline-only (parquet research scripts
01_inspect..06_lead_lag). The lead-lag analysis showed peak
cross-correlation HL→dYdX at +1..+10 sec on 1Hz mids — small but
non-zero edge. We need a public, honest, **paper** validation that the
edge survives realistic costs (fees, slippage, polling latency) and
that we can show the live equity curve to demonstrate operational
capability without risking capital. Adding `/lead-lag` matches the
operational pattern of `/whale` and `/funding`: tabs on a single
Next.js app, per-product server-side loader, backend worker fully
isolated by env prefix + systemd prefix + data dir.

### Migration required
- **Other products**: none. New surface is fully contained in the new
  `edge_lab` scope (env prefix `LEADLAG_` + `LAB_`, systemd prefix
  `edge-leadlag-`, schema `edge_lab`, route `/lead-lag`, repo dirs
  `edge-lab` + the two new meteora-dash files).
- **edge_lab operator**: deploy `edge-leadlag@10_paper_leadlag.service`
  and the `edge-leadlag-report` timer. Create `/var/lib/edge_lab`
  (root-owned, rwx for ubuntu) so the heartbeat path is writable from
  the systemd unit's `ReadWritePaths`. The systemd unit pins
  `IPAddressAllow=api.hyperliquid.xyz indexer.dydx.trade` —
  resolution is via NSS at unit start.

### Rollback note
- Removing the `meteora-dash/app/lead-lag` directory and
  `meteora-dash/lib/storage/leadlag.ts` restores the frontend to
  pre-1.4.0 state. The two link tags in `app/layout.tsx` and
  `app/page.tsx` will 404 until removed too — both are simple `<Link>`
  edits, easy to revert.
- products.yaml: revert the `edge_lab` entry verbatim and rerun
  `node docs/platform/generate-registry.mjs`. Bump VERSION to 1.4.1
  with a "Revert 1.4.0" entry per the rollback protocol.
- Backend: stopping `edge-leadlag@10_paper_leadlag.service` and
  `edge-leadlag-report.timer` fully neutralizes the change. The paper
  trader writes only inside `/opt/edge-lab/out/leadlag` and
  `/var/lib/edge_lab` — both inside our owned data_dirs. No DB schema
  was provisioned (filesystem-only MVP), so no SQL teardown needed.

---

## [1.2.0] — 2026-04-25 — agent: cursor (Claude Opus, whale-edge paper trader session)

### Surface touched
- `docs/platform/products.yaml` (whale_edge promoted to active, repo_dirs +
  meteora-dash/app/whale and meteora-dash/lib/storage/whale.ts, data_dirs +
  /var/lib/whale_edge, health block wired to heartbeat file + /whale HTTP probe)
- `docs/platform/PRODUCT_REGISTRY.md` (regenerated)
- `docs/platform/VERSION` (1.1.0 → 1.2.0)
- `whale-edge/loaders/paper.py` (new — pure paper-portfolio engine)
- `whale-edge/scripts/04_paper_trader.py` (new — live tail + paper apply +
  state/equity/events writers + heartbeat; replaces the Telegram-only
  04_live_signal as the recommended live worker)
- `whale-edge/scripts/08_discover.py` (new — daily 7d-rolling rank,
  watchlist promotion/degradation, discovery diff report)
- `whale-edge/tests/test_paper.py` (new — 11 tests for paper engine)
- `whale-edge/out/watchlist.json` (curated active set, seeded by hand from
  4-day window 2026-04-21..04-24)
- `whale-edge/deploy/hl-whale-discovery.timer` (new)
- `whale-edge/deploy/hl-whale-discovery.service` (new)
- `meteora-dash/app/whale/page.tsx` (new — public redacted UI)
- `meteora-dash/app/page.tsx` (added /whale link)
- `meteora-dash/app/layout.tsx` (added /whale nav entry)
- `meteora-dash/lib/storage/whale.ts` (new — server-side reader + redaction)

### Change
Activated whale_edge product end-to-end. Backend: a paper-trading worker
that mirrors the NET DIRECTION of curated Hyperliquid wallets into a
fixed-budget virtual portfolio (default $1k per kit). NEVER places real
orders. A separate daily discovery job re-ranks wallets on a 7-day
rolling window with quality filters (score, consistency pos_days,
median hold time, sample size) and reconciles against the watchlist:
new candidates land in pending, qualifying after N consecutive pass
days promotes them to active; failing actives degrade then archive.
Frontend: new /whale tab on the Next.js dashboard exposing redacted
positions, PnL, fees, and a roster-changes table. Wallet addresses
default to redacted (WHALE-1, WHALE-2, ...) — set
WHALE_REVEAL_WALLETS=true to expose. Health contract satisfied via
Path B heartbeat at /var/lib/whale_edge/heartbeat (5 min freshness).

### Why
Telegram-only signal mode (04_live_signal) was a dead end: spammy and
unverifiable. A paper-trading mirror lets us measure real out-of-sample
PnL without risking capital, gives the public dashboard a credible
showcase ("see our research live, redacted"), and feeds back into the
discovery loop so the watchlist self-corrects over time. Adding /whale
to the mono-frontend matches the operational pattern already used by
funding_lab.

### Migration required
- **Other products**: none. New surface is contained inside whale_edge
  scope (env prefix WHALE_, systemd prefix hl-whale-, schema
  whale_edge, route /whale, repo dirs whale-edge + the two new
  meteora-dash files).
- **whale_edge operator**: deploy `04_paper_trader` and the new
  `hl-whale-discovery` timer. Create `/var/lib/whale_edge` (root-owned,
  rwx for ubuntu) so the heartbeat path is writable from the systemd
  unit's ReadWritePaths.

### Rollback note
- Removing the `meteora-dash/app/whale` directory and the new
  `lib/storage/whale.ts` file restores the frontend to its pre-1.2.0
  state. The /whale link in `app/layout.tsx` and `app/page.tsx` will
  404 until removed too — both are simple link tags, easy to revert.
- products.yaml: revert the whale_edge entry (status, repo_dirs,
  data_dirs, health, notes) to the 1.1.0 version verbatim and rerun
  `node docs/platform/generate-registry.mjs`. Bump VERSION to 1.2.1
  with a "Revert 1.2.0" entry per the rollback protocol.
- Backend: stopping `hl-whale@04_paper_trader.service` fully neutralizes
  the change. The paper trader writes only inside /opt/whale-edge/out
  and /var/lib/whale_edge — both in our owned data_dirs.

---

## [1.1.0] — 2026-04-24 — agent: cursor (Claude Opus, session 54fe1b47)

### Surface touched
- `docs/platform/VERSION` (new)
- `docs/platform/PLATFORM_CHANGELOG.md` (new, this file)
- `docs/platform/ROADMAP.md` (new)
- `docs/platform/products.yaml` (new — machine-readable source of truth)
- `docs/platform/generate-registry.mjs` (new — yaml → markdown generator)
- `docs/platform/HEALTH_CONTRACT.md` (new)
- `docs/platform/PRODUCT_REGISTRY.md` (now generated from yaml; manual edits forbidden)
- `docs/platform/PLATFORM_CONTEXT.md` (updated — mono-frontend reality clarified, version reference added)
- `docs/agents/AGENT_BOOTSTRAP.md` (updated — version-check step required)
- `.cursor/rules/multi-product-platform.mdc` (updated — version awareness)
- `scripts/platform/check-boundaries.sh` (new)
- `scripts/platform/health-check.sh` (new)
- `scripts/platform/install-pre-commit.sh` (new)
- `scripts/platform/README.md` (new)
- `meteora-dash/scripts/refresh-mode-leaderboard.ts` (new — cached leaderboard worker)
- `meteora-dash/lib/storage/funding.ts` (read leaderboard from cache file when present)
- `meteora-dash/deploy/meteora-dash-mode-leaderboard.service` (new)
- `meteora-dash/deploy/meteora-dash-mode-leaderboard.timer` (new)

### Change
Introduced **platform versioning** with monotonic semver, mandatory CHANGELOG
entries, and rollback protocol. Added machine-readable `products.yaml` as the
single source of truth (PRODUCT_REGISTRY.md becomes a generated artifact).
Added `scripts/platform/` with `check-boundaries.sh` (CI/pre-commit guard against
cross-product changes) and `health-check.sh` (cron-driven per-product freshness
monitor with optional Telegram alerts). Added `HEALTH_CONTRACT.md` defining how
each product exposes its freshness signals so the cron checker can probe them
uniformly. Cached the Funding Lab mode leaderboard via a 5-min worker so the
`/funding` page no longer scans every `equity.jsonl` on each request. Clarified
in `PLATFORM_CONTEXT.md` that "independent deployability" applies to backend
workers and data pipelines — the Next.js frontend is intentionally a mono-app
where products are tabs/routes (operational simplicity for solo operator).

### Why
- Multiple agents working in parallel on different products need a way to
  coordinate without stepping on each other. Versioning + CHANGELOG +
  enforceable boundary checks make this possible.
- Previous PRODUCT_REGISTRY was markdown-only, so CI/agents couldn't reason
  about it. yaml + generator solves that.
- Funding Lab leaderboard scanned all jsonl on every request — would not scale
  past a handful of runs.
- BOUNDARIES.md was honor-system; check-boundaries.sh makes it enforceable.
- Solo operator can't manually monitor freshness of N products — health-check
  cron + Telegram closes that gap.

### Migration required
- **All product agents**: before any non-trivial change, read
  `docs/platform/VERSION` and `docs/platform/PLATFORM_CHANGELOG.md` (top entry).
  If you don't recognize the latest version, re-read `AGENT_BOOTSTRAP.md`.
- **Editors of PRODUCT_REGISTRY.md**: stop editing it directly. Edit
  `docs/platform/products.yaml` and run `node docs/platform/generate-registry.mjs`.
- **Each product** should adopt `scripts/platform/install-pre-commit.sh` in its
  own git repo to enable boundary checks locally.
- **Each product** should declare a `health` block in `products.yaml`
  (file path + max-age-min) so the platform health checker can monitor it.
  Products without health block are silently skipped (no breakage).

### Rollback note
- All new files added in this version are net-new; deleting them rolls back
  cleanly with no side effects on existing products.
- `PRODUCT_REGISTRY.md` content was preserved exactly — generator output is
  byte-identical to the previous hand-edited version (verified at commit time).
- `PLATFORM_CONTEXT.md` and `AGENT_BOOTSTRAP.md` had clarifying additions only;
  existing instructions remain valid. Reverting these files brings back the
  pre-1.1.0 wording without breaking products.
- `meteora-dash/lib/storage/funding.ts` change is backward-compatible: if the
  cache file is missing, it falls back to the original on-the-fly scan.

---

## [1.0.0] — 2026-04-24 — agent: cursor (prior session, baseline)

### Surface touched
- `docs/platform/PLATFORM_CONTEXT.md` (initial)
- `docs/platform/BOUNDARIES.md` (initial)
- `docs/platform/DB_TOPOLOGY.md` (initial)
- `docs/platform/PRODUCT_REGISTRY.md` (initial)
- `docs/agents/AGENT_BOOTSTRAP.md` (initial)
- `docs/agents/TASK_INTAKE_TEMPLATE.md` (initial)
- `.cursor/rules/multi-product-platform.mdc` (initial)
- `whale-edge/PRODUCT_SCOPE.md` (initial per-product scope addendum pattern)

### Change
Initial multi-product platform contract: shared engine philosophy, hard
product boundaries (DB schema, env prefix, systemd prefix, site route),
PostgreSQL topology with schema-per-product, agent bootstrap doc, task
intake template, always-applied Cursor rule.

### Why
Solo-operator workspace was growing into multiple co-existing products
(meteora, funding_lab, whale_edge, smart_money). Without explicit boundaries,
agents would inevitably cross-contaminate: shared env keys, systemd unit
collisions, schema name clashes, frontend route conflicts.

### Migration required
- N/A (baseline).

### Rollback note
- Pre-platform state had no boundaries enforced. Reverting to it would re-open
  every cross-contamination risk this version closed. Not recommended.
