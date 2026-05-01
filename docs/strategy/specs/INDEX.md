# W6 Specs — Index

Папка содержит формальные спецификации для дешёвого агента-исполнителя. **Каждая спецификация — самодостаточна:** содержит все необходимые входные данные, контракты, acceptance criteria и forbidden actions. Агенту-исполнителю НЕ нужен доступ к `salvage/pre-v2` worktree, потому что все нужные сниппеты уже выписаны.

## Принципы спецификаций

1. **Каждая spec — атомарная задача.** Один PR → один merged commit → DoD проверяется автоматически или одним SQL/curl.
2. **Контракты данных явные.** Каждая колонка таблицы, каждый env var, каждый JSON-ключ описаны.
3. **Forbidden actions перечислены.** Что агент НЕ должен делать (трогать другие модули, менять схему чего-то ещё, push на main, и т.д.).
4. **Acceptance criteria — measurable.** Не «работает», а «`SELECT count(*) FROM X` возвращает >0 после запуска».

## Текущий список (revised после ответов пользователя)

Цель первого цикла — запустить **3 dip-стратегии в paper** (DipRunner / Oscar / Dno). Smart Lottery, Coverage Guardian, smart-money discovery, RPC enrichment — отложены до W6.7+.

| ID | Файл | Статус | Зависит от |
|---|---|---|---|
| W6.0 | [`W6.0_database_restoration.md`](./W6.0_database_restoration.md) | **выполнено** ✓ (3 миграции, 6 таблиц, HEAD `2d2a25a`) | — |
| W6.1 | [`W6.1_dex_collectors_port.md`](./W6.1_dex_collectors_port.md) | **выполнено** ✓ (6 PM2 коллекторов + health endpoints, HEAD `85f19d5`) | W6.0 |
| W6.3a | [`W6.3a_paper_trader_skeleton.md`](./W6.3a_paper_trader_skeleton.md) | **выполнено** ✓ (skeleton + `pt1-skeleton-test` PM2-app, HEAD `8a9de0e`) | W6.1 |
| W6.3b | [`W6.3b_paper_trader_discovery.md`](./W6.3b_paper_trader_discovery.md) | **выполнено** ✓ (discovery + filters + dip + whale + Binance BTC, HEAD `282f745`) | W6.3a |
| W6.3c | [`W6.3c_paper_trader_executor.md`](./W6.3c_paper_trader_executor.md) | **выполнено** ✓ (executor + main loop, HEAD `cfe34e2`) | W6.3b |
| W6.4 | [`W6.4_observability_port.md`](./W6.4_observability_port.md) | **выполнено** ✓ (observability port + cron + logrotate, HEAD `ecca52a`) | W6.3c |
| W6.5 | `W6.5_strategy_launch.md` | **следующая** | W6.4 |
| W6.6 | `W6.6_strategy_lab_port.md` | через ≥7 дней работы paper | W6.5 + runtime data |
| W6.7+ | _(пока без spec)_ Smart Lottery, Coverage, smart-money | по решению пользователя | W6.6 |

**W6.2 (Intel layer / smart-money discovery / RPC queue) — отменён в первом цикле.** Будет переоткрыт в W6.7 если/когда понадобится Smart Lottery.

## Сквозные требования к W6.3a/b/c

- **Execution realism.** Любая spec для W6.3 ОБЯЗАНА включать модуль `src/papertrader/costs.ts` с per-DEX комиссиями + size-aware slippage + network fee. Подробности — секция «Execution realism» в [`../W6_AUDIT.md`](../W6_AUDIT.md). Цель: paper PnL должен быть **upper bound** для live, не fantasy.

## Как использовать

1. Оркестратор-агент (этот, Claude Opus) пишет следующую spec на основе результатов предыдущей.
2. Оркестратор передаёт spec дешёвому агенту (например, gpt-5.5-medium через `Task` tool с `subagent_type: generalPurpose` и явным указанием модели).
3. Дешёвый агент выполняет задачу строго по spec, делает PR.
4. Оркестратор валидирует DoD, при необходимости — спец-фикс одним hot-fix коммитом.
5. Цикл повторяется.

## Соглашения о коммитах для дешёвого агента

- Один коммит = одна spec.
- Сообщение коммита: `feat(papertrader): W6.X — <короткое описание>` или `feat(db): W6.X — <таблицы>`.
- Никаких force push, никаких изменений `docs/platform/**`, никаких изменений vacant модулей вне scope spec.
- Перед коммитом — `npm run typecheck && npm run lint && npm run build && npm run test`.
- Локальная ветка `w6.X-<slug>` → squash merge в `v2`.
