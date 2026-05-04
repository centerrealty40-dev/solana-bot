# Agent Bootstrap

Use this file as the first context in every new agent/chat window.
For faster startup, use `docs/agents/TASK_INTAKE_TEMPLATE.md`.

## Read First (mandatory, in this order)

1. `docs/platform/VERSION` — note the current platform version.
2. `docs/platform/PLATFORM_CHANGELOG.md` — read the top entry; this
   tells you what changed in the most recent platform update and
   whether your previous understanding is still valid.
3. `docs/platform/PLATFORM_CONTEXT.md`
4. `docs/platform/BOUNDARIES.md`
5. `docs/platform/DB_TOPOLOGY.md`
6. `docs/platform/PRODUCT_REGISTRY.md` (generated from
   `docs/platform/products.yaml` — that yaml is the source of truth)
7. `docs/platform/HEALTH_CONTRACT.md` — only if your task touches data
   refreshing or health monitoring.
8. The current product's `PRODUCT_SCOPE.md` if one exists in the
   product's repo dir (e.g. `whale-edge/PRODUCT_SCOPE.md`).
9. **Solana Alpha — релиз, `v2`, CI, деплой на VPS, параллельные агенты:**
   `docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md` (единый норматив). Указатель в `docs/agents/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`.
10. **Карта агент-доков:** `docs/agents/DOC_INDEX.md`.

## Working Mode

- You are implementing one product inside a multi-product platform.
- Do not touch other products unless the user explicitly asks.
- Keep changes minimal and scoped to the current task.
- Multiple agents may be active in parallel on different products.
  Treat the platform contract as binding: if you change platform
  files, you MUST also bump `VERSION` and add a changelog entry —
  this is enforced by `scripts/platform/check-boundaries.sh`.

## Mandatory Inputs For Every Task

- `PRODUCT_NAME`: one of `meteora`, `funding_lab`, `whale_edge`,
  `smart_money`, or new product name.
- `TASK_GOAL`: exact outcome requested by user.
- `ALLOWED_SURFACE`: files/services/schemas you may modify.

## Git `v2`, CI и деплой (Solana Alpha)

1. **Источник правды на проде:** ветка интеграции **`v2`** на GitHub; VPS **`/opt/solana-alpha`** — **клон Git**, обновление tracked-кода **только** `git fetch origin v2 && git reset --hard origin/v2 && npm ci` → PM2 (полная последовательность: **`docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`** §5).
2. **Запрещено по умолчанию:** доставлять **трекнутый** код на VPS через **`scp`/`rsync`** поверх клона (ломает `npm ci`, SHA и историю). Исключения — только явно оговорённый **emergency** + всё равно приведение дерева к коммиту в Git.
3. **До merge в `v2`:** локально **`npm run typecheck`**; по регламенту продукта — **`npm run check:hygiene`** и **`npm run check:hygiene:integration`** (см. тот же NORM и `RELEASE_OPERATING_MODEL.md`).
4. **Роль агента и ветка:** работа в **`task/*`** или согласованной ветке; **прямой push агента в `v2`** не считается нормой — merge после **просмотра diff** и **зелёного CI**. На GitHub для **`v2`**: branch protection (required checks), **без force-push** — по возможности (политика репозитория).
5. **SSH / секреты:** в обычной задаче («только код») агент **не** подключается к прод-серверу и **не** вставляет в ответ ключи, DSN с паролями, содержимое прод-`.env`. Сессия с SSH допустима только если пользователь **явно** включил **deploy-session / разбор инцидента на сервере** в промпте (см. `TASK_INTAKE_TEMPLATE.md`).
6. **Индекс документов:** `docs/agents/DOC_INDEX.md`.

## Hard Constraints

- No cross-schema writes in PostgreSQL.
- No edits to other products' systemd units, timers, env files,
  or page routes.
- No env key reuse between products. Every new env var must carry a
  product prefix from `products.yaml` (or be one of the explicitly
  whitelisted shared/system vars in `check-boundaries.sh`).
- Shared core changes must preserve backward compatibility for ALL
  registered products (active, in-development, and planned where
  feasible).
- `docs/platform/PRODUCT_REGISTRY.md` is generated; never edit by hand.

## Definition of Done

- Feature works for the current product.
- No regression in other products by contract review.
- Build/lint/tests relevant to touched code pass.
- If platform contracts changed: `VERSION` bumped + changelog entry
  with rollback note + `PRODUCT_REGISTRY.md` regenerated.
- Short summary in final response listing changed surface and
  explicitly confirming "no cross-product changes" (or, if there are
  cross-product changes, they are listed with justification and the
  commit message includes a `Cross-product:` line).

## Cross-Product Changes (if truly required)

If your task legitimately requires touching more than one product
(e.g. introducing a new shared core utility):

1. Get explicit user approval first.
2. Add a `Cross-product: <reason>` line to the commit message —
   this is what `check-boundaries.sh` looks for.
3. Document the rationale in `PLATFORM_CHANGELOG.md`.

## Starter Prompt Template

```text
Product: <PRODUCT_NAME>
Goal: <TASK_GOAL>
Allowed surface: <ALLOWED_SURFACE>

Before coding, read (in order):
- docs/platform/VERSION
- docs/platform/PLATFORM_CHANGELOG.md (top entry)
- docs/platform/PLATFORM_CONTEXT.md
- docs/platform/BOUNDARIES.md
- docs/platform/DB_TOPOLOGY.md
- docs/platform/PRODUCT_REGISTRY.md
- docs/agents/AGENT_BOOTSTRAP.md
- <product>/PRODUCT_SCOPE.md if it exists
```
