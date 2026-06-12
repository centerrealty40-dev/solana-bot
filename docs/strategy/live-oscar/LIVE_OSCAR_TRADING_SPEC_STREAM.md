# Live Oscar — торговая спецификация (stream-only)

> **Именование:** эта спецификация описывает **Oscar Stream** (новая standalone-реализация в репозитории `oscar-stream`, Shyft stream, без PostgreSQL). Она **не** описывает prod **Live Oscar** / **Живой Оскар** — PG-based бот в monorepo `solana-alpha` (PM2 `live-oscar`). См. также `oscar-stream/docs/STRATEGY_GLOSSARY.md`.

**Версия:** prod PM2 `live-oscar` (`ecosystem.config.cjs`, ветка `v2` / 1.11.440+)  
**Аудитория:** агент, переписывающий стратегию на новой архитектуре  
**Источник истины:** только **активные** env из `ecosystem.config.cjs` → `live-oscar` + соответствующий код в `src/`

---

## §1. Назначение и архитектурные ограничения

### 1.1. Что строим

Live Oscar — **живой** Solana-бот на PumpSwap / Raydium / Meteora post-lane: discovery проливов → staged entry $730+$730 → удержание с политикой выхода **Wave B v1** → Jupiter Pro swap (slippage 50 bps, persistent retry).

### 1.2. Новая архитектура (обязательные ограничения)

| Требование | Реализация |
|------------|------------|
| Цена и метрики | **Shyft paid** — Rabbit stream + gRPC; rolling OHLCV / liq / vol / buy-sell в памяти или stream-store |
| **Без PostgreSQL** | Не использовать `*_pair_snapshots`, SQL discovery pool, PG coverage guards как источник |
| **Без paper-слоя** | Не писать/читать paper JSONL; env-префикс `PAPER_*` в prod — наследие паритета, логика описана по смыслу |
| Исполнение | `LIVE_EXECUTION_MODE=live`, кошелёк `live-oscar-micro`, журнал `data/live/pt1-oscar-live.jsonl` |

### 1.3. Что заменить вместо PG в stream-архитектуре

В prod сегодня dip/policy/sybil/post-crash читают PG. В stream-версии **те же пороги и порядок гейтов**, но данные — из stream-агрегатов:

- high/low цены за окна 30/60/120/360/720 мин
- vol_5m, vol_1h, buys_5m, sells_5m, liq, mcap — live snapshot по mint
- история vol_5m за 6–24 ч (sybil / ephemeral)
- якорные цены 15/30/60 мин назад (Policy A+)

Если истории недостаточно: Policy A+ **не блокирует** (`coverageOk=false`); PG coverage guard в prod **блокирует** — в stream нужен эквивалент «thin history» gate или осознанное смягчение (см. §3).

### 1.4. Тактические интервалы (prod)

| Параметр | Значение |
|----------|----------|
| Discovery tick | 10 000 ms |
| Tracker tick | 30 000 ms |
| Follow-up tick | 60 000 ms |
| Re-eval (обычный пул) | 30 s |
| Re-eval (priority tier) | 15 s |
| Re-eval (volume leader) | 15 s |
| Max open positions | 30 |
| Max position USD | 1 460 (cap = notional) |

---

## §2. Капитал и размер позиции

### 2.1. Единый notional (все tier'ы)

| Параметр | Prod | Смысл |
|----------|------|-------|
| `PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` | **$1 460** | Полный размер позиции |
| Staged split | **$730 + $730** | Две cash-ноги, без DCA |
| `PAPER_DCA_LEVELS` | пусто | DCA выключен |
| Low-mcap lane split | $730+$730, position $1 460 | Паритет с prod tier |

Boot-check: `positionUsd === 2 × entrySplitLegUsd` (см. `assertLiveOscarUnifiedEntrySizing`).

### 2.2. Что не применяется

- First-mint-probe (`LIVE_MINT_FIRST_PROBE_ENABLED=0`)
- Phase-5 free-SOL gate (`LIVE_PHASE5_FREE_SOL_GATE_ENABLED=0`)
- Legacy scale-in (`LIVE_ENTRY_SCALE_IN_ENABLED=0`) — вторая нога только через staged entry

---

## §3. Discovery pipeline (порядок оценки)

### 3.1. Universe и lane

**Активно только post-lane:**

| Gate | Значение |
|------|----------|
| `PAPER_ENABLE_POST_LANE` | true |
| `PAPER_ENABLE_LAUNCHPAD_LANE` / `MIGRATION_LANE` | false |
| Min pool age | **2 160 min (36 ч)** |
| Max pool age | без верхней границы (0) |

**Discovery mcap corridor (SQL/stream pool):**

| | USD |
|--|-----|
| Min scan | **$1.3M** |
| Max scan | **$50M** (открытые позиции — exempt) |

**Mcap tier (двухфазный, `PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED=1`):**

| Tier | Mcap | Dip min | Vol1h min |
|------|------|---------|-----------|
| below | < $1.3M | skip | — |
| low | $1.3M – <$3M | **−30%** | **$75k** |
| prod | ≥ $3M | **−18%** | **$25k** |

### 3.2. Snapshot floor (post-lane, обычный tier)

Применяется `evaluateSnapshot` (не priority):

| Метрика | Порог |
|---------|-------|
| `liq_usd` | ≥ **$30 000** |
| `vol_5m` | ≥ **$2 500** |
| `buys_5m` | ≥ **4** |
| `sells_5m` | ≥ **3** |
| buy/sell ratio (5m) | ≥ **0.95** |
| vol_1h guard | enabled: vol_1h ≥ **$36 000**, vol_5m ≤ **7×** (vol_1h/12) |
| mcap | $1.3M – $50M |

**Priority dip-watch tier** (`PAPER_PRIORITY_DISCOVERY_ENABLED=1`): liq + mcap + vol_1h + BS ≥ **0.75**; **без** vol_5m/buys/sells floor.

**Volume leader tier** (`PAPER_VOLUME_LEADER_ENABLED=1`): top-**50** по peak vol_1h за 24 ч; reeval 15 s; snapshot lookback 30 min; Jupiter cross-check (divergence 0.5–35%).

### 3.3. Global gate

| | Значение |
|--|----------|
| `PAPER_MIN_TOKEN_AGE_MIN` | **2 160 min** |
| `PAPER_MIN_HOLDER_COUNT` | **0** (holders live **выкл**) |

### 3.4. Пути входа (entry path) — взаимоисключающий выбор

Порядок в коде (`dip-clones.ts`):

1. **`dip_windows`** — snapshot pass + dip OR по окнам
2. **`stress_kill_reentry`** — если dip fail, но stress re-entry pass (§7.3)
3. **`post_crash_fast`** — если fast path pass
4. ~~`impulse_pg_snap`~~ — **не активен** (`PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP` не задан → false)
5. ~~`runner`~~ — **выкл** (`PAPER_RUNNER_MODE_ENABLED=0`)

#### 3.4.1. Dip windows (основной путь)

| Параметр | Prod tier | Low tier |
|----------|-----------|----------|
| Lookback OR | **120, 360, 720 min** | те же |
| `dip_min_drop` | **−18%** | **−30%** |
| `dip_max_drop` | **−50%** | −50% |
| `dip_min_impulse` | **+12%** (high/low в окне) | +12% |
| `dip_min_age` | **2 160 min** | 2 160 min |

Pass: **любое** из окон 120/360/720 удовлетворяет глубине, impulse и age.

#### 3.4.2. Post-crash fast path (`PAPER_POST_CRASH_FAST_PATH_ENABLED=1`)

| Параметр | Значение |
|----------|----------|
| Lookback | 180 min |
| Min PG/stream samples | 8 |
| Drop from crash peak | **−20% … −50%** |
| Vol spike mult | ≥ **5×** |
| Stabilize after peak | ≥ **25 min** |
| Max age since peak | ≤ **240 min** |
| Max knife 15m | **−8%** |
| Bypass local-high veto | **да** |

Не bypass: Policy A+, BS, vol1h floors.

### 3.5. Protector-фильтры (единый блок для всех entry path)

Порядок после выбора `entryPath`:

1. **Recovery veto** (`PAPER_DIP_RECOVERY_VETO_ENABLED=1`)  
   - Окна: **30, 60 min** (только `< dip_lookback_used`)  
   - Max bounce от low окна: **12%**  
   - **Исключение:** `stress_kill_reentry` — recovery veto **пропускается**; вместо этого stress bounce gate (§7.3)

2. **Local-high veto** (`PAPER_DIP_LOCAL_HIGH_VETO_ENABLED=1`)  
   - Окна: **30, 60, 120 min**  
   - Max distance от high: **≤ 2%** → block (цена слишком у хая)

3. ~~Trend structure veto~~ — **выкл** (`PAPER_TREND_STRUCTURE_VETO_ENABLED=0`)

4. **Policy A+** (`PAPER_POLICY_A_PLUS_ENABLED=1`) — все подправила вкл:

   | Правило | Порог |
   |---------|-------|
   | Bounce from 30m low | block если **> 2.5%** |
   | Price change 1h | block если **< −20%** |
   | Vol 1h | block если **> $1M** |
   | Price change 15m | block если **< −7%** |

5. **PG data coverage** — в prod вкл; **в stream-spec заменить** на stream-coverage gate с теми же ratio-порогами или отключить осознанно:
   - lookback 24h, recent 6h, min recent hours 4, hour ratio 0.5/0.75, max gap 30 min

6. **Volume sybil guard** (`PAPER_VOLUME_SYBIL_GUARD_ENABLED=1`):

   | | |
   |--|--|
   | Lookback | 6 h |
   | Recent window | 45 min |
   | Baseline p10 max | $3 000 |
   | Min baseline samples | 25 |
   | Min recent vol5m | $8 000 |
   | Spike ratio min | **6×** |
   | Dead vol5m | $2 500 |
   | Min dead fraction | **0.55** |
   | Vol1h alive exempt | ≥ **$36k** → skip |

7. **Volume ephemeral guard** (`PAPER_VOLUME_EPHEMERAL_GUARD_ENABLED=1`):

   | | |
   |--|--|
   | Lookback | 24 h |
   | Min active hour vol5m | $8 000 |
   | Max active hours | 4 |
   | Min peak vol5m | $20 000 |
   | Tail block | enabled, max peak ratio **0.3** |

### 3.6. Whale analysis (observability, не блокирует)

`PAPER_DIP_WHALE_ANALYSIS_ENABLED=1`, `PAPER_DIP_REQUIRE_WHALE_TRIGGER=0` — анализ пишется в decision, но **не** блокирует без creator dump.

Creator dump block: **вкл** (`PAPER_DIP_BLOCK_CREATOR_DUMP=1`).

### 3.7. Cooldown перед входом (mint-level)

| Тип | Значение |
|-----|----------|
| Обычный dip cooldown | **30 min** с последнего entry |
| Scalp (dca_predictable whale) | **20 min** |
| Post-exit loss cooldown | **10 min** (см. §7) — при hybrid re-entry gate **не дублируется** на discovery (только execution) |

### 3.8. BTC gate (только `buy_open`)

`LIVE_BTC_GATE_ENABLED=1`:

| Окно | Block drawdown |
|------|----------------|
| 1h | **> 1%** |
| 4h | **> 2.5%** |
| 24h / 72h / peak72h | **выкл (0)** |
| Recovery | `ret_1h ≥ 0%` → только 1h+4h |

### 3.9. Discovery tiers (ускорение reeval)

- **Priority:** open + near-ready + recent eval + SQL pool; max 200 mints; near-miss Jupiter refresh gap **4%**
- **Volume leader:** top-50 / 24h

---

## §4. Entry execution (staged split + gates)

### 4.1. Staged entry v2 (`PAPER_LIVE_STAGED_ENTRY_ENABLED=1`)

| Параметр | Значение |
|----------|----------|
| Leg 1 (`buy_open`) | **$730** |
| Leg 2 (`entry_split`) | **$730** |
| Delay leg1→leg2 | **5 000 ms** |
| Price corridor vs anchor leg1 | **+3% / −10%** |
| Signal TTL | **0** (без лимита) |
| Signal kill drop | **0** (выкл) |
| Staged avg legs 2/3 | **$0** (усреднение выкл) |

**Leg 2 логика** (`live-staged-entry-lifecycle.ts`):

1. Ждать `leg1_ts + 5s`
2. `change_pct = (price / anchor - 1) × 100`
3. Если `−10% ≤ change_pct ≤ +3%` → `buy_scale_in` $730

### 4.2. Execution gates (перед каждым swap)

Порядок в `phase4-execution.ts` / pipeline:

1. **Mint blacklist** (если enabled)
2. **Permanent denylist** (seed + local)
3. **BTC gate** (только новый `buy_open`)
4. **Timed loss cooldown** (только Variant A tags — фактически не срабатывает на Wave B)
5. **Wallet mint min** — skip `buy_open` если на кошельке уже ≥ **$30** этого mint
6. **Post-exit re-entry gate** (§7)
7. **Price verify** — block on fail; max slip **4%** / 400 bps; max impact **8%**
8. **Buy max price impact** — **1.5%**
9. **Anti-chase** — abort если quote ушёл **> 3%** выше anchor вызова
10. **Quote max age** — **8 000 ms**
11. **Sim + retry** — 10 attempts × 3 s; slippage bump 50→300 bps (buy: 2 slippage-class retries)
12. **Staged-add sim_err cooldown** — 3 подряд `sim_err` → block **30 min** на mint

**Slippage execution:** `LIVE_DEFAULT_SLIPPAGE_BPS=50` (0.5%).

---

## §5. In-position management (Wave B state machine)

### 5.1. Политика на open

`PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=1` → `liveExitPolicyId = wave_b_v1`  
`PAPER_LIVE_EXIT_MODE_AB=0`, `PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A=0`

### 5.2. Состояния Wave B

```
OPEN → PRE_ARM (PnL < +7.5%) → ARMED (+7.5% touched) → partial TP / trail / insurance / breakeven
```

**Ключевые поля open trade:**

- `liveWavePreArmReached` — true после touch **+7.5%** vs entry market
- `liveWavePeakPnlFrac`, `liveWaveTrailAnchorPnlFrac`, `liveWaveTrailLevelsTaken`
- `liveWaveMaxExecutedTpFrac` — для eligibility breakeven full exit
- `liveWaveBreakevenInsuranceTaken`
- `liveWaveImpulseBelowFirstRung` — oscillation cycles до +7.5%
- `ladderUsedIndices` / `ladderUsedLevels` — отмеченные TP rungs

### 5.3. MTM и ghost-quote guard

- Tracker probe: $20–$200 (10% remainder), min $20
- `WAVE_B_MTM_MAX_TICK_JUMP_FRAC = 12%` — clamp MTM для exit-решений
- Inter-mint delay: **60 ms**

### 5.4. TP ladder (escalating)

| | Значение |
|--|----------|
| Step | **+2.5%** PnL vs avg entry |
| Sell profile | rung k → **k×5%** of remainder (cap 100%) |
| Max 1 partial per tick | да |

Примеры: +2.5%→5%, +5%→10%, +7.5%→15%, +10%→20%, …

### 5.5. Pre-arm oscillation cycles (< +7.5%)

- Цена ушла **ниже +2.5%** после rungs → flag `impulseBelowFirstRung`
- Если PnL **< 0%** и были rungs → **clear all TP marks** (re-arm на следующем ралли)
- Rally снова выше +2.5% → reset insurance flag, clear marks если были

### 5.6. Post-arm impulse reset (≥ +7.5% touched)

При pullback **≤ +2.5%**: снять TP marks **выше +2.5%** (частичный reset), trail state обновить.

### 5.7. Defensive trail (после +7.5%)

- Arm: peak или executed TP ≥ **+7.5%**
- Уровни: `anchor − n×2.5%` для n=1,2,…
- Sell: **20%** remainder за уровень (`PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION=0.20`)
- На новом ATH: `waveBOnNewHigh` — сброс trail descent, TP marks сохраняются
- Remainder **≤ $100** → flush 100%

### 5.8. Breakeven insurance (`PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_ENABLED=1`)

Условия (все):

1. Взяты rungs **+2.5%** и **+5%**
2. Max executed TP **< +7.5%**
3. Insurance ещё не брали

Действие: sell **50%** remainder at market (`BREAKEVEN_INSURANCE_FRACTION=0.5`, `PNL_FRAC=0`).

### 5.9. Breakeven full exit

Eligible после +7.5% touch **или** executed TP ≥ +7.5%.  
Если avg PnL **≤ 0%** → full close `BREAKEVEN_EXIT`.

### 5.10. Killstop

| | |
|--|--|
| `PAPER_DCA_KILLSTOP` | **−9%** (−0.09 fraction) |
| Wave B | `waveBAbsoluteKillEligible`: market ≤ −9% vs entry **или** avg ≤ −9% |
| Дебаунс после multi-leg | 2 ticks (не для waveBKill path) |

**Примечание:** `waveBPreArmKillEligible` (kill только до +7.5%) в tracker **не вызывается**; prod использует absolute −9% floor всегда.

### 5.11. Liq watch (`PAPER_LIQ_WATCH_ENABLED=1`)

| | |
|--|--|
| Drain vs entry liq | **≥ 25%** |
| Consecutive failures | **2** |
| Min position age | **1 min** |
| Action | **force close** `LIQ_DRAIN` |

### 5.12. Wave B и timeout

**48h TIMEOUT не применяется** к Wave B (`!isWaveBExitPolicy` guard). Позиция держится до exit-триггеров §6.

---

## §6. Exit triggers (приоритет в tracker tick)

Порядок обработки на одном tick (после MTM update):

| # | Триггер | Условие | Тип |
|---|---------|---------|-----|
| 1 | **LIQ_DRAIN** | liq watch force-close | full |
| 2 | **NO_DATA** | нет цены + age ≥ 48h (не Wave B) | full |
| 3 | **TP grid partials** | +2.5% steps, max 1/tick | partial |
| 4 | **Breakeven insurance** | §5.8 | partial 50% |
| 5 | **Trail partials** | defensive −2.5% steps | partial 20% |
| 6 | ~~Thin vol flush~~ | только Variant A hybrid — **не Wave B** | — |
| 7 | **Staged leg 2** | entry_split если corridor OK | add |
| 8 | **KILLSTOP** | −9% | full |
| 9 | **BREAKEVEN_EXIT** | §5.9 | full |
| 10 | Legacy TP x100 / SL / peak trail | не Wave B | — |
| 11 | **TIMEOUT 48h** | не Wave B | full |
| 12 | Remainder ~0 | `remainingFraction ≤ ε` | full TP |

После full close: tail sweep через **60 s** (`LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS`).

---

## §7. Post-exit: cooldown + re-entry + stress re-entry

### 7.1. Loss exit cooldown

`PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED=true`, **10 min** после убыточного close.

При **hybrid re-entry** (`LIVE_REENTRY_MIN_DROP=10%`, `MAX_WAIT=240`) discovery **не** дублирует 10m cooldown; gate на execution через `appendPostExitReentryGateReasons`.

### 7.2. Hybrid re-entry gate (активен)

| Параметр | Значение |
|----------|----------|
| `LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT` | **10%** |
| `LIVE_REENTRY_MAX_WAIT_MINUTES` | **240** (таймер-only bypass **не** используется — только price gap) |
| `LIVE_REENTRY_LOSS_MIN_DROP_FROM_LAST_EXIT_PCT` | **10%** |
| `LIVE_REENTRY_HYBRID_DISABLE_TIMER_AFTER_LOSS` | **1** |
| Gate max age | **4 h** после exit |

**Правило:** новый entry только если `price ≤ last_exit × (1 − drop%)`.  
Loss/stress exit: suffix `_loss`, drop = max(10%, 10%) = **10%**.

### 7.3. Stress kill re-entry (`LIVE_STRESS_REENTRY_ENABLED=1`, 1.11.436+)

**Stress exit:** net PnL < 0 **или** reason ∈ {`FLASH_CRASH_KILL`, `SL`, `KILLSTOP`, `LIQ_DRAIN`}.

| Параметр | Значение |
|----------|----------|
| Min drop from last exit | **40%** |
| Recovery veto max bounce | **8%** (окна ≤ 30 min) |
| Dip max drop relax | **−65%** (вместо tier −50%) |
| Recovery veto на path | **пропущен** |
| Bounce check | те же 30m окна, max **8%** от low |

Entry path: `stress_kill_reentry` — альтернатива dip_windows при глубоком drop после stress exit.

### 7.4. Mint repeat cooldown (между entry)

| | |
|--|--|
| После любого entry | **30 min** (20 min scalp) |
| Timed loss 24h | env **вкл**, но только Variant A `salvage24`/`h48_loss` — **не применяется** к Wave B |

### 7.5. Negative trade denylist

`LIVE_NEGATIVE_TRADE_DENY_ENABLED=0` — автодeny после убытка **выкл**.

---

## §8. Mint lists (только enabled)

| List | Enabled | Path / поведение |
|------|---------|------------------|
| **Blacklist** | **да** (`LIVE_MINT_BLACKLIST_ENABLED=1`) | `data/live/live-oscar-mint-blacklist.txt` — block до discovery и buy |
| **Permanent denylist** | **да** (`LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED=0`) | seed `live-oscar-permanent-denylist.seed.txt` + local на VPS |
| Whitelist | **нет** (`LIVE_MINT_WHITELIST_ENABLED=0`) | файл есть, gate не применяется |
| Auto deny on loss | **нет** | |
| Whitelist remove on consec losses | **нет** (0) | |
| Graduated list | файл есть, отдельный gate не описан в active path | |

---

## §9. Таблица констант (name → prod → meaning)

### Capital & entry

| Env / constant | Prod | Meaning |
|----------------|------|---------|
| `LIVE_OSCAR_ENTRY_NOTIONAL_USD` | 1460 | Полный notional |
| `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD` | 730 | Одна нога split |
| `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS` | 5000 | Пауза leg1→leg2 |
| `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_UP_PCT` | 3 | Верх коридора leg2 |
| `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_MAX_DOWN_PCT` | 10 | Низ коридора leg2 |
| `LIVE_MAX_OPEN_POSITIONS` | 30 | Max concurrent |
| `LIVE_DEFAULT_SLIPPAGE_BPS` | 50 | Jupiter tolerance |
| `LIVE_BUY_MAX_CHASE_PCT` | 3 | Anti-chase |
| `LIVE_BUY_MAX_PRICE_IMPACT_PCT` | 1.5 | Pre-buy impact cap |
| `LIVE_QUOTE_MAX_AGE_MS` | 8000 | Stale quote block |

### Discovery dip / mcap

| Env | Prod | Meaning |
|-----|------|---------|
| `PAPER_DIP_LOOKBACK_WINDOWS_MIN` | 120,360,720 | OR windows |
| `PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT` | -18 | Prod dip |
| `PAPER_LIVE_OSCAR_LOW_MCAP_DIP_MIN_DROP_PCT` | -30 | Low dip |
| `PAPER_DIP_MAX_DROP_PCT` | -50 | Too deep |
| `PAPER_DIP_MIN_IMPULSE_PCT` | 12 | Range impulse |
| `PAPER_POST_MIN_LIQ_USD` | 30000 | Liq floor |
| `PAPER_POST_MIN_VOL_5M_USD` | 2500 | Vol5m floor |
| `PAPER_POST_MIN_BS` | 0.95 | BS floor |
| `PAPER_VOL_1H_MIN_USD` | 36000 | Vol1h guard |
| `PAPER_VOL_5M_SPIKE_MAX_MULT` | 7 | Spike guard |

### Protectors

| Env | Prod | Meaning |
|-----|------|---------|
| `PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT` | 12 | Recovery cap |
| `PAPER_DIP_LOCAL_HIGH_VETO_MAX_DISTANCE_PCT` | 2 | Near high block |
| `PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT` | 2.5 | A+ rule 1 |
| `PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_MIN_PCT` | -20 | A+ rule 2 |
| `PAPER_POLICY_A_PLUS_VOL_1H_MAX_USD` | 1000000 | A+ rule 3 |
| `PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT` | -7 | A+ rule 4 (15m window) |

### Exit Wave B

| Env / code | Prod | Meaning |
|------------|------|---------|
| `PAPER_DCA_KILLSTOP` | -0.09 | −9% kill |
| `WAVE_B_V1_TP_GRID.gridStepPnl` | 0.025 | +2.5% steps |
| `WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC` | 0.075 | +7.5% arm |
| `PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_FRACTION` | 0.5 | Insurance peel |
| `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION` | 0.20 | Trail slice |
| `WAVE_B_TRAIL_FLUSH_REMAIN_USD` | 100 | Dust flush |

### Re-entry

| Env | Prod | Meaning |
|-----|------|---------|
| `PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES` | 10 | Loss cooldown |
| `LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT` | 10 | Re-entry dip |
| `LIVE_REENTRY_GATE_MAX_AGE_HOURS` | 4 | Gate TTL |
| `LIVE_STRESS_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT` | 40 | Stress path |
| `LIVE_STRESS_REENTRY_RECOVERY_VETO_MAX_BOUNCE_PCT` | 8 | Stress bounce |
| `LIVE_STRESS_REENTRY_DIP_MAX_DROP_PCT` | -65 | Relaxed max dip |

### Live gates

| Env | Prod | Meaning |
|-----|------|---------|
| `LIVE_BTC_BLOCK_1H_DRAWDOWN_PCT` | 1 | BTC 1h gate |
| `LIVE_BTC_BLOCK_4H_DRAWDOWN_PCT` | 2.5 | BTC 4h gate |
| `LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD` | 30 | Wallet dup guard |
| `LIVE_MINT_BLACKLIST_ENABLED` | 1 | Blacklist on |

---

## §10. Explicitly OUT OF SCOPE (не реализовывать)

Следующее **выключено в prod** или не относится к stream-реализации:

| Feature | Env / reason |
|---------|----------------|
| Paper trader / paper JSONL | unused path |
| PostgreSQL snapshots как source | заменить stream |
| Launchpad / migration lanes | `ENABLE=false` |
| Runner mode | `PAPER_RUNNER_MODE_ENABLED=0` |
| Impulse PG snap bypass | `PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP` unset |
| Trend structure veto | `PAPER_TREND_STRUCTURE_VETO_ENABLED=0` |
| Holders live gate | `PAPER_HOLDERS_LIVE_ENABLED=0` |
| DCA levels | `PAPER_DCA_LEVELS=''` |
| Staged averaging (−7/−14%) | second/third leg USD = 0 |
| Signal kill on staged plan | `KILL_DROP_PCT=0` |
| Flash crash kill | `PAPER_FLASH_CRASH_KILL_ENABLED=0` |
| Exit Variant A / AB mode | `VARIANT_A=0`, `MODE_AB=0` |
| TP regime classes | `PAPER_TP_REGIME_ENABLED=0` |
| Legacy grid TP (+5% step 10%) | superseded by Wave B on new opens |
| Thin vol flush | enabled in env but **only Variant A hybrid** — not Wave B |
| Breakeven trim after 1st TP | `BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED=0` |
| Classic peak trail 12% @ 1.35x | Wave B uses defensive trail |
| 48h TIMEOUT on Wave B | code skips for `wave_b_v1` |
| Whitelist required entry | `LIVE_MINT_WHITELIST_ENABLED=0` |
| Auto denylist on loss | `LIVE_NEGATIVE_TRADE_DENY_ENABLED=0` |
| First-mint-probe sizing | `LIVE_MINT_FIRST_PROBE_ENABLED=0` |
| Scratch re-entry | `LIVE_MINT_SCRATCH_REENTRY_ENABLED=0` |
| Mint loss re-entry cooldown (alt) | `LIVE_MINT_LOSS_REENTRY_COOLDOWN_ENABLED=0` |
| Phase-5 capital rotate / free SOL | `LIVE_PHASE5_FREE_SOL_GATE_ENABLED=0` |
| Legacy LIVE_ENTRY_SCALE_IN | `ENABLED=0` |
| Periodic stuck force-close | `LIVE_PERIODIC_STUCK_FORCE_CLOSE_ENABLED=0` |
| Signal lab / MTM shadow | `SIGNAL_LAB_ENABLED=0`, `MTM_SHADOW_ENABLED=0` |
| Dynamic killstop shadow | observability only, не меняет kill |
| Sim audit sampling | не блокирует live |

---

## Приложение A. Порядок гейтов discovery (чеклист)

```
1. Blacklist / permanent denylist
2. Reeval throttle (30s / 15s priority)
3. Mcap tier resolve (below → skip)
4. Snapshot floor (or priority tier)
5. Global token age
6. Entry path: dip | stress_reentry | post_crash
7. Protectors: recovery → local_high → policy_a+ → coverage → sybil → ephemeral
8. Whale (creator dump only blocks)
9. Cooldowns: mint 30m, post-exit (hybrid), loss 10m (legacy path)
10. Holders (off)
→ PASS → buy_open $730
```

## Приложение B. Файлы кода (reference)

| Область | Файл |
|---------|------|
| Discovery orchestration | `src/papertrader/discovery/dip-clones.ts` |
| Mcap tiers | `src/papertrader/live-oscar-mcap-tier.ts` |
| Dip math | `src/papertrader/dip-detector.ts` |
| Stress re-entry | `src/papertrader/discovery/stress-kill-reentry.ts` |
| Wave B exit | `src/papertrader/executor/exit-policy-wave-b.ts` |
| Tracker loop | `src/papertrader/executor/tracker.ts` |
| Staged entry | `src/papertrader/executor/live-staged-entry-lifecycle.ts` |
| Live execution | `src/live/phase4-execution.ts` |
| Prod env | `ecosystem.config.cjs` → `name: 'live-oscar'` |

---

*Документ: product `solana-alpha` only. Platform VERSION не менялся.*
