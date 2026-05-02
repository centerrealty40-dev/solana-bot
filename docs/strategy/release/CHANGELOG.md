# Solana Alpha — журнал релизов продукта

Версия в файле [`VERSION`](./VERSION) — **semver продукта** (торговое/paper ядро + конфиги стратегий + восстановление состояния из журнала). Она **не обязана** совпадать с полем `version` в `package.json` (npm); при желании их можно синхронизировать только для крупных релизов.

Каждая запись ниже обязана содержать: дату, номер версии, краткое описание, **git-тег** (если применимо), **инструкцию отката**.

Формат записей — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), семвер — [Semantic Versioning 2.0.0](https://semver.org/lang/ru/).

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
