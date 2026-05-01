# W6 Audit — port of paper-trader2 stack from `salvage/pre-v2` to `v2`

Status: complete + revised after user feedback. Author: оркестратор-агент. Дата: 2026-05-01.

## TL;DR

В `salvage/pre-v2` лежит **полностью построенная экосистема paper-trader2** — engine, dashboard, advisor, healthcheck, hourly-report, post-mortem, advisor-digest, 5 DEX-коллекторов, jupiter-watcher, direct-lp-detector, coverage-guardian, smart-money discovery, 4+ backtest-инструмента. Архитектура устраивает пользователя. Проблема была в **источнике данных**, который W2-W5 уже починили.

**Стратегия W6:**
- **paper-trader = rewrite** (118 KB монолит → чистый типизированный TS под `src/papertrader/` с теми же алгоритмами и теми же `PAPER_*` env vars).
- **коллекторы и observability = port as-is** (это HTTP-обёртки и вспомогательный tooling, переписывать смысла нет).
- **минимальный фокус: 3 dip-стратегии (DipRunner / Oscar / Dno).** Smart Lottery, Coverage Guardian, RPC enrichment — отложены до W6.7+.

После накопления N сделок — `dip-strategy-lab` калибрует параметры аналитически.

## Inventory: было / есть / дельта

### Таблицы (только то, что нужно для **первого цикла** W6.0–W6.5)

| Таблица | Где использовалась в salvage | В v2 | Действие |
|---|---|---|---|
| `swaps` | `live-paper-trader` | **есть** (W2) | используем 1-в-1 |
| `tokens` | `live-paper-trader` | **есть** | используем 1-в-1 |
| `entity_wallets` | `live-paper-trader` (smart-lottery, FV) | **есть** | НЕ нужно для dip-стратегий |
| `wallet_tags` | `live-paper-trader` (smart-lottery, FV) | **есть** | НЕ нужно для dip-стратегий |
| `money_flows` / `wallet_clusters` / `programs` | разные | **есть** | вне scope W6 |
| `paper_trades` (миграция 0006) | НЕ используется | **есть** | оставляем пустой; paper-trader пишет JSONL |
| `raydium_pair_snapshots` | POST_LANE, dip context | **нет** | **создаём в W6.0** + Raydium-collector в W6.1 |
| `meteora_pair_snapshots` | POST_LANE, dip context | **нет** | **создаём + port коллектора** |
| `orca_pair_snapshots` | DirectLP, post-mortem | **нет** | **создаём + port коллектора** |
| `moonshot_pair_snapshots` | coverage, jupiter | **нет** | **создаём + port коллектора** |
| `jupiter_route_snapshots` | FV routeable, dip pre-entry | **нет** | **создаём + port watcher** (DipRunner проверяет routeable перед entry) |
| `direct_lp_events` | DirectLP detector | **нет** | **создаём + port detector** (опц., но дёшево) |

### Таблицы, отложенные на W6.7+ (НЕ создаём в первом цикле)

| Таблица | Зачем нужна | Почему откладываем |
|---|---|---|
| `pumpswap_pair_snapshots` | UNION в discovery | **выкидываем навсегда** — pump.fun BC данные уже есть в `swaps WHERE dex='pumpfun'` через sa-stream. SQL paper-trader'а адаптируем. |
| `coverage_events` / `coverage_gaps` | мониторинг покрытия | используется только когда есть несколько источников данных для cross-check; для 3 dip-стратегий не нужен |
| `rpc_tasks` / `rpc_features` | on-chain enrichment (holders, authorities) | используется в FV-lane и Smart Lottery; dip-стратегии без него обходятся |
| `wallet_trades_raw` | `dip-strategy-lab` backfill mode | используется в W6.6 (lab); создадим в W6.6 миграцией |
| `rug_wallet_denylist`, `pump_features_10m`, `watchlist_wallets` | разные фичи | низкий приоритет, не блокируют MVP |

**Итого новых миграций в W6.0:** 3 (вместо 6). Таблиц после W6.0: **12 + 6 = 18**.

### Файлы кода (для **первого цикла** W6.0–W6.5)

| Источник (salvage/pre-v2) | Размер | Таргет в v2 | Статус | Этап |
|---|---|---|---|---|
| `scripts-tmp/live-paper-trader.ts` | 118 KB | `src/papertrader/*.ts` (split на ~7 модулей) | **rewrite на чистом TS** | W6.3a/b/c |
| (нет в salvage) | — | `src/papertrader/raydium-collector.mjs` | **написать с нуля** по паттерну meteora | W6.1 |
| `scripts-tmp/meteora-collector.mjs` | 13 KB | `scripts-tmp/meteora-collector.mjs` | **port as-is** | W6.1 |
| `scripts-tmp/orca-collector.mjs` | 14 KB | `scripts-tmp/orca-collector.mjs` | **port as-is** | W6.1 |
| `scripts-tmp/moonshot-collector.mjs` | 13 KB | `scripts-tmp/moonshot-collector.mjs` | **port as-is** | W6.1 |
| `scripts-tmp/jupiter-route-watcher.mjs` | 16 KB | `scripts-tmp/jupiter-route-watcher.mjs` | **port as-is** | W6.1 |
| `scripts-tmp/direct-lp-detector.mjs` | 16 KB | `scripts-tmp/direct-lp-detector.mjs` | **port as-is** | W6.1 |
| `scripts-tmp/dashboard.mjs` | 14 KB | расширить `scripts-tmp/dashboard-server.ts` | **port логики, инкорпорировать в существующий v2-dashboard** | W6.4 |
| `scripts-tmp/dashboard-paper2.html` | 13 KB | `scripts-tmp/dashboard-paper2.html` | копия | W6.4 |
| `scripts-tmp/paper2-advisor.mjs` | 7 KB | `scripts-tmp/paper2-advisor.mjs` | port | W6.4 |
| `scripts-tmp/paper2-healthcheck.mjs` | 3 KB | `scripts-tmp/paper2-healthcheck.mjs` | port | W6.4 |
| `scripts-tmp/post-mortem-paper-v1.mjs` | 5 KB | `scripts-tmp/post-mortem-paper-v1.mjs` | port | W6.4 |
| `scripts-tmp/hourly-telegram-report.mjs` | 12 KB | `scripts-tmp/hourly-telegram-report.mjs` | port | W6.4 |
| `scripts-tmp/advisor-digest.mjs` | 5 KB | `scripts-tmp/advisor-digest.mjs` | port | W6.4 |
| `scripts/lib/telegram.mjs` | ? | **уже есть** в v2 | OK | — |
| `scripts-tmp/profiles/run-pt1-dip-runners.sh` | 3.5 KB | `scripts-tmp/profiles/run-pt1-dip-runners.sh` | копия | W6.5 |
| `scripts-tmp/profiles/run-pt1-oscar-clone.sh` | 2.5 KB | `scripts-tmp/profiles/run-pt1-oscar-clone.sh` | копия | W6.5 |
| `scripts-tmp/profiles/run-pt1-dno-clone.sh` | 2.5 KB | `scripts-tmp/profiles/run-pt1-dno-clone.sh` | копия | W6.5 |

### Файлы, отложенные на W6.6+

- `dip-strategy-lab.mjs` (45 KB) → W6.6
- `coverage-guardian.mjs` (26 KB) → W6.7
- `discover-smart-money.ts` → W6.7 (Smart Lottery)
- `atlas-tag-all.ts`, `atlas-expander.ts`, `atlas-stats.ts` → low priority, могут не понадобиться вообще
- `enhanced-backtest.mjs`, `historical-backtest.mjs`, `founder-backtest.ts`, `pumpcade-backtest.ts`, `detector-validation.ts`, `human-trader-discovery.ts` → исследовательские one-shot, не входят в production loop
- `run-pt1-smart-lottery.sh` → W6.7

### Внешние API (для первого цикла)

| API | Кто использует | Auth |
|---|---|---|
| **DexScreener** | meteora/orca/moonshot/raydium collectors | бесплатно, no auth |
| **GeckoTerminal** | те же | бесплатно, no auth |
| **Jupiter Quote** | jupiter-watcher, paper-trader (SOL/USD) | бесплатно, rate limits |
| **Pump.fun frontend-api-v3** | paper-trader (entry MC) | бесплатно, не публичный |
| **Telegram Bot API** | observability (hourly-report, healthcheck, advisor) | требует `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |

**Не нужно в первом цикле:** Helius (потребуется только в W6.6 для `dip-strategy-lab` backfill, но и там можно обойтись без — использовать `swaps` как источник). Solana RPC дополнительно — нет (всё уже идёт через sa-stream).

## Ключевые контракты данных

### Что новый paper-trader будет читать/писать

**Читает (DB SELECT-only):**
- `swaps` (BTC context, candidate aggregates, whale analysis, pre-entry dynamics, context tail, **pump.fun BC данные напрямую вместо `pumpswap_pair_snapshots`**)
- `tokens` (CTE `fresh`, JOIN для symbol/age, `metadata->>'source'`)
- `raydium_pair_snapshots`, `meteora_pair_snapshots`, `orca_pair_snapshots`, `moonshot_pair_snapshots` (UNION для POST/MIGRATION lanes, dip context, latest price)
- `jupiter_route_snapshots` (routeable check)

**Пишет:** только JSONL (`PAPER_TRADES_PATH`).

**JSONL event types:** `eval`, `eval-skip-open`, `open`, `heartbeat`, `peak`, `dca_add`, `partial_sell`, `close`, `followup_snapshot`. Полная схема в `salvage/pre-v2/scripts-tmp/live-paper-trader.ts` (см. отчёт subagent A в conversation history).

### Что dashboard.mjs знает

- `GET /api/paper2` — вычитывает все `*.jsonl` из `PAPER2_DIR`, агрегирует state по стратегиям.
- В W6.4 это становится новым endpoint в нашем `scripts-tmp/dashboard-server.ts` (рядом с уже существующими `/api/atlas/health`, `/api/parser/health`, `/api/stream/health`).

### Cron (после W6.4)

```cron
5 * * * *      hourly-telegram-report.mjs       # отчёт за час
*/10 * * * *   paper2-healthcheck.mjs            # alert на стейл стратегии
15 */3 * * *   paper2-advisor.mjs                # рекомендации каждые 3ч
```

`discover-smart-money` cron — только в W6.7.

## Roadmap — этапы W6 (revised)

Принцип: каждый этап **независимо запускаемый и тестируемый**.

### W6.0 — Database restoration *(spec для cheap agent: готова)*
**Цель.** 3 миграции. Без pumpswap. Без coverage/rpc/wallet_trades_raw — отложены.

**Состав:**
- Миграция `0012_dex_pair_snapshots.sql` — `raydium_pair_snapshots`, `meteora_pair_snapshots`, `orca_pair_snapshots`, `moonshot_pair_snapshots` (4 таблицы, унифицированная схема).
- Миграция `0013_jupiter_routes.sql` — `jupiter_route_snapshots`.
- Миграция `0014_direct_lp_events.sql` — `direct_lp_events`.
- Drizzle schema entries.
- DoD: 18 таблиц на VPS.

**Spec:** [`specs/W6.0_database_restoration.md`](./specs/W6.0_database_restoration.md)

### W6.1 — DEX collectors port + Raydium новый
**Цель.** Поднять 6 коллекторов как PM2-процессы; данные потекут в `*_pair_snapshots`.

**Состав:**
- Написать с нуля **`scripts-tmp/raydium-collector.mjs`** (по паттерну `meteora-collector.mjs` с фильтром `dexId='raydium'`).
- Port `meteora-collector.mjs`, `orca-collector.mjs`, `moonshot-collector.mjs`, `jupiter-route-watcher.mjs`, `direct-lp-detector.mjs`.
- `scripts-tmp/profiles/`: shell-скрипты для каждого PM2-app.
- Расширить `ecosystem.config.cjs` на 6 новых apps: `sa-raydium`, `sa-meteora`, `sa-orca`, `sa-moonshot`, `sa-jupiter`, `sa-direct-lp`.
- `.env.example` — добавить переменные коллекторов.
- В `dashboard-server.ts` — добавить `/api/<dex>/health` для каждого (m5 count + last_ts).

**Spec:** будет `specs/W6.1_dex_collectors_port.md` (после успешного W6.0).

### W6.3a — Paper-trader skeleton
**Цель.** Каркас под `src/papertrader/`, без trading-логики. Главный loop — пустой.

**Состав:**
- `src/papertrader/config.ts` — все `PAPER_*` env vars в zod (полный список из salvage; см. `live-paper-trader.ts:46-258`).
- `src/papertrader/pricing.ts` — SOL/USD из Jupiter, BTC context из `swaps`, pump.fun MC из frontend-api-v3, latest snapshot price из `*_pair_snapshots`.
- `src/papertrader/store-jsonl.ts` — append + fsync для `open/close` событий, как в legacy.
- `src/papertrader/types.ts` — `OpenTrade`, `ClosedTrade`, `PositionLeg`, `PartialSell` интерфейсы.
- `src/papertrader/main.ts` — пустой `setInterval` loop с heartbeat. Запускается под `npm run papertrader`.
- `package.json` script `papertrader`.
- DoD: PM2 app `pt1-skeleton-test` запускается, пишет heartbeat в JSONL, логирует «no candidates».

**Spec:** будет `specs/W6.3a_paper_trader_skeleton.md`.

### W6.3b — Discovery + filters + dip-detector + whale-analysis
**Цель.** Все читающие части paper-трейдера. После W6.3b он способен сказать «вот candidate, прошёл фильтры», но НЕ открывает позицию.

**Состав:**
- `src/papertrader/discovery/snapshot.ts` — UNION SQL для POST/MIGRATION lanes по 4 DEX snapshots; БЕЗ pumpswap; SQL переписан с raw на drizzle где разумно.
- `src/papertrader/discovery/launchpad.ts` — **stub `NotImplementedError`** (под Smart Lottery в W6.7).
- `src/papertrader/discovery/fresh-validated.ts` — **stub** (под FV-lane в W6.7).
- `src/papertrader/filters/snapshot-filter.ts`, `filters/global-gate.ts` — фильтры из `evaluateSnapshot`, `globalGate`.
- `src/papertrader/dip-detector.ts` — `evaluateDip` 1-в-1 с алгоритмом из salvage.
- `src/papertrader/whale-analysis.ts` — capitulation, group dumps, creator dumps, DCA classification.
- `src/papertrader/discovery/dip-clones.ts` — entry-логика DipRunner/Oscar/Dno.
- DoD: запускаем с любым из 3 профилей, в JSONL появляются `eval` события с `pass=true/false` и осмысленными `reasons`.

**Spec:** будет `specs/W6.3b_paper_trader_discovery.md`.

### W6.3c — Executor + main loop
**Цель.** Полнофункциональный paper-trader. От `eval pass` до `close`.

**Состав:**
- `src/papertrader/executor/open.ts` — `makeOpenTradeFromEntry`, fetchPreEntryDynamics, fetchContextSwaps.
- `src/papertrader/executor/dca.ts` — DCA усреднение по `PAPER_DCA_LEVELS`.
- `src/papertrader/executor/tp-ladder.ts` — частичные продажи по `PAPER_TP_LADDER`.
- `src/papertrader/executor/trailing.ts` — арминг trailing после `PAPER_TRAIL_TRIGGER_X`.
- `src/papertrader/executor/exit.ts` — финальный exit (KILLSTOP / TP / SL / TRAIL / TIMEOUT).
- `src/papertrader/executor/followup.ts` — followup snapshots.
- `src/papertrader/main.ts` — полный event loop (discoveryTick / trackerTick / followupTick / statsTick) с graceful shutdown.
- DoD: запускаем под `pt1_dip_runners` env, наблюдаем `open` → `partial_sell` → `close` события на реальных монетах в paper.

**Spec:** будет `specs/W6.3c_paper_trader_executor.md`.

### W6.4 — Observability port
**Цель.** Дашборд `/papertrader2`, hourly TG-отчёт, healthcheck-алерты, advisor.

**Состав:**
- Расширить `scripts-tmp/dashboard-server.ts` (уже есть в v2): `GET /papertrader2`, `GET /api/paper2`.
- Скопировать `dashboard-paper2.html`.
- Port `paper2-advisor.mjs`, `paper2-healthcheck.mjs`, `hourly-telegram-report.mjs`, `post-mortem-paper-v1.mjs`, `advisor-digest.mjs` — все 5 mjs as-is, минимальные правки путей.
- Cron на VPS (через `crontab -e` под salpha).
- Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` в `/opt/solana-alpha/.env` (новые ключи).

**Spec:** будет `specs/W6.4_observability_port.md`.

### W6.5 — Запуск 3 dip-стратегий в paper
**Цель.** Реально запустить.

**Состав:**
- 3 PM2 apps: `pt1-dip-runners`, `pt1-oscar-clone`, `pt1-dno-clone` (по одному `live-paper-trader` бинарнику с разными `PAPER_*` env).
- `scripts-tmp/profiles/run-pt1-*.sh` копии из salvage.
- Smoke-проверка через 30 минут: открылась ли хоть одна позиция, идут ли `eval` события, hourly-report дошёл ли в TG.

**Spec:** будет `specs/W6.5_strategy_launch.md` (короткая, в основном PM2 + smoke).

### W6.6 — Strategy lab
**Цель.** После 7+ дней работы — калибровать TP/SL/trailing/timeout аналитически.

**Состав:**
- Миграция `wallet_trades_raw` (если решим использовать backfill mode) или адаптация lab под `swaps`.
- Port `dip-strategy-lab.mjs`.
- Запуск `node scripts-tmp/dip-strategy-lab.mjs all`.
- Анализ результатов; новые env-параметры для каждой стратегии.

**Spec:** позже, после получения первых данных.

### W6.7+ — Smart Lottery, Coverage, smart-money
**Цель.** Подключение оставшихся стратегий.

**Состав:**
- Миграции `coverage`, `rpc_queue`.
- Port `coverage-guardian.mjs`, `discover-smart-money.ts`.
- Smart Lottery PM2-app.

## Зависимости между этапами

```
W6.0 (DB) ──→ W6.1 (collectors)
                    │
                    └──→ W6.3a (skeleton) ──→ W6.3b (discovery) ──→ W6.3c (executor)
                                                                            │
                                                                            └──→ W6.4 (observability)
                                                                                          │
                                                                                          └──→ W6.5 (launch)
                                                                                                    │
                                                                                                    └──[7d wait]──→ W6.6 (lab)
                                                                                                                          │
                                                                                                                          └──→ W6.7 (Smart Lottery, etc)
```

## Execution realism (paper-trader должен быть честным)

**Зачем.** Если `paper_pnl > 0`, но при переходе на live будет `live_pnl < 0` из-за fee/slippage/failed-TX — это гораздо хуже, чем если paper будет немного pessimistic. Цель: чтобы P&L в paper был **upper bound** для реального live, а не fantasy.

### Что было в legacy (`live-paper-trader.ts:226-238`)

Примитивная flat-модель: `PAPER_FEE_BPS_PER_SIDE=100` (1%) + `PAPER_SLIPPAGE_BPS_PER_SIDE=200` (2%) = 3% per side для **любого** DEX. Для зрелого Raydium 3% — слишком pessimistic, для pump.fun BC при тонкой ликвидности — **слишком optimistic**.

### Что должно быть в W6.3 (модуль `src/papertrader/costs.ts`)

#### 1. Per-DEX комиссии (env-конфигурируемые, defaults — реалистичные медианы):

| DEX | Default fee per side | Обоснование |
|---|---|---|
| `pumpfun` (bonding curve) | **1.00%** (`PAPER_FEE_BPS_PUMPFUN=100`) | Точный protocol fee |
| `pumpswap` (после migration) | **0.30%** (`=30`) | 0.25% creator + 0.05% protocol |
| `raydium` | **0.25%** (`=25`) | Стандартный AMM fee |
| `orca` (whirlpool) | **0.10%** (`=10`) | Median для CL pools (диапазон 0.04-0.30%) |
| `meteora` (DLMM) | **0.20%** (`=20`) | Median (диапазон 0.01-1%) |
| `moonshot` | **1.00%** (`=100`) | Аналог pump.fun |

#### 2. Slippage — двухкомпонентная модель:

```
total_slip_bps = base_slip_bps[dex] + dynamic_slip_bps
dynamic_slip_bps = (trade_usd / liquidity_usd) * SLIP_LIQUIDITY_COEF * 10000
```

**Defaults базового slip:**

| DEX | `PAPER_SLIP_BASE_BPS_*` | Обоснование |
|---|---|---|
| `pumpfun` | **200** (2%) | Тонкая ликвидность, MEV боты, частый fail |
| `pumpswap` | **50** (0.5%) | После migration ликвидность лучше |
| `raydium` | **50** | Зрелый AMM, медленно |
| `orca` | **50** | CL pool — концентрированная ликвидность |
| `meteora` | **50** | DLMM — переменная ликвидность |
| `moonshot` | **150** (1.5%) | Между pump.fun и AMM |

`PAPER_SLIP_LIQUIDITY_COEF=1.0` (default) — означает что сделка размером 1% ликвидности добавит +100 bps slip. Это agressive-pessimistic, что хорошо для paper.

**Пример расчёта.** Покупка pump.fun токена на $50 в пуле с ликвидностью $25k:
- base = 200 bps (2%)
- dynamic = (50 / 25000) * 1.0 * 10000 = 20 bps (0.2%)
- total = 220 bps = **2.2%**

Та же сделка на raydium с ликвидностью $500k:
- base = 50 bps (0.5%)
- dynamic = (50 / 500000) * 1.0 * 10000 = 1 bps
- total = 51 bps ≈ **0.5%**

#### 3. Network fee (фиксированный, конфигурируемый):

```
PAPER_NETWORK_FEE_USD=0.05  # base TX fee + priority fee + Jito tip (realistic median)
```

Списывается **за каждую отправку** (включая failed). Для одной round-trip сделки = $0.10 минимум, что для $50-trade означает -0.2% от gross.

#### 4. Failed-TX rate (опционально, default = выкл, но env есть):

```
PAPER_FILL_RATE_PCT=100  # default: все сделки успешны; для conservative-режима ставить 90
```

Если < 100: симулируется отказ части buy'ов с потерей `PAPER_NETWORK_FEE_USD` без открытия позиции. **Дефолт 100** — чтобы не вносить шум до того, как сравним с реальной live-статистикой; включать ручкой когда наберём данные.

#### 5. Effective price formulas:

```
total_cost_pct = (fee_bps + total_slip_bps) / 10000
effective_buy_price  = market_price * (1 + total_cost_pct)
effective_sell_price = market_price * (1 - total_cost_pct)
```

(Та же формула что в legacy, но `total_cost_pct` теперь **per-DEX и size-aware**.)

#### 6. JSONL события — полный cost breakdown:

Каждый `close` event ДОЛЖЕН содержать:

```json
{
  "kind": "close",
  ...
  "costs": {
    "dex": "pumpfun",
    "fee_bps_per_side": 100,
    "slip_base_bps_per_side": 200,
    "slip_dynamic_bps_entry": 20,
    "slip_dynamic_bps_exit": 18,
    "network_fee_usd_total": 0.10,
    "gross_pnl_usd": 12.34,
    "fee_cost_usd": 1.00,
    "slippage_cost_usd": 1.20,
    "network_cost_usd": 0.10,
    "net_pnl_usd": 10.04
  },
  "effective_entry_price": ...,
  "effective_exit_price": ...,
  "theoretical_entry_price": ...,
  "theoretical_exit_price": ...
}
```

Это **критично** для будущего `dip-strategy-lab` (W6.6): он сможет перепрогнать сделки с другими параметрами костов и оценить sensitivity P&L к модели исполнения.

### Что НЕ моделируем в W6.3 (отложено)

- **MEV / sandwich attacks** — добавим в W6.7+ если будут реальные данные о потерях.
- **Реальный mempool snapshot** для exact slippage — нужен платный stream, после первой прибыли.
- **Time-to-confirm** (latency между decision и fill) — пока считаем мгновенным; в live это +1-3 секунды задержки.
- **Pump.fun BC analytical curve** — точная формула slip для bonding curve. Сейчас используем общую liquidity-based модель (overestimates для крупных коинов на BC, что pessimistic-safe).

### Дополнительно к spec W6.3a

Cheap-агенту явно укажу:
- модуль `src/papertrader/costs.ts` с типизированными `feeBpsForDex(dex)`, `slipBaseBpsForDex(dex)`, `dynamicSlipBps(tradeUsd, liquidityUsd)`, `applyEntryCosts(...)`, `applyExitCosts(...)`, `costsBreakdown(...)`;
- env-параметры в `src/papertrader/config.ts` (zod, с дефолтами выше);
- интеграция в `executor/open.ts`, `executor/exit.ts`, `executor/dca.ts`, `executor/tp-ladder.ts` — каждое движение цены идёт через `effective*` формулы;
- JSONL events содержат полный cost breakdown.

## Открытые вопросы

1. ~~`pumpswap_pair_snapshots` источник~~ — **закрыт.** Заменяем на `swaps WHERE dex='pumpfun'` в W6.3b SQL.
2. **`tagAtlas`/`traceWallet`/`tagWallet`** — нужны только для W6.7 (Smart Lottery). Не блокирует первый цикл. Будем разбираться когда дойдём.
3. **Confidence для smart-money тега** — отложено до W6.7.
4. **Pump.fun frontend-api-v3 stability** — критическая зависимость для entry MC. В W6.3a `pricing.ts` обязательно сделать fallback на DexScreener (оба endpoint'а возвращают market_cap_usd, схема похожа).
5. **JSONL ротация** — без неё store растёт бесконечно. Решение в W6.4: добавить cron `logrotate` через `crontab -e`.

## Что НЕ входит в W6 (продуктовые границы)

- НЕ модификация `wallet_clusters` структуры.
- НЕ модификация `swaps` / `stream_events` / `parser_cursor` / `atlas_cursor`.
- НЕ работа с `docs/platform/**` или платформенным VERSION.
- НЕ настоящие swap'ы (full-auto будет позже, после ≥1 месяца paper).
- НЕ изменение sa-stream / sa-parser / sa-atlas — они работают как есть.
- НЕ Smart Lottery / Coverage / smart-money discovery в первом цикле.

## Риски

| Риск | Вероятность | Митигация |
|---|---|---|
| Pump.fun frontend-api-v3 ломается / меняет схему | низкая | fallback на DexScreener в `pricing.ts` (W6.3a). |
| Конкуренция за pump.fun ниша выросла за месяцы | высокая | для этого paper-mode 1-2 месяца + dip-strategy-lab. |
| Слишком много новых PM2 процессов на VPS (после W6.5: 4+6+3=13) | средняя | мониторить RAM/CPU; при необходимости — объединить collectors в один loop. |
| JSONL stores растут без ротации | средняя | logrotate cron в W6.4. |
| Dashboard роуты конфликтуют (старые `/api/state` vs новые `/api/paper2`) | низкая | W6.4 spec явно фиксирует namespace. |

## Артефакт-набор после W6.5 (полный production paper-trader)

- 12+6=**18 миграций**; 12+6=**18 таблиц**.
- 4+6+3=**13 PM2 процессов**: `dashboard-organizer-paper`, `sa-stream`, `sa-parser`, `sa-atlas`, `sa-raydium`, `sa-meteora`, `sa-orca`, `sa-moonshot`, `sa-jupiter`, `sa-direct-lp`, `pt1-dip-runners`, `pt1-oscar-clone`, `pt1-dno-clone`.
- HTTP endpoints на дашборде: `/api/atlas/health`, `/api/parser/health`, `/api/stream/health`, **+ `/api/<dex>/health`** для каждого DEX-коллектора, **+ `/api/paper2`**, **+ `/papertrader2`** UI.
- Cron: `hourly-report` (5 * * * *), `healthcheck` (*/10), `advisor` (15 */3).
- 3 paper-trading стратегии в активном бэктесте (paper-only) с автоматическими TG-отчётами.

## Следующий шаг

Spec для W6.0 готова: [`specs/W6.0_database_restoration.md`](./specs/W6.0_database_restoration.md). После выполнения — пишу `W6.1_dex_collectors_port.md`.
