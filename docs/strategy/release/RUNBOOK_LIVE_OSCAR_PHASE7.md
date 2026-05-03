# Runbook — Live Oscar Phase 7 (replay + reconcile)

Операционные сценарии для процесса **`live-oscar`** после включения **W8.0-p7**. Нормативная спека: [`../specs/W8.0_phase7_replay_reconcile_spec.md`](../specs/W8.0_phase7_replay_reconcile_spec.md). Дополнение **p7.1** (якоря, quarantine, notional parity): [`../specs/W8.0_phase7_1_chain_anchored_live_journal_spec.md`](../specs/W8.0_phase7_1_chain_anchored_live_journal_spec.md). Чеклист кода: [`../specs/W8.0_phase7_implementation_checklist.md`](../specs/W8.0_phase7_implementation_checklist.md). Rollout live: родительская спека [`../specs/W8.0_live_oscar_trading_bot.md`](../specs/W8.0_live_oscar_trading_bot.md) §9.

---

## 0. Rollout W8.0 §9 — шаг 1 (**`dry_run`**, ~1 неделя)

**Цель:** гонять тот же discovery/трекер/Oscar-логику, что и **`pt1-oscar`**, но **без** подписи транзакций и **без** отправки в сеть; сравнивать кандидатов и «намерения» с бумажным Oscar.

| Параметр | Значение (prod в `ecosystem.config.cjs`) |
|----------|------------------------------------------|
| **`LIVE_STRATEGY_ENABLED`** | **`1`** |
| **`LIVE_EXECUTION_MODE`** | **`dry_run`** |
| **`LIVE_WALLET_SECRET`** | **не нужен** (конфиг это допускает в `dry_run`) |

**Что пишется в JSONL:** попытки исполнения заканчиваются **`execution_skip`** с причинами вида **`dry_run:buy_open`** / **`dry_run:dca_add`** и т.п. — это ожидаемо. Jupiter quote/swap-build может вызываться по политике Phase 4 — сеть не трогаем.

**Reconcile на boot:** в **`dry_run`** Phase 7 reconcile **пропускается** (см. `live/main.ts`); в **`heartbeat`** будет **`reconcileBootStatus: skipped`**, **`reconcileBootSkipReason: dry_run`**.

**После смены режима в ecosystem:**  
`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`

**Критерий перехода к шагу 2 (`simulate`):** минимум **~7 дней** наблюдения, нет критичных расхождений live vs paper по твоим правилам, зафиксирован короткий отчёт (хотя бы список замечаний). Шаг 2 — отдельное решение + микро-кошелёк + **`LIVE_EXECUTION_MODE=simulate`**.

---

## 0.1 Rollout W8.0 §9 — шаг 2 (**`simulate`** + микролимиты)

**Цель:** тот же Oscar-цикл, что у **`pt1-oscar`**, но с **подписью** swap-tx и **`simulateTransaction`** (без **`sendTransaction`**); в JSONL появляются **`live_position_*`** при успешной симуляции (в отличие от **`dry_run`**).

| Параметр | Значение (prod в `ecosystem.config.cjs`) |
|----------|------------------------------------------|
| **`LIVE_STRATEGY_ENABLED`** | **`1`** |
| **`LIVE_EXECUTION_MODE`** | **`simulate`** |
| **`LIVE_WALLET_SECRET`** | Путь к keypair на VPS, **`chmod 600`**, владелец **`salpha`** (в git не коммитится; шаблон имени **`*.keypair.json`**) |
| **`LIVE_WALLET_PUBKEY`** | Опционально, но **рекомендуется**: ожидаемый base58 **публичный** адрес того же кошелька. При несовпадении с ключом из файла процесс **не стартует** (защита от неверного файла). |
| **`LIVE_MAX_POSITION_USD`** | **`10`** |
| **`LIVE_MAX_OPEN_POSITIONS`** | **`5`** |
| **`LIVE_MAX_STRATEGY_LOSS_USD`** | **`50`** |
| **`LIVE_KILL_AFTER_CONSEC_FAIL`** | **`3`** |
| **`LIVE_MIN_WALLET_SOL`** | **`0.05`** (порог «есть SOL на комиссии»; при нулевом балансе — **`risk_block`** **`min_wallet_sol`**) |

**Только публичный адрес недостаточен для торговли:** подпись транзакций делает **приватный ключ** (содержимое keypair-файла или base58-секрет в `LIVE_WALLET_SECRET`). Сид-фразу **не** храните в репозитории и **не** присылайте в чат; один раз восстановите keypair (**Phantom → экспорт приватного ключа**, или `solana-keygen recover` с офлайн-дисциплиной), положите файл на VPS по пути из **`LIVE_WALLET_SECRET`**, права **`chmod 600`**, владелец **`salpha`**. Затем выставьте **`LIVE_WALLET_PUBKEY`** на ваш публичный адрес и перезагрузите PM2.

**Phantom даёт длинную строку (base58), не JSON:** можно сохранить её в **один текстовый файл** без кавычек и переносов (одна строка) по пути **`LIVE_WALLET_SECRET`** — загрузчик поддерживает и CLI JSON `[…]`, и base58 из файла. **Не** используйте `ConvertTo-Json` в PowerShell для преобразования строки в «keypair»: это не формат Solana и ключ будет неверным.

**Первичное заведение ключа на VPS:** из корня продукта  
`sudo -u salpha node scripts/ops/ensure-live-micro-keypair.mjs`  
создаёт файл по пути из **`LIVE_WALLET_SECRET`**, если его ещё нет. Дальше — **пополнить этот pubkey минимальным SOL** (комиссии + запас под правило **2X** §3.4 относительно **`LIVE_MAX_POSITION_USD`**).

**После смены режима:**  
`pm2 flush live-oscar && pm2 reload ecosystem.config.cjs --only live-oscar --update-env` (под **`salpha`**).

**Откат на шаг 1:** **`LIVE_EXECUTION_MODE=dry_run`**, убрать или не задавать **`LIVE_WALLET_SECRET`** в ecosystem (в **`dry_run`** ключ не обязателен), **`pm2 reload`** как выше.

---

## 0.2 Rollout W8.0 §9 — шаг 3 (**`live`** + микролимиты)

**Цель:** реальные swap по Oscar-паритету: **`simulateTransaction`** (если включено политикой Phase 6) → **`sendTransaction`** → подтверждение; в JSONL — **`execution_result`** со статусами **`sent`/`confirmed`/`failed`** и **`txSignature`** при успешной отправке (см. §9 родительской спеки).

| Параметр | Значение (prod в `ecosystem.config.cjs`) |
|----------|------------------------------------------|
| **`LIVE_STRATEGY_ENABLED`** | **`1`** |
| **`LIVE_EXECUTION_MODE`** | **`live`** |
| **`LIVE_WALLET_SECRET`** / **`LIVE_WALLET_PUBKEY`** | как в §0.1 — ключ на VPS, pubkey для проверки при старте |
| **Микролимиты §3.3** | те же, что в §0.1 (`LIVE_MAX_POSITION_USD`, `LIVE_MAX_OPEN_POSITIONS`, …) |

**Деплой конфигурации:** только через Git на сервер-клон по [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](./NORM_UNIFIED_RELEASE_AND_RUNTIME.md) §5.2 (`git reset --hard origin/v2`, **`npm ci`**, **`pm2 reload ecosystem.config.cjs --update-env`**); секреты остаются вне Git (`data/live/*.keypair.json`, права **`chmod 600`**).

**После смены режима:**  
`pm2 flush live-oscar && pm2 reload ecosystem.config.cjs --only live-oscar --update-env` (под **`salpha`**).

**Откат на шаг 2 (`simulate`):** **`LIVE_EXECUTION_MODE=simulate`**, коммит + push + §5.2 (или эквивалентный деплой того же SHA с правкой ecosystem на ветке).

**Откат на шаг 1 (`dry_run`):** как в §0.1.

---

## 1. Политика журнал ↔ цепь (канон)

1. **Восстановление `open` / `closed`** делается только из **`live_position_*`** строк в **`LIVE_TRADES_PATH`** (путь **A** в спеки). События **`execution_attempt` / `execution_result`** в v1 **не** участвуют в replay позиций.
2. **Reconcile** сравнивает ожидаемые SPL-атомы из восстановленного `OpenTrade` с **`getTokenAccountsByOwner`** (Token + Token-2022). Дополнительно запрашивается **`getBalance`** (SOL, lamports) для heartbeat — **не** используется как жёсткий gate на расхождение с журналом (журнал не хранит целевой SOL).
3. Read-only RPC Phase 7 идёт через **`qnCall`** с feature **`sim`** (тот же бюджет, что симуляции Phase 3 / `getBalance` в Phase 5). Отдельного `live_read` в метере нет — зафиксировано в CHANGELOG продукта. Ответ **`getBalance`** у провайдера может быть **`{ context, value }`**; клиент нормализует лампорты (продукт **`1.11.20`**, см. CHANGELOG).
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

---

## 12. W8.0-p7.1 — якоря **`entryLegSignatures`**, quarantine, паритет notional

С **продукта 1.11.23** новые строки **`live_position_*`** для **`simulate`** несут **`liveAnchorMode: simulate`**; для **`live`** после **`confirmed`** buy — непустой **`entryLegSignatures`** (подписи swap).

| Переменная | Дефолт | Смысл |
|------------|--------|--------|
| **`LIVE_REPLAY_TRUST_GHOST_POSITIONS`** | **`0`** | **`1`** — replay применяет строки без якорей (как до p7.1). **Опасно** при рассинхроне журнал/цепь. |
| **`LIVE_STRICT_NOTIONAL_PARITY`** | **`1`** | В **`live`** при несогласованности **`PAPER_POSITION_USD`** с **`LIVE_ENTRY_NOTIONAL_USD`** / **`LIVE_MAX_POSITION_USD`** → **`risk_block`** **`parity_notional_mismatch`**, новые входы заблокированы. |
| **`LIVE_ANCHOR_VERIFY_ON_BOOT`** | **`1`** | В **`live`** перед SPL reconcile — **`getTransaction`** по каждой подписи в **`entryLegSignatures`**; ошибочная/отсутствующая tx → строки **`live_reconcile_quarantine`**, mint исключается из **`open`** для reconcile; транспортный сбой RPC → **`anchor_verify_rpc_fail`** (аналогично **`rpc_fail`** reconcile). |

В **`heartbeat`** могут появиться **`quarantinedMints`** (префиксы mint). Откат см. **CHANGELOG 1.11.23**.
