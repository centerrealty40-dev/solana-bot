# Multi-Product Platform — Roadmap

> Platform version: see `docs/platform/VERSION`.
> Change log: `docs/platform/PLATFORM_CHANGELOG.md`.
> Source of truth for products: `docs/platform/products.yaml`.

This is the single document that any agent (human or AI) should read
to understand **where the platform is going**, what each product is
for, and what the next moves are.

When you change anything material here (priorities, product status,
new product slot), bump platform `VERSION` and add a CHANGELOG entry.

## Table of Contents

1. [Platform Status](#platform-status)
2. [Product Status & Direction](#product-status--direction)
3. [Active Workstreams](#active-workstreams)
4. [Next Up](#next-up)
5. [Backlog](#backlog)
6. [Architecture Decisions](#architecture-decisions)
7. [Multi-Agent Workflow](#multi-agent-workflow)
8. [Open Questions](#open-questions)

## Platform Status

| Component | State | Notes |
|---|---|---|
| Versioning + CHANGELOG | active (v1.1.0) | Mandatory `VERSION` bump + entry on every platform change |
| `products.yaml` source of truth | active | `PRODUCT_REGISTRY.md` is generated; do not edit by hand |
| Boundary enforcement | active | `scripts/platform/check-boundaries.sh`, installable via `install-pre-commit.sh` |
| Health monitoring | active | `scripts/platform/health-check.sh` + Telegram, per `HEALTH_CONTRACT.md` |
| Mono-frontend (Next.js) | active | All routes in `meteora-dash/`; rationale in `PLATFORM_CONTEXT.md` |
| Postgres schema isolation | partial | Topology defined; per-product roles only fully provisioned for `meteora`. Others provision when first DB-backed feature lands |

## Product Status & Direction

### `meteora` — Meteora Analytics  *(active)*

**What it is**: ranking + per-pool analytics for Meteora DLMM pools,
positioned as a serious research tool. Public, no paywall during the
honest-track-record window.

**Surface**:
- `/` — top pools dashboard
- `/pool/[address]` — per-pool detail
- `/methodology` — full backtest methodology
- `/positions` — live $100 LP pilot tracker
- `/why-free` — strategy explainer

**Direction**:
- Honest 90-day track record from a real $100 position.
- Then evaluate: charge for alerts/CSV/API, OR pivot to B2B research.
- Add Conservative APR / dataset disclosures (model overstates fees in
  bear markets — flagged on the dashboard).

### `funding_lab` — Funding Lab / Anti-Funding  *(active)*

**What it is**: live paper-trading telemetry for a funding-rate carry
strategy on perps. Anonymized assets (`ASSET-N`) on the public view to
protect alpha. Mode leaderboard compares sizing modes head-to-head.

**Surface**:
- `/funding` — live PnL, open positions (redacted), mode leaderboard
- `/strategy` — allocation logic explainer

**Direction**:
- Demonstrate operational capability for B2B clients.
- Mode leaderboard becomes the "we test our own assumptions"
  differentiator.
- Future: private/Pro mode that unredacts asset names.
- Move paper data to Postgres `funding_lab` schema once we need
  long-horizon analytics (currently jsonl is fine).

### `edge_lab` — Edge Lab (Cross-Venue Research)  *(active)*

**What it is**: cross-venue research lab over Hyperliquid + dYdX v4 live
data. First active surface: HL→dYdX **lead-lag paper trader** with
$10,000 virtual capital that polls public quote endpoints at ~1Hz, runs
a z-score impulse signal on log-returns, and simulates entries on dYdX
with explicit fee + slippage + latency. NEVER places real orders.

**Surface**:
- `/lead-lag` — live equity, open positions, recent closed trades,
  rolling 24h/72h/7d analytics, freshness badge.

**Direction**:
- Validate that the cross-correlation peak measured offline
  (`06_lead_lag.py`) survives realistic execution costs.
- Add daily verify-on-parquet to catch live-engine drift.
- If equity curve is honestly profitable for ≥30 days, promote the
  signal from research to a B2B offering ("we run paper, here is the
  receipt").
- Provision `edge_lab` Postgres schema only when long-horizon analytics
  outgrow the jsonl/parquet on-disk format.

### `whale_edge` — Whale Edge  *(in-development)*

**What it is**: whale-flow analytics. Reads from `/opt/hl-research`
strictly READ-ONLY. PnL math regression-tested.

**Direction**:
- Surface `/whale` route once first usable signal is wired.
- Provision `whale_edge` Postgres schema when first DB-backed feature
  lands.
- Per-product scope already declared in `whale-edge/PRODUCT_SCOPE.md`.

### `smart_money` — Smart Money Solana  *(planned)*

**What it is**: smart-wallet identification and signal extraction on
Solana.

**Direction**:
- Slot reserved in `products.yaml`; no code yet.
- First milestone: define wallet-clustering algorithm + data sources
  (Helius enhanced txns, Solana RPC).

## Active Workstreams

(Status as of platform v1.1.0 — agent windows currently active.)

- **Platform** — v1.1.0 just shipped: versioning, machine-readable
  registry, boundary checks, health checks, leaderboard cache.
- **Funding Lab** — sizing modes recently added in
  `Ideas/hyperliquid-edge/47_funding_live_paper.py`; mode leaderboard
  page integrated.
- **Meteora** — production deploy live at `https://medioko.com/`,
  hourly refresh enabled. Pilot $100 LP position not yet opened.
- **Whale Edge** — early development; PnL test suite; not yet on web.

## Next Up

Loose priority order — adjust freely, just bump platform version if
this list is part of a contract change.

1. **Per-product `PRODUCT_SCOPE.md` for `meteora` and `funding_lab`**
   (template: `whale-edge/PRODUCT_SCOPE.md`). Currently those scopes
   live implicitly in `products.yaml`; explicit per-product files
   give agents tighter context.
2. **Wire `health-check.sh` into VPS cron** for `meteora` and
   `funding_lab`. Configure `PLATFORM_TG_BOT_TOKEN` +
   `PLATFORM_TG_CHAT_ID` for the operator Telegram.
3. **Install per-repo pre-commit hooks** in active product repos
   (`meteora-dash`, `hyperliquid-edge`, `whale-edge`) using
   `scripts/platform/install-pre-commit.sh`.
4. **Deploy mode-leaderboard timer** to VPS (`meteora-dash-mode-leaderboard.timer`).
5. **Conservative APR / dataset disclosure** on Meteora dashboard
   (already discussed; Meteora-product scope only).
6. **Open the $100 LP pilot position** per `meteora-dash/docs/PILOT.md`.
7. **Provision `funding_lab` Postgres schema** when first long-horizon
   analytics feature is requested (not now).

## Backlog

- Smart Money product MVP (clustering algorithm + data ingest).
- Whale Edge `/whale` page (once signal is producing).
- Per-product `health` heartbeat for `whale_edge` once it has any
  steady-state worker.
- Decision: monetization model for Meteora (alerts subscription vs
  B2B research) — defer until 30 days of public track record exist.
- Decision: whether to spin off a separate degen/memecoin domain or
  keep all products serious-grade. Current default: keep separate.

## Architecture Decisions

Recorded as ADRs in entries below. When taking a new architectural
decision, append it here and reference it from the relevant
CHANGELOG entry.

### ADR-001 — Mono-frontend Next.js (v1.1.0)

**Decision**: All product routes live in a single Next.js app
(`meteora-dash/`). Each product owns its `app/<route>/` and
`lib/storage/<product>.ts`, but the build, deploy, and reverse proxy
are shared.

**Context**: Solo-operator scale. Splitting into N Next.js apps would
multiply operational overhead (build pipelines, Caddy blocks, TLS
certs, process trees) by N for marginal isolation gain.

**Consequences**: Frontend deploys release all products at once. To
mitigate: per-product page modules MUST NOT throw at module load
(defer all I/O to request-time). Backend workers, ingestors, and
schemas remain fully independent.

### ADR-002 — Postgres schema-per-product, role-per-product (v1.0.0)

**Decision**: One Postgres instance, one schema per product, one DB
role per product with RW only in its own schema.

**Context**: Sharing a single instance is operationally simple; not
sharing schemas avoids cross-contamination.

**Consequences**: New product = new schema + new role + grant routine.
Cross-product reads happen via `core` schema (read-only) or via
filesystem with explicit READ-ONLY mounts.

### ADR-003 — Funding paper data on filesystem, not Postgres (v1.0.0)

**Decision**: Funding Lab paper-trading writes JSON/JSONL to
`/opt/hl-research/data/funding/...` rather than Postgres.

**Context**: Faster iteration, simpler ops, zero Postgres dependency
for the live paper loop. Postgres outage cannot kill paper trading.

**Consequences**: No SQL analytics on paper history yet. Mode
leaderboard recomputed by worker every 5 min and cached
(`mode_leaderboard.json`) so request path stays cheap. Migration to
Postgres is a future MINOR bump if/when needed.

### ADR-004 — Machine-readable `products.yaml` as source of truth (v1.1.0)

**Decision**: `products.yaml` is the canonical product registry.
`PRODUCT_REGISTRY.md` is generated from it.

**Context**: Markdown is not machine-readable; CI checks and helper
scripts need a structured format. yaml is the smallest format that
covers our needs (4-line vendored parser is enough).

**Consequences**: Editing the markdown directly is a mistake; the
boundary checker rejects it. Generator runs in seconds with no deps.

### ADR-005 — Versioned platform contracts with rollback protocol (v1.1.0)

**Decision**: Platform contracts are versioned (semver). Every change
bumps `VERSION` and appends to `PLATFORM_CHANGELOG.md`. Versions are
monotonic; reverts use a new PATCH bump describing the revert.

**Context**: Multi-agent + multi-product without versioning leads to
silent contract drift. Solo operator cannot remember what changed
when. Need explicit rollback path for bad changes.

**Consequences**: Slightly more friction per platform change; large
visibility win for any agent reading the codebase later.

## Multi-Agent Workflow

Multiple agent windows often work in parallel. To keep them from
stepping on each other:

1. **Each agent task starts with reading order from
   `AGENT_BOOTSTRAP.md`** — including the latest CHANGELOG entry, so
   the agent knows the current contract version.
2. **Every agent uses the task intake template**
   (`docs/agents/TASK_INTAKE_TEMPLATE.md`) declaring `Product`,
   `Allowed surface`, and `Do not touch`. This is binding.
3. **Boundary checker enforces** at commit time. An agent that
   touches a forbidden file gets blocked.
4. **CHANGELOG is append-only**. No agent rewrites past entries.
   If a previous agent's change was wrong, current agent reverts and
   bumps PATCH.
5. **When two agents need to touch the same surface** (rare),
   coordinate via the operator. Don't try to merge concurrently.

## Open Questions

(Things worth deciding soon. Move to ADRs when decided.)

- **Q1**: When do we provision Postgres schemas for `funding_lab` and
  `whale_edge`? Trigger condition: first analytics feature that needs
  joins or aggregates beyond what jsonl/parquet supports.
- **Q2**: Will we spin off a separate domain for memecoin/degen
  products, or keep them on the same `medioko.com` umbrella with
  clear visual separation? Current default: separate.
- **Q3**: Operator Telegram chat — single chat for all platform
  alerts, or per-product chats? Current default: single chat with
  product name in the message body.
- **Q4**: Is `core` schema's first concrete table needed, or is
  filesystem coordination enough until a real cross-product join
  appears? Current default: defer until needed.
