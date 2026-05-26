# Product Boundaries

## Scope Guardrails for Any Agent

- Touch only the current product scope unless explicitly requested.
- Never change another product's schema, jobs, env keys, or dashboards by accident.
- Avoid cross-product refactors in feature tasks.
- If shared core must change, keep backward compatibility for all products.

## Database Boundaries

- One PostgreSQL instance is allowed.
- Each product has its own schema and DB role.
- Product role has RW only in its schema.
- Cross-product reads are read-only and explicitly approved.

## Runtime Boundaries

- One service family per product (`systemd` units/targets grouped by product prefix).
- Logs are separated per product and per worker.
- Lock keys and cron/timer names must be product-prefixed.

## Config Boundaries

- Environment variables must be product-prefixed:
  - `METEORA_*`
  - `FUNDING_*` or `HL_FUND_*`
  - `WHALE_*`
  - `SMARTMONEY_*`
- No reuse of generic keys for different products.

## Change Management

- Before merge: check impact on other schemas, jobs, and routes.
- If uncertain, stop and ask for explicit approval before crossing boundaries.
