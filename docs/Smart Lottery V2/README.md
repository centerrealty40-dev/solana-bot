# Smart Lottery V2 — документация аналитического контура

Каталог **единой точки входа** для документов по **аналитическим разработкам** продукта Solana Alpha: сбор кошельков (seed), Wallet Atlas, smart-money / антибот, теги, жизненный цикл данных.

Торговые спеки paper/live (W6.3–W8), релизная нормативка и журнал версий продукта по-прежнему живут в [`../strategy/`](../strategy/) и [`../strategy/release/`](../strategy/release/).

---

## Для агентов (bootstrap)

1. **Сначала прочитайте этот `README.md`** и нужные файлы из списка ниже — не ищите аналитический контур по всему `docs/strategy/specs/`.
2. Реализация кода — ветка продукта **`v2`**, см. [`../strategy/release/RELEASE_OPERATING_MODEL.md`](../strategy/release/RELEASE_OPERATING_MODEL.md).
3. Платформенные границы Ideas: [`../../../docs/platform/BOUNDARIES.md`](../../../docs/platform/BOUNDARIES.md), [`../../../docs/platform/DB_TOPOLOGY.md`](../../../docs/platform/DB_TOPOLOGY.md).

---

## Решения для пилотного коллектора (зафиксировано)

Закрытые микро-решения и полный контракт **`metadata`**, semver, `batch_id`, извлечение pubkey, `ON CONFLICT` — **§6.3 и §6.6** в [`W6.7_gecko_raydium_wallet_seed_collector_local.md`](./W6.7_gecko_raydium_wallet_seed_collector_local.md). Кратко:

- Режим по умолчанию: **`SA_GRWS_MODE=v1b`** (есть `getTransaction`, запись в **`wallets`**).
- Пилот **без** отдельной staging-таблицы; конфликт по адресу: **`DO NOTHING`**.
- Версии: **`collector_id`** / **`SA_GRWS_COLLECTOR_SEMVER`** / **`batch_id`** на каждый прогон.
- Артефакт реализации: **`scripts-tmp/sa-grws-collector.mjs`** + **`npm run sa-grws-collector`** (при появлении кода).

---

## Оглавление (Smart Lottery V2)

| Документ | Назначение |
|----------|------------|
| [`ROADMAP_SMART_MONEY_DATA_PLANE.md`](./ROADMAP_SMART_MONEY_DATA_PLANE.md) | Дорожная карта: ingest → canonical → теги → архив → сигналы; риски |
| [`CONCEPT_DATA_PLANE_STAGING_TAGS_LIFECYCLE.md`](./CONCEPT_DATA_PLANE_STAGING_TAGS_LIFECYCLE.md) | Staging vs canonical, версии коллекторов/правил, теги, неактивность 90d |
| [`W6.7_gecko_raydium_wallet_seed_collector_local.md`](./W6.7_gecko_raydium_wallet_seed_collector_local.md) | Normative spec: Gecko `new_pools` + Raydium + QuickNode → `wallets` (локально v1) + **pilot defaults §6.6** |
| [`W6.8_wallet_ingest_orchestrator_gecko_multi_source.md`](./W6.8_wallet_ingest_orchestrator_gecko_multi_source.md) | Normative spec: **оркестратор** ingest в `wallets` по нескольким DEX‑lane (только Gecko + QN), **веса** lane, **weekly rebalance**, без DexScreener; торговые коллекторы не трогаются |
| [`W6.9_wallet_intel_detective_trading_spec.md`](./W6.9_wallet_intel_detective_trading_spec.md) | Normative spec: **Wallet Intel Detective** для торговли — denylist ферм / foundation smart money; слои L0–L4; правило по новому mint; фазы внедрения; **Helius опционально** (Phase 1–2) |
| [`W6.9_IMPLEMENTATION_CHECKLIST.md`](./W6.9_IMPLEMENTATION_CHECKLIST.md) | Чеклист реализации **v1** для агента: npm/CLI, миграции, схемы таблиц, E2E прогон, non-goals |
| [`W6.10_bot_umbrella_and_intel_pipeline.md`](./W6.10_bot_umbrella_and_intel_pipeline.md) | Umbrella-тег **`bot`**, слои A/B, единый пайплайн с W6.9, таксономия без wipe, задел на подтипы ботов |
| [`W6.11_intel_policy_dashboard_operator_spec.md`](./W6.11_intel_policy_dashboard_operator_spec.md) | Normative: решения оператора (ENV, K=1000, permissive mint-gate, WRITE_ATLAS), таксономия тегов ↔ политика, метрики scam-farm, дашборд **`/SmartLottery`** на etonne-moi.com |
| [`W6.14_scam_farm_analyzer_optimization_spec.md`](./W6.14_scam_farm_analyzer_optimization_spec.md) | Normative: оптимизация scam-farm analyzer — фаза B (treasury/sink, мета-кластеры, relay, temporal, CEX hint), новые теги/`source`, витрины, лимиты, roadmap P0–P5 |

### W6.12 — детектив без chain-wide firehose (ingest + бюджет)

| Документ | Назначение |
|----------|------------|
| [`W6.12_OVERVIEW_detective_without_chain_firehose.md`](./W6.12_OVERVIEW_detective_without_chain_firehose.md) | Обзор контура, карта S01–S06 |
| [`W6.12_S06_bounded_completeness_swap_ingest_plan_spec.md`](./W6.12_S06_bounded_completeness_swap_ingest_plan_spec.md) | **S06:** месячный план сходимости `wallet_backfill_queue`, формулы кредитов, gate enqueue, метрики SQL, согласование окон scam-farm / bot-bucket |

---

## Указатель на смежные документы (не дублировать без нужды)

| Тема | Где искать |
|------|------------|
| Индекс всех формальных W6+ спек (paper/trading) | [`../strategy/specs/INDEX.md`](../strategy/specs/INDEX.md) |
| PM2, cron, конвейеры sigseed / Atlas | [`../../deploy/RUNTIME.md`](../../deploy/RUNTIME.md) |
| Semver и CHANGELOG продукта solana-alpha | [`../strategy/release/VERSION`](../strategy/release/VERSION), [`CHANGELOG.md`](../strategy/release/CHANGELOG.md) |

---

## История названия

**Smart Lottery V2** — рабочее имя контура подготовки данных и аналитики для последующих стратегий (в т.ч. smart-money и отбор кошельков); не смешивать с одноимённым paper-процессом в PM2 без явной отсылки в задаче.
