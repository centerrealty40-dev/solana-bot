# Runbook — Live Oscar Phase 7 (replay + reconcile)

Операционные сценарии для процесса **`live-oscar`** после включения **W8.0-p7**. Нормативная спека: [`../specs/W8.0_phase7_replay_reconcile_spec.md`](../specs/W8.0_phase7_replay_reconcile_spec.md). Чеклист кода: [`../specs/W8.0_phase7_implementation_checklist.md`](../specs/W8.0_phase7_implementation_checklist.md).

---

## 1. Политика журнал ↔ цепь (канон)

1. **Восстановление `open` / `closed`** делается только из **`live_position_*`** строк в **`LIVE_TRADES_PATH`** (путь **A** в спеки). События **`execution_attempt` / `execution_result`** в v1 **не** участвуют в replay позиций.
2. **Reconcile** сравнивает ожидаемые SPL-атомы из восстановленного `OpenTrade` с **`getTokenAccountsByOwner`** (Token + Token-2022). Дополнительно запрашивается **`getBalance`** (SOL, lamports) для heartbeat — **не** используется как жёсткий gate на расхождение с журналом (журнал не хранит целевой SOL).
3. Read-only RPC Phase 7 идёт через **`qnCall`** с feature **`sim`** (тот же бюджет, что симуляции Phase 3 / `getBalance` в Phase 5). Отдельного `live_read` в метере нет — зафиксировано в CHANGELOG продукта.
4. **`LIVE_RECONCILE_MODE=block_new`** (дефолт): при расхождении SPL или при ошибке RPC списка токенов новые **`buy_open`/DCA** блокируются (`risk_block` с лимитами **`reconcile_divergence`** или **`reconcile_rpc_fail`**). Выходы по трекеру **не** режутся этим флагом.
5. **Свежесть Jupiter quote (W8.0 §10):** **`LIVE_QUOTE_MAX_AGE_MS`** — верхняя граница возраста **`quoteSnapshot.quoteAgeMs`** до подписи/sim/send. **Дефолт в коде и в `ecosystem.config.cjs` для `live-oscar`: 8000 ms.** Значение **`0`** выключает проверку (только если явно задано в окружении). При превышении лимита — **`execution_result`** **`sim_err`** с префиксом **`quote_stale:`**. После смены переменной в ecosystem: **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** (или эквивалентный деплой по [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md)).

---

## 2. Обрезанный или повреждённый журнал

| Симптом | Действие |
|--------|----------|
| Файл **`LIVE_TRADES_PATH`** больше **`LIVE_REPLAY_MAX_FILE_BYTES`** (дефолт 25 MiB) | Replay сканирует **хвост** файла; в логах и heartbeat: **`journalReplayTruncated: true`**. Увеличить лимит, задать **`LIVE_REPLAY_TAIL_LINES`**, или архивировать старый журнал и начать новый файл по регламенту релиза. |
| Нужны только свежие события | **`LIVE_REPLAY_SINCE_TS`** (unix ms) и/или **`LIVE_REPLAY_TAIL_LINES`**. |
| Ручной repair после сбоя записи | Остановить процесс; исправить/обрезать последнюю некорректную строку JSONL; при необходимости удалить незавершённую пару событий; перезапуск с **`LIVE_STRATEGY_ENABLED=0`** для проверки replay без торговли. |

---

## 3. `reconcile_divergence` / `block_new`

1. Проверить JSONL: **`risk_block`** с **`limit: reconcile_divergence`** и **`mismatches`** (mint, expected/actual atoms).
2. Сверить фактические ATA на кошельке live (Explorer / RPC) с ожидаемым остатком позиции.
3. После устранения причины (докатить **`live_position_*`**, исправить цепь вне бота только в крайнем случае) — **`pm2 restart live-oscar --update-env`**. Флаг блокировки снимается при чистом старте (`clearLiveReconcileBlock`).

---

## 4. `trust_chain`

Режим **`trust_chain`** в коде **v1 — заглушка** (нет мутации модели по цепи). Конфиг **отклоняется** при загрузке, если не выставлено **`LIVE_RECONCILE_TRUST_CHAIN_ALLOWED=1`**. Для прод по умолчанию используйте **`block_new`** или **`report`**.

---

## 5. Pending swap / обрыв между attempt и result

Модель replay по **`live_position_*`** не создаёт «висящих» позиций из одного **`execution_attempt`** без **`live_position_*`**. Если swap прошёл on-chain, но снимок позиции не записан — состояние процесса может расходиться с цепью до следующей записи; лечение: reconcile и ручной контроль журнала.

---

## 6. Heartbeat

В **`heartbeat`** (после boot) добавлены опциональные поля: **`reconcileBootStatus`**, **`reconcileBootSkipReason`**, **`reconcileMintsDivergent`**, **`reconcileWalletSolLamports`**, **`reconcileChainOnlyMints`**, **`journalReplayTruncated`**. Используйте для дашборда и алертов (полный пласт Phase 8 — отдельно).

Колонка **Live Oscar** на **`/papertrader2`** показывает последний **`reconcile boot:*`** из heartbeat и предупреждение по **`live_reconcile_report.txAnchorSample`**, если есть пропуски по RPC.

---

## 7. Решение по пути replay **(B)** и индексу `intentId` (§4 спеки)

- **Путь (B)** — восстановление позиций **только** из **`execution_attempt` / `execution_result`** — **не реализуется**: дублирует состояние, которое уже надёжно отражено в **`live_position_*`**, и требует вывода полного `OpenTrade` из исполнения с высоким риском расхождений. Канон остаётся **путь (A)**.
- **Индекс по `intentId`** для упорядочивания execution-событий при **(B)** — **n/a** при каноне **(A)**.

---

## 8. Строка **`live_reconcile_report`** (`liveSchema: 2`)

На каждом старте процесса (после ветки replay/reconcile) в **`LIVE_TRADES_PATH`** дописывается одна строка **`kind: live_reconcile_report`** с **`liveSchema: 2`**: итог SPL reconcile (`ok`, `reconcileStatus`, `mode`, при необходимости **`mismatches`**, SOL, **`chainOnlyMints`**, **`journalReplayTruncated`**). Пишется **после** возможных **`risk_block`** / **`execution_skip`** по reconcile.

---

## 9. Выборочная проверка **`txSignature`** (мягкий якорь P7-I4)

- **`LIVE_RECONCILE_TX_SAMPLE_N`** (целое **0…50**, дефолт **0**): при **`N > 0`** после replay процесс берёт **до N** последних уникальных подписей из журнала со статусом **`execution_result.confirmed`** и вызывает **`getTransaction`** (тот же **`qnCall` / feature `sim`**, commitment как **`LIVE_CONFIRM_COMMITMENT`**). Результат попадает в **`live_reconcile_report.txAnchorSample`** (`checked`, `notFound`, `rpcErrors`). Отсутствие tx в RPC **не** переводит SPL reconcile в fail — это отдельный сигнал для оператора.

---

## 10. CLI без запуска Oscar

```bash
npm run live-reconcile
```

Загружает тот же ENV, что **`live-oscar`**, выполняет replay + reconcile (+ tx sample, если **`LIVE_RECONCILE_TX_SAMPLE_N > 0`**), печатает JSON в stdout; код выхода **1** при ошибке SPL reconcile или при проблемах tx sample (`notFound` / `rpcErrors`). Не запускает торговый цикл.

---

## 11. Относительный допуск reconcile (%)

По решению продукта остаётся только **`LIVE_RECONCILE_TOLERANCE_ATOMS`**; процентный допуск к остатку **не вводился**.
