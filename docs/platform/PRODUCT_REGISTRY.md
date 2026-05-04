# Product Registry

> **GENERATED FILE — DO NOT EDIT BY HAND.**
> Source of truth: `docs/platform/products.yaml`.
> Regenerate: `node docs/platform/generate-registry.mjs`.
> Platform version: 1.5.2

Single source of truth for product ownership and isolation boundaries.

## Rules

- Every product must have unique values for:
  - `db_schema`
  - `env_prefix` (each prefix string globally unique)
  - `systemd_prefix`
  - `site_routes` (each route globally unique)
- Shared components are listed explicitly in `shared_dependencies`.
- Any change to `products.yaml` is a platform-level change and must be:
  1. Reviewed against `BOUNDARIES.md` and `DB_TOPOLOGY.md`.
  2. Accompanied by a `PLATFORM_CHANGELOG.md` entry and `VERSION` bump.
  3. Followed by regenerating this file.

## Registry

| product_key | product_name | owner | status | db_schema | env_prefix | systemd_prefix | site_routes | shared_dependencies | notes |
|---|---|---|---|---|---|---|---|---|---|
| `meteora` | Meteora Analytics | center team | active | `meteora` | `METEORA_` | `hl-meteora-` | `/`, `/pool`, `/methodology`, `/positions`, `/paper-portfolio` | core ingestion, core entities | Main serious analytics surface (DLMM pools). Includes: (1) hourly ranking refresh of top pools (writes shared/data/latest.json), (2) /paper-portfolio: $10k paper allocation across top-5 by composite     score, daily UTC-midnight rebalance, recompute every 5 min via     meteora-dash-paper-trader. |
| `funding_lab` | Funding Lab / Anti-Funding | center team | active | `funding_lab` | `FUNDING_`, `HL_FUND_` | `hl-funding-` | `/funding`, `/strategy` | core ingestion, signal engine | Paper mode matrix enabled. Mode leaderboard cached every 5 min. |
| `whale_edge` | Whale Edge | center team | active | `whale_edge` | `WHALE_` | `hl-whale-` | `/whale` | core ingestion, wallet labels | Paper-trader (04_paper_trader) mirrors NET DIRECTION of curated Hyperliquid wallets into a fixed-budget virtual portfolio. NEVER places real orders. Reads /opt/hl-research/data/stream/trades/ <COIN>/*.jsonl strictly READ-ONLY via O_RDONLY (systemd ReadOnlyPaths=/opt/hl-research). Daily 08_discover refreshes the watchlist on a 7-day rolling window with quality filters. Public site route /whale shows redacted positions/PnL/roster. See whale-edge/PRODUCT_SCOPE.md for per-product details. |
| `edge_lab` | Edge Lab (Cross-Venue Research) | center team | active | `edge_lab` | `LEADLAG_`, `LAB_` | `edge-leadlag-` | `/lead-lag` | core ingestion | Cross-venue research lab (Hyperliquid + dYdX v4). First active surface: HL→dYdX lead-lag PAPER trader (10_paper_leadlag) with $10,000 virtual capital that polls public quote endpoints at ~1Hz and writes state/equity/events to /opt/edge-lab/out/leadlag. NEVER places real orders — no SDKs imported, systemd IPAddressAllow restricted to api.hyperliquid.xyz + indexer.dydx.trade. Daily 11_leadlag_report computes rolling 24h/72h/7d analytics and (optionally) verifies the live engine against historical mids parquet. Public site route /lead-lag in meteora-dash exposes a redacted live snapshot. Schema edge_lab reserved; not provisioned (filesystem-only for MVP). |
| `smart_money` | Smart Money Solana | center team | planned | `smart_money` | `SMARTMONEY_` | `hl-smartmoney-` | `/smart-money` | core ingestion, wallet labels | Future product slot. |

## New Product Checklist

1. Add product entry in `products.yaml` with all required fields.
2. Run `node docs/platform/generate-registry.mjs` to update this file.
3. Bump `VERSION` (MINOR for new product).
4. Append entry to `PLATFORM_CHANGELOG.md` with rollback note.
5. Create dedicated DB schema and role per `DB_TOPOLOGY.md`.
6. Reserve env prefix and systemd prefix.
7. Register site route(s) in the frontend (or note "not yet built").
8. Add per-product `PRODUCT_SCOPE.md` in the product's repo dir
   (see `whale-edge/PRODUCT_SCOPE.md` for the canonical template).
9. Add a `health` block in `products.yaml` so platform health checker
   can monitor freshness (or leave `null` for planned products).
