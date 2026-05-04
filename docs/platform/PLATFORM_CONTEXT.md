# Platform Context

> Platform version: see `docs/platform/VERSION`.
> Change log: `docs/platform/PLATFORM_CHANGELOG.md`.
> Source of truth for products: `docs/platform/products.yaml`.

## Mission

Build a multi-product onchain analytics platform on one shared engine:

- serious analytics products for B2B research and decision support;
- higher-volatility products for memcoin/speculative audience (in
  separate sub-product slots, not on the same domain as serious tools);
- both tracks live under one infrastructure if boundaries are strict.

## Product Map

The authoritative list is `docs/platform/products.yaml`. The current
state is also rendered into `PRODUCT_REGISTRY.md` for human reading.

Currently registered:

- `meteora` — LP analytics and pool intelligence (Meteora DLMM).
- `funding_lab` — funding-rate carry telemetry and strategy comparison.
- `whale_edge` — whale flow and large-wallet behavior (in development).
- `smart_money` — smart-wallet behavior and signal extraction (planned).

Future products must:

1. Add an entry in `products.yaml` (unique `db_schema`, `env_prefix`,
   `systemd_prefix`, `site_routes`, `repo_dirs`).
2. Bump platform `VERSION` (MINOR for additive product) and append a
   `PLATFORM_CHANGELOG.md` entry with rollback notes.
3. Run `node docs/platform/generate-registry.mjs` to regenerate
   `PRODUCT_REGISTRY.md`.
4. Add a per-product `PRODUCT_SCOPE.md` in the product's repo
   (template: `whale-edge/PRODUCT_SCOPE.md`).

## Shared Platform Components

- Ingestion and normalization engine (per-product workers + shared
  reusable libraries — kept backward-compatible).
- Common scheduler/runtime: systemd units with product-prefixed names,
  cron via systemd timers.
- Shared PostgreSQL instance with **schema-per-product isolation**
  (see `DB_TOPOLOGY.md`). Per-product DB roles enforce write isolation
  at the database level.
- Shared frontend foundation: a single Next.js app
  (`meteora-dash` codebase) where each product owns one or more route
  prefixes. See "Frontend topology" below for the rationale.

## Non-Negotiable Principles

1. **Schema-per-product isolation in Postgres**: a product role cannot
   write to another product's schema. Cross-product reads happen via
   `core` only (or via filesystem with explicit READ-ONLY mounts).
2. **Naming-prefix discipline**: env vars, systemd units, log paths,
   advisory locks, and (where possible) directories carry the
   product's prefix. Validated by `scripts/platform/check-boundaries.sh`.
3. **Backend independent deployability**: backend workers, ingestors,
   and timers are per-product. Stopping `hl-funding-*` units must not
   affect `hl-meteora-*` and vice versa.
4. **Versioned platform contract**: every change to platform docs,
   `products.yaml`, agent rules, or platform scripts requires a `VERSION`
   bump and a `PLATFORM_CHANGELOG.md` entry. Rollback protocol is
   documented in the changelog.

## Frontend Topology — explicit clarification

Earlier wording said "every product must be independently deployable
without breaking other products" without qualifying scope. In practice
the **frontend is intentionally a mono-Next.js app** (currently in
`meteora-dash/`). Each product's routes live in `app/<route>/`,
data accessors in `lib/storage/<product>.ts`, etc.

This is a deliberate trade-off for the solo-operator scale:

- **Pros**: one build pipeline, one Caddy block, one TLS cert, one
  process tree. Operational complexity grows with `O(1)` not `O(N
  products)`. Cross-product navigation is trivial (it's just `<Link>`).
- **Cons**: a frontend deploy releases code for all products at once;
  a render-time exception in one product's page can affect routing.
  Mitigated by per-product error boundaries and the rule that
  product page modules MUST NOT throw at module load (defer all I/O
  to request-time).
- **Will we split frontends later?** Only when a product's UI grows
  large enough that its build time, dependencies, or release cadence
  diverges meaningfully from the others. Not before.

The "independent deployability" rule still applies fully to:

- backend workers (each is its own systemd unit);
- ingestion pipelines (each is its own process);
- DB schemas (no cross-schema writes);
- data directories (no shared write paths).

## Operational Defaults

- **Health monitoring**: each product declares a `health` block in
  `products.yaml`; `scripts/platform/health-check.sh` runs from cron
  every 10 min and notifies Telegram on state transitions.
  See `HEALTH_CONTRACT.md`.
- **Boundary enforcement**: `scripts/platform/check-boundaries.sh` is
  installable as a per-repo pre-commit hook via
  `scripts/platform/install-pre-commit.sh`.
- **Funding paper data**: writes to `/opt/hl-research/data/funding/...`
  on disk; no Postgres dependency by default. The mode leaderboard is
  recomputed every 5 minutes by `meteora-dash-mode-leaderboard.timer`
  to keep `/funding` request-time cheap.

## For Agents

Read in this order before any non-trivial change:

1. `docs/platform/VERSION` (note current version)
2. `docs/platform/PLATFORM_CHANGELOG.md` (top entry — what changed last)
3. This file (`PLATFORM_CONTEXT.md`)
4. `docs/platform/BOUNDARIES.md`
5. `docs/platform/DB_TOPOLOGY.md`
6. `docs/platform/PRODUCT_REGISTRY.md` (or `products.yaml` for the source)
7. `docs/agents/AGENT_BOOTSTRAP.md`
8. The current product's `PRODUCT_SCOPE.md` (if it exists)

If you don't recognize the platform `VERSION`, you may be working
against stale assumptions — re-read the bootstrap doc.
