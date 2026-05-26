# Task Intake Template

Copy this block into any new agent chat and fill placeholders.

```text
Product: <meteora | funding_lab | whale_edge | smart_money | solana-alpha | new_product>
Goal: <what must be delivered>

Allowed surface (ALLOWED_SURFACE): <exact folders/globs/files/schemas — empty means forbidden to touch code>
Do not touch: <critical paths / other products / schemas>

Deploy session: <yes | no>
  - no (default): implementation only — commit/PR readiness, typecheck/CI; NO SSH, NO scp, NO prod secrets in chat.
  - yes (explicit): after merge/push to integration branch, deploy per Solana Alpha NORM §5.2 — still NO scp/rsync of tracked trees over the Git clone.

Done when: <acceptance criteria in 2-5 bullets>

Read first:
- docs/platform/PLATFORM_CONTEXT.md
- docs/platform/BOUNDARIES.md
- docs/platform/DB_TOPOLOGY.md
- docs/platform/PRODUCT_REGISTRY.md
- docs/agents/AGENT_BOOTSTRAP.md
- If Solana Alpha release/deploy: docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md
```

## Git v2 / CI (Solana Alpha и затрагивающий прод код)

- Трекнутый код на VPS — **только** из **`origin/v2`** (`git fetch` → `reset --hard` → `npm ci` → PM2). Рутинный **`scp`/`rsync`** исходников и `package*.json` поверх клона **запрещён**.
- Перед пометкой «готово к merge в `v2`»: **`npm run typecheck`**, по политике репозитория — **`npm run check:hygiene`** и **`npm run check:hygiene:integration`** (см. норматив продукта).
- Агент **не мержит напрямую в `v2`** без вашего процесса: ветка **`task/*`** или PR → **human review diff** → CI → merge.
- **Секреты** (SSH-ключи прод, пароли DSN, содержимое `.env` на сервере) в промпт агента **не кладём**, если задача **не** помечена как deploy-session и не требуется явно для инцидента.

## Example

```text
Product: solana-alpha
Goal: Tune wallet orchestrator RPC caps.
Allowed surface: scripts-tmp/sa-wallet-orchestrator.mjs, scripts-tmp/wallet-orchestrator-lib.mjs, tests/wallet-orchestrator-lib.test.ts, ecosystem.config.cjs
Do not touch: src/live/**, other products, docs/platform/**
Deploy session: no

Done when:
- npm run typecheck passes
- Tests for wallet-orchestrator-lib pass
- PR opened; no scp — deploy later via Git v2 on VPS after merge

Read first:
- docs/agents/AGENT_BOOTSTRAP.md
- docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md
```
