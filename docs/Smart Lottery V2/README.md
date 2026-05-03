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
