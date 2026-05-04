# Solana Alpha — runtime (VPS)

Единая точка входа для оператора: **что запущено**, **как перезапускать**, **какие cron’ы относятся к продукту**, известные дубли.

Репозиторий: `/opt/solana-alpha`, пользователь процессов: `**salpha`**, PM2 home: `/home/salpha/.pm2`.

**RPC / очередь:** если `rpc_tasks` раздута (сотни тысяч `queued`), новые DEX-коллекторы поднимаются с `**RAYDIUM_ENQUEUE_RPC` / `METEORA_ENQUEUE_RPC` / `ORCA_ENQUEUE_RPC` = `0`** — они всё равно пишут `*_pair_snapshots` для `enqueue-seed-signatures`, но не добавляют задачи в `rpc_tasks`. Включить `=1` после просадки очереди.

---

## 1. PM2 — манифест в git

После **W2 slim** файл `ecosystem.config.cjs` в корне репозитория описывает **только** процесс **`dashboard-organizer-paper`** (дашборд на `HOST`/`PORT`, `STORE_PATH` к JSONL — см. сам файл).

Краткая операторская сводка по железу и TLS: **`deploy/README.md`**.

```bash
cd /opt/solana-alpha
sudo -u salpha -H bash -lc 'pm2 start ecosystem.config.cjs && pm2 save'
```

Таблица ниже — **исторический** манифест до W1/W2; большинство процессов и скриптов удалены из репозитория. Оставлено как архив рассуждений.

### Состав (имена процессов)


| Имя                         | Тип       | Детали                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sa-moonshot-collector`     | ingestion | `scripts-tmp/moonshot-collector.mjs`                                                                                                                                                                                                                                                                                                                                                                                              |
| `sa-raydium-collector`      | ingestion | `scripts-tmp/raydium-collector.mjs` (HTTP DexScreener/Gecko; `RAYDIUM_ENQUEUE_RPC` default `0` в ecosystem)                                                                                                                                                                                                                                                                                                                       |
| `sa-meteora-collector`      | ingestion | `scripts-tmp/meteora-collector.mjs` (`METEORA_ENQUEUE_RPC` default `0`)                                                                                                                                                                                                                                                                                                                                                           |
| `sa-orca-collector`         | ingestion | `scripts-tmp/orca-collector.mjs` (`ORCA_ENQUEUE_RPC` default `0`)                                                                                                                                                                                                                                                                                                                                                                 |
| `sa-jupiter-route-watcher`  | ingestion | `scripts-tmp/jupiter-route-watcher.mjs` — Quote API → `jupiter_route_snapshots`; `**JUPITER_WATCHER_ENQUEUE_RPC=0**` по умолчанию                                                                                                                                                                                                                                                                                                 |
| `sa-direct-lp-detector`     | ingestion | `scripts-tmp/direct-lp-detector.mjs`                                                                                                                                                                                                                                                                                                                                                                                              |
| `sa-pumpswap-collector`     | ingestion | `npm run pumpswap-collector:start` (+ PM2 `cron_restart` раз в 6 ч)                                                                                                                                                                                                                                                                                                                                                               |
| `sa-rpc-collector`          | ingestion | `npm run rpc-collector:start`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sa-sigseed-worker`         | pipeline  | `npm run sigseed:worker`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sa-wallet-trace-worker`    | pipeline  | Не в `ecosystem.config.cjs` (избегаем `pm2 start … --only ecosystem`); первичный запуск: `pm2 start npm --name sa-wallet-trace-worker --cwd /opt/solana-alpha --interpreter none --merge-logs --time -- run --silent wallet:trace:worker` под `salpha`. Очередь `wallet_trace_queue` → RPC (`getSignatures`+`getTransaction`, ретраи/лимиты см. env). Опционально: `WALLET_TRACE_WORKER_BATCH=3` для съёма нескольких задач за цикл. |
| `pt1-smart-lottery`         | paper     | `profiles/run-pt1-smart-lottery.sh` → `paper:live`                                                                                                                                                                                                                                                                                                                                                                                |
| `pt1-fresh-validated`       | paper     | `profiles/run-pt1-fresh-validated.sh`                                                                                                                                                                                                                                                                                                                                                                                             |
| `pt1-dip-runners`           | paper     | `profiles/run-pt1-dip-runners.sh`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pt1-oscar-clone`           | paper     | `profiles/run-pt1-oscar-clone.sh`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pt1-dno-clone`             | paper     | `profiles/run-pt1-dno-clone.sh`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pt1-organizer-paper`       | paper     | `npm run paper:live`, `PAPER_STRATEGY_KIND=runner_organizer`                                                                                                                                                                                                                                                                                                                                                                      |
| `dashboard-organizer-paper` | UI        | `npm run dashboard`, порт **3008**, `STORE_PATH` = organizer JSONL (`data/paper2/organizer-paper.jsonl`)                                                                                                                                                                                                                                                                                                                          |


Логи: `~/.pm2/logs/<name>-out.log` / `-error.log`.

### Paper: sniper legitimacy bump

Smart Lottery и Fresh Validated: в SQL считаются ранние покупатели-снайперы (`primary_tag = sniper` или строка в **`wallet_tags`** с `tag = sniper`), доля USD и **`legitimacy.bump`** в строках `eval`. **`SNIPER_LEGITIMACY_MODE`**: `shadow` (по умолчанию — только метрики и bump в JSONL), `off`, `rank` (сортировка кандидатов по bump), `gate` (при `bump ≥ SNIPER_LEGIT_GATE_MIN_BUMP` минимум smart-buyers снижается на 1). Прочие пороги: `SNIPER_LEGIT_MAX`, `SNIPER_LEGIT_MAX_DISTINCT`, `SNIPER_LEGIT_WEIGHT_PER_DISTINCT`, `SNIPER_LEGIT_WEIGHT_SHARE`, `SNIPER_LEGIT_DECAY_START_MIN`, `SNIPER_LEGIT_DECAY_END_MIN`.

### Два конвейера `pipeline` (для ориентира)


| №     | PM2                      | Очередь / сырьё                                                              | Назначение                                                                        |
| ----- | ------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **1** | `sa-wallet-trace-worker` | `wallet_trace_queue` → профиль кошелька + `money_flows`                      | Atlas: история кошелька (Helius или RPC), аудит `trace_last_*` в `entity_wallets` |
| **2** | `sa-sigseed-worker`      | `signatures_seed_queue` → `rpc_features` → `npm run sigseed:parse` → `swaps` | Сиды по минтам без Helius Enhanced на каждый токен: RPC QuickNode, парсер в свопы |


**Enqueue pipeline 2:** `npm run sigseed:enqueue` (cron `*/15`), второй проход — `scripts/cron/enqueue-seed-followup.sh` (`*/30`). **Парсинг:** `sigseed:parse` (`*/3`). В логах воркера: `queueDepth` (остаток в `signatures_seed_queue`), `rpcFeaturesTxUnparsed` (хвост `rpc_features` до парсера). **W6.12 S03:** при переносе worker на эту ветку billable RPC желательно направлять через **`scripts-tmp/sa-qn-json-rpc.mjs`** (`componentId` **`sigseed_worker`**) и общий лимит **`SA_QN_GLOBAL_*`**.

**Atlas → pipeline 2:** из **runner-organizer-watch** и **wallet trace** (после реального фетча истории, не cache-hit) минты ставятся в `signatures_seed_queue`, если по `base_mint` в `swaps` не больше `ATLAS_ENQUEUE_SWAPS_CEILING` строк; дневной потолок `ATLAS_ENQUEUE_MAX_PER_DAY`, подробности в `.env.example`. Лог постановок: `data/logs/atlas-sigseed-enqueue.jsonl`; в логах PM2 смотреть `atlasSigseedEnqueued`.

#### Дорожная карта улучшений (SigSeed / pipeline 2)


| Шаг | Статус  | Суть                                                                                                                                                                                                          |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | сделано | Метрики очереди + бэклог `rpc_features` в логах `sa-sigseed-worker` и `sigseed:parse`                                                                                                                         |
| 2   | сделано | Юнит-тесты `parseRpcTxSwap` (`tests/parse-rpc-tx-swap.test.ts`), логика в `src/intel/parse-rpc-tx-swap.ts`                                                                                                    |
| 3   | сделано | Отчёт `npm run unknown-dex:report` (`scripts/cron/unknown-dex-programs-report.mjs`): сводка `swaps` с `dex=unknown`, топ `program_id` из `rpc_features` (outer ± inner ix), Telegram при `UNK_DEX_TELEGRAM=1` |
| 4   | сделано | `npm run rpc-features:prune` — удаление старых `tx_for_signature` (processed) и `signatures_for_mint`; env `RPC_FEATURES_RETENTION_DAYS`, cron см. §2                                                         |
| 5   | сделано | Связка Atlas → pipeline 2: постановка минтов из trace (`tokenTransfers`) и из runner-organizer signals при лимите свопов в БД (`ATLAS_ENQUEUE_*`)                                                             |


---

## 2. Cron `salpha` — только solana-alpha


| Расписание (UTC)      | Задача                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*/30`                | `npm run copy:sweep`                                                                                                                                                                                                                                                          |
| `*/5`                 | `strategy-simulator.mjs`                                                                                                                                                                                                                                                      |
| М `:05`               | `hourly-telegram-report.mjs` (`.env.hourly`)                                                                                                                                                                                                                                  |
| `15 */4`              | `run-advisor-cron.sh`                                                                                                                                                                                                                                                         |
| `30 9 * * *`          | `run-advisor-digest-cron.sh`                                                                                                                                                                                                                                                  |
| `30 4 * * *`          | `discover-smart-money.sh` (сдвиг от `25 4` daily-scam-telegram и backup `10 3`)                                                                                                                                                                                               |
| `20 4 * * *`          | `run-scam-farm.sh` — полный прогон scam-farm-detective раз в сутки UTC (перед `daily-scam-farm-telegram`); установка: `sudo bash scripts/cron/install-scam-farm-cron-salpha.sh`                                                                                              |
| `25 4 * * *`          | `daily-scam-farm-telegram.mjs`                                                                                                                                                                                                                                                |
| `*/30`                | `tokens:seed:dex`                                                                                                                                                                                                                                                             |
| `*/15`                | `sigseed:enqueue`                                                                                                                                                                                                                                                             |
| `*/30`                | `enqueue-seed-followup.sh` — второй проход очереди (coverage gaps + low-swap snapshots; см. скрипт в репо)                                                                                                                                                                    |
| `*/15` или по желанию | `ocean:health` — JSON-снимок ocean (`npm run ocean:health`; лог при необходимости через `>> data/logs/ocean-health.log`)                                                                                                                                                      |
| `*/3`                 | `sigseed:parse`                                                                                                                                                                                                                                                               |
| `15 6 * * 1`          | `unknown-dex:report` — weekly пн 06:15 UTC; **Telegram:** `UNK_DEX_TELEGRAM=1` + `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` в `.env`; лог: `data/logs/unknown-dex-report.log`. Первичная установка cron: `sudo -u salpha bash scripts/cron/install-unknown-dex-cron-salpha.sh` |
| `35 4 * * 0`          | `rpc-features:prune` — вс **04:35 UTC**, retention `RPC_FEATURES_RETENTION_DAYS` (default 30); установка: `sudo -u salpha bash scripts/cron/install-rpc-features-prune-cron-salpha.sh`                                                                                        |
| `0 * * * *`           | `health:summary`                                                                                                                                                                                                                                                              |
| `10 3 * * *`          | `backup-db-r2-api.sh`                                                                                                                                                                                                                                                         |
| `45 5 * * *`          | `discover-smart-money-by-dex.sh` (перед ним в том же shell: `mv:refresh:swap-first-by-dex`; интервал ~1h15 после blended discover)                                                                                                                                             |
| `30 3,15 * * *`       | `runner-organizer.sh`                                                                                                                                                                                                                                                         |
| `*/3 * * * *`         | `runner-organizer-watch.sh`                                                                                                                                                                                                                                                   |
| `*/30 * * * *`        | `runner-organizer-followup.sh`                                                                                                                                                                                                                                                |
| `10 6 * * *`          | `speed-refresh.sh` (не чаще раз в 72 ч; штамп `data/logs/speed-refresh.last`; сдвиг от `45 5` by-dex + MV)                                                                                                                                                                      |
| `35 17 * * *`         | `sniper-refresh.sh` (не чаще раз в 72 ч; штамп `data/logs/sniper-refresh.last`; другое время UTC, чем speed — меньше одновременной нагрузки на БД)                                                                                                                            |
| `*/10 * * * *`        | `sniper-tag-worker.sh` — дренаж `sniper_tag_queue` → `tagWallet` (после установки: `install-sniper-tag-worker-cron-salpha.sh`; не чаще нужной частоты можно ослабить вручную)                                                                                               |
| `8-58/10 * * * *`     | `speed-tag-worker.sh` — дренаж `speed_tag_queue` → `tagWallet` (смещение минут относительно sniper-tag-worker; установка: `install-speed-tag-worker-cron-salpha.sh`)                                                                                                         |


Установка обеих строк: `sudo bash /opt/solana-alpha/scripts/cron/install-intel-refresh-crons-salpha.sh` (идемпотентно; убирает legacy `mev-refresh.sh` из crontab).

Строки **follow-up sigseed** и **ocean:health**: `sudo bash /opt/solana-alpha/scripts/cron/install-ocean-followup-crons-salpha.sh` (идемпотентно).

### Sniper refresh (`npm run intel:sniper-refresh`)

Отбор кошельков, часто попадающих в первые **K** покупателей по mint за lookback; батч `INSERT … entity_wallets`; затем по умолчанию **`SNIPER_REFRESH_TAG_MODE=queue`** — кандидаты с приоритетом `n_hits` попадают в таблицу **`sniper_tag_queue`** и обрабатываются отдельно **`npm run intel:sniper-tag-worker`** (ограничение «сколько `tagWallet` за один запуск» через env воркера), чтобы не создавать пик нагрузки на Postgres из тысяч вызовов подряд. Альтернатива: **`SNIPER_REFRESH_TAG_MODE=direct`** — прежний режим параллельного `tagWallet` в том же процессе (`SNIPER_TAG_CONCURRENCY`). По умолчанию выбираются **все** кошельки, прошедшие пороги `SNIPER_REFRESH_MIN_*`; опционально **`SNIPER_REFRESH_LIMIT_WALLETS=N`** (топ‑N по `n_hits`). **Sniper job не чаще чем раз в 72 ч:** `scripts/cron/sniper-refresh.sh`, штамп `data/logs/sniper-refresh.last`, лог `data/logs/sniper-refresh.log`. **Очередь тегов:** `scripts/cron/sniper-tag-worker.sh` (лог `data/logs/sniper-tag-worker.log`), установка cron: `sudo bash scripts/cron/install-sniper-tag-worker-cron-salpha.sh` (по умолчанию раз в 10 мин UTC). Проверка без записи в БД: `DRY_RUN=1` или `SNIPER_REFRESH_DRY_RUN=1`. Для плана выполнения на проде подставьте lookback в SQL из скрипта и выполните `EXPLAIN (ANALYZE, BUFFERS)` — частичный индекс `swaps_buy_base_mint_block_time_idx` (`WHERE side = 'buy'` на `base_mint, block_time`).

### Speed refresh (`npm run intel:speed-refresh`)

Высокая активность по `swaps` за lookback (`HAVING COUNT(*) >= SPEED_REFRESH_MIN_SWAPS`); батч `entity_wallets`; по умолчанию **`SPEED_REFRESH_TAG_MODE=queue`** — кандидаты с приоритетом по числу свапов попадают в **`speed_tag_queue`**, дренаж **`npm run intel:speed-tag-worker`** (env `SPEED_TAG_WORKER_*`). Альтернатива: **`SPEED_REFRESH_TAG_MODE=direct`** и **`SPEED_TAG_CONCURRENCY`**. Без верхней отсечки по умолчанию (все кошельки выше порога); опционально **`SPEED_REFRESH_LIMIT_WALLETS`** или legacy **`LIMIT_WALLETS`**. Не чаще раз в 72 ч: `speed-refresh.sh`, штамп `data/logs/speed-refresh.last`, лог `data/logs/speed-refresh.log`. Очередь тегов: лог `data/logs/speed-tag-worker.log`, установка: `sudo bash scripts/cron/install-speed-tag-worker-cron-salpha.sh`. Проверка: `DRY_RUN=1` или `SPEED_REFRESH_DRY_RUN=1`.

### Scam-farm roadmap

### W6.12 — budget-first ingest для scam-farm detective (без chain-wide stream/parser)

Нормативные спеки по шагам: **[`docs/Smart Lottery V2/W6.12_OVERVIEW_detective_without_chain_firehose.md`](../docs/Smart%20Lottery%20V2/W6.12_OVERVIEW_detective_without_chain_firehose.md)** (карта **S01–S05** в том же каталоге).

**Целевой порядок конвейера (UTC-сутки, после появления кода):** оркестратор **`wallets`** (W6.8) → узкий **sigseed** → **`swaps`** (S03) → wallet-centric **nightly backfill** → **`money_flows`** / доп. **`swaps`** (S02) → backfill **`wallets.funding_source`** из flows (S04) → **`npm run scam-farm:detect`**. Дневной потолок QuickNode-кредитов — **единый ledger** для всех тяжёлых RPC-джоб (S01).

**До внедрения S02/S04:** сверять **`SCAM_FARM_LOOKBACK_DAYS`** с фактической глубиной данных (например `npm run wallet-intel:doctor`), иначе SQL-фаза детектива работает на «пустом» окне.

**Пример cron (UTC, после миграций `0017`/`0018`):** очередь backfill пополнять вручную или отдельным заданием (`npm run wallet-backfill:run -- --enqueue-from-wallets=5000`), затем ночной прогон:

```text
# 02:15 — wallet backfill (требует SA_BACKFILL_ENABLED=1 в окружении salpha)
15 2 * * * cd /opt/solana-alpha && npm run wallet-backfill:run >> data/logs/wallet-backfill.log 2>&1
# 02:45 — funding_source (требует SA_FUNDING_BACKFILL_ENABLED=1)
45 2 * * * cd /opt/solana-alpha && npm run wallet-funding:backfill >> data/logs/wallet-funding-backfill.log 2>&1
```

#### Pilot: `swaps` без стрима (wallet-backfill), в лимите кредитов (W6.12 S02)

**Стрим (`npm run stream`) не используем.** Единственный поддерживаемый в git «коллектор свопов» для узких experimentов — **`npm run wallet-backfill:pilot`** → внутри **`wallet-backfill-run`** (pump.fun **`decodePumpfunSwap`** → **`swaps`**, SOL legs → **`money_flows`), billable RPC через глобальный ledger (**`wallet_backfill`**).

**Деплой:** только **`git pull`** на `/opt/solana-alpha` до нужного тега/`v2`, без правки файлов на сервере в обход репозитория.

**Оценка кредитов за один пилот-прогон (верхняя граница):**

`SA_BACKFILL_MAX_WALLETS_PER_RUN × (SA_BACKFILL_SIG_PAGES_MAX + SA_BACKFILL_MAX_TX_PER_WALLET) × QUICKNODE_CREDITS_PER_SOLANA_RPC`

Дефолты пилота (если ENV пустой): **40 × (2 + 12) × 30 = 16 800** кредитов (фактически часто меньше — не все кошельки исчерпывают лимиты).

**Фактический замер (тестовый прогон pilot на VPS, ledger `wallet_backfill`):** порядка **~15,3k** кредитов за один прогон при **~470** billable RPC на свопы/историю (верхняя теория **16,8k** не достигнута). Отсюда оценка **сколько раз в сутки безболезненно** при выделенном подпуле на backfill **`SA_BACKFILL_MAX_CREDITS_PER_DAY`** (или руками из операционных **~1,05M** минус оркестратор):

| Выделено на backfill / сутки | Ориентир числа прогонов `wallet-backfill:pilot` (те же лимиты ENV) |
|-----------------------------|-------------------------------------------------------------------|
| **50 000** | **~3** (`floor(50000 / 15300)`) |
| **80 000** | **~5** |
| **120 000** | **~7** |
| **150 000** | **~9** |

Это **только** контур **`wallet_backfill`**; оркестратор и прочие процессы суммируются в **`sa_qn_global_daily`** отдельно. После смены дефолтов пилота пересчитайте: `runs ≈ floor(backfill_subpool_credits / credits_per_measured_run)`.

##### Sigseed (pipeline 2) — статус на ветке `v2`

**Sigseed (W6.12 S03) на `v2`:** таблица **`signatures_seed_queue`** (миграция **`0019_signatures_seed_queue`**), скрипты **`npm run sigseed:enqueue`** / **`npm run sigseed:run`**, billable RPC через **`scripts-tmp/sa-qn-json-rpc.mjs`** с **`component_id=sigseed_worker`**. Парсинг pump.fun в **`swaps`** выполняется **внутри** `sigseed:run` (отдельного `sigseed:parse` и **`rpc_features`** в этом релизе нет). Исполнимый backlog: **[`docs/Smart Lottery V2/W6.12_S03_sigseed_execution_spec.md`](../docs/Smart%20Lottery%20V2/W6.12_S03_sigseed_execution_spec.md)**.

**Целевой контур без стрима на `v2`:** Gecko/DEX коллекторы + **`sa-wallet-orchestrator`** → **`wallet-backfill:*`** → опционально **sigseed** → **`money_flows`** / **`swaps`** → **`wallet-funding:backfill`** → **`npm run scam-farm:detect`** → учёт **`sa_qn_global_daily`**.

**Автоустановка cron (один скрипт после `git pull`):**

```bash
sudo bash /opt/solana-alpha/scripts/cron/install-detective-data-plane-salpha.sh
```

Блок помечен `# SA_ALPHA_DP_BEGIN` … `# SA_ALPHA_DP_END` (повторный запуск перезаписывает только этот блок).

---

##### Sigseed (pipeline 2) — текущая реализация `v2`

- **Миграция:** `npm run db:migrate` → **`signatures_seed_queue`**.
- **Enqueue:** `SA_SIGSEED_ENQUEUE_ENABLED=1 npm run sigseed:enqueue` (опционально `-- --from-dex=N`, `--dry-run`). Берёт `base_mint` из **`*_pair_snapshots`** за ~8 суток, не дублирует очередь и не ставит минты с ≥ **`SA_SIGSEED_SWAPS_CEILING`** строк в **`swaps`**; дневной потолок постановок **`SA_SIGSEED_ENQUEUE_MAX_PER_DAY`**.
- **Worker:** `SA_SIGSEED_ENABLED=1 npm run sigseed:run` — для каждого mint из очереди: `getSignaturesForAddress` → `getTransaction` → **`decodePumpfunSwap`** → **`swaps`** (`source=sigseed`). Один активный прогон: **`pg_advisory_lock(941337041)`**. Лимиты: **`SA_SIGSEED_MAX_MINTS_PER_RUN`**, **`SA_SIGSEED_SIG_PAGES_MAX`**, **`SA_SIGSEED_MAX_TX_PER_MINT`**, мягкий потолок **`SA_SIGSEED_MAX_CREDITS_PER_DAY`** по полю **`sigseed_worker`** в **`sa_qn_global_daily`**.
- **Cron:** строки внутри **`install-detective-data-plane-salpha.sh`** (по умолчанию gates **`SA_SIGSEED_*_ENABLED=0`** — безопасный no-op). Логи: `data/logs/sigseed-enqueue.log`, `data/logs/sigseed-run.log`.
- Нормативно: **[`W6.12_S03_sigseed_bounded_swaps_ingest_spec.md`](../docs/Smart%20Lottery%20V2/W6.12_S03_sigseed_bounded_swaps_ingest_spec.md)**.

**Разово под `salpha`:**

```bash
cd /opt/solana-alpha
npm run sa-qn-global-report
# при пустой wallet_backfill_queue:
SA_BACKFILL_ENABLED=1 npm run wallet-backfill:run -- --enqueue-from-wallets=400
SA_BACKFILL_ENABLED=1 npm run wallet-backfill:pilot
npm run wallet-intel:doctor
npm run sa-qn-global-report
# опционально обновить кандидатов детектива после появления свежих swaps:
npm run scam-farm:detect
```

Обёртка с логом: **`bash scripts/cron/wallet-backfill-pilot-salpha.sh`** (при необходимости раскомментировать строку enqueue внутри скрипта).

Метрика общего ledger: **`npm run sa-qn-global-report`**. Порядок относительно **`run-scam-farm.sh`** — см. **`docs/Smart Lottery V2/W6.12_S05_detective_operational_readiness_spec.md`**.

**Лимит 1.5M кредитов/сутки — операционный пул ~70% и резерв ~30% под анализатор ботов:** **`docs/Smart Lottery V2/W6.13_budget_bot_reserve_detective_stable_spec.md`**.

**W6.13 (реализация ≥ sa-alpha-1.11.70):**

| ENV | Назначение |
|-----|------------|
| `SA_QN_GLOBAL_CREDITS_PER_DAY` | Жёсткий дневной лимит кредитов (UTC) в `sa_qn_global_daily`. |
| `SA_QN_OPERATIONAL_POOL_PCT` | Целевой операционный потолок как % от глобального (default **70** → **1 050 000** при 1.5M). |
| `SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY` | Потолок оркестратора (входит в сумму операционных объявлений). |
| `SA_BACKFILL_MAX_CREDITS_PER_DAY` | Явный потолок backfill; иначе при `SA_BACKFILL_ENABLED=1` — оценка из `SA_BACKFILL_*`. |
| `SA_BOT_ANALYZER_MAX_CREDITS_PER_DAY` | Резерв под будущий анализатор (≤ ~450k при 1.5M). |
| `SA_SIGSEED_MAX_CREDITS_PER_DAY` / `SA_WALLET_TRACE_MAX_CREDITS_PER_DAY` | Заглушки под VPS-воркеры (0 = не учитывать). |
| `SCAM_FARM_MAX_RPC_CREDITS_PER_DAY` | Явные кредиты для RPC-фазы detective; иначе `SCAM_FARM_RPC_BUDGET` × `QUICKNODE_CREDITS_PER_SOLANA_RPC`. |
| `npm run sa-qn-budget-check` | Проверка суммы потолков (stdout JSON, предупреждения в stderr). |
| `HOURLY_APPEND_QN_LEDGER=1` | В **hourly-telegram-report** добавить строку `sa_qn_global_daily` (нужен PG в env hourly). |

**Cron (рекомендация):** раз в сутки после UTC-смены или перед scam-farm — `npm run sa-qn-global-report >> data/logs/sa-qn-global-report.log`; опционально `npm run sa-qn-budget-check >> data/logs/sa-qn-budget-check.log 2>&1`.

**Откат релиза W6.13:** `git checkout sa-alpha-1.11.69` (или предыдущий тег), перезапуск PM2/cron; **`HOURLY_APPEND_QN_LEDGER=0`** если секция hourly мешает; **`SCAM_FARM_ENABLE_RPC=0`** или **`SA_QN_GLOBAL_LEDGER_ENABLED=0`** при конфликте RPC detective с ledger.

---

Пошаговый план улучшений детектива и антискама по монетам: `docs/SCAM_FARM_IMPROVEMENT_STEPS.md`. **Шаг 1:** `npm run tokens:backfill-dev-wallet`. **Шаг 2:** таблица `dev_wallet_stats` — `npm run dev-wallet-stats:refresh` (пороги `DEV_WALLET_STATS_*_LIQ_USD`; сначала `DRY_RUN=1`). **Шаг 3:** тег **`serial_rug_dev`** — `npm run dev-wallet-stats:tag-serial-rugs` (после refresh; env `SERIAL_RUG_*`; опционально cron после refresh). **Шаг 4:** экспансия по якорным mint и кластерам `scam_farm_detective` — **`npm run scam-farm:expand-touch-wallets`** (тег **`scam_farm_touch`**, `source=scam_farm_expand`; лимиты `SCAM_FARM_EXPAND_*`; по умолчанию только кандидаты с `wrote_to_atlas` и без `reverted`; сначала `DRY_RUN=1`). **Шаг 5:** «быстрый раг» (окно часов `RUG_TIMING_MIN_HOURS`–`RUG_TIMING_MAX_HOURS`) — **`npm run scam-farm:rug-timing-boost`** дописывает в **`artifacts.rug_timing`** бонус к score при следующем **`npm run scam-farm:detect`** (слияние в `putCandidate`); cron: **`15 4`** UTC `scripts/cron/run-scam-farm-rug-timing.sh`, затем **`20 4`** `run-scam-farm.sh`; установка: `sudo bash scripts/cron/install-scam-farm-cron-salpha.sh`. **Шаг 6:** paper (`npm run paper:live` / `live-paper-trader.ts`) — anti-scam слой: **`PAPER_SCAM_FARM_MIN_SCORE`** (0 = любой матч по якорю как раньше), **`PAPER_DEV_WALLET_SCAM_GATE`** (гейт по `tokens.dev_wallet` и тегам из **`PAPER_SCAM_TAGS`**), общий выключатель **`PAPER_ANTI_SCAM_ENABLED`**. **Шаг 7:** дайджест в Telegram — **`npm run paper:anti-scam-digest`** (счётчики отказов eval по anti-scam причинам в JSONL + новые строки **`wallet_tags`** за окно для **`serial_rug_dev`** / **`scam_farm_touch`**, отдельно **всего уникальных `scam_farm_touch` в БД**, **за последние 24 ч** и за окно отчёта); включается **`PAPER_ANTI_SCAM_DIGEST_TELEGRAM=1`**, период **`PAPER_ANTI_SCAM_DIGEST_HOURS`**; лог `data/logs/paper-anti-scam-digest.log`; установка cron: **`sudo bash scripts/cron/install-paper-anti-scam-digest-cron-salpha.sh`** (UTC `35 5`).

### Discover smart-money by DEX (`npm run discover:smart-money:by-dex`)

Per-DEX отбор «smart money» по раннерам из `<dex>_pair_snapshots` и ранним покупкам в `swaps WHERE dex=…`; тег `wallet_tags.source = discover_sm_<dex>`. Лог: `data/logs/discover-smart-money-by-dex.log`. Env см. шапку `src/scripts/discover-smart-money-by-dex.ts`.

#### Дорожная карта улучшений


| Шаг | Статус  | Суть                                                                                                                                |
| --- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | сделано | Алиас npm `discover:smart-money:by-dex`; cron вызывает его вместо голого `tsx`-пути                                                 |
| 2   | сделано | Общий SQL-блок `mint_t0`/`peak_mcap`/`runners` для выборки кандидатов и для счётчика `runners` (метрика совпадает с логикой отбора) |
| 3   | сделано | `tagWallet()` только для кошельков, получивших тег в этом батче (`smartTagOk`), без лишних проходов по speed-block                  |
| 4   | сделано | Индекс `swaps (dex, base_mint, block_time)` — миграция + запись в `schema.ts`                                                       |
| 5   | сделано | MV `mv_swaps_first_block_by_dex_mint` + `npm run mv:refresh:swap-first-by-dex` перед by-dex; `mint_t0` из MV при `DISCOVER_SM_MINT_T0_FROM_MV` (default) |
| 6   | сделано | Модуль `src/intel/discover-smart-money-write.ts`: `bad_wallets` CTE, батчи tag/tagWallet, guard speed по env                                     |
| 7   | сделано | Cron: blended `30 4`, by-dex `45 5` UTC; install-скрипты обновлены; MV refresh в shell by-dex                                                     |


---

## 3. Cron `root`, затрагивающий solana-alpha

На одном хосте с другими проектами в root crontab есть строки под `/opt/solana-alpha`:

- `strategy-simulator` — **должен быть только у одного пользователя** (см. §4).
- `raydium-healthcheck.mjs`
- `hourly-telegram-report.mjs` — сводка в Telegram: Coverage + **оркестратор кошельков** (новые **`wallets`** за **`HOURLY_COVERAGE_HOURS`** по **`seed_lane`**, W6.8 §10 п.4) + Health + **Live Oscar** (PnL, открытыя), Eval (paper `pt1-oscar.jsonl`), баланс кошелька (**`HOURLY_RPC_URL`** / **`HOURLY_WALLET_PUBKEY`**, иначе fallback **`SA_RPC_*`** / **`LIVE_WALLET_PUBKEY`**), неуспешные исполнения за час; см. **`HOURLY_*`** в `.env.example`
- `paper2-healthcheck.mjs` (два варианта с разными флагами Telegram)
- `paper2-advisor.mjs`
- `sa-export-root-pm2.sh` ежеминутно — экспорт `pm2 jlist` root в `/run/sa-root-pm2.json` для `health-summary` (см. `scripts/cron/export-root-pm2.sh`).

Остальное в root (hl-research, polymarket, live-commerce backup) — **не** этот продукт.

---

## 4. Известные дубли и политика


| Проблема                                                                                               | Действие                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `**strategy-simulator`** запускался и из **root**, и из **salpha** каждые 5 мин с одним и тем же логом | Оставить `**salpha`**; строку в **root** удалить (автоматически при выкатывании фазы B). |
| Два канала **hourly Telegram** (root vs `.env.hourly`)                                                 | Разные переменные; если нужен один отчёт — отключить лишний cron осознанно.              |
| Два вызова `**paper2-healthcheck`** у root                                                             | Проверить, нужны ли оба (алерт vs без алерта); объединить при желании.                   |


---

## 5. Быстрые команды

```bash
# все бумажные стратегии
sudo -u salpha pm2 restart pt1-smart-lottery pt1-fresh-validated pt1-dip-runners pt1-oscar-clone pt1-dno-clone pt1-organizer-paper --update-env

# ingestion + worker (+ DEX snapshot collectors + wallet-trace queue)
sudo -u salpha pm2 restart sa-moonshot-collector sa-raydium-collector sa-meteora-collector sa-orca-collector sa-jupiter-route-watcher sa-direct-lp-detector sa-pumpswap-collector sa-rpc-collector sa-sigseed-worker sa-wallet-trace-worker --update-env

# постановка кошельков в очередь обогащения атласа (RPC-бэкенд): `npm run wallet:trace:enqueue -- <wallet>`

# первичный запуск DEX snapshot collectors (если ещё не в pm2 dump), с паузами между тиками и без rpc_tasks:
sudo -u salpha bash -lc 'cd /opt/solana-alpha && RAYDIUM_COLLECTOR_INTERVAL_MS=90000 RAYDIUM_ENQUEUE_RPC=0 pm2 start scripts-tmp/raydium-collector.mjs --name sa-raydium-collector --cwd /opt/solana-alpha --interpreter /usr/bin/node --time --merge-logs --max-memory-restart 320M'
sudo -u salpha bash -lc 'cd /opt/solana-alpha && METEORA_COLLECTOR_INTERVAL_MS=105000 METEORA_ENQUEUE_RPC=0 pm2 start scripts-tmp/meteora-collector.mjs --name sa-meteora-collector --cwd /opt/solana-alpha --interpreter /usr/bin/node --time --merge-logs --max-memory-restart 320M'
sudo -u salpha bash -lc 'cd /opt/solana-alpha && ORCA_COLLECTOR_INTERVAL_MS=120000 ORCA_ENQUEUE_RPC=0 pm2 start scripts-tmp/orca-collector.mjs --name sa-orca-collector --cwd /opt/solana-alpha --interpreter /usr/bin/node --time --merge-logs --max-memory-restart 320M'
sudo -u salpha bash -lc 'cd /opt/solana-alpha && JUPITER_WATCHER_INTERVAL_MS=120000 JUPITER_WATCHER_LOOKBACK_HOURS=6 JUPITER_WATCHER_MAX_MINTS=16 JUPITER_WATCHER_REQUEST_DELAY_MS=1600 JUPITER_WATCHER_ENQUEUE_RPC=0 pm2 start scripts-tmp/jupiter-route-watcher.mjs --name sa-jupiter-route-watcher --cwd /opt/solana-alpha --interpreter /usr/bin/node --time --merge-logs --max-memory-restart 280M'
sudo -u salpha pm2 save
```

---

## 6. Откат

- PM2: `pm2 resurrect` из последнего `pm2 save`, либо восстановить дамп из бэкапа `~/.pm2/dump.pm2`.
- Cron: хранить копию `crontab -l` перед правками.

---

## 7. Фаза C — organizer paper как остальные pt1

- Профиль: `**scripts-tmp/profiles/run-pt1-organizer-paper.sh**` — те же `PAPER_TRACK_*`, что у других бумажных стратегий; `PAPER_STRATEGY_KIND=runner_organizer`, журнал `organizer-paper.jsonl`.
- В `**ecosystem.config.cjs**` процесс `pt1-organizer-paper` запускается через этот bash-профиль (не через `npm run paper:live` с inline env).

### Сверка PM2 ↔ git-манифест

Из каталога приложения под пользователем с PM2:

```bash
cd /opt/solana-alpha
node scripts/deploy/pm2-vs-ecosystem.mjs
# или: npm run runtime:diff
```

Код выхода `1`, если есть лишние или отсутствующие имена — после ручных `pm2 delete`/`pm2 start` снова запусти скрипт.

Ожидаемо: **12** процессов с именами из таблицы выше (включая `pt1-organizer-paper`).