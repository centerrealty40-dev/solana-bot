# Solana Alpha — журнал релизов продукта

Версия в файле [`VERSION`](./VERSION) — **semver продукта** (торговое/paper ядро + конфиги стратегий + восстановление состояния из журнала). Она **не обязана** совпадать с полем `version` в `package.json` (npm); при желании их можно синхронизировать только для крупных релизов.

Каждая запись ниже обязана содержать: дату, номер версии, краткое описание, **git-тег** (если применимо), **инструкцию отката**.

Формат записей — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), семвер — [Semantic Versioning 2.0.0](https://semver.org/lang/ru/).

---

## [1.11.14] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.14`.

### Paper / Live Oscar — сетка TP + запрет DCA после первого TP

- Трекер: при **`PAPER_TP_GRID_STEP_PNL > 0`** включается сетка частичных TP (шаг PnL к средней, доля продажи от **текущего** остатка); дискретный **`PAPER_TP_LADDER`** не используется.
- После **первого** частичного TP по сетке **DCA отключены** для этой позиции.
- **`ladder_retrace`:** откат PnL к порогу предыдущей ступени сетки → полное закрытие (режим **`grid`** в `ladderRetraceTriggered`).
- Env: **`PAPER_TP_GRID_STEP_PNL`**, **`PAPER_TP_GRID_SELL_FRACTION`**; **`ecosystem.config.cjs`** для **`pt1-oscar`** и **`live-oscar`**: шаг **0.05**, доля **0.2**, **`PAPER_TP_LADDER`** пустой.
- Дашборд **`/papertrader2`**: таймлайны частичных продаж с меткой сетки; блок описания стратегии — **`<details>`** (компактная шапка).

### Откат

- В ecosystem вернуть прежний **`PAPER_TP_LADDER`** и **`PAPER_TP_GRID_STEP_PNL=0`** (или удалить grid-ключи); коммит + деплой §5.2.

---

## [1.11.13] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.13`.

### Live Oscar — W8.0 §9 шаг 3 (`live`)

- **`ecosystem.config.cjs`** (`live-oscar`): **`LIVE_EXECUTION_MODE=live`** при сохранении микролимитов §3.3 (`LIVE_MAX_POSITION_USD`, `LIVE_MAX_OPEN_POSITIONS`, …).
- Runbook: [`RUNBOOK_LIVE_OSCAR_PHASE7.md`](./RUNBOOK_LIVE_OSCAR_PHASE7.md) §0.2; деплой на VPS — только Git по [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md) §5.2.

### Откат шага 3

- В ecosystem **`LIVE_EXECUTION_MODE=simulate`** (шаг 2) или **`dry_run`** (шаг 1); коммит в **`v2`**, push, деплой §5.2.

---

## [1.11.12] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.12`.

### Live Oscar — keypair-файл из Phantom (base58)

- **`loadLiveKeypairFromSecretEnv`:** если **`LIVE_WALLET_SECRET`** указывает на файл, поддерживается содержимое как JSON-массив байт (CLI), так и **одна строка base58** (типичный экспорт Phantom).

### Откат

- Откат кода `wallet.ts` на версию **1.11.11**.

---

## [1.11.11] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.11`.

### Live Oscar — привязка к вашему кошельку

- **`LIVE_WALLET_PUBKEY`** (env): ожидаемый публичный адрес; при **`simulate`/`live`** и заданном ключе процесс сверяет pubkey из **`LIVE_WALLET_SECRET`** с этим значением и падает при расхождении.
- **`LIVE_WALLET_PUBKEY`**: задаётся на VPS (например в `ecosystem.config.cjs`), когда keypair-файл уже совпадает с вашим кошельком — иначе процесс завершится с ошибкой сверки (не включайте до загрузки верного файла).
- Runbook: [`RUNBOOK_LIVE_OSCAR_PHASE7.md`](./RUNBOOK_LIVE_OSCAR_PHASE7.md) §0.1 (про сид-фразу и keypair).

### Откат

- Убрать **`LIVE_WALLET_PUBKEY`** из env и перезагрузить PM2; откат кода — предыдущий коммит.

---

## [1.11.10] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.10`.

### Live Oscar — лимиты и дашборд

- **`LIVE_MAX_OPEN_POSITIONS=5`** в `ecosystem.config.cjs` (`live-oscar`).
- **`/papertrader2`:** таймлайн показывает ссылку **Solscan** на транзакцию, если в событии есть `txSignature` (on-chain подтверждённые свапы в live-журнале).
- **`loadLiveOscarJsonlAsPaper2`:** парсинг `live_position_*` в API paper2 для колонки Live Oscar + корреляция `execution_result.txSignature` с событиями таймлайна.

### Откат

- В ecosystem вернуть прежнее **`LIVE_MAX_OPEN_POSITIONS`**; откатить правки `dashboard-server.ts` / `dashboard-paper2.html` при необходимости.

---

## [1.11.9] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.9`.

### Live Oscar — rollout W8.0 §9 шаг 2 (simulate + микролимиты)

- **`ecosystem.config.cjs`** (`live-oscar`): **`LIVE_EXECUTION_MODE=simulate`**, **`LIVE_WALLET_SECRET`** → путь к микро-keypair на VPS, лимиты §3.3 (**`LIVE_MAX_POSITION_USD=10`**, **`LIVE_MAX_OPEN_POSITIONS=1`**, **`LIVE_MAX_STRATEGY_LOSS_USD=50`**, **`LIVE_KILL_AFTER_CONSEC_FAIL=3`**, **`LIVE_MIN_WALLET_SOL=0.05`**).
- Операторский скрипт: **`scripts/ops/ensure-live-micro-keypair.mjs`** — создаёт keypair при первом запуске, если файла нет.
- Runbook: [`RUNBOOK_LIVE_OSCAR_PHASE7.md`](./RUNBOOK_LIVE_OSCAR_PHASE7.md) §0.1.

### Откат шага 2

- В ecosystem вернуть **`LIVE_EXECUTION_MODE=dry_run`**, убрать **`LIVE_WALLET_SECRET`** из блока `live-oscar` (или оставить файл на диске — в **`dry_run`** не используется), **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`**.

---

## [1.11.8] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.8`.

### Live Oscar — старт rollout W8.0 §9 шаг 1

- **`ecosystem.config.cjs`** (`live-oscar`): **`LIVE_STRATEGY_ENABLED=1`**, **`LIVE_EXECUTION_MODE=dry_run`** — неделя наблюдения паритета с **`pt1-oscar`** без ключа и без on-chain send (см. [`RUNBOOK_LIVE_OSCAR_PHASE7.md`](./RUNBOOK_LIVE_OSCAR_PHASE7.md) §0).

### Откат шага 1

- В ecosystem выставить **`LIVE_STRATEGY_ENABLED=0`**, **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`**.

---

## [1.11.7] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.7`.

### Live Oscar — quote freshness по умолчанию включена

- **`LIVE_QUOTE_MAX_AGE_MS`:** если переменная **не** задана, конфиг использует **8000 ms**; **`0`** явно **выключает** гейт.
- **`ecosystem.config.cjs`** (`live-oscar`): **`LIVE_QUOTE_MAX_AGE_MS: '8000'`** для видимости в проде.
- Runbook: [`RUNBOOK_LIVE_OSCAR_PHASE7.md`](./RUNBOOK_LIVE_OSCAR_PHASE7.md) §1 п.5; после правки env в ecosystem — **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`**.

### Откат

- `VERSION` **`1.11.6`**; выставить **`LIVE_QUOTE_MAX_AGE_MS=0`** или убрать ключ из ecosystem и перезагрузить PM2.

---

## [1.11.6] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.6`.

### Live Oscar — свежесть Jupiter quote (W8.0 §10)

- **`LIVE_QUOTE_MAX_AGE_MS`** (опционально): после успешного quote+build Phase 4 сравнивает **`quoteSnapshot.quoteAgeMs`** с лимитом; при превышении или отсутствии валидного возраста — **`execution_result`** **`sim_err`** с **`quote_stale:…`** и счётчик consec-fail как у прочих `sim_err` ([`jupiter.ts`](../../../src/live/jupiter.ts) `liveQuoteExceedsMaxAge`, [`phase4-execution.ts`](../../../src/live/phase4-execution.ts)).

### Откат

- `VERSION` **`1.11.5`**; unset **`LIVE_QUOTE_MAX_AGE_MS`**.

---

## [1.11.5] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.5`.

### Live Oscar — Phase 7 хвосты (report, tx sample, CLI, дашборд)

- **`live_reconcile_report`** в **`LIVE_TRADES_PATH`** с **`liveSchema: 2`** (полный итог boot reconcile + опционально **`txAnchorSample`**).
- **`LIVE_RECONCILE_TX_SAMPLE_N`** — до N последних **`confirmed`** подписей → **`getTransaction`** (мягкая проверка якоря; см. runbook §9).
- **`npm run live-reconcile`** — одноразовый replay + reconcile без торгового цикла.
- Дашборд **`/papertrader2`**: индикаторы boot reconcile и tx anchor для колонки live-oscar.
- Документы: [`RUNBOOK_LIVE_OSCAR_PHASE7.md`](./RUNBOOK_LIVE_OSCAR_PHASE7.md) §7–11; [`W8.0_phase1_live_jsonl_contract.md`](../specs/W8.0_phase1_live_jsonl_contract.md) — вид **`live_reconcile_report`**.

### Откат

- `VERSION` **`1.11.4`**; выставить **`LIVE_RECONCILE_TX_SAMPLE_N=0`**; потребители, жёстко ожидающие только `liveSchema: 1`, могут игнорировать строки с `liveSchema: 2`.

---

## [1.11.4] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.4`.

### Live Oscar — W8.0 Phase 7 (закрытие хвостов чеклиста)

- **Replay:** `LIVE_REPLAY_MAX_FILE_BYTES` (дефолт 25 MiB) — при превышении читается только **хвост** файла (`readLiveJournalLinesBounded`); флаг **`journalTruncated`** в результате replay и **`journalReplayTruncated`** в heartbeat.
- **Reconcile:** параллельно **`getBalance`** (SOL lamports) и SPL; в результате — **`walletSolLamports`**, **`chainOnlyMints`** (ATA не из восстановленного `open`). Read-only RPC Phase 7 через **`qnCall` feature `sim`** (зафиксировано как канон; отдельного `live_read` в метере нет).
- **Boot telemetry:** снимок reconcile в **`live-reconcile-state`** → опциональные поля в каждом **`heartbeat`** (`reconcileBootStatus`, divergent mints, SOL, chain-only mints, truncated replay).
- **Безопасность:** при ошибке RPC списка токенов (`rpc_fail`) в режиме **`block_new`** выставляется блок новых входов + **`risk_block` / `reconcile_rpc_fail`** (раньше блок не включался).
- **`trust_chain`:** конфиг **отвергается**, пока не задано **`LIVE_RECONCILE_TRUST_CHAIN_ALLOWED=1`** (явное разрешение заглушки v1).
- **Документы:** [`RUNBOOK_LIVE_OSCAR_PHASE7.md`](./RUNBOOK_LIVE_OSCAR_PHASE7.md); спека [`W8.0_phase7_implementation_checklist.md`](../specs/W8.0_phase7_implementation_checklist.md) обновлена.
- **Канон replay v1:** восстановление позиций только из **`live_position_*`**, не из **`execution_*`** (путь **A** спеки).

### Откат

- `VERSION` **`1.11.3`**; откатить коммит; при необходимости **`LIVE_REPLAY_MAX_FILE_BYTES`** увеличить или отключить reconcile.

---

## [1.11.3] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.3`.

### Добавлено

- **W7.4.1** — повторные запросы Jupiter lite-api quote с экспоненциальным backoff на транзитных `skipped` (`http-error`, `timeout`, `fetch-fail`, `parse-error`) и **circuit breaker**: скользящее окно, порог доли неудач строго выше `PAPER_PRICE_VERIFY_CIRCUIT_SKIP_RATE_PCT`, cooldown; вердикт `skipped` / `circuit-open`. Охватывает pre-entry (`verifyEntryPrice`), pre-exit (`verifyExitPrice`), коридор Jupiter в **W7.6** (`impulse-confirm`), quote-fetch в **W7.8** (`fetchJupiterBuyQuoteResponse`).
- Спека [`docs/strategy/specs/W7.4.1_jupiter_quote_retries_circuit.md`](../specs/W7.4.1_jupiter_quote_retries_circuit.md); строка в [`INDEX`](../specs/INDEX.md); [`ROADMAP`](../ROADMAP.md) обновлён.

### Откат

- `VERSION` **`1.11.2`**; выставить `PAPER_PRICE_VERIFY_QUOTE_RETRIES_ENABLED=0` и `PAPER_PRICE_VERIFY_CIRCUIT_ENABLED=0` (или откатить коммит с `jupiter-quote-resilience.ts` и правками `price-verify.ts`).

---

## [1.11.2] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.2`.

### Изменено

- **`dashboard-paper2.html`:** расширено описание стратегии **Live Oscar** — полное зеркало paper-слоя (паритет с pt1-oscar), отличия **W7.3 / W7.5 / W7.8**, W7.4 / W7.4.2, интервалы и блок **LIVE_*** из [`ecosystem.config.cjs`](../../../ecosystem.config.cjs).
- Подписи **pt1-diprunner**, **pt1-dno**, **pt1-oscar** синхронизированы с текущими флагами RPC/Priority fee / verify (`ecosystem.config.cjs`).

### Откат

- `VERSION` **`1.11.1`**; откатить правки в **`scripts-tmp/dashboard-paper2.html`**.

---

## [1.11.1] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.1`.

### Изменено

- **RPC / QN нагрузка:** **W7.3** priority fee, **W7.5** liq-watch и **W7.8** paper sim-audit включены **только** у PM2 **`live-oscar`**; у **`pt1-diprunner`**, **`pt1-oscar`**, **`pt1-dno`** выключены (`PAPER_PRIORITY_FEE_ENABLED=0`, `PAPER_LIQ_WATCH_ENABLED=0`, `PAPER_SIM_AUDIT_ENABLED=0`).
- **W7.2 safety** включён и у **`pt1-diprunner`** (паритет с остальными тремя по «тяжёлому» pre-entry контуру).
- **`live-oscar`:** paper-слой выровнен с **`pt1-oscar`** (интервалы, post/dip/DCA, holders, impulse, W7.4); отдельный кеш **`priority-fee-cache-live-oscar.json`**; **`PAPER_SIM_AUDIT`** канарейка **5%** семпла.

### Откат

- `VERSION` **`1.11.0`**; восстановить прежние флаги в **`ecosystem.config.cjs`** для четырёх приложений; **`pm2 reload ecosystem.config.cjs --update-env`**.

---

## [1.11.0] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.0`.

### Добавлено

- **W7.4.2 pre-exit price verify:** перед частичной продажей (TP ladder) и полным закрытием трекер запрашивает Jupiter quote **token → SOL**, сравнивает исполнимую цену USD/токен с ценой снапшота по тем же порогам, что pre-entry (`PAPER_PRICE_VERIFY_MAX_*`). При `PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL=1` выход **откладывается** на следующий тик (`eval-skip-exit` в JSONL); на успешных выходах в журнал пишется `priceVerifyExit`. **LIQ_DRAIN** и **NO_DATA** по-прежнему без pre-exit.
- **ENV:** `PAPER_PRICE_VERIFY_EXIT_ENABLED`, `PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL` — [`config.ts`](../../../src/papertrader/config.ts), [`.env.example`](../../../.env.example).
- **Спека:** [`W7.4.2_pre_exit_price_verify.md`](../specs/W7.4.2_pre_exit_price_verify.md).
- **PM2:** `PAPER_PRICE_VERIFY_EXIT_*` включены для `pt1-diprunner`, `pt1-oscar`, `pt1-dno`, `live-oscar` в [`ecosystem.config.cjs`](../../../ecosystem.config.cjs).

### Откат

- `VERSION` **`1.10.4`**; выставить **`PAPER_PRICE_VERIFY_EXIT_ENABLED=0`** (или только снять **`EXIT_BLOCK_ON_FAIL`**) для затронутых приложений; **`pm2 reload … --update-env`**.

---

## [1.10.4] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.10.4`.

### Изменено

- **PM2 `live-oscar`:** включены **W7.4 pre-entry price verify** и **`PAPER_PRICE_VERIFY_BLOCK_ON_FAIL=1`** с теми же порогами, что у **`pt1-oscar`** ([`ecosystem.config.cjs`](../../../ecosystem.config.cjs)) — общий discovery до `tryExecuteBuyOpen` больше не зависит от «забытых» переменных только на VPS.

### Откат

- `VERSION` **`1.10.3`**; в **`ecosystem.config.cjs`** для `live-oscar` удалить или выставить **`PAPER_PRICE_VERIFY_ENABLED=0`** / **`PAPER_PRICE_VERIFY_BLOCK_ON_FAIL=0`**; **`pm2 reload live-oscar --update-env`**.

---

## [1.10.3] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.10.3`.

### Изменено

- **PaperTrader2 (`dashboard-paper2.html`):** описание стратегии **`pt1-oscar`** приведено в соответствие с prod **`ecosystem.config.cjs`** (одно DCA −7%, kill −14%, двухступенчатый TP-ladder +10%→50% и +20%→100% остатка, recovery veto дипа); добавлена явная отсылка к SSOT и [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md).
- Подписи таймлайнов открытых/закрытых позиций: уточнено, что доля ладдера — от **текущего** остатка после предыдущих частичных продаж; K/N берётся из журнала.

### Откат

- `VERSION` **`1.10.2`**; откатить изменения в `scripts-tmp/dashboard-paper2.html`; деплой по §5.2 норматива.

---

## [1.10.2] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.10.2`.

### Добавлено

- **Единый норматив** деплоя и параллельной работы: [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md) — свод **GitHub / локальный диск / VPS**, запрет рутинного **`scp`** tracked-кода поверх git-клона на проде; согласование с Cursor rule `server-autodeploy`. Перекрёстные ссылки в [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md), [`PARALLEL_WORKFLOW.md`](./PARALLEL_WORKFLOW.md), [`specs/INDEX.md`](../specs/INDEX.md).

### Откат

- Удалить указательный файл и записи в смежных документах; `VERSION` **`1.10.1`**.

---

## [1.10.1] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.10.1`.

### Изменено

- **PM2 `pt1-oscar`:** **`PAPER_DCA_LEVELS`** — одна ступень **−7%** (доля докупки **0.3** от базовой позиции); **`PAPER_DCA_KILLSTOP`** **−14%**; **`PAPER_TP_LADDER`** — **+10%** PnL → **50%** текущего остатка, **+20%** PnL → **100%** остатка (полное закрытие оставшегося), см. [`ecosystem.config.cjs`](../../../ecosystem.config.cjs).

### Откат

- `VERSION` **`1.10.0`**; в **`ecosystem.config.cjs`** для `pt1-oscar` вернуть прежние **`PAPER_DCA_LEVELS`**, **`PAPER_DCA_KILLSTOP`**, **`PAPER_TP_LADDER`**; **`pm2 reload pt1-oscar --update-env`**.

---

## [1.10.0] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.10.0`.

### Добавлено

- **W8.0 Phase 7:** восстановление **`open` / `closed`** из live JSONL событий **`live_position_*`** ([`replay-strategy-journal.ts`](../../../src/live/replay-strategy-journal.ts)); зеркалирование снимков из discovery + tracker ([`strategy-snapshot.ts`](../../../src/live/strategy-snapshot.ts)); reconcile SPL vs модели позиций через **`getTokenAccountsByOwner`** (Token + Token-2022), RPC **`qnCall`** с feature **`sim`** и опциональным **`LIVE_RPC_HTTP_URL`** ([`reconcile-live.ts`](../../../src/live/reconcile-live.ts)).
- **Политика расхождений:** **`LIVE_RECONCILE_MODE`**: `report` | `block_new` (дефолт) | `trust_chain` (v1 = отчёт + stub, без мутации модели по цепи); при **`block_new`** новые **`buy_open`/DCA** блокируются через [`live-reconcile-state.ts`](../../../src/live/live-reconcile-state.ts) + [`phase5-gates.ts`](../../../src/live/phase5-gates.ts).
- **ENV:** `LIVE_REPLAY_ON_BOOT`, `LIVE_REPLAY_TAIL_LINES`, `LIVE_REPLAY_SINCE_TS`, `LIVE_RECONCILE_ON_BOOT`, `LIVE_RECONCILE_MODE`, `LIVE_RECONCILE_TOLERANCE_ATOMS` — [`config.ts`](../../../src/live/config.ts), [`.env.example`](../../../.env.example).
- Контракт JSONL: **`live_position_open`**, **`live_position_dca`**, **`live_position_partial_sell`**, **`live_position_close`** в [`events.ts`](../../../src/live/events.ts); журналы без этих строк после рестарта дают пустое **`open`** (ожидаемо до появления новых событий).

### Изменено

- **[`store-restore.ts`](../../../src/papertrader/executor/store-restore.ts):** экспорт **`restoreOpenTradeFromJson`** для replay.

### Откат

- `VERSION` **`1.9.0`**; **`LIVE_REPLAY_ON_BOOT=0`** и/или **`LIVE_RECONCILE_ON_BOOT=0`**; PM2 restart **`live-oscar`**.

---

## [1.9.0] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.9.0`.

### Добавлено

- **W8.0 Phase 6 (`LIVE_EXECUTION_MODE=live`):** [`src/live/phase6-send.ts`](../../../src/live/phase6-send.ts) — опциональный pre-send **`simulateTransaction`** (`LIVE_SIM_BEFORE_SEND`), **`sendTransaction`**, опрос **`getSignatureStatuses`** до **`LIVE_CONFIRM_COMMITMENT`**; JSONL **`execution_result`** со статусом **`confirmed`** (+ опциональный **`slot`**) или **`failed`** / **`sim_err`**.
- **QuickNode:** feature **`live_send`** в [`qn-feature-usage.ts`](../../../src/core/rpc/qn-feature-usage.ts); опциональный **`QN_FEATURE_BUDGET_LIVE_SEND`**; [`qnCall`](../../../src/core/rpc/qn-client.ts) поддерживает **`httpUrl`** (`LIVE_RPC_HTTP_URL` для изоляции send/confirm).
- **ENV:** `LIVE_CONFIRM_*`, `LIVE_SEND_*`, `LIVE_RPC_HTTP_URL` — см. [`config.ts`](../../../src/live/config.ts), [`.env.example`](../../../.env.example).

### Изменено

- **[`src/live/config.ts`](../../../src/live/config.ts):** снят fail-fast «live до Phase 6»; **`live`** требует кошелёк как **`simulate`**.
- **[`src/live/phase4-execution.ts`](../../../src/live/phase4-execution.ts):** ветка **`live`** для buy/sell после Phase 5.
- **[`src/live/phase5-gates.ts`](../../../src/live/phase5-gates.ts):** гейты §3.3–§3.4 для **`live`**; виртуальный bump SOL из quote ротации только в **`simulate`** (в **`live`** — реальный баланс после confirm).

### Откат

- `VERSION` **`1.8.0`**; **`LIVE_EXECUTION_MODE=simulate`**; PM2 restart **`live-oscar`**.

---

## [1.8.0] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.8.0`.

### Добавлено

- **W8.0 Phase 5 (risk + capital gates):** слой перед Phase 4 adapter — [`src/live/phase5-gates.ts`](../../../src/live/phase5-gates.ts), [`src/live/phase5-runtime.ts`](../../../src/live/phase5-runtime.ts), счётчик [`src/live/phase5-state.ts`](../../../src/live/phase5-state.ts); порядок §6 спеки [`W8.0_phase5_risk_capital_gates_spec.md`](../../specs/W8.0_phase5_risk_capital_gates_spec.md).
- **`risk_block` / `capital_skip` / `capital_rotate_close`** при срабатывании лимитов; **simulate** — ротация через `executeLiveTokenToSolPipeline` + виртуальный bump **`free_usd`** из `outAmount` quote + повторный **`getBalance`** (§7).
- **ENV** §3.3–§3.4 в [`src/live/config.ts`](../../../src/live/config.ts); см. [`.env.example`](../../../.env.example).

### Изменено

- **[`src/live/phase4-execution.ts`](../../../src/live/phase4-execution.ts):** `sim_err` / `sim_ok` → **`notifyLiveExecutionSimErr` / `notifyLiveExecutionSimOk`**; экспорт **`executeLiveTokenToSolPipeline`** с **`wsolOutLamports`** для §3.4.
- **[`src/papertrader/main.ts`](../../../src/papertrader/main.ts):** опция **`liveOscarFactory(deps)`** (deps: open/closed maps) — используется **`live-oscar`** вместо статического `liveOscar`.
- **[`src/live/main.ts`](../../../src/live/main.ts):** `createLiveOscarPhase5Bundle` + baseline **`PAPER_POSITION_USD`** через **`loadPaperTraderConfig().positionUsd`** для **X**, если не заданы `LIVE_ENTRY_NOTIONAL_USD` / `LIVE_MAX_POSITION_USD`.

### Зафиксировано в реализации

- **`LIVE_MAX_POSITION_USD`:** превышение **`intendedUsd`** → **`risk_block`** (`max_position_usd`), **без clamp**.
- **Не заданные** числовые лимиты §3.3–§3.4 → соответствующая проверка **пропускается** (канарейка по умолчанию).
- **`LIVE_HALT_CLOSE_ALL_ON_MAX_LOSS`:** только последовательность **simulate** sell по открытым позициям в live JSONL; **Oscar `open` map не мутируется** (источник истины трекер / Phase 7 reconcile).
- **§3.4 dry_run:** гейты Phase 5 **не** применяются (как и simulate adapter); включайте **`simulate`** для проверки лимитов.

### Откат

- `VERSION` **`1.7.0`**; PM2 **`live-oscar`** restart; откат кода Phase 5 → снова **`createLiveOscarPhase4Bundle`** + **`liveOscar`** без factory.

---

## [1.7.0] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.7.0`.

### Добавлено

- **W8.0 Phase 4 (Oscar → adapter):** общий Oscar dip runtime в [`src/papertrader/main.ts`](../../../src/papertrader/main.ts) — опции **`journalAppend`**, **`skipPaperJsonlStore`**, **`liveOscar`** (discovery + tracker simulate), **`onOscarHeartbeat`**, **`onShutdown`**; live процесс не пишет paper JSONL (**P4-I1**).
- **Исполнение:** [`src/live/phase4-execution.ts`](../../../src/live/phase4-execution.ts) — `buy_open`, **`dca_add`** (SOL→token), **`sell_partial` / `sell_full`** (token→SOL) в режиме **`simulate`** → пара **`execution_attempt` / `execution_result`**; **`dry_run`** → **`execution_skip`** без открытия позиции.
- **Jupiter:** продажи [`liveSellQuoteAndPrepareSnapshot`](../../../src/live/jupiter.ts) (token → WSOL).
- **ENV:** опциональный **`LIVE_INHERIT_ENV_FILE`** (фрагмент с baseline **`PAPER_*`**, §3.3.1 спеки p4) — загрузка в [`src/live/main.ts`](../../../src/live/main.ts) до `loadLiveOscarConfig`; см. [`.env.example`](../../../.env.example).

### Изменено

- **[`src/papertrader/executor/tracker.ts`](../../../src/papertrader/executor/tracker.ts):** **`journalAppend`** + опциональный **`livePhase4`** (simulate перед мутацией DCA / partial / close).
- **[`src/scripts/live-oscar.ts`](../../../src/scripts/live-oscar.ts):** async **`main()`**.
- **PM2 `live-oscar`:** минимальный baseline **`PAPER_STRATEGY_KIND=dip`**, **`PAPER_DRY_RUN=false`**, **`PAPER_TRADES_PATH`** → заглушка (journal paper не используется); полный паритет с **`pt1-oscar`** — через серверный `.env` или **`LIVE_INHERIT_ENV_FILE`**.

### Документация

- [`docs/strategy/specs/W8.0_IMPLEMENTATION_PHASES.md`](../../specs/W8.0_IMPLEMENTATION_PHASES.md) — Phase 4 отмечена ✅.

### Откат

- `VERSION` **`1.6.3`**; **`git revert`** коммита Phase 4; PM2 перезапуск **`live-oscar`** (и при необходимости **`pt1-*`**).

---

## [1.6.3] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.6.3`.

### Добавлено

- **Recovery veto (dip):** после прохода dip-windows опционально блокировать вход, если по более короткому окну PG отскок от low ≥ порога (`PAPER_DIP_RECOVERY_VETO_*`). Реализация: [`src/papertrader/dip-detector.ts`](../../../src/papertrader/dip-detector.ts) (`evaluateRecoveryVeto`), интеграция в discovery; в JSONL `eval.m.recovery_veto`.
- Утилита [`scripts-tmp/paper2-diagnose-dip-recovery.ts`](../../../scripts-tmp/paper2-diagnose-dip-recovery.ts), npm **`paper2:diagnose-dip-recovery`**.

### Изменено

- **PM2 `pt1-oscar`:** **`PAPER_DIP_RECOVERY_VETO_ENABLED=1`**, окна **`30,60`** мин, порог **`12`**% — вето активно сразу после деплоя этого релиза.

### Откат

- `VERSION` **`1.6.2`**; в **`ecosystem.config.cjs`** для `pt1-oscar`: **`PAPER_DIP_RECOVERY_VETO_ENABLED: '0'`** или удалить три ключа **`PAPER_DIP_RECOVERY_VETO_*`**; при полном откате кода — revert коммита с dip-recovery.

---

## [1.6.2] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.6.2`.

### Добавлено

- **[`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md):** инварианты **I7** (монополия интегратора на `VERSION`/`CHANGELOG`, обязательный `git fetch` / опора на `origin/v2` перед bump), **I8** (до пяти параллельных исполнителей при соблюдении параллельного workflow); §4.7 параллельная работа и опциональный «резерв» semver; §6 — разделение исполнитель / интегратор; §8.1 — явное допущение **`git revert`** для точечного отката на `v2`.
- **[`PARALLEL_WORKFLOW.md`](./PARALLEL_WORKFLOW.md):** лимит и слоты **`task/agent-1-*` … `task/agent-5-*`**, локальные коммиты и **`git worktree`**, запреты для исполнителей, расширенный merge до пяти веток, чеклист интегратора с **I7**, §7 про **`git revert`**, §10 таблица «от черновиков до чистого push».

### Откат

- Документы: revert этого коммита; `VERSION` **`1.6.1`**.

---

## [1.6.1] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.6.1`.

### Добавлено

- **Дашборд `/papertrader2`:** первая колонка **Live Oscar** (`live-oscar`), фиксированный порядок **Live → Paper Oscar → Deep Runner → Dno** (`DASHBOARD_PANEL_ORDER`); журнал live **`DASHBOARD_LIVE_OSCAR_JSONL`** (дефолт от `PAPER2_DIR`); исключение **`pt1-oscar-live.jsonl`** из сканирования `PAPER2_DIR`.
- Тесты **`tests/dashboard-paper2-panels.test.ts`**.
- Спека **W8.0-p4:** §7 buy+sell+DCA в одном релизе, §3.3.1 два профиля ENV, §7.1 дашборд, закрыт §13.

### Миграции / деплой

- PM2 **`dashboard-organizer-paper`:** задать **`PAPER2_DIR`** и опционально **`DASHBOARD_LIVE_OSCAR_JSONL`** (в **`ecosystem.config.cjs`** уже добавлены дефолты путей).

### Откат

- Revert изменений в **`scripts-tmp/dashboard-server.ts`**, **`dashboard-paper2.html`**, **`ecosystem.config.cjs`**; `VERSION` **`1.6.0`**.

---

## [1.6.0] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.6.0`.

### Добавлено

- **W8.0 Phase 3 (live-oscar):** загрузка keypair из `LIVE_WALLET_SECRET` (файл / JSON-массив / base58), подпись Jupiter swap tx, **`simulateTransaction`** только через **`qnCall`** (`feature: 'sim'`), JSONL **`execution_attempt` / `execution_result`** со статусами **`sim_ok` | `sim_err`** в опциональном self-test; конфиг **`LIVE_SIM_*`**; fail-fast при **`LIVE_EXECUTION_MODE=live`** до Phase 6.
- Модули: **`src/live/wallet.ts`**, **`src/live/simulate.ts`**, **`src/live/phase3-self-test.ts`**; обновлены **`src/live/config.ts`**, **`src/live/main.ts`**.
- Тесты: **`tests/live-wallet.test.ts`**, **`tests/live-phase3-sim.test.ts`**; расширены **`tests/live-jupiter.test.ts`**, **`tests/live-oscar-config.test.ts`**.

### Миграции / деплой

- `npm install` (прямая зависимость **`bs58`**, dev **`@types/bs58`**); `npm run verify`; **`pm2 flush live-oscar && pm2 restart live-oscar --update-env`** при включённом процессе.

### Откат

- `VERSION` **`1.5.7`** и revert изменений Phase 3 в `src/live/**` и связанных тестах; при симуляции на сервере убедиться, что **`LIVE_EXECUTION_MODE`** не остаётся в неконсистентном состоянии.

---

## [1.5.7] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.5.7`.

### Исправлено

- **Счётчик холдеров (QN GPA):** для **Token-2022** убран фильтр `dataSize: 165` в `getProgramAccounts` (`holders-resolve.ts`). Аккаунты с **extensions** длиннее 165 байт больше не отбрасываются — устранён сильный недосчёт у популярных mint.

### Добавлено

- Утилита класса **A** ([`DIAGNOSTIC_SCRIPTS.md`](./DIAGNOSTIC_SCRIPTS.md)): `scripts-tmp/paper2-diagnose-holders-gpa.mjs`, npm **`paper2:diagnose-holders-gpa`** — сравнение старого и нового GPA для произвольного mint (read-only RPC).

### Миграции / деплой

- `npm run typecheck`; затем **`pm2 reload`** для paper-процессов, где включён live gate по холдерам (при необходимости полный restart по политике релиза).

### Откат

- Revert коммита или `VERSION` **`1.5.6`** + откат `holders-resolve.ts` и удаление утилиты/npm-скрипта.

---

## [1.5.6] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.5.6`.

### Добавлено

- **Спека W8.0 Phase 3:** [`W8.0_phase3_wallet_simulate_spec.md`](../specs/W8.0_phase3_wallet_simulate_spec.md) — lazy keypair (**P3-I1**), подпись swap tx, **`simulateTransaction`** только через **`qnCall`** (`feature: 'sim'`), JSONL **`execution_result`** (`sim_ok` / `sim_err`), self-test ENV, DoD §10; обновлены [`W8.0_IMPLEMENTATION_PHASES.md`](../specs/W8.0_IMPLEMENTATION_PHASES.md) и строка **W8.0-p3** в [`INDEX.md`](../specs/INDEX.md).

### Откат

- `VERSION` **`1.5.5`** и удаление спеки / строки INDEX / откат правок деревьев фаз.

---

## [1.5.4] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.5.4`.

### Добавлено

- **[`DIAGNOSTIC_SCRIPTS.md`](./DIAGNOSTIC_SCRIPTS.md)** — норматив: классы **A** (утилита в репо), **B** (одноразовый `_` + `.gitignore`), **C** (без файла); именование `paper2-*`, шапка файла, npm-регистрация, промоция B→A, сервер только через git.

### Изменено

- [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) — **§9.3**, связанный артефакт и таблица §12.
- [`INDEX.md`](../specs/INDEX.md) — ссылка на `DIAGNOSTIC_SCRIPTS.md` в блоке управления релизами.

### Откат

- `VERSION` **`1.5.3`** и удаление `DIAGNOSTIC_SCRIPTS.md` / откат правок §9.3.

---

## [1.5.3] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.5.3`.

### Изменено

- [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) — **§7.4** единый канон SSH для агентов: **`root@187.124.38.242`**, ключ **`botadmin_187_auto`**, явный **`-i`**; запрет опираться на чужой `~/.ssh/config` (`botadmin` / DNS хостинга) для этого VPS; PM2 по-прежнему через **`sudo -u salpha`**.

### Откат

- `VERSION` **`1.5.2`** и удаление §7.4.

---

## [1.5.2] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.5.2`.

### Добавлено

- **`scripts/check-release-hygiene.mjs`** + npm-скрипты **`check:hygiene`**, **`check:hygiene:integration`** (`--git-clean`), агрегатор **`verify`** (`typecheck` + hygiene + `test`) — автоматическая проверка **I5** (ссылки из [`INDEX.md`](../specs/INDEX.md)) и формата [`VERSION`](./VERSION); интеграционный режим дополнительно проверяет **I6**.
- **GitHub Actions** `.github/workflows/ci.yml`: на push/PR в `v2` и `main` — `npm ci`, `typecheck`, `check:hygiene` (без БД).

### Изменено

- [`PARALLEL_WORKFLOW.md`](./PARALLEL_WORKFLOW.md) и [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) — явное требование запуска проверок перед merge/push.
- [`INDEX.md`](../specs/INDEX.md) строка W8.0: semver не захардкожен, отсылка на [`VERSION`](./VERSION).

### Откат

- Удалить скрипт/workflow или `VERSION` **`1.5.1`**.

---

## [1.5.1] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.5.1`.

### Добавлено

- **`docs/strategy/ROADMAP.md`** — единая дорожная карта (статусы пакетов; SSOT выполненного по-прежнему `INDEX` + `CHANGELOG`).
- **`docs/strategy/specs/W6.3c_tp_ladder_remaining_mark_spec.md`** — файла не было в git, хотя на него уже ссылался [`INDEX.md`](./specs/INDEX.md) (W6.3c.1); устранено нарушение целостности каталога спек.
- Утилиты **`scripts-tmp/paper2-agg-eval-reasons.mjs`**, **`paper2-count-eval-recent.mjs`**, **`paper2-analyze-price-verify-jsonl.mjs`** — закреплены в репо (имена как у остальных `paper2-*.mjs`).

### Изменено

- **`docs/strategy/specs/W7.6_impulse_confirm_entry_path.md`** — статус блока: соответствие реализации (`impulse-confirm.ts`, Orca vs Jupiter-only ветки).
- **[`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md)** — инварианты **I5** (INDEX ↔ файлы в коммите), **I6** (чистое дерево перед push в `v2`); шаг закрытия задачи и пункты чеклиста §10; исправлена отсылка деплоя на **§7** (раньше ошибочно было §8).

### Откат

- `VERSION` **`1.5.0`** и удаление добавленных путей / revert коммита.

---

## [1.5.0] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.5.0`.

### Добавлено

- **W8.0 Phase 2 — Jupiter для live-oscar:** `src/live/jupiter.ts` — GET quote (SOL→mint) с настраиваемым **`LIVE_JUPITER_QUOTE_URL`**, POST unsigned swap с **`LIVE_JUPITER_SWAP_URL`**; нормализованный **`quoteSnapshot`** (§5 W8.0-p1) + поля **`swapBuildOk` / `swapTxBase64Len` / `swapBuildReason`**; опциональный смок **`runLiveJupiterSelfTest`** (`LIVE_PHASE2_JUPITER_SELF_TEST=1`, **`LIVE_PHASE2_SELF_TEST_MINT`**) пишет **`execution_attempt`** или **`execution_skip`** после `live_boot`. Конфиг: **`LIVE_JUPITER_QUOTE_TIMEOUT_MS`**, **`LIVE_JUPITER_SWAP_TIMEOUT_MS`**, **`LIVE_DEFAULT_SLIPPAGE_BPS`**; заголовок **`JUPITER_API_KEY`** при наличии.

### Миграции / деплой

- Без обязательных вызовов Jupiter, пока не включён self-test. Paper-процессы не затронуты.

### Откат

- Revert коммита Phase 2 или `VERSION` **`1.4.0`** + удаление `src/live/jupiter*.ts` и правок `config.ts` / `main.ts`.

---

## [1.4.0] — 2026-05-02

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.4.0`.

### Добавлено

- **W8.0 Phase 1 — замороженный контракт JSONL для `live-oscar`:** поле **`liveSchema: 1`** на каждой строке; типы событий `live_boot`, `live_shutdown`, `heartbeat`, `execution_attempt`, `execution_result`, `execution_skip`, `risk_block`, `capital_skip`, `capital_rotate_close`; валидация **Zod**; единая запись через **`appendLiveJsonlEvent`**; **`intentId`** (UUID v4) и **`newLiveIntentId()`**; матрица **`fsync`** по [`W8.0_phase1_live_jsonl_contract.md`](../specs/W8.0_phase1_live_jsonl_contract.md). Опционально **`LIVE_JSONL_FSYNC_HEARTBEAT=1`**.

### Миграции / деплой

- Деплой по желанию: процесс **`live-oscar`** по-прежнему без торговли (`LIVE_STRATEGY_ENABLED=0`). После выката новые строки в `LIVE_TRADES_PATH` содержат `liveSchema: 1`; старые строки Phase 0 без `liveSchema` остаются валидными для человеческого чтения, replay Phase 7 будет документировать политику.

### Откат

- Код: revert коммита W8.0-p1 или `VERSION` **`1.3.0`** + откат `src/live/*`.

---

## [1.3.0] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.3.0`.

### Добавлено

- **W7.8 — аудит `simulateTransaction` (papertrader):** на части открытий (семпл `PAPER_SIM_SAMPLE_PCT`, стабильный хеш `strategyId`+`mint`+`entryTs`) строится unsigned swap через Jupiter lite-api, затем **`qnCall('simulateTransaction', …, { feature: 'sim' })`**; результат — опциональное поле **`simAudit`** на событии **`open`** (`SimAuditStamp`: `ok` / `err` / `skipped`). По умолчанию выключено (`PAPER_SIM_AUDIT_ENABLED=0`); **не** блокирует вход v1. Переменные: `PAPER_SIM_*` (см. `.env.example`). Юнит-тесты: `tests/papertrader-sim-audit.test.ts`, фикстура `tests/fixtures/w7_8_open_sim_audit_ok.jsonl`.

### Миграции / деплой

- Код + `pm2 flush` / `pm2 restart --update-env` для процессов paper (**`pt1-diprunner`**, **`pt1-oscar`**, **`pt1-dno`**). Убедиться, что для симуляции задан **`SA_RPC_HTTP_URL`** (QuickNode), и при включении аудита учтён бюджет **`QN_FEATURE_BUDGET_SIM`**.

### Откат

1. **Операционно:** `PAPER_SIM_AUDIT_ENABLED=0`, `PAPER_SIM_SAMPLE_PCT=0` на всех pt1-* → `pm2 restart … --update-env` + `pm2 flush`.
2. **Код:** `git revert` merge-коммита W7.8 или откат к **`1.2.1`** (`VERSION` + исходники `sim-audit.ts`, `main.ts`, `config.ts`, `types.ts`, `price-verify.ts`).

---

## [1.2.1] — 2026-05-02

**Git-тег продукта:** `sa-alpha-1.2.1` (`git show sa-alpha-1.2.1` — полное описание релиза в сообщении тега).

### Исправлено

- **DCA (Oscar, diprunner, dno и любые процессы с `PAPER_DCA_LEVELS`):** каждый уровень усреднения срабатывает **не чаще одного раза** (индекс шага `dcaStepIndex` + `dcaUsedIndices`, совместимо с legacy `dcaUsedLevels` и epsilon); порог проверяется как **пересечение вниз** относительно предыдущего тика (`dcaLastEvalDropFromFirstPct`), чтобы при откате цены вверх и повторном входе в зону −7% повторной покупки не было.
- **`parseDcaLevels`:** дубликаты порога схлопываются; порядок ступеней — **от менее глубокого отката к более глубокому** (−7% перед −14%), как при обычном движении цены.
- После **`loadStore`** для открытых позиций вызывается **`reconcileOpenTradeDcaFromLegs`** по фактическим `legs[]`, если в журнале не было полных меток.

### Изменено

- Таймлайн `dca_add`: при наличии полей — **шаг K/N** и уточнение «от первой ноги».

### Добавлено (документация)

- **W8.0** — нормативный черновик спеки live Oscar: процесс `live-oscar` параллельно paper, схема `LIVE_*`, Jupiter swap + RPC, лимиты риска, ротация капитала **2X**, разделение журналов; см. [`docs/strategy/specs/W8.0_live_oscar_trading_bot.md`](../specs/W8.0_live_oscar_trading_bot.md) и строку в [`INDEX.md`](../specs/INDEX.md). Код live-исполнения в этот релиз **не входит**.

### Миграции / деплой

- Деплой + `pm2 restart` всех paper-процессов с DCA (`pt1-oscar`, `pt1-diprunner`, `pt1-dno`) и дашборда.

### Откат

- Коммит до merge или `VERSION` `1.2.0` и откат `tracker.ts`, `main.ts`, `config.ts`, `store-restore.ts`, `dca-state.ts`, `types.ts`.

---

## [1.2.0] — 2026-05-02

### Исправлено

- **TP-ladder (Oscar / diprunner и др.):** учёт срабатываний по **индексу ступени** (`ladderStepIndex` в JSONL + `ladderUsedIndices` в памяти/restore), параллельно с legacy `ladderPnlPct` / `ladderUsedLevels` — устраняет повторное срабатывание первой ступени после рестарта или при несовпадении float-ключей; финальная ступень с `sellFraction: 1` снова полностью выводит остаток.
- **`parseTpLadder`:** ступени всегда в порядке **возрастания порога PnL**; дубликаты порога в строке env схлопываются (последняя доля продажи побеждает).

### Изменено

- **Таймлайн paper2:** подпись частичного TP показывает **шаг K/N** и формулировку порога «к среднему входу»; для строк журнала без `ladderStepIndex` сохраняется прежний вид подписи.

### Миграции / действия при деплое

- Деплой кода + `pm2 flush … && pm2 restart pt1-oscar pt1-diprunner --update-env` (и прочие paper-процессы с ладдером). Старые строки `partial_sell` без `ladderStepIndex` по-прежнему восстанавливаются через `ladderPnlPct`.

### Откат

- Коммит до merge или установка `VERSION`/`CHANGELOG` на `1.1.0` и откат бинарника/исходников до предыдущего состояния `tracker.ts` / `store-restore.ts` / `parseTpLadder`.

---

## [1.1.0] — 2026-05-02

### Добавлено

- Опциональный вход discovery: **`PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP`** — если окна dip не прошли, но сработал тот же PG-триггер импульса, что и в начале `runImpulseConfirmGate`, dip-гейт для последующих фильтров считается пройденным; в событии **`eval`** журнала — опциональное поле **`entry_path`**: `dip_windows` | `impulse_pg_snap`.
- Для **pt1-dno** в `ecosystem.config.cjs` включён bypass по умолчанию (`PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP: '1'`).

### Заметки по поведению

- **Orca** в коде импульса — это только реализация ончейн-декодера для части пулов; bypass и PG-триггер работают для любого `source`, для которого есть таблица снимков в Postgres.
- Пролив «вверх» между двумя PG-снимками (условно «зелёная свеча» по Δ_pg): включите **`PAPER_IMPULSE_PG_ABS_MODE=1`** и задайте порог **`PAPER_IMPULSE_PG_MIN_ABS_PCT`** — тогда и bypass, и полный impulse-gate используют симметричный порог по |Δ_pg|.

### Миграции / действия при деплое

- После выката: `pm2 reload pt1-dno --update-env` (или полный цикл из runbook).

### Откат

1. Код: коммит до merge или предыдущий тег продукта.
2. Конфиг: снять `PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP` или выставить `0` для процессов, где bypass не нужен.

---

## [1.0.1] — 2026-05-02

### Добавлено

- [`PARALLEL_WORKFLOW.md`](./PARALLEL_WORKFLOW.md) — регламент параллельной работы агентов: ветки, роли исполнитель/интегратор, батчинг коммитов, один деплой на окно, связь с bump версии.

### Откат

- Код: предыдущий тег или коммит до merge этого документа.
- Версия продукта при откате документа только: вернуть `VERSION` к `1.0.0` не обязательно для runtime; для строгого совпадения — см. git history.

---

## [1.0.0] — 2026-05-02

### Добавлено

- Нормативный документ [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md): единый источник правды для параметров, контракт восстановления состояния после рестарта, процесс изменений, деплой, откат.
- Файлы **`VERSION`** и **`CHANGELOG.md`** в этой папке как обязательная точка учёта версии продукта.

### Известное состояние кода (ориентир для отката)

- Ветка разработки/прода: **`v2`** (актуальный коммит на момент принятия документа — см. `git log -1`).
- Критичные недавние исправления до введения версионирования (имеет смысл упоминать в пост-мортемах): восстановление `ladderUsedLevels` / `remainingFraction` из JSONL при `loadStore`, выравнивание описания Oscar в дашборде с `ecosystem.config.cjs`.

### Тег и откат

- Рекомендуемый аннотированный тег после стабилизации процесса:  
  `git tag -a sa-alpha-1.0.0 <commit> -m "Solana Alpha product release 1.0.0 — governance baseline"`  
  Тег **не заменяет** сохранение журналов сделок и БД на сервере.
- **Откат кода** до этой логической точки:  
  `git checkout sa-alpha-1.0.0` (или конкретный SHA из строки «Известное состояние» выше) → деплой по runbook в `RELEASE_OPERATING_MODEL.md`.
- **Откат состояния позиций** кодом не восстанавливается: см. раздел «Откат ≠ восстановление журнала» в операционной модели.

---

## Шаблон следующей записи (копировать при bump)

```markdown
## [X.Y.Z] — YYYY-MM-DD

### Добавлено / Изменено / Исправлено / Устарело / Удалено
- …

### Миграции / действия при деплое
- …

### Git-тег
- `sa-alpha-X.Y.Z` → SHA …

### Откат
1. Код: …
2. Конфиг/данные: …
```
