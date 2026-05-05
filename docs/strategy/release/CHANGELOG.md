# Solana Alpha — журнал релизов продукта

Версия в файле [`VERSION`](./VERSION) — **semver продукта** (торговое/paper ядро + конфиги стратегий + восстановление состояния из журнала). Она **не обязана** совпадать с полем `version` в `package.json` (npm); при желании их можно синхронизировать только для крупных релизов.

Каждая запись ниже обязана содержать: дату, номер версии, краткое описание, **git-тег** (если применимо), **инструкцию отката**.

Формат записей — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), семвер — [Semantic Versioning 2.0.0](https://semver.org/lang/ru/).

---

## [1.11.88] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.88`.

### Оркестратор кошельков — выше дневные капы QN + исправление повторов слота

- **`ecosystem.config.cjs` (`sa-wallet-orchestrator`):** **`SA_QN_GLOBAL_CREDITS_PER_DAY=4000000`**, **`SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY=2200000`**, **`SA_BACKFILL_MAX_CREDITS_PER_DAY=500000`** — чтобы локальный потолок оркестратора не обрывал поток при заявленном низком расходе QuickNode.
- **`scripts-tmp/sa-wallet-orchestrator.mjs`:** после попытки job всегда **`markSlotFired`** (включая пропуск из‑за нулевого RPC-бюджета); **`markSlotFired`** через **`getState()`**; расширенный **`job skipped zero rpc budget`** в логах.

### Откат

- Прежние значения в **`ecosystem.config.cjs`** для блока **`sa-wallet-orchestrator`** или **`git checkout sa-alpha-1.11.87`**.

---

## [1.11.87] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.87`.

### Интегратор — исправление паритета байтов с VPS (`commit-tree`)

- Коммит **`c22f3a4`** на **`v2`**: заново записаны в git **фактические байты** с диска **`187.124.38.242`** для **`ecosystem.config.cjs`**, **`src/live/phase4-execution.ts`**, **`src/papertrader/executor/tracker.ts`** (родитель **`f2a401e`**). Сборка выполнена на VPS через временный индекс **`git read-tree f2a401e` + `git add` + `git commit-tree`** без `checkout`, затем bundle → push с машины с доступом к GitHub; **`git merge`/`reset` на проде не выполнялись до совпадения MD5 диск ↔ blob**.
- После проверки **`md5sum` диск = `git show origin/v2:`** для этих путей выполнено **`git reset --hard origin/v2`** на VPS — чистое **`git status`**, HEAD = **`c22f3a4`**, рабочие байты приложений не менялись относительно уже работавшего состояния.

### Откат

- **`git checkout sa-alpha-1.11.86`** или SHA **`f2a401e`** — вернёт репозиторий к состоянию до **`c22f3a4`** (не рекомендуется, если цель — совпадение с текущим продом).

---

## [1.11.86] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.86`.

### Интегратор — паритет репозитория с рабочей копией VPS (без изменений на сервере)

- На **`187.124.38.242`** ветка **`v2`** была на **`e387a15`**, при этом в рабочем дереве без коммита отличались **`ecosystem.config.cjs`**, **`src/live/phase4-execution.ts`**, **`src/papertrader/executor/tracker.ts`** — это и есть фактическая конфигурация/код, на которых крутится прод.
- Данный релиз **переносит эти три файла в `origin/v2`** как есть с диска VPS (через `scp`), чтобы GitHub совпадал с продом. Сервер **не модифицировался**.
- **Замечание:** байтовое содержимое в **`f2a401e`** для части путей **не совпало** с фактическим диском VPS; канонический паритет обеспечивает **`c22f3a4`** + релиз **`1.11.87`**.

### Откат

- **`git checkout sa-alpha-1.11.85`** (или SHA **`e387a15`**) — вернёт репозиторий к состоянию до паритета; откат **не** меняет уже развёрнутые на VPS файлы.

---

## [1.11.85] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.85`.

### Scam-farm graph — мягче пороги, длиннее окно, wide по умолчанию

- Дефолты **`graph/config.ts`:** lookback **168h**, narrow **≥5** источников, treasury **≥8**, **`SCAM_FARM_SINK_WIDE_MODE` включён по умолчанию** (исправлена подстановка env: раньше незаданная переменная давала wide=off), wide **≥10**, max targets **800**, SQL timeout **300s**, relay **3/3**, лимит рёбер среди seeds **12k**.
- **`.env.example`** — комментарии синхронизированы с дефолтами.

### Откат

- Задать в `.env` прежние пороги явно или **`git checkout sa-alpha-1.11.84`**.

---

## [1.11.84] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.84`.

### Scam-farm graph — исправление переполнения стека

- **`UnionFind.find`:** итеративный поиск с path compression вместо рекурсии — устранён **`Maximum call stack size exceeded`** на длинных цепочках объединений при больших выборках `money_flows`.

### Откат

- **`git checkout sa-alpha-1.11.83`** или предыдущий SHA; повторный деплой §5.2 норматива.

---

## [1.11.83] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.83`.

### Scam-farm — фаза B (W6.14): граф, treasury/sink, мета-кластеры

- **Миграция `0021_scam_farm_meta_graph`:** таблицы `scam_farm_meta_clusters`, `scam_farm_meta_cluster_members`, `scam_farm_meta_cluster_candidates` (идемпотентность мета по `fingerprint` SHA256 от отсортированных кошельков компоненты).
- **Код:** `src/intel/scam-farm-detective/graph/*` — узкий/широкий поиск sinks по `money_flows`, теги `farm_sink` / `farm_treasury` (`source=scam_farm_graph`), мета-кластеры и `farm_meta_member` (`source=scam_farm_meta`), relay (`relay_hub`), опционально temporal (`farm_time_cohort`, `source=scam_farm_temporal`) и CEX hint по allowlist.
- **CLI:** `npm run scam-farm:graph`; переменные окружения — блок в `.env.example`. По умолчанию **`SCAM_FARM_GRAPH_ENABLED=0`**, **`SCAM_FARM_GRAPH_DRY_RUN=1`** (безопасный noop).
- **Cron:** `scripts/cron/install-detective-data-plane-salpha.sh` — строка **`35 4`** UTC после `scam-farm:detect`; включение записи через `.env` на сервере (`SCAM_FARM_GRAPH_ENABLED=1`, `SCAM_FARM_GRAPH_DRY_RUN=0`).

### Откат

- Отключить граф: **`SCAM_FARM_GRAPH_ENABLED=0`** (или не задавать); при необходимости удалить cron-строку `scam-farm:graph` и откатить миграцию **`0021`** только по согласованию (данные мета-кластеров и новые теги с `scam_farm_graph` / `scam_farm_meta` / `scam_farm_temporal`).

---

## [1.11.82] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.82`.

### Live Oscar — scale-in 70/30, коридор ±5/−7%, TP до второй ноги

- **`ecosystem.config.cjs` (live-oscar):** `PAPER_ENTRY_FIRST_LEG_FRACTION=0.7`, `LIVE_ENTRY_SCALE_IN_DELAY_MS=5000`, коридор **`+5% / −7%`** к якорю первой ноги.
- **`tracker.ts`:** проверка второй ноги перенесена **после** частичных TP по сетке; при уже сработавшей ступени докупка не выполняется.
- **`entry-scale-in.ts`:** защита от докупки при ненулевом **`partialSells`** (`risk_note` `live_scale_in_skip_partial_tp_fired`).
- Дашборд / **IDEALIZED_OSCAR_STACK_SPEC.md** / **`.env.example`** — синхронизация описания.

### Откат

- **`git checkout sa-alpha-1.11.81`** и **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**; прежние числа: доля первой ноги **0.55**, задержка **30 000** мс, коридор **+1 / −2**.

---

## [1.11.81] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.81`.

### Oscar (paper + live) — IDEALIZED stack, дашборд, документация

- **Спека:** выравнивание с [`docs/strategy/specs/IDEALIZED_OSCAR_STACK_SPEC.md`](../specs/IDEALIZED_OSCAR_STACK_SPEC.md): усиленные пороги пост-lane (**ликв. ≥ $200k**, **vol 5m ≥ $20k**) для **pt1-oscar** и **live-oscar**; **paper:** `PAPER_TP_REGIME_ENABLED=1`, **`PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS=12`**; **live paper-слой:** `PAPER_TP_REGIME_ENABLED=0`, **`PAPER_LIVE_EXIT_MODE_AB=1`** и overrides **`PAPER_LIVE_EXIT_MODE_B_*`** (trail / timeout / kill).
- **Код:** журнал scale-in с `liveExitProfileMode`; paper `open` — то же при `PAPER_LIVE_EXIT_MODE_AB`; DCA-журнал — `liveExitProfileMode: B`; дашборд: поле **`contextNote`** в таймлайне (TP-regime на open/close у paper, режимы A/B; replay **live** JSONL подмешивает `tpRegime` / `liveExitProfileMode` из snapshot).
- **`scripts-tmp/dashboard-paper2.html`:** обновлены описания стратегий и подсказки таймлайна.

### Откат

- **`git checkout sa-alpha-1.11.80`** (или тег **`sa-alpha-1.11.80`**); затем **`pm2 reload ecosystem.config.cjs --only pt1-oscar,live-oscar --update-env`** под **`salpha`** и при необходимости перезапуск процесса дашборда. Предыдущие значения порогов входа в ecosystem: **$25k / $10k** vol 5m; у paper не было единого TP-regime по умолчанию и блока loss-exit cooldown в том виде.

---

## [1.11.80] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.80`.

### Detective ledger 2M / Telegram / sigseed включён по конфигу

- **`SA_QN_GLOBAL_CREDITS_PER_DAY`:** эталон **2 000 000** (detective: оркестратор, backfill, sigseed, scam-farm RPC-probe через **`sa-qn-json-rpc`**). При исчерпании — блок этих RPC до следующего UTC-дня + один **`[ALERT][detective-qn-day-cap]`** (миграция **`0020_sa_qn_global_daily_detective_alert`**, колонка **`detective_cap_alert_sent`**; выкл.: **`SA_QN_DETECTIVE_CAP_TELEGRAM=0`**).
- **Торговые стратегии** по-прежнему **`qn-client`** / **`QUICKNODE_*`** meter — отдельный контур, detective ledger их не режет.
- **`ecosystem.config.cjs`:** `SA_QN_GLOBAL_CREDITS_PER_DAY=2000000`, orch **850k**, backfill **350k** (≈70 % от 2M с запасом под **sigseed** в `.env`).
- Документация **`.env.example`**, **`RUNTIME.md`**: пример включённого sigseed и согласованных потолков.

### Откат

- **`git checkout sa-alpha-1.11.79`** на затронутые пути; при необходимости **`ALTER TABLE sa_qn_global_daily DROP COLUMN detective_cap_alert_sent`**.

---

## [1.11.79] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.79`.

### Исправление — Sigseed и W6.13 budget-check

- **`SA_SIGSEED_MAX_CREDITS_PER_DAY=0`:** не суммируется в `sa-qn-budget-check`, мягкий потолок компонента выключен (остаётся глобальный ledger). Непустое значение → мягкий потолок и учёт в предупреждении.

### Откат

- **`git checkout sa-alpha-1.11.78 -- src/scripts/sigseed-run.ts`**.

---

## [1.11.78] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.78`.

### Функция — W6.12 S03 Sigseed на `v2`

- Миграция **`0019_signatures_seed_queue`**, скрипты **`sigseed:enqueue`** / **`sigseed:run`** (`src/scripts/sigseed-run.ts`): очередь минтов из `*_pair_snapshots` → RPC (`sigseed_worker` в **`sa_qn_global_daily`**) → **`decodePumpfunSwap`** → **`swaps`** (`source=sigseed`). Advisory lock **`941337041`**, gates **`SA_SIGSEED_ENQUEUE_ENABLED`** / **`SA_SIGSEED_ENABLED`**.
- Cron detective installer: строки sigseed (по умолчанию gates **0**).
- **`deploy/RUNTIME.md`**: актуальное описание контура; **`w70-preflight-vps.sh`**: **`QUICKNODE_HOURLY_CREDIT_BUDGET=0`**.
- **`tsconfig.json`**: временный exclude для незавершённых локальных файлов papertrader/counterfactual (не в git).

### Откат

- **`git checkout sa-alpha-1.11.77 --`** затронутые пути; **`DROP TABLE signatures_seed_queue`** при необходимости снять миграцию вручную (осторожно: только если таблица пуста/не нужна).

---

## [1.11.77] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.77`.

### Согласование PM2 — лимиты QuickNode (W6.13)

- В `ecosystem.config.cjs` для `sa-wallet-orchestrator`: `SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY=700000`, `SA_BACKFILL_MAX_CREDITS_PER_DAY=320000`, `SA_QN_GLOBAL_CREDITS_PER_DAY=1500000` — совпадает с проверкой `sa-qn-budget-check` и не перекрывает весь глобальный кап оркестратором.

### Откат

- **`git checkout sa-alpha-1.11.76 -- ecosystem.config.cjs`**.

---

## [1.11.76] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.76`.

### Уточнение — вывод установщика crontab

- Убран повторный дамп блока в конце `install-detective-data-plane-salpha.sh` (проверка: `sudo -u salpha crontab -l`).

### Откат

- **`git checkout sa-alpha-1.11.75 -- scripts/cron/install-detective-data-plane-salpha.sh`**.

---

## [1.11.75] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.75`.

### Исправление — `install-detective-data-plane-salpha.sh` и crontab `salpha`

- Вся сборка `crontab` выполняется под **`salpha`** (`mktemp` + `crontab`), чтобы не было `Permission denied` на временном файле.

### Откат

- **`git checkout sa-alpha-1.11.74 -- scripts/cron/install-detective-data-plane-salpha.sh`**.

---

## [1.11.74] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.74`.

### Контур детектива без стрима на `v2` (sigseed в коде отсутствует)

- **Явно зафиксировано в `deploy/RUNTIME.md`:** на ветке **`v2`** нет реализации **sigseed** (нет `sigseed:*`, очередей, `rpc_features`) — только документация.
- **`scripts/cron/install-detective-data-plane-salpha.sh`:** идемпотентная установка crontab-блока **`SA_ALPHA_DP_*`** для **enqueue → `wallet-backfill:pilot` → `wallet-funding:backfill` → `scam-farm:detect` → `sa-qn-global-report` / `sa-qn-budget-check`** (UTC).
- **`src/scripts/wallet-funding-backfill.ts`:** добавлен в git (**W6.12 S04**), уже есть **`npm run wallet-funding:backfill`**.

### Откат

- Удалить блок `# SA_ALPHA_DP_BEGIN` … `# SA_ALPHA_DP_END` из `crontab -u salpha -e`; **`git checkout sa-alpha-1.11.73`**.

---

## [1.11.73] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.73`.

### RUNTIME — sigseed vs pilot, замер кредитов на прогон

- **`deploy/RUNTIME.md`:** что такое **sigseed** (pipeline 2), связь с торговыми стратегиями (опосредованно через данные), как проверить **PM2/cron** на хосте; **таблица** «сколько раз в сутки» **`wallet-backfill:pilot`** при подпуле **50k–150k** кредитов на backfill по фактическому замеру **~15,3k**/прогон.

### Откат

- **`git checkout sa-alpha-1.11.72 -- deploy/RUNTIME.md docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.73] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.73`.

### Paper Oscar A/B — TP regime по 12h снимкам + live dip «flush» guard

- **`pt1-oscar-regime` (PM2):** общий env с `pt1-oscar` через `ecosystem-paper-pt1-oscar-env.cjs`; отличия — `PAPER_STRATEGY_ID`, журнал `data/paper2/pt1-oscar-regime.jsonl`, `PAPER_TP_REGIME_ENABLED=1`.
- **Режимы:** `down` → одна ступень TP-grid, продажа 100% остатка; `sideways` → не более 2 ступеней; `up` / `unknown` → поведение как у baseline сетки.
- **`PAPER_DIP_FLUSH_GUARD_*`:** доп. фильтр входа по короткому окну high (по умолчанию 45m, min drop −7%) — включён для **live-oscar** в ecosystem.
- **Дашборд:** колонка `pt1-oscar-regime`, сетка тайлов `xl:grid-cols-5`.

### Откат

- **`git checkout sa-alpha-1.11.72`** и `pm2 reload ecosystem.config.cjs --only pt1-oscar,pt1-oscar-regime,live-oscar --update-env` (или отключить новый процесс).

---

## [1.11.72] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.72`.

### W6.12 — pilot wallet-backfill для `swaps` без стрима + расширенный doctor

- **`npm run wallet-backfill:pilot`:** узкие дефолты **`SA_BACKFILL_*`**, верхняя оценка кредитов в stdout, делегирование в **`wallet-backfill-run`** (совместимо с **`--enqueue-from-wallets`**, **`--dry-run`**).
- **`wallet-intel:doctor`:** **`swaps_last_168h`**, **`money_flows_last_168h`**, **`swaps_total`**, **`swaps_last_block_time`**, **`swaps_last_created_at`**; предупреждение при «старых» свопах.
- **`scripts/cron/wallet-backfill-pilot-salpha.sh`**, **`deploy/RUNTIME.md`:** процедура только через **git pull**; формула кредитов; цепочка **`sa-qn-global-report` → pilot → doctor → detect**.

### Откат

- **`git checkout sa-alpha-1.11.71`** на затронутые пути.

---

## [1.11.71] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.71`.

### Исправление — оркестратор не стартовал без `wallet-orchestrator-lib.mjs` из коммита W6.13

- **`scripts-tmp/wallet-orchestrator-lib.mjs`:** экспорт **`computeOrchestratorJobRpcCap`** (используется **`sa-wallet-orchestrator.mjs`**).
- **`tests/wallet-orchestrator-lib.test.ts`:** покрытие.

### Откат

- **`git checkout sa-alpha-1.11.70`** — если нужно вернуться к состоянию до фикса lib (оркестратор будет падать без ручного выравнивания lib); предпочтительнее остаться на **`sa-alpha-1.11.71`**.

---

## [1.11.70] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.70` (на VPS используйте **`sa-alpha-1.11.71`** — см. выше).

### W6.13 — операционный бюджет ~70%, резерв ~30%, наблюдаемость

- **`scripts-tmp/sa-qn-global-budget-lib.mjs`:** **`auditOperationalBudgetDeclared`**, **`logOperationalBudgetWarnings`**, **`qnOperationalPoolCeilingCredits`** (доля через **`SA_QN_OPERATIONAL_POOL_PCT`**, default **70**); учёт **`SA_SIGSEED_MAX_CREDITS_PER_DAY`**, **`SA_WALLET_TRACE_MAX_CREDITS_PER_DAY`**, **`SA_BOT_ANALYZER_MAX_CREDITS_PER_DAY`**, **`SA_BACKFILL_MAX_CREDITS_PER_DAY`** / оценка при **`SA_BACKFILL_ENABLED=1`**, **`SCAM_FARM_MAX_RPC_CREDITS_PER_DAY`** или **`SCAM_FARM_RPC_BUDGET`** × кредиты при **`SCAM_FARM_ENABLE_RPC=1`**.
- **`scripts-tmp/sa-wallet-orchestrator.mjs`**, **`wallet-backfill-run`:** предупреждения при старте при превышении целевого операционного потолка.
- **`npm run sa-qn-budget-check`** — JSON в stdout + **`warn`** в stderr для cron.
- **`hourly-telegram-report.mjs`:** секция ledger при **`HOURLY_APPEND_QN_LEDGER=1`** (нужен **`DATABASE_URL`** / **`SA_PG_DSN`** в окружении hourly).
- **`scam-farm-detective` / `rpc-probe`:** при наличии **`DATABASE_URL`** billable **`getAccountInfo`** через **`jsonRpcWithQnLedger`** (`scam_farm_rpc_probe`), остановка при **`QN_GLOBAL_DAY_CAP`**.
- **`wallet-backfill-run`:** приоритет очереди по **`metadata.seed_lane`** (enqueue + **`pickBatch`**).
- **Тесты:** `tests/sa-qn-global-budget-lib.test.ts`.

### Откат

- **`git checkout sa-alpha-1.11.69`** на затронутые пути; при сбоях hourly — **`HOURLY_APPEND_QN_LEDGER=0`**; при RPC detective — **`SA_QN_GLOBAL_LEDGER_ENABLED=0`** или **`SCAM_FARM_ENABLE_RPC=0`** (после согласования).

---

## [1.11.69] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.69`.

### W6.12 S05 — операционная готовность (документация runtime)

- **`deploy/RUNTIME.md`:** пример cron для **`wallet-backfill:run`** и **`wallet-funding:backfill`**, ссылка на **`sa-qn-global-report`** и спеку **W6.12 S05**.

### Откат

- **`git checkout sa-alpha-1.11.68 -- deploy/RUNTIME.md docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.68] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.68`.

### W6.12 S04 — funding_source из money_flows

- **`src/scripts/wallet-funding-backfill.ts`:** SQL-батч — первый вход **SOL** по **`money_flows`** за **`SA_FUNDING_LOOKBACK_DAYS`** → **`wallets.funding_source`** / **`funding_ts`** (только где **`funding_source IS NULL`**).
- **npm:** **`npm run wallet-funding:backfill`**, флаг **`--dry-run`** (без **`SA_FUNDING_BACKFILL_ENABLED`**); лимит строк за прогон **`SA_FUNDING_BATCH_SIZE`**.

### Откат

- Обнулить поля точечным SQL только после согласования; git **`sa-alpha-1.11.67`**.

---

## [1.11.67] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.67`.

### W6.12 S03 — общий JSON-RPC слой под глобальный ledger

- **`scripts-tmp/sa-qn-json-rpc.mjs`:** **`jsonRpcWithQnLedger`** — reserve/refund кредитов + вызов RPC; **`component_id`** задаёт потребитель (**`wallet_orchestrator`**, **`wallet_backfill`**, далее **`sigseed_worker`** / **`wallet_trace_worker`** при подключении кода на VPS).
- **`sa-wallet-orchestrator`:** billable RPC переведены на **`jsonRpcWithQnLedger`** (без дублирования логики S01).
- **`wallet-backfill-run`:** использует тот же модуль.

### Откат

- **`git checkout sa-alpha-1.11.66 --`** затронутые пути; при необходимости временно **`SA_QN_GLOBAL_LEDGER_ENABLED=0`**.

---

## [1.11.66] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.66`.

### W6.12 S02 — wallet-centric backfill

- **Миграция `0018_wallet_backfill_queue`:** очередь **`wallet_backfill_queue`**.
- **`src/intel/wallet-backfill-sol-flows.ts`:** извлечение нативных SOL transfers из **jsonParsed** tx → строки **`money_flows`**.
- **`src/scripts/wallet-backfill-run.ts`:** прогон с лимитами **`SA_BACKFILL_*`**, интеграция **глобального ledger** (`wallet_backfill`), pump.fun **`swaps`** через **`decodePumpfunSwap`**, источник свопов **`wallet_backfill`**.
- **npm:** **`npm run wallet-backfill:run`**; **`--enqueue-from-wallets=N`** заполняет очередь из **`wallets`**; **`--dry-run`**. Рабочий прогон только при **`SA_BACKFILL_ENABLED=1`**.
- **Тест:** `tests/wallet-backfill-sol-flows.test.ts`.

### Откат

- Выключить прогон: **`SA_BACKFILL_ENABLED=0`** / не ставить cron.
- Откат миграции: **`DROP TABLE IF EXISTS wallet_backfill_queue;`** (после согласования); git **`sa-alpha-1.11.65`**.

---

## [1.11.65] — 2026-05-05

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.65`.

### W6.12 S01 — глобальный учёт QuickNode-кредитов

- **Миграция `0017_sa_qn_global_daily`:** таблица **`sa_qn_global_daily`** (`usage_date`, `credits_used`, `by_component`, `updated_at`).
- **`scripts-tmp/sa-qn-global-budget-lib.mjs`:** резерв кредитов перед billable RPC (`FOR UPDATE`), **refund** при ошибке JSON-RPC; cap из **`SA_QN_GLOBAL_CREDITS_PER_DAY`** или fallback **`SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY`**.
- **`sa-wallet-orchestrator`:** при **`SA_QN_GLOBAL_LEDGER_ENABLED=1`** (default) каждый успешный billable RPC списывает кредиты в ledger; код **`QN_GLOBAL_DAY_CAP`** при исчерпании дня.
- **CLI:** **`npm run sa-qn-global-report`** (`scripts-tmp/sa-qn-global-report.mjs`).

### Откат

- Выключить ledger: **`SA_QN_GLOBAL_LEDGER_ENABLED=0`** → перезапуск **`sa-wallet-orchestrator`**.
- Откат миграции: **`DROP TABLE IF EXISTS sa_qn_global_daily;`** (после согласования); git **`sa-alpha-1.11.64`** на затронутые пути.

---

## [1.11.64] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.64`.

### Intel — устранение ограничений v1

- **`ensureDecisionsForWallets`:** общая материализация по списку адресов; **`mint-check`** по умолчанию дописывает решения для покупателей без строки (`WALLET_INTEL_MINT_CHECK_MATERIALIZE`, флаг **`--no-materialize-missing`**).
- **`wallet-intel:policy --ensure-wallets=a,b,c`** — точечный прогон без лимита batch.
- **`wallet-intel-pipeline --dry-run`:** scam-farm и policy без записи; tagger пропускается; восстановление `SCAM_FARM_*` env в `finally`.
- **`wallet-intel:doctor`:** массив **`warnings`** (пустые `money_flows` / `swaps`, пустой Atlas при непустых `wallets`).
- **`REDIS_URL`:** не задан или пустой → дефолт **`redis://127.0.0.1:6379`** (CLI/intel; прод задаёт явный URL).

### Откат

- **`git checkout sa-alpha-1.11.63 --`** затронутые пути → редеплой **`v2`**.

---

## [1.11.63] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.63`.

### Intel — Wallet Intel policy + CLI (W6.9 / W6.11)

- **Миграция `0016_wallet_intel`:** таблицы **`wallet_intel_decisions`**, **`wallet_intel_runs`**.
- **`src/intel/wallet-intel/`:** классификация кошелька по тегам + участию в **`scam_farm_candidates`** (порог и статусы через ENV), **`mintDecision`** для mint-gate.
- **npm:** `scam-farm:detect`, `wallet-intel:doctor`, `wallet-intel:policy`, `wallet-intel:mint-check`, `wallet-intel:pipeline`.
- **`.env.example`:** блоки **`SCAM_FARM_*`** и **`WALLET_INTEL_*`**.

### Откат

- Откат миграции вручную (`DROP TABLE wallet_intel_decisions, wallet_intel_runs`) только после согласования; проще **`git checkout sa-alpha-1.11.62 --`** затронутые пути и редеплой **`v2`**.

---

## [1.11.62] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.62`.

### Процесс — норматив: атомарность изменений кода и зелёный CI

- **[`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md):** §**4.2** — как вносить правки в TypeScript/контракты модулей, чтобы **`npm run typecheck`** на GitHub совпадал с локальной практикой; VPS (`git pull` без «грязного» `src/`), откат; явный антипаттерн «только потребитель без типов в репо» (ошибки вида `LiveBuyIncreaseDeny` / `increaseDeny`).
- **[`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md):** инвариант **I9**; §**9.4** — чеклист TS перед push/merge.

### Откат

- **`git checkout sa-alpha-1.11.61 -- docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md docs/strategy/release/RELEASE_OPERATING_MODEL.md docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.61] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.61`.

### Сборка — `entry-scale-in` без зависимости от несинхронизированных типов Phase4

- **`src/live/entry-scale-in.ts`:** убраны ссылки на **`LiveBuyIncreaseDeny`** / **`increaseDeny`** (ещё не в типах **`LiveBuyPipelineResult`** на ветке **v2**); логика повторов свопа второй ноги — как до расширения telemetry (retry + giveup с подписью таймлайна).

### Откат

- **`git checkout sa-alpha-1.11.60 -- src/live/entry-scale-in.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → деплой + **`pm2 flush live-oscar && pm2 restart live-oscar --update-env`** под **`salpha`** (на **v2** без этого патча `tsc` падает).

---

## [1.11.60] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.60`.

### Live Oscar — профиль второй ноги и риска (асимметричный коридор, без DCA, kill −5%)

- **`src/live/config.ts`:** env **`LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT`** и **`LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT`**; при отсутствии — симметричный fallback из **`LIVE_ENTRY_SCALE_IN_CORRIDOR_PCT`** (как раньше).
- **`src/live/entry-scale-in.ts`**, **`src/papertrader/types.ts`**, **`src/papertrader/main.ts`**, **`src/papertrader/executor/store-restore.ts`:** pending второй ноги хранит **`corridorUpPct` / `corridorDownPct`**; восстановление из журнала понимает legacy **`corridorPct`**.
- **`ecosystem.config.cjs` (`live-oscar`):** задержка второй ноги **30 с**; коридор **+1% / −2%**; **`PAPER_DCA_LEVELS` пуст** (DCA нет); **`PAPER_DCA_KILLSTOP=-0.05`** (−5% к средней); первая нога **70%** без изменений.
- **`scripts-tmp/dashboard-paper2.html`:** блок **live-oscar** в `STRATEGY_META` приведён к этим числам.

### Откат

- **`git checkout sa-alpha-1.11.59 -- src/live/config.ts src/live/entry-scale-in.ts src/papertrader/types.ts src/papertrader/main.ts src/papertrader/executor/store-restore.ts ecosystem.config.cjs scripts-tmp/dashboard-paper2.html .env.example docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → деплой **`v2`** + **`pm2 flush live-oscar && pm2 restart live-oscar --update-env`** (или **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`**) под **`salpha`**.

---

## [1.11.59] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.59`.

### Discovery — guard объёма 5m vs 1h (paper + live Oscar)

- **`src/papertrader/discovery/snapshot.ts`:** в выборку кандидатов добавлено поле **`volume_1h`** из парных снимков DEX.
- **`src/papertrader/filters/snapshot-filter.ts`:** **`evaluateVol5m1hGuard`** — при **`PAPER_VOL_5M_1H_GUARD_ENABLED=1`** отсекаются строки с отсутствующим/малым **`volume_1h`** и подозрительным всплеском **`volume_5m`** относительно среднего за 5 минут из часа (**`volume_1h / 12`**), если **`volume_5m > (volume_1h/12) * PAPER_VOL_5M_SPIKE_MAX_MULT`**.
- **`src/papertrader/config.ts`:** env **`PAPER_VOL_5M_1H_GUARD_ENABLED`**, **`PAPER_VOL_1H_MIN_USD`** (дефолт **36000**), **`PAPER_VOL_5M_SPIKE_MAX_MULT`** (дефолт **7**); выключатель guard по умолчанию **выкл.** для обратной совместимости без env.
- **`ecosystem.config.cjs`:** guard **вкл.** для **`pt1-diprunner`**, **`pt1-oscar`**, **`pt1-dno`**, **`live-oscar`** с теми же стартовыми числами.
- **`src/papertrader/types.ts`**, **`dip-clones.ts`:** в **`features`** журнала добавлено **`vol1h_usd`**.
- **Тесты:** `tests/vol-5m-1h-guard.test.ts`.

### Откат

- **`git checkout sa-alpha-1.11.58 -- src/papertrader/discovery/snapshot.ts src/papertrader/filters/snapshot-filter.ts src/papertrader/config.ts src/papertrader/types.ts src/papertrader/discovery/dip-clones.ts src/papertrader/main.ts ecosystem.config.cjs .env.example tests/fixtures/w7_8_open_sim_audit_ok.jsonl tests/vol-5m-1h-guard.test.ts tests/papertrader-dip-recovery-veto.test.ts tests/papertrader-dip-windows.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → деплой **`v2`** + **`pm2 reload ecosystem.config.cjs --only pt1-diprunner,pt1-oscar,pt1-dno,live-oscar --update-env`** под **`salpha`** (или точечно **`PAPER_VOL_5M_1H_GUARD_ENABLED=0`** в ecosystem без отката кода).

---

## [1.11.58] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.58`.

### Observability — hourly Telegram: новые `wallets` оркестратора по `seed_lane`

- **`scripts-tmp/hourly-telegram-report.mjs`:** после Coverage добавлен блок с числом **новых строк** `wallets` за **`HOURLY_COVERAGE_HOURS`**, с фильтром оркестратора (`collector_id = sa-wallet-orch` или `gecko_multi_seed`) и разбивкой по **`metadata.seed_lane`** (фиксированный порядок lane + прочие).
- **Нормативка:** **W6.8** §10 п.4 (spec **0.2**), **W6.4** п.3, **`deploy/RUNTIME.md`**, комментарий к **`HOURLY_COVERAGE_HOURS`** в **`.env.example`**.

### Откат

- **`git checkout sa-alpha-1.11.57 -- scripts-tmp/hourly-telegram-report.mjs docs/Smart Lottery V2/W6.8_wallet_ingest_orchestrator_gecko_multi_source.md docs/strategy/specs/W6.4_observability_port.md deploy/RUNTIME.md .env.example docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → деплой **`v2`** на VPS (cron подхватит скрипт со следующего часа).

---

## [1.11.57] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.57`.

### Live Oscar — закрытие после ротации капитала не как RECONCILE_ORPHAN

- **Проблема:** Phase 5 вызывал `sell_full` on-chain, но не обновлял `open`/`closed` и не писал `live_position_close` → на следующем тике orphan reconcile давал **`RECONCILE_ORPHAN`** (выглядело как поломка).
- **Решение:** новый **`ExitReason` `CAPITAL_ROTATE`** + **`finalizeLiveCapitalRotatePaperClose`** (`tracker.ts`) сразу после успешного rotation sell; колбэк в **`LiveOscarStrategyDeps`**; **`risk_note`** `capital_rotate_paper_sync_failed` при исключении.
- **Дашборд:** подпись таймлайна для `CAPITAL_ROTATE`, счётчики выходов, стили pill/timeline; уточнён текст **`RECONCILE_ORPHAN`** в `triggerLabel`.

### Откат

- **`git checkout sa-alpha-1.11.56 --`** затронутые пути → деплой **`v2`** + **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.56] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.56`.

### Live Oscar — двухногий вход (70% + 30%) с коридором Jupiter

- **Paper-слой:** `PAPER_ENTRY_FIRST_LEG_FRACTION` (default **1** у pt1-*); первая нога `OpenTrade` и Jupiter quote-verify/sim-audit по **`positionUsd × fraction`**.
- **Live:** `LIVE_ENTRY_SCALE_IN_ENABLED` и env **`LIVE_ENTRY_SCALE_IN_*`** — после задержки вторая нога по **`buy_scale_in`**, если implied Jupiter USD/token в **±corridorPct** к **marketPrice первой ноги**; при падении свопа в коридоре — до **N** попыток с backoff; при выходе из коридора или **DCA раньше второй ноги** — отложенная докупка снимается.
- **Журнал:** `live_position_open` (+ `timelineOpenLabelRu`, `liveScaleInParams`), `live_position_scale_in`, paper `scale_in_add`; replay **`live_position_scale_in`**.
- **Дашборд:** таймлайн «Покупка 70% позиции» / «Докупка 30% позиции»; блок описания live-oscar в `dashboard-paper2.html`.

### Откат

- **`git checkout sa-alpha-1.11.55 --`** затронутые пути (`src/papertrader/types.ts`, `config.ts`, `main.ts`, `executor/open.ts`, `executor/tracker.ts`, `pricing/sim-audit.ts`, `live/config.ts`, `live/main.ts`, `live/phase4-*.ts`, `live/entry-scale-in.ts`, `live/events.ts`, `live/store-jsonl.ts`, `live/replay-strategy-journal.ts`, `live/repair-missed-live-buys.ts`, `live/strategy-snapshot.ts`, `executor/store-restore.ts`, `scripts-tmp/dashboard-server.ts`, `scripts-tmp/dashboard-paper2.html`, `ecosystem.config.cjs`, `tests/papertrader-sim-audit.test.ts`, `docs/strategy/release/VERSION`, `docs/strategy/release/CHANGELOG.md`) → деплой **`v2`** + **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.55] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.55`.

### Live Oscar — тайм-аут и соответствие журнала кошельку

- **Непрерывный orphan-reconcile:** `live/main.ts` снова передаёт в paper-трекер **`reconcilePaperCloseZeroMints(open)`** + **`verifyReconcileOrphanWalletZero`** (SPL RPC через `fetchLiveWalletSplBalancesByMint`). Каждый тик: mint в `open`, но **0** атомов на кошельке → бумажное закрытие **`RECONCILE_ORPHAN`** + `live_position_close` (раньше колбэки не передавались после удаления boot SPL reconcile — дашборд мог расходиться с цепью).
- **Сигнатура колбэка:** принимает актуальный `Map` открытых позиций; допускает `async` (см. `tracker.ts`, `papertrader/main.ts`).
- **TIMEOUT не блокируется exit price-verify:** для `exitReason === 'TIMEOUT'` включён **`ignoreBlockOnFail`** на pre-exit Jupiter verify (без бесконечных `live_exit_verify_defer`).
- **NO_DATA при отсутствии цены:** порог возраста выровнен с TIMEOUT — **`ageH >= timeoutHours`** (было строгое `>`).

### Откат

- **`git checkout sa-alpha-1.11.54 -- src/live/main.ts src/papertrader/main.ts src/papertrader/executor/tracker.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → деплой + **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.54] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.54`.

### Live Oscar — позиция 40 USD и порог кошелька 50 USD на новые входы

- **`ecosystem.config.cjs` → live-oscar:** **`PAPER_POSITION_USD`** и **`LIVE_MAX_POSITION_USD` → 40** (было 20); исполняемый размер в SOL по-прежнему из Jupiter quote по USD-нотации.
- **`LIVE_MIN_WALLET_SOL_EQUITY_USD` → 50** (было 22): блок **`buy_open`**, если оценка нативного SOL на кошельке (× `solUsd`) ниже порога; **`LIVE_MAX_STRATEGY_LOSS_USD=50`** без изменений; DCA (`isNewPosition: false`) порогом не режется.

### Документация

- **`docs/strategy/specs/W8.0_live_oscar_trading_bot.md`** §3.3–§3.4 (примеры X / 2X / минимальный SOL-equity).
- **`docs/strategy/specs/W8.0_phase5_risk_capital_gates_spec.md`** §3.1 — явная строка про **`LIVE_MIN_WALLET_SOL_EQUITY_USD`**.

### Откат

- В **`ecosystem.config.cjs`** для **`live-oscar`:** вернуть **`PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD`** к **20**, **`LIVE_MIN_WALLET_SOL_EQUITY_USD`** к **22** → **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`** (после **`pm2 flush live-oscar`** по политике ops).

---

## [1.11.53] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.53`.

### Live Jupiter — slippage 300 bps + потолок приоритета 0.0001 SOL

- **`LIVE_DEFAULT_SLIPPAGE_BPS=300`** в **`ecosystem.config.cjs`** для **`live-oscar`** (был дефолт кода 400 без явного env).
- Новые env: **`LIVE_JUPITER_PRIORITY_MAX_SOL`** или **`LIVE_JUPITER_PRIORITY_MAX_LAMPORTS`**, опционально **`LIVE_JUPITER_SWAP_PRIORITY_LEVEL`** (`medium` | `high` | `veryHigh`) → тело POST **`/swap/v1/swap`** получает **`prioritizationFeeLamports.priorityLevelWithMaxLamports`** с **`maxLamports`** (кап по желанию ops). Хелпер **`liveJupiterSwapPostBody`** в **`src/live/jupiter.ts`**.

### Откат

- Удалить/закомментировать новые ключи в **`ecosystem.config.cjs`** и **`git checkout sa-alpha-1.11.52 --`** затронутые файлы → **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.52] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.52`.

### Интегратор — канон платформы и Cursor rules в репозитории

- В дерево **`solana-bot`** добавлены **`docs/platform/**`**, **`docs/agents/**`**, **`scripts/platform/**`**, **`.cursor/rules/**`** как единый SSOT (ранее жили только в монорепозитории Ideas без remote).
- Обновлены перекрёстные ссылки и **`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`** §6 (синхронизация с Ideas).
- Платформа **`docs/platform/VERSION` → 1.5.2**, запись в **`PLATFORM_CHANGELOG.md`**.

### Откат

- **`git checkout sa-alpha-1.11.51 -- docs/platform docs/agents scripts/platform .cursor docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → при необходимости деплой только если требуется откат рабочего дерева на сервере.

---

## [1.11.51] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.51`.

### Документация процесса — Git `v2`, CI, branch protection

- **`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`:** добавлен §**4.1** (branch protection на **`v2`**, обязательный CI, без force-push, роль человека при merge).
- Согласовано с платформенными правилами Ideas: **`docs/agents/TASK_INTAKE_TEMPLATE.md`** (поле **Deploy session**, **ALLOWED_SURFACE**), **`AGENT_BOOTSTRAP.md`**, **`.cursor/rules/server-autodeploy.mdc`** (деплой только после явной deploy-session; без секретов в контексте).

### Откат

- Документ-only: **`git checkout sa-alpha-1.11.50 -- docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** (и при необходимости revert связанного платформенного коммита в Ideas).

---

## [1.11.50] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.50`.

### Live Phase 4 — не симулировать продажу без SPL на кошельке

- При **`LIVE_EXECUTION_MODE=live`** и **`sell_partial` / `sell_full`**: если RPC-баланс mint **0** или **нет ответа SPL** → **`execution_skip`** (`wallet_spl_balance_zero` / `spl_balance_rpc_null`), **без** Jupiter simulate — убирает лавину **`sim_err` `6024` (Jupiter `InsufficientFunds`)**, когда журнал/трекер ещё держит позицию, а токенов на ATA уже нет.
- **`sell_partial`**: объём всегда **`min(USD-math, chain)`**, чтобы не запрашивать у Jupiter больше атомов, чем есть on-chain.

### Откат

- **`git checkout sa-alpha-1.11.49 -- src/live/phase4-execution.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.49] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.49`.

### Live — критический фикс: SPL балансы кошелька с QuickNode / Solana RPC

- **`fetchLiveWalletSplBalancesByMint`** (`reconcile-live.ts`): ответ **`getTokenAccountsByOwner`** имеет вид **`{ context, value: [...] }`**, а парсер ожидал голый массив → карта балансов была **пустой**.
- Следствие: **`sell_full`** не подставлял **полный on-chain raw**, оставался только **USD-math** (недопродажа крупного хвоста); **`live_post_close_tail`** получал **`zero_balance`** при реальном остатке на кошельке.
- **`package-lock.json`:** синхронизация под **`npm ci`** на Linux (опциональная зависимость **`utf-8-validate`** / корректное дерево для npm 10 на VPS).

### Откат

- **`git checkout sa-alpha-1.11.48 -- src/live/reconcile-live.ts tests/live-reconcile-rpc-parse.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.48] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.48`.

### Live Oscar — BTC gate + SOL equity floor + удвоение микролимитов (ecosystem)

- **Только `LIVE_EXECUTION_MODE=live`** и **только новые позиции** (`buy_open`, не DCA): если контекст BTC из Binance **свежий** (`≤ LIVE_BTC_GATE_MAX_STALE_MS`, дефолт **15 мин**), блок **`risk_block`** при **`ret1h_pct ≤ −2.5`** или **`ret4h_pct ≤ −5`** (пороги в п.п.: `LIVE_BTC_BLOCK_1H_DRAWDOWN_PCT`, `LIVE_BTC_BLOCK_4H_DRAWDOWN_PCT`). Выключение: **`LIVE_BTC_GATE_ENABLED=0`**. При устаревших/пустых данных BTC **вход не режется** (fail-open).
- **`LIVE_MIN_WALLET_SOL_EQUITY_USD`**: live-only новые входы — **`native SOL × SOL/USD ≥ N`** иначе **`risk_block`** `min_wallet_sol_equity_usd`.
- **`ecosystem.config.cjs` → live-oscar:** **`PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` → 20**; **`LIVE_MIN_WALLET_SOL_EQUITY_USD=22`**; убран **`LIVE_MIN_WALLET_SOL`**; **`LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD` → 12**; **`LIVE_BTC_GATE_ENABLED=1`**.

### Откат

- **`git checkout sa-alpha-1.11.47 -- src/live/config.ts src/live/phase5-gates.ts ecosystem.config.cjs .env.example tests/live-oscar-config.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.47] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.47`.

### Live Oscar — дожим хвоста SPL после полного close

- После каждого **`live_position_close`** (TP/SL/TRAIL/TIMEOUT/KILLSTOP, LIQ_DRAIN, PERIODIC_HEAL, RECONCILE_ORPHAN): через **`LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS`** (дефолт **60000**, **`0`** = выкл.) повторно читается баланс mint на кошельке; если **`> 0`**, выполняется **`sell_full`** (фактический raw с цепи через существующий Phase 4 pipeline).
- JSONL: **`live_post_close_tail`** (`ok`, `note`, опц. `rawAtoms`, `estUsd`).
- **`LIVE_POST_CLOSE_TAIL_SWEEP_MIN_USD`** — нижняя подсказка notional для микро-хвостов (дефолт **0.05**).
- Повторный close по тому же mint до срабатывания таймера сбрасывает предыдущий timeout и планирует новый.

### Откат

- **`git checkout sa-alpha-1.11.46 -- src/live/post-close-tail-sweep.ts src/live/config.ts src/live/events.ts src/live/store-jsonl.ts src/live/periodic-self-heal.ts src/papertrader/executor/tracker.ts src/papertrader/main.ts ecosystem.config.cjs .env.example tests/live-oscar-config.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.46] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.46`.

### Live Oscar — предохранитель «уже есть монета на кошельке»

- Перед **`buy_open`** в режиме **`live`**: если оценка стоимости SPL по mint на торговом кошельке **≥ `LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD`** (баланс RPC × цена из snapshot DB или Jupiter lite-api), своп **не выполняется**, в JSONL — **`execution_skip`** `wallet_holds_mint_over_usd_cap`. **`0`** = выключено (дефолт в коде).
- **`dca_add` / simulate** не затрагиваются.
- Если RPC балансов или цены нет — **вход не блокируется** (как и при отключённом reconcile: не глушим торговлю из‑за сбоев оценки).

### Откат

- **`git checkout sa-alpha-1.11.45 -- src/live/config.ts src/live/phase4-execution.ts src/papertrader/pricing.ts ecosystem.config.cjs .env.example tests/live-oscar-config.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → **`pm2 restart live-oscar --update-env`** под **`salpha`**.

---

## [1.11.45] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.45`.

### Live Oscar — удалён SPL reconcile (журнал vs кошелёк)

- Boot больше не вызывает **`reconcileLiveWalletVsReplay`**, не ставит **`risk_block`** по **`reconcile_*`**, не закрывает **`RECONCILE_ORPHAN`** из boot mismatch; **`live_reconcile_report`** остаётся строкой диагностики со **`skipReason: spl_reconcile_removed`** (и прежними **`skipped`** для dry_run / execution_mode).
- Pending RPC при anchor-verify на буте — только **`execution_skip`** / **`skipped`**, без блокировки новых входов.
- Периодический self-heal: хвостовые продажи и force-close «зависших» open без сверки журнала; поле **`reconcileOk`** в JSONL оставлено **`true`** для совместимости дашборда.
- Удалены **`npm run live-reconcile`**, скрипт **`live-reconcile-cli.ts`**, env-ключи загрузчика **`LIVE_RECONCILE_ON_BOOT`**, **`LIVE_RECONCILE_MODE`**, **`LIVE_RECONCILE_TOLERANCE_ATOMS`**, **`LIVE_RECONCILE_PAPER_CLOSE_ZERO_BALANCE`**, **`LIVE_ORPHAN_MIN_POSITION_AGE_MS`** (старые строки в `.env` просто игнорируются). Сохранены **`LIVE_RECONCILE_TX_SAMPLE_N`**, **`LIVE_RECONCILE_BLOCK_MAX_MS`** (TTL для блока по **parity**).
- **`risk_note`:** **`exposure_block_ttl_cleared`** вместо **`reconcile_block_ttl_cleared`** при срабатывании TTL.

### Откат

- **`git checkout sa-alpha-1.11.44 -- src/live src/papertrader package.json ecosystem.config.cjs .env.example tests docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → на VPS: **`pm2 flush live-oscar && pm2 restart live-oscar --update-env`** под **`salpha`**.

---

## [1.11.44] — 2026-05-04

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.44`.

### Hotfix — кулдаун повторного входа по mint (**30 мин**)

- **`ecosystem.config.cjs`:** **`PAPER_DIP_COOLDOWN_MIN`** **120 → 30** у **`pt1-diprunner`**, **`pt1-oscar`**, **`pt1-dno`**, **`live-oscar`** (меньше расхождения бумаги vs live после частичных проходов по одному mint).
- **`.env.example`:** то же значение по умолчанию.

### Откат

- **`git checkout sa-alpha-1.11.43 -- ecosystem.config.cjs .env.example docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → **`pm2 reload ecosystem.config.cjs --only pt1-diprunner,pt1-oscar,pt1-dno,live-oscar --update-env`** под **`salpha`**.

---

## [1.11.43] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.43`.

### Live Oscar — стабилизация P0/P1 (reconcile, капитал, фаталы)

- **P0:** возраст reconcile exposure block в heartbeat (`reconcileBlocksNewExposure`, `reconcileBlockAgeSec`); опциональный TTL **`LIVE_RECONCILE_BLOCK_MAX_MS`** (0 = выкл.); fail-fast при **`PAPER_POSITION_USD` ≠ `LIVE_MAX_POSITION_USD`** в `live`/`simulate`; схема JSONL **`risk_note`** (в т.ч. `reconcile_block_ttl_cleared`, orphan verify).
- **P1:** повторное чтение SPL через **`getTokenAccountsByOwner`** (~2.5 с) при первом `null` в boot/tick reconcile; поле **`shortfallUsd`** во всех **`capital_skip`**; **`src/scripts/live-oscar.ts`** — запись **`data/live/last-fatal.json`** при **`uncaughtException`** / **`unhandledRejection`** / падении **`main`**.

### Откат

- **`git checkout sa-alpha-1.11.42 -- src/live/config.ts src/live/events.ts src/live/store-jsonl.ts src/live/main.ts src/live/live-reconcile-state.ts src/live/reconcile-live.ts src/live/phase5-gates.ts src/scripts/live-oscar.ts ecosystem.config.cjs tests/live-oscar-config.test.ts tests/live-jsonl-phase1.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → на VPS: **`pm2 flush live-oscar && pm2 restart live-oscar --update-env`**.

---

## [1.11.42] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.42`.

### Oscar TP-grid — retrace после первой ступени не к безубытку

- **Проблема:** при одной сработавшей ступени сетки «предыдущий порог» для **`ladder_retrace`** был **0% к средней** → остаток закрывался на откате к входу/ниже; плюс с частичного TP съедался комиссиями.
- **`src/papertrader/executor/tp-ladder-state.ts`:** для grid, если заполнена только первая ступень, использовать **`tpGridFirstRungRetraceMinPnlPct`** вместо нуля.
- **`src/papertrader/config.ts`**, **`.env.example`:** **`PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL`** (доля PnL к средней; prod **0.025** ≈ +2.5%).
- **`ecosystem.config.cjs`:** **`pt1-oscar`**, **`live-oscar`** — **`0.025`**.
### Откат

- **`git checkout sa-alpha-1.11.41 -- src/papertrader/config.ts src/papertrader/executor/tp-ladder-state.ts src/papertrader/executor/tracker.ts ecosystem.config.cjs .env.example tests/papertrader-ladder-retrace.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → **`pm2 reload ecosystem.config.cjs --only pt1-oscar,live-oscar --update-env`**.

---

## [1.11.41] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.41`.

### W6.8 — коллектор‑оркестратор пополнения `wallets` (Gecko → QuickNode)

- **`scripts-tmp/wallet-orchestrator-lib.mjs`**, **`scripts-tmp/sa-wallet-orchestrator.mjs`:** один процесс с планировщиком UTC (new_pools / trending / extended / daily_deep по lane), глобальный троттлинг Gecko (**≤28/мин** по умолчанию), мягкий дневной потолок Gecko HTTP и billable RPC под **1 500 000** кредитов QuickNode/сутки (**`QUICKNODE_CREDITS_PER_SOLANA_RPC`**, **`SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY`**), веса lane + резерв RPC; запись в **`wallets`** с **`gecko_multi_seed`** / **`seed_lane`**; **`--budget-report`**, **`--once`**, **`--daemon`**.
- **`tests/wallet-orchestrator-lib.test.ts`:** юнит‑тесты расписания и вспомогательных функций.
- **`package.json`:** `npm run sa-wallet-orchestrator`; **`ecosystem.config.cjs`:** процесс **`sa-wallet-orchestrator`** (`--daemon`).
- Торговые `*-collector.mjs` (DexScreener) **не изменялись**.

### Откат

- **`git checkout sa-alpha-1.11.40 -- scripts-tmp/wallet-orchestrator-lib.mjs scripts-tmp/sa-wallet-orchestrator.mjs tests/wallet-orchestrator-lib.test.ts package.json ecosystem.config.cjs .env.example .gitignore docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md docs/Smart Lottery\ V2/W6.8_wallet_ingest_orchestrator_gecko_multi_source.md`** → на VPS: **`pm2 delete sa-wallet-orchestrator`** (или отключить автозапуск), восстановить предыдущий **`ecosystem.config.cjs`**.

---

## [1.11.40] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.40`.

### Live Oscar — снятие Phase 5 блока после reconcile

- **`LIVE_RECONCILE_MODE=block_new`:** при boot создаётся «липкий» флаг **`reconcileBlocksNewExposure`**; после **`RECONCILE_ORPHAN`** журнал в памяти совпадает с кошельком, но флаг **никогда не сбрасывался** → **`phase5AllowIncreaseExposure`** молча запрещала **любые** новые покупки (бумажный Oscar в отдельном процессе этого ограничения не имеет).
- **`src/live/main.ts`:** **`liveClearExposureBlockHook`** — после закрытия boot-сирот повторный **`reconcileLiveWalletVsReplay`** и **`clearLiveReconcileBlock()`** при **`rec.ok`**.
- **`src/live/periodic-self-heal.ts`:** при **`reconcileOk`** на тике heal — **`clearLiveReconcileBlock()`** (дефолт интервал heal до 30 мин — без хука сирот блок мог держаться долго).
- **`src/papertrader/main.ts`**, **`src/papertrader/executor/tracker.ts`:** проводка хука после **`RECONCILE_ORPHAN`**.
- **`tests/live-reconcile-block-clear.test.ts`:** регрессия — Phase 5 при липком флаге отклоняет вход до SOL/RPC; после **`clearLiveReconcileBlock()`** этот стоп снимается.

### Откат

- **`git checkout sa-alpha-1.11.39 -- src/live/main.ts src/live/periodic-self-heal.ts src/papertrader/main.ts src/papertrader/executor/tracker.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → перезапуск **`live-oscar`**.

---

## [1.11.39] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.39`.

### Live Oscar — `repairedLegSignatures` → якорь входа в `OpenTrade`

- **`src/papertrader/executor/store-restore.ts`:** при восстановлении из JSON объединяются **`entryLegSignatures`** и legacy **`repairedFromTxSignature` / `repairedLegSignatures`** (как в live replay). Иначе **`verifyReplayedOpenBuyAnchorsOnBoot`** видел пустые подписи, выкидывал позицию (**`missing_entry_leg_signatures`**), а дашборд (линейный проход JSONL) продолжал считать её **открытой** без **`live_position_close`** → расхождение с процессом и «вечный BELIEF».

### Откат

- **`git checkout sa-alpha-1.11.38 -- src/papertrader/executor/store-restore.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → перезапуск **`live-oscar`**.

---

## [1.11.37] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.37`.

### Live Oscar — RECONCILE_ORPHAN без фантомного −100%

- **`src/papertrader/executor/tracker.ts`:** при **`RECONCILE_ORPHAN`** пересчитываются proceeds/PnL: учитываются уже совершённые **`partialSells`**, остаток списывается **по себестоимости** (`remainingFraction × invested`), без вымышленной полной потери позиции.
- **`scripts-tmp/patch-live-reconcile-orphan-neutral.mjs`:** разовый проход по **`live_position_close`** в live JSONL для исправления старых строк.

### Откат

- **`git checkout sa-alpha-1.11.36 -- src/papertrader/executor/tracker.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → восстановить JSONL из **`.bak-reconcile-orphan-*`** при необходимости → перезапуск **`live-oscar`**.

---

## [1.11.38] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.38`.

### W6.7 — пилотная диагностика GRWS (серия сценариев)

- **`scripts-tmp/sa-grws-pilot-diagnose.mjs`**, **`npm run sa-grws-pilot-diagnose`:** несколько прогонов с паузами (`SA_GRWS_PILOT_PAUSE_MS`), дельты budget-state, средние RPC/Gecko, экстраполяция тиков/сутки по QuickNode и Gecko; отчёт **`data/sa-grws-pilot-diagnose-report.json`**.
- **`scripts-tmp/sa-grws-collector.mjs`:** режим **`SA_GRWS_GECKO_ONLY_DIAGNOSTIC=1`** — замер воронки Gecko→Raydium без JSON-RPC.

### Откат

- **`git checkout sa-alpha-1.11.37 -- scripts-tmp/sa-grws-pilot-diagnose.mjs scripts-tmp/sa-grws-collector.mjs package.json .gitignore docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md docs/Smart Lottery V2/W6.7_gecko_raydium_wallet_seed_collector_local.md`**.

---

## [1.11.36] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.36`.

### W6.7 — SA-GRWS: отчёт аналитики пилота + журнал тиков

- **`scripts-tmp/sa-grws-analytics.mjs`**, **`npm run sa-grws-analytics`:** сводка кошельков по окнам времени (Postgres), оценка кредитов QuickNode и нагрузки Gecko из **`sa-grws-budget-state.json`**, опционально усреднение по **`SA_GRWS_TICK_LOG_PATH`** JSONL; **`summaryRu`** в JSON.
- **`scripts-tmp/sa-grws-collector.mjs`:** опциональная запись тика в JSONL (**`SA_GRWS_TICK_LOG_PATH`**); пропуск тика по дневному RPC также логируется в JSONL.
- **`scripts-tmp/_grws-pilot-measure.sh`:** включает **`SA_GRWS_TICK_LOG_PATH`** и парсит **`geckoHttpCallsThisTick`** из лога.
- **`docs/Smart Lottery V2/W6.7_…md`**, **`.env.example`**, **`.gitignore`**, **`package.json`**.

### Откат

- **`git checkout sa-alpha-1.11.35 -- scripts-tmp/sa-grws-analytics.mjs scripts-tmp/sa-grws-collector.mjs scripts-tmp/_grws-pilot-measure.sh package.json .env.example .gitignore docs/Smart Lottery V2/W6.7_gecko_raydium_wallet_seed_collector_local.md docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.35] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.35`.

### W6.7 — SA-GRWS collector: бюджет QuickNode + троттлинг Gecko

- **`scripts-tmp/sa-grws-collector.mjs`:** персистентные счётчики **`data/sa-grws-budget-state.json`** (UTC‑сутки); дневной потолок **`SA_GRWS_MAX_QUICKNODE_CREDITS_PER_DAY`** (дефолт 1.5M кредитов); кап RPC на тик (daemon — авто из интервала и **`SA_GRWS_RPC_BUDGET_HEADROOM`**); проверка перед каждым **`rpcCall`**; троттлинг HTTP к Gecko (**`SA_GRWS_GECKO_TARGET_CALLS_PER_MINUTE`**, дефолт 28/min); soft‑cap **`SA_GRWS_MAX_GECKO_HTTP_PER_DAY`**; режим **`--budget-report`**; **`SA_GRWS_BREADTH_FIRST`** распределяет **`getTransaction`** между пулами на тик.
- **`docs/Smart Lottery V2/W6.7_gecko_raydium_wallet_seed_collector_local.md`**, **`.env.example`**, **`.gitignore`**: документация и игнор state‑файла.

### Откат

- **`git checkout sa-alpha-1.11.34 -- scripts-tmp/sa-grws-collector.mjs docs/Smart Lottery V2/W6.7_gecko_raydium_wallet_seed_collector_local.md .env.example .gitignore docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.35] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.35`.

### Live Oscar — периодический self-heal (30 мин по умолчанию)

- **`src/live/periodic-self-heal.ts`:** по таймеру (**`LIVE_PERIODIC_SELF_HEAL_MS`**, default **1_800_000** = 30 мин; **`0`** = выкл.) в режиме **`live`**: SPL reconcile (report-only), продажа **хвостов** по mint, которые **не в `open`**, но есть на кошельке и есть в истории **`closed`** процесса (или любые chain-only при **`LIVE_PERIODIC_SWEEP_UNKNOWN_CHAIN_ONLY=1`**), с порогом **`LIVE_PERIODIC_SWEEP_MIN_USD`** (default **0.25**); принудительное закрытие **зависших open** старше **`timeoutHours` + `LIVE_PERIODIC_STUCK_GRACE_HOURS`** с ончейн-балансом через **`trackerForceFullExitLive`** (продажа без exit price-verify). Сводка в JSONL: **`live_periodic_self_heal`**.
- **`src/papertrader/executor/tracker.ts`:** экспорт **`trackerForceFullExitLive`**, причина выхода **`PERIODIC_HEAL`**.
- **`src/papertrader/types.ts`**, **`src/papertrader/main.ts`**, **`src/live/main.ts`**, **`src/live/config.ts`**, **`src/live/events.ts`**, **`src/live/store-jsonl.ts`**: конфиг, события, wiring таймера, очистка при shutdown.

### Откат

- **`git checkout sa-alpha-1.11.34 -- src/live/periodic-self-heal.ts src/papertrader/executor/tracker.ts src/papertrader/types.ts src/papertrader/main.ts src/live/main.ts src/live/config.ts src/live/events.ts src/live/store-jsonl.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md ecosystem.config.cjs`** → перезапуск **`live-oscar`**.

---

## [1.11.34] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.34`.

### Live Oscar — продажа по фактическому SPL-балансу (без хвостов)

- **`src/live/phase4-execution.ts`:** в режиме **`live`** перед Jupiter quote для продажи выполняется **`getTokenAccountsByOwner`** (как в reconcile); для **`sell_full`** в срок берётся **весь on-chain остаток** по mint (не `floor(usd/price)`); для **`sell_partial`** сумма **ограничивается сверху** реальным балансом, если бумажная модель завысила атомы. В **`execution_attempt`** добавлено поле **`sellAmountSource`**: `usd_math` | `chain_full_balance` | `usd_capped_by_chain`.
- **`src/live/reconcile-live.ts`:** экспорт **`fetchLiveWalletSplBalancesByMint`** для переиспользования Phase 4.
- **`src/live/replay-strategy-journal.ts`:** строки **`live_position_partial_sell`** проходят тот же **anchor gate**, что и `live_position_open` / `dca`, чтобы «призраки» без **`entryLegSignatures`** не восстанавливались только из partial.

### Откат

- **`git checkout sa-alpha-1.11.33 -- src/live/phase4-execution.ts src/live/reconcile-live.ts src/live/replay-strategy-journal.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → перезапуск **`live-oscar`** под **`salpha`**.

---

## [1.11.33] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.33`.

### Live Oscar (hotfix) — TP grid 5% / 30%

- **`ecosystem.config.cjs`** (`live-oscar`): **`PAPER_TP_GRID_SELL_FRACTION`** **0.2 → 0.3** (30% текущего остатка на ступень); **`PAPER_TP_GRID_STEP_PNL`** **0.05** (+5% PnL к средней); **`PAPER_TP_LADDER`** пуст (только сетка).

### Откат

- **`git checkout sa-alpha-1.11.32 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** → **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`**.

---

## [1.11.32] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.32`.

### W6.7 — GRWS: Raydium по `dex.id`, пауза Gecko, оценка QN в логах

- **`scripts-tmp/sa-grws-collector.mjs`:** Raydium — явно по **`relationships.dex.data.id`** (`raydium`, `raydium-*`) + legacy `dex_name`; адрес пула и mint из Gecko через префикс **`solana_`**; **`SA_GRWS_GECKO_PAGE_SLEEP_MS`** (дефолт **650 ms**) снижает 429; в **`tick completed`** — **`rpcBillableCalls`**, **`estimatedQuicknodeCredits`** (× **`QUICKNODE_CREDITS_PER_SOLANA_RPC`**); комментарий в шапке файла про отсутствие записи в **`quicknode-usage.json`**.

### Откат

- **`git checkout sa-alpha-1.11.31 -- scripts-tmp/sa-grws-collector.mjs .env.example docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.31] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.31`.

### Live Oscar — выход по TIMEOUT при verify block + reconcile «журнал vs нулевой баланс»

- **`live_exit_verify_defer`** в live JSONL — каждый defer/эскалация pre-exit Jupiter verify (paper `eval-skip-exit` по-прежнему noop в live).
- **`PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION`** (дефолт **60**): после N defer для **TIMEOUT** один проход закрытия с `ignoreBlockOnFail` + событие `phase: escalate_proceed`.
- Новый **`ExitReason` `RECONCILE_ORPHAN`**: при **`LIVE_RECONCILE_PAPER_CLOSE_ZERO_BALANCE=1`** и boot reconcile **mismatch** с **actualRaw=0** для mint — позиция снимается без Jupiter sell (`live_position_close` + paper-close stamp).
- **`LIVE_RECONCILE_PAPER_CLOSE_ZERO_BALANCE`**, дашборд **`RECONCILE_ORPHAN`**, **`ecosystem.config.cjs`** для `live-oscar`.

### Откат

- **`git checkout sa-alpha-1.11.30 -- src/papertrader/executor/tracker.ts src/papertrader/main.ts src/papertrader/config.ts src/papertrader/types.ts src/live/main.ts src/live/config.ts src/live/events.ts src/live/store-jsonl.ts src/live/live-reconcile-state.ts ecosystem.config.cjs scripts-tmp/dashboard-paper2.html scripts-tmp/dashboard-server.ts tests/live-jsonl-phase1.test.ts tests/live-oscar-config.test.ts .env.example docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.30] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.30`.

### W6.7 — seed-пулы для бенчмарка без Gecko

- **`scripts-tmp/sa-grws-collector.mjs`:** **`SA_GRWS_SEED_POOLS_JSON`** или **`SA_GRWS_SEED_POOLS_PATH`** — фиксированный список пулов (обход Gecko для замеров RPC/БД); исправлен **`signaturesPages`** в ответе пула (использовался неверный счётчик).
- **`scripts-tmp/_grws-pilot-measure.sh`:** записывает seed JSON и задаёт **`SA_GRWS_SEED_POOLS_PATH`** для пилотного замера.
- **`.env.example`:** закомментированные ключи seed.

### Откат

- **`git checkout sa-alpha-1.11.29 -- scripts-tmp/sa-grws-collector.mjs scripts-tmp/_grws-pilot-measure.sh .env.example docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.29] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.29`.

### W6.7 — Gecko `new_pools`: ретраи при теле без `data[]`

- **`scripts-tmp/sa-grws-collector.mjs`:** отдельный fetch Gecko с **User-Agent**, пауза **400 ms** между страницами; если ответ **200** без массива **`data`** (типично при лимитах), **ретрай** с backoff вместо тихого «0 пулов».
- **`scripts-tmp/_grws-pilot-measure.sh`:** пауза **75 s** перед прогоном (меньше пересечений с cron TG `:05` и всплесками Gecko); замер **`credits_used`** биллинг-периода QuickNode Console API до/после (дельта **приблизительная**, включает фоновый расход других процессов).

### Откат

- **`git checkout sa-alpha-1.11.28 -- scripts-tmp/sa-grws-collector.mjs scripts-tmp/_grws-pilot-measure.sh docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.28] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.28`.

### W6.7 — hot-fix: Raydium на Gecko `new_pools`

- **`scripts-tmp/sa-grws-collector.mjs`:** признак Raydium берётся также из **`relationships.dex.data.id`** (актуальный ответ API); иначе список пулов мог быть пустым при непустой выдаче Gecko.
- **`scripts-tmp/_grws-pilot-measure.sh`:** вспомогательный замер окна QuickNode Admin API + прогон коллектора (операторский).

### Откат

- **`git checkout sa-alpha-1.11.27 -- scripts-tmp/sa-grws-collector.mjs scripts-tmp/_grws-pilot-measure.sh docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`**.

---

## [1.11.27] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.27`.

### W6.7 — коллектор Gecko → Raydium → RPC для пополнения `wallets` (пилот)

- **`scripts-tmp/sa-grws-collector.mjs`:** `new_pools` GeckoTerminal, фильтр Raydium, `getSignaturesForAddress` / `getTransaction` (режим **`v1b`** по умолчанию), **`INSERT … ON CONFLICT DO NOTHING`** в **`wallets`** с контрактом `metadata` из W6.7 §6.3; **`batch_id`** по PI-5 — один на процесс; последовательная обработка пулов; env **`SA_GRWS_*`**.
- **`package.json`:** скрипт **`npm run sa-grws-collector`**.
- **`.env.example`:** блок переменных W6.7 §8.
- **`scripts/check-release-hygiene.mjs`**, **`docs/strategy/specs/INDEX.md`:** проверка относительных ссылок допускает пробелы/`%20` в пути (папка **`Smart Lottery V2`**).

PM2 на VPS по умолчанию не добавлялся (локальный пилот / ручной запуск по [`W6.7`](../../Smart Lottery V2/W6.7_gecko_raydium_wallet_seed_collector_local.md)).

### Откат

- **`git checkout sa-alpha-1.11.26 -- scripts-tmp/sa-grws-collector.mjs package.json .env.example scripts/check-release-hygiene.mjs docs/strategy/specs/INDEX.md docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** (или **`git reset --hard sa-alpha-1.11.26`** на клоне). Перезапуск PM2 не требуется.

---

## [1.11.26] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.26`.

### Live Oscar — W8.0-p7.1: журнал ↔ цепь, якоря входов, notional parity (снимает ложный «вечный» reconcile-block)

- **`src/live/main.ts`:** перед SPL-reconcile — **паритет номинала** paper/live (`evaluateLiveNotionalParity`, env **`LIVE_STRICT_NOTIONAL_PARITY`**, по умолчанию вкл.); **`commitBootSnapshot`** не затирает статус при активном parity-block; replay через общие **`replayJournalOpts()`** (в т.ч. **`LIVE_REPLAY_TRUST_GHOST_POSITIONS`**); после repair — повторный replay; **верификация `entryLegSignatures` на boot** (`verifyReplayedOpenBuyAnchorsOnBoot`, **`LIVE_ANCHOR_VERIFY_ON_BOOT`**).
- **Новые модули:** **`boot-anchor-verify.ts`**, **`notional-parity.ts`**, **`live-buy-anchor.ts`** — проверка якорных tx и дописывание якорей в журнал после **open/DCA** (paper → live JSONL).
- **`replay-strategy-journal.ts`**, **`repair-missed-live-buys.ts`**, **`store-jsonl`**, **`phase4`/`phase5`**, **`live-reconcile-*`**, **`strategy-snapshot`**, **`events`**, **`config`:** поддержка p7.1 и событий.
- **`src/papertrader`:** вызовы якорения live-buy после открытия/DCA; типы/store-restore при необходимости.
- **`src/scripts/live-reconcile-cli.ts`**, **`.env.example`:** документация env-ключей p7.1.
- **Тесты:** **`tests/live-phase7-p71.test.ts`**, обновлён **`live-phase7-replay.test.ts`**.

### Откат

- **`git reset --hard sa-alpha-1.11.25`** на клоне и деплой по [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md) §5.2; **`pm2 reload ecosystem.config.cjs --only live-oscar,pt1-oscar,pt1-diprunner,pt1-dno --update-env`** под **`salpha`** (при необходимости **`dashboard-organizer-paper`**).

---

## [1.11.25] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.25`.

### Дашборд и главная страница сайта — явная плашка пост-lane (48 ч / 3000 холдеров)

- **`scripts-tmp/dashboard.html`** (`/`): краткий текст prod-порогов пост-lane и ссылка на **`/papertrader2`**.
- **`scripts-tmp/dashboard-paper2.html`** (`/papertrader2`): заметная плашка под шапкой с **`PAPER_POST_MIN_AGE_MIN=2880`** и **`PAPER_MIN_HOLDER_COUNT=3000`**; у **Oscar** обновлён **one-liner**, чтобы возраст пула и холдеры были видны в шапке карточки (детали в `STRATEGY_META` уже совпадали с SSOT).

### Откат

- **`git checkout sa-alpha-1.11.24 -- scripts-tmp/dashboard.html scripts-tmp/dashboard-paper2.html docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`** (или **`git reset --hard sa-alpha-1.11.24`** на клоне), затем деплой на сервер; перезапуск PM2 **`dashboard-organizer-paper`** не обязателен для HTML (файл читается с диска на каждый запрос), но **`pm2 reload … --update-env`** допустим по политике релиза.

---

## [1.11.24] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.24`.

### Hot-fix — пост-lane 2 дня и холдеры ≥3000 (четыре prod стратегии)

- **`ecosystem.config.cjs`:** **`PAPER_POST_MIN_AGE_MIN=2880`** (48 ч / 2 дня) для **`pt1-diprunner`**, **`pt1-oscar`**, **`live-oscar`**, **`pt1-dno`**.
- **`PAPER_MIN_HOLDER_COUNT=3000`** для тех же процессов (ранее 2000 / 1500 / 1500 / 1000).
- **`scripts-tmp/dashboard-paper2.html`**, **`docs/strategy/specs/INDEX.md`** (примечание W6.5): зеркало SSOT в UI/доках.

### Откат

- В **`ecosystem.config.cjs`**: **`PAPER_POST_MIN_AGE_MIN=720`**; **`PAPER_MIN_HOLDER_COUNT`** как в **`sa-alpha-1.11.22`** (diprunner 2000, oscar/live-oscar 1500, dno 1000). Затем **`pm2 reload ecosystem.config.cjs --only pt1-diprunner,pt1-oscar,pt1-dno,live-oscar,dashboard-organizer-paper --update-env`** под **`salpha`**.
- Или **`git reset --hard sa-alpha-1.11.22`** на сервер-клоне и reload PM2 ([`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md) §5.2).

---

## [1.11.22] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.22`.

### Live Oscar — подтверждение swap и восстановление зеркала позиций в журнале

- **`src/live/phase6-send.ts`:** корректный разбор ответа **`getSignatureStatuses`** (`value` vs голый массив); при таймауте опроса — **`getTransaction`**: если транзакция в блоке без **`meta.err`**, исход считается успешным (снижает ложные **`failed`** при «медленном» RPC).
- **`src/live/pending-buy-cooldown.ts`**, **`src/live/phase4-execution.ts`**, **`src/papertrader/main.ts`:** после неоднозначного сценария с подписью на цепи и **`confirm_timeout`** — короткий cooldown на повторный **`buy_open`/`dca_add`** по тому же mint (снижение двойных входов).
- **`src/live/repair-missed-live-buys.ts`**, **`src/live/main.ts`:** при старте **`live`** после Phase 7 replay — поиск пар **`execution_attempt` (buy) + `execution_result` (`failed` + tx)** с фактическим зачислением токена на кошелёк; дописывание **`live_position_open`** / **`live_position_dca`** и повторный replay. Env: **`LIVE_REPAIR_MISSED_OPENS`**, **`LIVE_REPAIR_MISSED_OPEN_MAX_AGE_MS`** (см. **`.env.example`**).

### Дашборд и отчёты (вспомогательные скрипты)

- **`scripts-tmp/dashboard-server.ts`**, **`scripts-tmp/dashboard-paper2.html`:** доработки сервера дашборда и разметки стратегий (в т.ч. удобство mobile / метаданные).
- **`scripts-tmp/hourly-telegram-report.mjs`:** цепочка RPC для баланса и сопутствующие правки.

### Утилиты диагностики live (не PM2)

- **`scripts-tmp/check-tx-once.mjs`**, **`scripts-tmp/verify-swap-tx.mjs`:** разовая проверка подписи / свопа через RPC.

### Откат

- Выключить repair: **`LIVE_REPAIR_MISSED_OPENS=0`** → **`pm2 restart live-oscar --update-env`**.
- Полный откат кода: revert коммита **1.11.22** (или восстановить файлы из тега **`sa-alpha-1.11.21`**) и перезапуск **`live-oscar`**.

---

## [1.11.21] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.21`.

### Пост-lane — единый минимальный возраст пула 12 ч (бумага + live)

- **`ecosystem.config.cjs`:** для **`pt1-oscar`**, **`pt1-diprunner`**, **`pt1-dno`**, **`live-oscar`** выставлено **`PAPER_POST_MIN_AGE_MIN=720`** (12 ч); **`PAPER_POST_MAX_AGE_MIN=0`** (верхняя граница по возрасту в снимке не задаётся).
- **`scripts-tmp/dashboard-paper2.html`:** тексты **STRATEGY_META** (Oscar, Deep Runner, Dno, Live Oscar) приведены к этим числам; уточнён объём 5m для Dno ($10 000 — как в ecosystem).
- **`.env.example`**, **[`specs/INDEX.md`](../specs/INDEX.md)** (примечание W6.5), фрагмент примера в **[`W6.5_strategy_launch.md`](../specs/W6.5_strategy_launch.md)** — согласованы с SSOT.

### Откат

- В ecosystem вернуть прежние **`PAPER_POST_MIN_AGE_MIN`** / **`PAPER_POST_MAX_AGE_MIN`** по приложениям; **`pm2 reload ecosystem.config.cjs --update-env`** для затронутых процессов.

---

## [1.11.20] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.20`.

**Интеграция:** в этот же git-тег и push в **`origin/v2`** впервые входят накопленные в рабочем дереве изменения, текстово описанные в журнале ниже как **[1.11.19]** (дашборд cookie, hourly RPC, сопутствующие правки **`ecosystem.config.cjs`**, **`.env.example`**, **`deploy/RUNTIME.md`**, **`W6.4_observability_port.md`**).

### RPC `getBalance` — паритет с QuickNode (Live Phase 5 / reconcile)

- **Симптом:** в live-журнале **`risk_block`** с **`limit: wallet_balance_rpc`** при работающем RPC; paper **`pt1-oscar`** мог открывать позиции в тот же период.
- **Причина:** ответ QuickNode для **`getBalance`** часто имеет вид **`{ context, value }`**, а код ожидал голое число лампортов → **`NaN`** → **`null`** lamports → ложный блок Phase 5.
- **`src/core/rpc/qn-client.ts`:** **`lamportsFromGetBalanceResult`** — разбор обоих форматов (число или вложенный **`value`**).
- **`src/live/phase5-gates.ts`**, **`src/live/reconcile-live.ts`:** использование парсера вместо **`Number(result)`** по объекту.
- **`tests/qn-getbalance-lamports.test.ts`:** регрессия на форму QuickNode.
- **`scripts/diag-live-wallet-rpc.ts`**, npm **`diag:live-wallet-rpc`** — диагностика (сырой POST + **`qnCall`** с **`feature: sim`**, снимок meter).
- **`docs/strategy/release/DIAGNOSTIC_SCRIPTS.md`:** §3 — явное исключение для утилит в **`scripts/*.ts`** с импортом из **`src/`**.
- **`docs/strategy/release/RUNBOOK_LIVE_OSCAR_PHASE7.md`:** примечание про форму ответа **`getBalance`**.

### Откат

- Revert коммита с **`lamportsFromGetBalanceResult`** и связанными вызовами (или восстановить файлы до **1.11.19**); **`pm2 restart live-oscar --update-env`** на VPS.

---

## [1.11.19] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.19`.

### Дашборд PaperTrader2 — мобильный вход после Basic Auth

- **`scripts-tmp/dashboard-server.ts`:** при успешном HTTP Basic или валидной cookie **`sa_dash_sess`** выставляется **HttpOnly** сессионная cookie (HMAC, sliding ~7 суток). Так **`fetch('/api/paper2', { credentials: 'include' })`** на телефонах получает доступ без повторной отправки заголовка `Authorization` (типичная причина «перезагрузки» и пустого состояния только на mobile).

### Hourly Telegram — баланс кошелька

- **`scripts-tmp/hourly-telegram-report.mjs`:** в цепочку RPC добавлен **`SA_RPC_HTTP_URL`** (как на VPS в `.env`).
- На сервере в **`/opt/solana-alpha/.env`** должен быть **`LIVE_WALLET_PUBKEY`** (или **`HOURLY_WALLET_PUBKEY`**), иначе в отчёте остаётся текст про незаданный ключ.

### Откат

- Откат **`dashboard-server.ts`** на версию без cookie; удалить опциональные **`DASHBOARD_SESSION_SECRET`** / cookie у клиентов не обязательно.

---

## [1.11.18] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.18`.

### Deep Runner (`pt1-diprunner`) — dip-паритет с Oscar + recovery veto

- Параметры дипа (**lookback 120/360/720**, откат −15…−50%, импульс ≥12%, мин. возраст дипа 0, кулдаун 120 / скальп 20) уже были в **`ecosystem.config.cjs`**; добавлены **`PAPER_DIP_RECOVERY_VETO_*`** как у **`pt1-oscar`**.
- Дашборд **`/papertrader2`**: описание Deep Runner приведено к фактическим env; уточнён контекст **live holders** (общий модуль **`holders-resolve.ts`**, в т.ч. исправление GPA Token-2022 без недосчёта из‑за `dataSize`).

### Откат

- Удалить три ключа **`PAPER_DIP_RECOVERY_VETO_*`** из блока **`pt1-diprunner`** и `pm2 reload ecosystem.config.cjs --only pt1-diprunner --update-env`.

---

## [1.11.17] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.17`.

### Live Oscar — микролимиты: вход $10, потолок потерь стратегии $50

- **`ecosystem.config.cjs`** (`live-oscar`): **`PAPER_POSITION_USD=10`**, **`LIVE_MAX_POSITION_USD=10`**, **`LIVE_MAX_STRATEGY_LOSS_USD=50`** (без изменений по сумме, зафиксировано в комментарии как совокупный лимит стратегии).
- Дашборд: мета Live Oscar отражает **$10** и **$50**.

### Откат

- Вернуть прежние USD-значения в блоке **`live-oscar`** и **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`**.

---

## [1.11.16] — 2026-05-03

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.16`.

### Live Oscar — хотфикс: возраст пула 12 ч + снятие ложного risk_block на вход

- **`ecosystem.config.cjs`** (`live-oscar`): **`PAPER_POST_MIN_AGE_MIN=720`** (12 ч); ранее 360 (6 ч).
- **`LIVE_MAX_POSITION_USD=100`** — выровнено с **`PAPER_POSITION_USD`**; при **`10`** live-контур стабильно писал **`risk_block`** (`max_position_usd`: intent $100 vs max $10), из‑за чего не было ни одной покупки при **`executionMode=live`**.
- Дашборд: текст меты Live Oscar — **720 мин (12 ч)**.

### Откат

- В ecosystem для **`live-oscar`**: **`PAPER_POST_MIN_AGE_MIN`** как было; **`LIVE_MAX_POSITION_USD=10`** только если снова нужна канарейка §3.3; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.15] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.15`.

### Live Oscar — возраст пула 6 ч, тайм-аут 8 ч; hourly Telegram

- **`ecosystem.config.cjs`** (`live-oscar`): **`PAPER_POST_MIN_AGE_MIN=360`** (6 ч), **`PAPER_TIMEOUT_HOURS=8`**; paper **`pt1-oscar`** без изменений (120 мин / 12 ч).
- **`scripts-tmp/hourly-telegram-report.mjs`**: одно сообщение — Coverage (unique mints), Health по источникам, блок **Live Oscar** (открытые позиции, новые открытия за час, реализованный / нереализованный / суммарный PnL), **Eval** из paper Oscar JSONL, баланс **SOL/USDC**, сводка **failed/sim_err** за час с разбивкой по причинам.
- Дашборд **`/papertrader2`**: текст меты **Live Oscar** приведён к 360 мин / 8 ч.
- **`.env.example`**: переменные **`HOURLY_*`** для hourly-отчёта.

### Откат

- В ecosystem для **`live-oscar`** вернуть **`PAPER_POST_MIN_AGE_MIN=120`**, **`PAPER_TIMEOUT_HOURS=12`** (как у pt1-oscar) при необходимости паритета; откат hourly — предыдущий коммит `hourly-telegram-report.mjs`.

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
