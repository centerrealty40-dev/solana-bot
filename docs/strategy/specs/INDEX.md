# W6 Specs — Index

Папка содержит формальные спецификации для дешёвого агента-исполнителя. **Каждая спецификация — самодостаточна:** содержит все необходимые входные данные, контракты, acceptance criteria и forbidden actions. Агенту-исполнителю НЕ нужен доступ к `salvage/pre-v2` worktree, потому что все нужные сниппеты уже выписаны.

## Управление релизами продукта (normative)

Единая операционная модель, semver продукта, журнал релизов и правила отката:

- [`../release/RELEASE_OPERATING_MODEL.md`](../release/RELEASE_OPERATING_MODEL.md) — **обязательный** регламент изменений, SSOT, рестарт/replay, деплой, чеклист.
- [`../release/VERSION`](../release/VERSION) — текущая версия продукта (semver).
- [`../release/CHANGELOG.md`](../release/CHANGELOG.md) — что вошло в каждую версию и как откатиться.
- [`../release/PARALLEL_WORKFLOW.md`](../release/PARALLEL_WORKFLOW.md) — как работать вдвоём/втроём агентов и не ломать деплой.
- [`../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md) — **единый свод:** версии, GitHub, локальный диск, VPS; канон деплоя (**Git на прод-клоне**, не `scp` tracked-кода поверх дерева).
- [`../release/DIAGNOSTIC_SCRIPTS.md`](../release/DIAGNOSTIC_SCRIPTS.md) — **нормативно:** классы **A/B/C** для скриптов анализа сделок и JSONL (`scripts-tmp/`, префикс `_`, `.gitignore`).

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
| W6.3c.1 | [`W6.3c_tp_ladder_remaining_mark_spec.md`](./W6.3c_tp_ladder_remaining_mark_spec.md) | **normative** (семантика `sellFraction` = доля остатка MTM; аудит `tracker.ts`; UX дашборда) | W6.3c |
| W6.4 | [`W6.4_observability_port.md`](./W6.4_observability_port.md) | **выполнено** ✓ (observability port + cron + logrotate, HEAD `ecca52a`) | W6.3c |
| W6.5 | [`W6.5_strategy_launch.md`](./W6.5_strategy_launch.md) | **выполнено** ✓ (DipRunner/Oscar/Dno PM2 + whale silence + heartbeat HC, HEAD `40d27dc`; см. примечание Dno ниже) | W6.4 |
| W7.2 | [`W7.2_safety_check_and_live_mcap.md`](./W7.2_safety_check_and_live_mcap.md) | **выполнено** ✓ (pre-entry QN safety + `mcUsdLive` timeline; canary safety на `pt1-dno`, HEAD `5faa6e5`) | W7.1 |
| W7.3 | [`W7.3_priority_fee_monitor.md`](./W7.3_priority_fee_monitor.md) | **выполнено** ✓ (live priority fee + JSONL `priorityFee`; full rollout pt1-{diprunner,oscar,dno}, HEAD `185044e`) | W7.2 |
| W7.4 | [`W7.4_pre_entry_price_verify.md`](./W7.4_pre_entry_price_verify.md) | **выполнено** ✓ (Jupiter quote pre-entry; canary shadow → block → full → use_jupiter_price; HEAD `d4d7bce`) | W7.3 |
| W7.4.1 | [`W7.4.1_jupiter_quote_retries_circuit.md`](./W7.4.1_jupiter_quote_retries_circuit.md) | **выполнено** ✓ (retry + exponential backoff + circuit breaker на транзитных `skipped`; см. [`CHANGELOG`](../release/CHANGELOG.md)) | W7.4 |
| W7.4.2 | [`W7.4.2_pre_exit_price_verify.md`](./W7.4.2_pre_exit_price_verify.md) | **выполнено** ✓ (Jupiter quote pre-exit перед partial/full sell; `eval-skip-exit`; см. [`CHANGELOG`](../release/CHANGELOG.md)) | W7.4 |
| W7.5 | [`W7.5_liquidity_drain_watch.md`](./W7.5_liquidity_drain_watch.md) | **выполнено** ✓ (LIQ_DRAIN + снимки пула vs `entryLiqUsd`; open стампит `pairAddress`/`entryLiqUsd`; tracker + dashboard + `/api/paper2/liq-watch-stats`; heartbeat в JSONL несёт `trackerStats` с `LIQ_DRAIN`. **Прод:** все три стратегии в `ecosystem.config.cjs` с `PAPER_LIQ_WATCH_ENABLED=1`, `FORCE_CLOSE=1` — без поэтапных канареек.) | W7.4 |
| W7.6 | [`W7.6_impulse_confirm_entry_path.md`](./W7.6_impulse_confirm_entry_path.md) | **выполнено** ✓ (impulse-confirm: триггер **Δ по двум последним PG-снимкам** пары; **Orca Whirlpool** — `getAccountInfo` (QN) + decode spot в USD; **остальные DEX** — путь **Jupiter-only** при `PAPER_IMPULSE_ALLOW_JUPITER_ONLY_UNSUPPORTED=1` (дефолт), иначе блок; коридор якорь↔on-chain↔Jupiter; `PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP` + `entry_path` в журнале; `ecosystem.config.cjs` pt1-* с `PAPER_IMPULSE_CONFIRM_ENABLED=1`) | W6.3b + W7.4 |
| W7.8 | [`W7.8_simulate_transaction_audit.md`](./W7.8_simulate_transaction_audit.md) | **выполнено** ✓ (аудит исполнимости: Jupiter unsigned swap + `simulateTransaction` через `qnCall` feature `sim`, семпл на пути `open`, опциональное поле `simAudit` в JSONL; v1 **не** gate; продукт **1.3.0**, см. [`CHANGELOG`](../release/CHANGELOG.md)) | (m) W7.1 + W7.4 + W6.3c |
| W8.0 | [`W8.0_live_oscar_trading_bot.md`](./W8.0_live_oscar_trading_bot.md) | **normative draft** (live Oscar параллельно paper; **Phase 2+ в коде:** `src/live/jupiter.ts` и др.; актуальный semver — [`VERSION`](../release/VERSION); см. [`W8.0_IMPLEMENTATION_PHASES`](./W8.0_IMPLEMENTATION_PHASES.md)) | W6.3c + W7.4 + release model |
| W8.0-p1 | [`W8.0_phase1_live_jsonl_contract.md`](./W8.0_phase1_live_jsonl_contract.md) | **выполнено** ✓ (контракт JSONL live-oscar в коде: `src/live/events.ts`, `appendLiveJsonlEvent`; продукт **1.4.0**; см. [`CHANGELOG`](../release/CHANGELOG.md)) | W8.0 Phase 0 |
| W8.0-p3 | [`W8.0_phase3_wallet_simulate_spec.md`](./W8.0_phase3_wallet_simulate_spec.md) | **выполнено** ✓ (продукт **1.6.0**; см. [`CHANGELOG`](../release/CHANGELOG.md), [`W8.0_IMPLEMENTATION_PHASES`](./W8.0_IMPLEMENTATION_PHASES.md)) | W8.0 Phase 2 + W8.0-p1 |
| W8.0-p4 | [`W8.0_phase4_oscar_parity_adapter_spec.md`](./W8.0_phase4_oscar_parity_adapter_spec.md) | **выполнено** ✓ (продукт **1.7.0**; см. [`CHANGELOG`](../release/CHANGELOG.md), [`W8.0_IMPLEMENTATION_PHASES`](./W8.0_IMPLEMENTATION_PHASES.md)) | W8.0-p3 + paper Oscar (`main`/`tracker`) |
| W8.0-p5 | [`W8.0_phase5_risk_capital_gates_spec.md`](./W8.0_phase5_risk_capital_gates_spec.md) | **выполнено в коде** (продукт **1.8.0**; [`CHANGELOG`](../release/CHANGELOG.md); см. [`W8.0_IMPLEMENTATION_PHASES`](./W8.0_IMPLEMENTATION_PHASES.md)) | W8.0-p4 + [`W8.0_live_oscar_trading_bot.md`](./W8.0_live_oscar_trading_bot.md) §3.3–§3.4 |
| W8.0-p6 | [`W8.0_phase6_live_send_confirm_spec.md`](./W8.0_phase6_live_send_confirm_spec.md) | **выполнено в коде** (продукт **1.9.0**; [`CHANGELOG`](../release/CHANGELOG.md); см. [`W8.0_IMPLEMENTATION_PHASES`](./W8.0_IMPLEMENTATION_PHASES.md)) | W8.0-p5 + W8.0-p3 + W8.0-p1 |
| W8.0-p7 | [`W8.0_phase7_replay_reconcile_spec.md`](./W8.0_phase7_replay_reconcile_spec.md) | **выполнено в коде** ✓ v1 (продукт **1.11.13** rollout §9 шаг 3 **live** + §0.2 runbook; [`CHANGELOG`](../release/CHANGELOG.md), [`RUNBOOK_LIVE_OSCAR_PHASE7.md`](../release/RUNBOOK_LIVE_OSCAR_PHASE7.md), [`чеклист`](./W8.0_phase7_implementation_checklist.md)) | W8.0-p6 + W8.0-p1 + paper restore patterns |
| W6.6 | `W6.6_strategy_lab_port.md` | **отложена** (через ≥7 дней работы paper после W7.3..W7.6) | W6.5 + runtime data |
| W6.7+ | _(пока без spec)_ Smart Lottery, Coverage, smart-money | по решению пользователя | W6.6 |

**W6.2 (Intel layer / smart-money discovery / RPC queue) — отменён в первом цикле.** Будет переоткрыт в W6.7 если/когда понадобится Smart Lottery.

**Примечание W6.5 (DoD):** все prod бумажные стратегии (`pt1-oscar`, `pt1-diprunner`, `pt1-dno`) и **`live-oscar`** используют пост-lane с **минимальным возрастом пула в снимке 2880 мин (48 ч / 2 дня)** и **`PAPER_POST_MAX_AGE_MIN=0`** (верхняя граница не задана); SSOT — блоки `env` в [`ecosystem.config.cjs`](../../../ecosystem.config.cjs). Если за окно наблюдения в БД мало зрелых пар, в JSONL возможны серии только `heartbeat` (`disc=0`) — это ожидаемо; формальный DoD «≥5 eval за 30 мин» в такой сессии может не достигаться до появления кандидатов или по решению пользователя — точечный hot-fix параметров (например ослабить `PAPER_POST_MIN_AGE_MIN` только для отдельного PM2-приложения) оформляется отдельным коммитом и записью в [`CHANGELOG`](../release/CHANGELOG.md).

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
