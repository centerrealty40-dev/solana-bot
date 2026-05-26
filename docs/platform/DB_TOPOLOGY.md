# PostgreSQL Topology (Multi-Product)

## Target Layout

Single PostgreSQL instance, schema-per-product:

- `core` - shared normalized entities and reference tables.
- `meteora` - Meteora-specific marts and materializations.
- `funding_lab` - funding strategy analytics and experiment outputs (if DB-backed).
- `whale_edge` - whale flow product tables.
- `smart_money` - smart wallet product tables.

## Roles and Permissions

- `role_core_rw` -> RW in `core`.
- `role_meteora_rw` -> RW in `meteora`, optional RO in `core`.
- `role_funding_rw` -> RW in `funding_lab`, optional RO in `core`.
- `role_whale_rw` -> RW in `whale_edge`, optional RO in `core`.
- `role_smart_rw` -> RW in `smart_money`, optional RO in `core`.

No product role gets RW rights to another product schema.

## Migration Rules

- Each product keeps migrations in its own folder.
- Migration names are prefixed by product.
- Shared `core` migrations require explicit compatibility review.
- No "quick fix" SQL in production without migration artifact.

## Naming Rules

- Table names: `<domain>_<entity>` inside each schema.
- Job-owned tables include product prefix in comments/metadata.
- Advisory locks use product-specific key ranges.

## Data Flow Contract

- Raw/event tables can be shared only in `core`.
- Product marts stay product-local.
- Cross-product joins should happen in read models, not by writing into another product schema.
