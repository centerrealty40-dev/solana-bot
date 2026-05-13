# Oscar stack — спецификация V2 (режимы A/B по триггерам после сплит-входа)

**Версия документа:** 2.1  
**Статус:** норматив **целевого** поведения **выходов** live Oscar (`live-oscar`) после полного двухногого входа. Разделы про гейты входа и инфраструктуру ниже по-прежнему выровнены под снимок [`ecosystem.config.cjs`](../../../ecosystem.config.cjs) (если не оговорено иное).

**Двойной SSOT:**

- **Выходы и активация режимов A/B** — по **§1–§7** этого файла (версия 2.1).
- **Остальное (discovery, ликвидность, impulse, holders, verify, liq-watch, пути JSONL, scale-in delay/corridor как механика входа)** — блок `live-oscar` в `ecosystem.config.cjs` и оговорка про `.env` на VPS.

**Связь с V1:** [`IDEALIZED_OSCAR_STACK_SPEC.md`](./IDEALIZED_OSCAR_STACK_SPEC.md) — общий свод Paper ∥ Live и история.

**Реализация в коде:** текущий трекер (`tracker.ts`) и конфиг **могут не совпадать** с §2–§7 до отдельной задачи имплементации; см. **§8**.

---

## 1. Вход: две покупки обязательны (must have)

| Требование | Норматив |
|------------|----------|
| Число ног на полную позицию | Ровно **две**: первая нога + вторая нога **scale-in** (сплит ликвидности; это **не** «режим B по факту докупа»). |
| Интервал | Вторая нога не раньше **`LIVE_ENTRY_SCALE_IN_DELAY_MS`** после условий коридора; в прод-снимке задержка **5 с** — сохраняется. |
| Коридор второй ноги | Как в ecosystem: **`LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT` / `DOWN`** (в снимке **+5% / −7%** к якорю первой ноги). |
| Нотионал | Как в ecosystem (в снимке **`PAPER_POSITION_USD` = 120**, доля первой ноги **`PAPER_ENTRY_FIRST_LEG_FRACTION` = 0.75**). |

Пока вторая нога **не** исполнена, логика режимов **§3–§7** **не** стартует (нет «полной» позиции в смысле спеки).

---

## 2. База для процентов

Все пороги **+5%**, **−4%**, **kill −8%** считаются как **доля PnL к эффективной средней цене входа `avgEntry`** после того, как учтены **обе** ноги сплита (и после усреднения в режиме B — к обновлённой средней):

- \(x_{\mathrm{avg}} = P / \texttt{avgEntry}\).
- «Коснулась +5%» означает: \(x_{\mathrm{avg}} - 1 \ge 0.05\) (с допуском сравнения как в коде, например `LADDER_PNL_EPS`).
- «Коснулась −4%» означает: \(x_{\mathrm{avg}} - 1 \le -0.04\).

Цена для проверки — та же метрика, что сейчас использует трекер для TP/kill (эффективная рыночная оценка / Jupiter при live).

---

## 3. Состояние до активации режима («нейтральная фаза»)

После **успешного** завершения **обеих** ног входа и до наступления **ровно одного** из триггеров §4 или §5:

- **Режим A ещё не активен** → **не** исполняются частичные фиксации по **TP-сетке режима A** (в том числе первая ступень +5% / 15%).
- **Режим B ещё не активен** → **не** исполняется докуп по условию §5 и **не** применяется kill режима B.

Разрешены только поведения, не зависящие от профиля A/B: например **LIQ_DRAIN**, глобальные проверки, **NO_DATA**, отложенная вторая нога, а также любые **отдельно оговорённые** аварийные выходы, если они есть в коде вне A/B.

**Тайм-аут позиции:** сохранить семантику трекера: после активации режима A или B правила подавления тайм-аутa — как сейчас для partial TP / DCA (см. `timeoutSuppressedByProgress`); до активации режима — действует базовый **`PAPER_TIMEOUT_HOURS`**.

---

## 4. Режим A — условие включения и поведение

### 4.1 Триггер включения

**Режим A включается только если** после полного двухногого входа цена **выросла** и **впервые достигла первого тейк-профита +5%** к средней (`avgEntry` после обеих ног).

До этого момента профиль **A не считается активным** (см. §3).

### 4.2 После включения

- **Первая** срабатывающая фиксация по профилю A: продать **15%** **от текущего остатка** позиции (та же семантика `sellFraction`, что для TP-grid: доля **остатка**).
- Далее — **неограниченное** число ступеней вверх: шаг **+5%** к средней за ступень, доля с каждой ступени **15%** остатка, логика **retrace / ladder_retrace** — **как у текущего режима A** в прод-снимке (`PAPER_TP_GRID_STEP_PNL`, `PAPER_TP_GRID_SELL_FRACTION`, `PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL`, `PAPER_TRAIL_MODE`, `PAPER_TRAIL_DROP`, `PAPER_TRAIL_TRIGGER_X`, `PAPER_TIMEOUT_HOURS` для ветки A).
- **Трейл** в режиме A — **без изменений** относительно текущего прод-профиля A (те же параметры, что в ecosystem для базовой ветки до переключения в B).

### 4.3 Липкость

После включения режима **A** позиция **не** переходит в **B** до закрытия (ниже §6).

---

## 5. Режим B — условие включения и поведение

### 5.1 Триггер включения

**Режим B включается только если** после полного двухногого входа цена **упала** и **впервые достигла −4%** к средней (`avgEntry` после обеих ног).

### 5.2 Действие в момент включения (усреднение)

В тот же момент (логически — при первом выполнении условия, с исполнением свопа в live):

- Выполнить **одну** докупку на **20%** от **полного нотионала позиции** (`PAPER_POSITION_USD`), т.е. размер докупа **0.20 × PAPER_POSITION_USD** USD (в пределах допусков Jupiter и лимитов кошелька).
- После исполнения пересчитать **`avgEntry` / `avgEntryMarket` / `totalInvestedUsd`** и зафиксировать режим **`liveExitProfileMode = 'B'`** в журнале (аналогично текущему `dca_add`, но по **новому** триггеру −4%, не по списку `PAPER_DCA_LEVELS`).

### 5.3 Kill-stop режима B

После активации B **kill-stop** для позиции: **−8%** к обновлённой средней (\(x_{\mathrm{avg}} - 1 \le -0.08\)).  
В конфигурации это соответствует **`PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP = '-0.08'`** (или эквивалент при имплементации).

### 5.4 TP-сетка и трейл режима B

- Шаг ступени, доля продажи за ступень, retrace min, параметры трейла и тайм-аут **ветки B** — **те же числа**, что в текущем прод-снимке для `PAPER_LIVE_EXIT_MODE_B_*` (**шаг 5%**, **50%** остатка, **2%** retrace min, trail **12%** / arm **1.06×**, timeout **4 ч** — как задано сейчас).
- **Ограничение числа ступеней TP снимается:** норматив — **бесконечная** лестница по тем же правилам шага/доли (в коде: не задавать верхнюю крышку или задать явное «без лимита» вместо `PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS = 4`).

### 5.5 Липкость

После включения режима **B** позиция **не** переходит в **A** до закрытия.

---

## 6. Взаимоисключение и приоритет

- Режимы **A** и **B** **взаимно исключают** друг друга на всём жизненном цикле позиции.
- **Первым сработавшим** условием после полного входа определяется активный режим:
  - если **раньше** выполнен триггер **+5%** → активируется **A** (ветка «вверх»);
  - если **раньше** выполнен триггер **−4%** → активируется **B** с докупом 20%.
- Нет переключений **A↔B** после выбора.

**Гонка в один тик:** если в одном проходе трекера теоретически возможны оба условия, приоритет задаётся имплементацией явно (рекомендация: фиксировать порядок оценки в коде и журналировать; по умолчанию согласовать с владельцем продукта — например, **более консервативный** сценарий первым).

---

## 7. Сводная таблица параметров (версия 2.1)

| Параметр | Режим A | Режим B |
|----------|---------|---------|
| Активация | Первая касание **+5%** к avg после 2 ног | Первая касание **−4%** к avg после 2 ног |
| Первое действие | Partial TP **15%** остатка на этой ступени | Докуп **20%** от `PAPER_POSITION_USD` |
| Далее TP | Шаг **+5%**, **15%** остатка, **без** лимита ступеней | Шаг **+5%**, **50%** остатка, **без** лимита ступеней |
| Retrace min (1-я ступень и т.д.) | Как сейчас A (**2.5%** в снимке) | Как сейчас B (**2%** в снимке) |
| Kill | Как сейчас A (**−5%** в снимке `PAPER_DCA_KILLSTOP`) | **−8%** |
| Trail / timeout | Как сейчас A (10% / 1.10× / **8 ч**) | Как сейчас B (12% / 1.06× / **4 ч**) |

---

## 8. Расхождение с текущей реализацией (к моменту версии 2.1 документа)

До выноса отдельных задач в код:

| Тема | Сейчас (упрощённо) | Нужно по §2–§7 |
|------|---------------------|----------------|
| Старт режима A | `liveExitProfileMode = 'A'` с открытия / scale-in | **A** только после первого **+5%** |
| Частичные TP до триггера | TP-grid может работать с первого тика при росте | **Запрет** TP A до триггера |
| Режим B | Только после `PAPER_DCA_LEVELS` (`dca_add`) | После **−4%** + докуп **20%** нотионала |
| Kill B | −7% в снимке | **−8%** |
| Max ступеней B | `PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS = 4` | **Снять лимит** |
| Докуп B | Зависит от `PAPER_DCA_LEVELS` (в проде пусто) | Один шаг **20%** от полного нотионала по триггеру −4% |

---

## 9. Процесс и идентификаторы (без изменений относительно прод-снимка)

| Поле | Значение (прод) |
|------|-----------------|
| PM2 app | `live-oscar` |
| `NODE_ENV` | `production` |
| Команда | `npm run --silent live-oscar` |
| `PAPER_STRATEGY_KIND` | `dip` |
| `PAPER_STRATEGY_ID` | `live-oscar` |
| `LIVE_STRATEGY_ENABLED` | `1` |
| `LIVE_EXECUTION_MODE` | `live` |
| `LIVE_STRATEGY_PROFILE` | `oscar` |
| `LIVE_STRATEGY_ID` | `live-oscar` |
| Живой журнал сделок | `LIVE_TRADES_PATH` → `data/live/pt1-oscar-live.jsonl` |
| Paper-журнал (заглушка) | `PAPER_TRADES_PATH` → `data/paper2/_live_oscar_unused_journal.jsonl` |

---

## 10. Тайминги циклов

| Env | Значение |
|-----|----------|
| `PAPER_HEARTBEAT_INTERVAL_MS` | `30000` |
| `PAPER_DISCOVERY_INTERVAL_MS` | `10000` |
| `PAPER_TRACK_INTERVAL_MS` | `30000` |
| `PAPER_FOLLOWUP_TICK_MS` | `60000` |
| `PAPER_DRY_RUN` | `false` |
| `LIVE_HEARTBEAT_INTERVAL_MS` | `60000` |

---

## 11. Лейны и возраст пула

| Env | Значение |
|-----|----------|
| `PAPER_ENABLE_LAUNCHPAD_LANE` | `false` |
| `PAPER_ENABLE_MIGRATION_LANE` | `false` |
| `PAPER_ENABLE_POST_LANE` | `true` |
| `PAPER_POST_MIN_AGE_MIN` | `2880` (48 ч) |
| `PAPER_POST_MAX_AGE_MIN` | `0` |

---

## 12. Ликвидность, объём 5m, держатели, guard

| Env | Значение |
|-----|----------|
| `PAPER_POST_MIN_LIQ_USD` | `200000` |
| `PAPER_POST_MIN_VOL_5M_USD` | `20000` |
| `PAPER_POST_MIN_BUYS_5M` | `4` |
| `PAPER_POST_MIN_SELLS_5M` | `3` |
| `PAPER_POST_MIN_BS` | `0.98` |
| `PAPER_VOL_5M_1H_GUARD_ENABLED` | `1` |
| `PAPER_VOL_1H_MIN_USD` | `36000` |
| `PAPER_VOL_5M_SPIKE_MAX_MULT` | `7` |
| `PAPER_MIN_HOLDER_COUNT` | `3000` |

---

## 13. Дип, cooldown, recovery veto

| Env | Значение |
|-----|----------|
| `PAPER_DIP_LOOKBACK_MIN` | `120` |
| `PAPER_DIP_LOOKBACK_WINDOWS_MIN` | `120,360,720` |
| `PAPER_DIP_MIN_DROP_PCT` | `-15` |
| `PAPER_DIP_MAX_DROP_PCT` | `-50` |
| `PAPER_DIP_MIN_IMPULSE_PCT` | `12` |
| `PAPER_DIP_MIN_AGE_MIN` | `0` |
| `PAPER_DIP_COOLDOWN_MIN` | `30` |
| `PAPER_DIP_COOLDOWN_MIN_SCALP` | `20` |
| `PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED` | `true` |
| `PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES` | `30` |
| `PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS` | `0` |
| `PAPER_DIP_RECOVERY_VETO_ENABLED` | `1` |
| `PAPER_DIP_RECOVERY_VETO_WINDOWS_MIN` | `30,60` |
| `PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT` | `12` |

---

## 14. Импульс / W7.6

| Env | Значение |
|-----|----------|
| `PAPER_IMPULSE_CONFIRM_ENABLED` | `1` |
| `PAPER_IMPULSE_DIP_POLICY` | `parallel_and` |
| `PAPER_IMPULSE_PG_MIN_DROP_PCT` | `12` |
| `PAPER_IMPULSE_RPC_MAX_PER_MIN` | `30` |
| `QN_FEATURE_BUDGET_IMPULSE_CONFIRM` | `5000000` |
| `IMPULSE_QN_ROLLING_MAX_CREDITS` | `1000000` |

---

## 15. TP-regime на входе

| Env | Значение |
|-----|----------|
| `PAPER_TP_REGIME_ENABLED` | `0` |

---

## 16. Размер позиции и сплит (вход)

| Env | Значение |
|-----|----------|
| `PAPER_POSITION_USD` | `120` |
| `PAPER_ENTRY_FIRST_LEG_FRACTION` | `0.75` |
| `LIVE_MAX_POSITION_USD` | `120` |

**Примечание:** усреднение режима B по §5 — **0.20 × PAPER_POSITION_USD** USD, независимо от прежнего пустого `PAPER_DCA_LEVELS` в снимке; после имплементации список `PAPER_DCA_LEVELS` может быть заменён или дополнен новой семантикой (отдельное решение).

---

## 17. Двухногий вход (scale-in)

| Env | Значение |
|-----|----------|
| `LIVE_ENTRY_SCALE_IN_ENABLED` | `1` |
| `LIVE_ENTRY_SCALE_IN_DELAY_MS` | `5000` |
| `LIVE_ENTRY_SCALE_IN_CORRIDOR_UP_PCT` | `5` |
| `LIVE_ENTRY_SCALE_IN_CORRIDOR_DOWN_PCT` | `7` |
| `LIVE_ENTRY_SCALE_IN_MAX_SWAP_ATTEMPTS` | `5` |
| `LIVE_ENTRY_SCALE_IN_RETRY_BACKOFF_MS` | `2000` |

---

## 18. Базовые env режимов A/B в снимке (подлежат сверке с §7 после имплементации)

До имплементации §2–§7 значения ниже — **старый** прод-снимок; целевые отличия перечислены в **§8**.

| Env | Значение (снимок) |
|-----|-------------------|
| `PAPER_LIVE_EXIT_MODE_AB` | `1` |
| `PAPER_LIVE_EXIT_MODE_B_TRAIL_DROP` | `0.12` |
| `PAPER_LIVE_EXIT_MODE_B_TRAIL_TRIGGER_X` | `1.06` |
| `PAPER_LIVE_EXIT_MODE_B_TIMEOUT_HOURS` | `4` |
| `PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP` | `-0.07` → **целевое −0.08 (§5.3)** |
| `PAPER_LIVE_EXIT_MODE_B_TP_GRID_STEP_PNL` | `0.05` |
| `PAPER_LIVE_EXIT_MODE_B_TP_GRID_SELL_FRACTION` | `0.50` |
| `PAPER_LIVE_EXIT_MODE_B_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL` | `0.02` |
| `PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS` | `4` → **целевое: без лимита (§5.4)** |
| `PAPER_DCA_LEVELS` | *(пусто)* → **целевое: триггер −4% + докуп 20% в коде (§5)** |
| `PAPER_DCA_KILLSTOP` | `-0.05` |
| `PAPER_TP_LADDER` | *(пусто)* |
| `PAPER_TP_GRID_STEP_PNL` | `0.05` |
| `PAPER_TP_GRID_SELL_FRACTION` | `0.15` |
| `PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL` | `0.025` |
| `PAPER_TP_X` | `100` |
| `PAPER_SL_X` | `0` |
| `PAPER_TRAIL_MODE` | `ladder_retrace` |
| `PAPER_TRAIL_DROP` | `0.10` |
| `PAPER_TRAIL_TRIGGER_X` | `1.10` |
| `PAPER_TIMEOUT_HOURS` | `8` |
| `PAPER_PEAK_LOG_STEP_PCT` | `1` |

---

## 19. Киты, создатель, dip-DCA предикторы

| Env | Значение |
|-----|----------|
| `PAPER_DIP_WHALE_ANALYSIS_ENABLED` | `1` |
| `PAPER_DIP_REQUIRE_WHALE_TRIGGER` | `0` |
| `PAPER_DIP_LARGE_SELL_USD` | `3000` |
| `PAPER_DIP_RECENT_LOOKBACK_MIN` | `10` |
| `PAPER_DIP_CAPITULATION_PCT` | `0.7` |
| `PAPER_DIP_WHALE_SILENCE_MIN` | `10` |
| `PAPER_DIP_GROUP_SELL_USD` | `5000` |
| `PAPER_DIP_GROUP_MIN_SELLERS` | `2` |
| `PAPER_DIP_GROUP_DUMP_PCT` | `0.4` |
| `PAPER_DIP_BLOCK_CREATOR_DUMP` | `1` |
| `PAPER_DIP_CREATOR_DUMP_LOOKBACK_MIN` | `20` |
| `PAPER_DIP_CREATOR_DUMP_MIN_PCT` | `0.05` |
| `PAPER_DIP_CREATOR_DUMP_MAX_PCT` | `0.6` |
| `PAPER_DIP_DCA_PRED_MIN_SELLS_24H` | `4` |
| `PAPER_DIP_DCA_PRED_MIN_INTERVAL_MIN` | `30` |
| `PAPER_DIP_DCA_PRED_MIN_CHUNK_USD` | `3000` |
| `PAPER_DIP_DCA_AGGR_MIN_SELLS_24H` | `6` |
| `PAPER_DIP_DCA_AGGR_MAX_INTERVAL_MIN` | `15` |

---

## 20. Holders, price verify, sim-audit

| Env | Значение |
|-----|----------|
| `PAPER_HOLDERS_LIVE_ENABLED` | `1` |
| `PAPER_HOLDERS_USE_QN_ADDON` | `0` |
| `PAPER_HOLDERS_TTL_MS` | `90000` |
| `PAPER_HOLDERS_NEG_TTL_MS` | `15000` |
| `PAPER_HOLDERS_MAX_PER_TICK` | `10` |
| `PAPER_HOLDERS_TIMEOUT_MS` | `4000` |
| `PAPER_HOLDERS_INCLUDE_TOKEN2022` | `1` |
| `PAPER_HOLDERS_ON_FAIL` | `db_fallback` |
| `PAPER_HOLDERS_DB_WRITEBACK` | `1` |
| `PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX` | `12` |
| `PAPER_HOLDERS_GPA_CREDITS_PER_CALL` | `100` |
| `QN_FEATURE_BUDGET_HOLDERS` | `10000000` |
| `PAPER_PRICE_VERIFY_ENABLED` | `1` |
| `PAPER_PRICE_VERIFY_BLOCK_ON_FAIL` | `1` |
| `PAPER_PRICE_VERIFY_USE_JUPITER_PRICE` | `0` |
| `PAPER_PRICE_VERIFY_MAX_SLIP_PCT` | `4.0` |
| `PAPER_PRICE_VERIFY_MAX_SLIP_BPS` | `400` |
| `PAPER_PRICE_VERIFY_MAX_PRICE_IMPACT_PCT` | `8.0` |
| `PAPER_PRICE_VERIFY_TIMEOUT_MS` | `2500` |
| `PAPER_PRICE_VERIFY_EXIT_ENABLED` | `1` |
| `PAPER_PRICE_VERIFY_EXIT_BLOCK_ON_FAIL` | `1` |
| `PAPER_PRICE_VERIFY_EXIT_MAX_DEFERS_ESCALATION` | `60` |
| `PAPER_SIM_AUDIT_ENABLED` | `1` |
| `PAPER_SIM_SAMPLE_PCT` | `5` |
| `PAPER_SIM_MAX_WALL_MS` | `8000` |
| `PAPER_SIM_BUILD_TIMEOUT_MS` | `5000` |
| `PAPER_SIM_USE_JUPITER_BUILD` | `1` |
| `PAPER_SIM_CREDS_PER_CALL` | `30` |
| `PAPER_SIM_STRICT_BUDGET` | `1` |

---

## 21. Liq-watch

| Env | Значение |
|-----|----------|
| `PAPER_LIQ_WATCH_ENABLED` | `1` |
| `PAPER_LIQ_WATCH_FORCE_CLOSE` | `1` |
| `PAPER_LIQ_WATCH_DRAIN_PCT` | `35` |
| `PAPER_LIQ_WATCH_MIN_AGE_MIN` | `1` |
| `PAPER_LIQ_WATCH_CONSECUTIVE_FAILURES` | `2` |
| `PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS` | `120000` |
| `PAPER_LIQ_WATCH_RPC_FALLBACK` | `0` |
| `PAPER_LIQ_WATCH_STAMP_ON_ALL_CLOSE` | `1` |
| `PAPER_LIQ_WATCH_STAMP_ON_TRACK` | `0` |

---

## 22. Live: лимиты, гейты, whitelist, shadow, исполнение

| Env | Значение |
|-----|----------|
| `LIVE_MAX_OPEN_POSITIONS` | `30` |
| `LIVE_KILL_AFTER_CONSEC_FAIL` | `3` |
| `LIVE_PHASE5_FREE_SOL_GATE_ENABLED` | `0` |
| `LIVE_MIN_WALLET_SOL` | *(пусто)* |
| `LIVE_MIN_WALLET_SOL_EQUITY_USD` | *(пусто)* |
| `LIVE_BTC_GATE_ENABLED` | `1` |
| `LIVE_RECONCILE_BLOCK_MAX_MS` | `0` |
| `LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD` | `30` |
| `LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS` | `60000` |
| `LIVE_SIM_ENABLED` | `1` |
| `LIVE_SIM_TIMEOUT_MS` | `12000` |
| `LIVE_SIM_CREDITS_PER_CALL` | `30` |
| `LIVE_QUOTE_MAX_AGE_MS` | `8000` |
| `LIVE_JUPITER_TRACKER_TELEGRAM` | `0` |
| `LIVE_DEFAULT_SLIPPAGE_BPS` | `300` |
| `LIVE_JUPITER_PRIORITY_MAX_SOL` | `0.0001` |
| `LIVE_MINT_WHITELIST_ENABLED` | `1` |
| `LIVE_MINT_WHITELIST_PATH` | `data/live/live-oscar-mint-whitelist.txt` |
| `LIVE_MINT_WHITELIST_TELEGRAM_CATEGORY` | `ADVICE` |
| `LIVE_MINT_WHITELIST_NOTIFY_COOLDOWN_MS` | `300000` |
| `SIGNAL_LAB_ENABLED` | `1` |
| `SIGNAL_LAB_SAMPLE_PCT` | `100` |
| `SIGNAL_LAB_PATH` | `data/live/signal-lab.jsonl` |
| `SIGNAL_LAB_ALT_PROBE_FRACTION` | `0.55` |
| `MTM_SHADOW_ENABLED` | `1` |
| `MTM_SHADOW_SAMPLE_PCT` | `100` |
| `MTM_SHADOW_PATH` | `data/live/mtm-shadow.jsonl` |
| `MTM_SHADOW_ALT_FRACTION` | `0.58` |
| `LIVE_PERIODIC_SELF_HEAL_MS` | `1800000` |
| `LIVE_PERIODIC_SWEEP_MIN_USD` | `0.25` |
| `LIVE_PERIODIC_STUCK_GRACE_HOURS` | `0.5` |
| `LIVE_PERIODIC_SWEEP_UNKNOWN_CHAIN_ONLY` | `0` |

---

## 23. Приоритетная комиссия и прочее paper-слой

| Env | Значение |
|-----|----------|
| `PAPER_SAFETY_CHECK_ENABLED` | `1` |
| `PAPER_LIVE_MCAP_TTL_MS` | `30000` |
| `PAPER_PRIORITY_FEE_ENABLED` | `1` |
| `PAPER_PRIORITY_FEE_TICKER_MS` | `60000` |
| `PAPER_PRIORITY_FEE_MAX_AGE_MS` | `600000` |
| `PAPER_PRIORITY_FEE_RPC_TIMEOUT_MS` | `2500` |
| `PAPER_PRIORITY_FEE_PERCENTILE` | `p75` |
| `PAPER_PRIORITY_FEE_TARGET_CU` | `200000` |
| `PAPER_PRIORITY_FEE_CACHE_PATH` | `data/priority-fee-cache-live-oscar.json` |

*(Ключи кошелька и пути к секретам на VPS не воспроизводятся в спеке.)*

---

## 24. Ключевые файлы кода

| Область | Файл |
|---------|------|
| Очередность выходов, DCA, TP-grid | `src/papertrader/executor/tracker.ts` |
| Вторая нога входа | `src/live/entry-scale-in.ts` |
| Подстановка профиля B | `src/papertrader/cfg-effective-for-open.ts` |
| События live JSONL | `src/live/events.ts`, `src/live/store-jsonl.ts` |

---

## 25. Сопровождение

1. После имплементации §2–§7 — обновить **`ecosystem.config.cjs`** и таблицу **§18** (убрать противоречия).  
2. Запись в [`CHANGELOG.md`](../release/CHANGELOG.md) по регламенту релиза.  
3. При изменении только гейтов входа — править §9–§23 и сверять с ecosystem.

---

*Версия 2.1: целевая логика режимов A/B по триггерам; снимок инфраструктуры сохранён из предыдущей редакции V2.*
