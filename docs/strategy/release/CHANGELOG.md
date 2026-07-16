# Solana Alpha — журнал релизов продукта

Версия в файле [`VERSION`](./VERSION) — **semver продукта** (торговое/paper ядро + конфиги стратегий + восстановление состояния из журнала). Она **не обязана** совпадать с полем `version` в `package.json` (npm); при желании их можно синхронизировать только для крупных релизов.

Каждая запись ниже обязана содержать: дату, номер версии, краткое описание, **git-тег** (если применимо), **инструкцию отката**.

Формат записей — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), семвер — [Semantic Versioning 2.0.0](https://semver.org/lang/ru/).

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---


---

---

---

---

---


---

---

---

---

---

---

---

---

---

---

---

---

## [1.11.600] — 2026-07-16

**Тег:** `sa-alpha-1.11.600`

### Live Oscar — restore discovery stall watchdog (visibility, not a perf fix)

- **Причина:** 1.11.599 убрал `LIVE_DISCOVERY_STALL_ALERT_*` и Telegram `[ALERT][discovery_stall]` — оператор терял видимость, когда eval > timeout и тики не завершались. Это была ошибка revert: диагностику нельзя отключать, пока discovery не здоров.
- **Восстановлено:** `recordDiscoveryTickCompleted`, `markDiscoverySchedulerStarted`, stall watchdog в `discovery-health-window.ts`, Telegram ALERT + `risk_note` в heartbeat, env `LIVE_DISCOVERY_STALL_ALERT_*` в `live-oscar`.
- **Дополнительно:** при `discoveryTick timeout` сбрасываем `discoveryInFlight`, чтобы следующий интервал мог стартовать (mutex не залипает на zombie tick).
- **Не входит:** abort eval loop при timeout (pool 500 всё ещё может давать `errors≈ticks`); отдельный релиз.
- **Откат:** redeploy `sa-alpha-1.11.599` / SHA `ffe33a4` или `LIVE_DISCOVERY_STALL_ALERT_ENABLED=0`.

## [1.11.599] — 2026-07-16

**Тег:** `sa-alpha-1.11.599`

### Live Oscar — revert discovery runtime to pre–1.11.578 (fix recurring stall)

- **Причина:** 1.11.578 unfreeze mutex на timeout + 1.11.596/597 (pool 250, timeout 300s, stall watchdog) не устранили корень: eval >5 мин → zombie ticks → overlapping DexScreener load → `discovery_stall` ALERT и ~16% throughput за ночь.
- **Откат scheduler:** убран `runDiscoveryTickGuarded` / `discoveryInFlightGen` unfreeze; single-flight mutex как до 11 июля (timeout логирует ошибку, новый тик ждёт завершения in-flight).
- **Удалён stall watchdog:** `recordDiscoveryTickCompleted`, `LIVE_DISCOVERY_STALL_ALERT_*`, Telegram `[ALERT][discovery_stall]`.
- **Env (`live-oscar`):** `PAPER_DISCOVERY_INTERVAL_MS` 30s→**10s**; `PAPER_DISCOVERY_TICK_TIMEOUT_MS` 300s→**120s**; `PAPER_SNAPSHOT_CANDIDATE_LIMIT` 250→**500**; `PAPER_VOLUME_LEADER_REEVAL_SEC` 30→**15**; `PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MAX_PER_TICK` 5→**20**.
- **Откат:** redeploy `sa-alpha-1.11.598` / SHA `be983e1`.

## [1.11.598] — 2026-07-16

**Тег:** `sa-alpha-1.11.598`

### Ops — Oscar VPS: remove shadow knife-catcher + awakening-catcher PM2 apps

- **Причина:** на Oscar VPS shadow `knife-catcher` / `awakening-catcher` были включены через `.env` drift (`ENABLED=1`), грузили Dex/RPC рядом с `live-oscar` discovery. Live lanes — только LERA (`/opt/lera`).
- **Что сделано:** блоки PM2 удалены из `ecosystem.config.cjs`; на хосте `pm2 delete` + `pm2 save`; `.env` flags `KNIFE_CATCHER_ENABLED=0`, `AWAKENING_CATCHER_ENABLED=0`.
- **Откат:** вернуть PM2-блоки из `sa-alpha-1.11.597` + `pm2 reload ecosystem.config.cjs --update-env` (не рекомендуется на Oscar).

## [1.11.597] — 2026-07-15

**Тег:** `sa-alpha-1.11.597`

### Live Oscar — discovery stall: mark eval complete before open pipeline

- **Причина:** `recordDiscoveryTickCompleted()` вызывался только после **всего** `discoveryTick` (eval + journal + open/sim). Open/sim могли идти минутами → `[ALERT][discovery_stall]` при живом eval. Boot `await discoveryTick()` не брал mutex → параллельные тики при старте.
- **Что сделано:** `recordDiscoveryTickCompleted()` сразу после `runDipDiscovery` (до open-loop). Boot и scheduler через общий `runDiscoveryTickGuarded`. `PAPER_DISCOVERY_INTERVAL_MS` **10s→30s**.
- **Откат:** revert `1.11.597` + `pm2 reload live-oscar --update-env`.

## [1.11.596] — 2026-07-15

**Тег:** `sa-alpha-1.11.596`

### Live Oscar — discovery stall hotfix (timeout + eval load)

- **Причина:** с 2026-07-15 discovery-тик стабильно **>120s** (DexScreener 120 RPM gate + volume-leader Jupiter crosscheck + SQL pool 500) → `discoveryTick timeout` каждые ~2 мин, `discovery_stall` Telegram, `errors≈ticks`.
- **Что сделано (PM2 `live-oscar`):** `PAPER_DISCOVERY_TICK_TIMEOUT_MS` **120000→300000**; `PAPER_SNAPSHOT_CANDIDATE_LIMIT` **500→250**; `PAPER_VOLUME_LEADER_REEVAL_SEC` **15→30**; `PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_MAX_PER_TICK` **20→5**.
- **Откат:** вернуть прежние значения в `ecosystem.config.cjs` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

## [1.11.593] — 2026-07-15

**Тег:** `sa-alpha-1.11.593`

### Live Oscar — смягчение trend/recovery veto (без отключения)

- **Trend dip bypass:** при dip ≥15% и slope3d ≥0 — пропуск `no_high_break` + `decline` (febu/ANSEM pullback); ski-slope остаётся.
- **Recovery veto:** base 12% (было 8%) + dip-scaled bonus на глубоких dip.
- **Trend decline:** `MAX_SLOPE_7D` −8% (было −3%); ski reversal bounce 60% (было 80%).
- **Откат:** вернуть env из 1.11.589/583 + `pm2 reload live-oscar --update-env`.

## [1.11.592] — 2026-07-14

**Тег:** `sa-alpha-1.11.592`

### Knife-catcher — vol-decay exit + $250 leg

- **`KNIFE_VOL_DECAY_EXIT_ENABLED`:** scalp — при **5** подряд минутах с падением `vol5m` (PG `pumpswap_pair_snapshots`) — выход `vol_decay` **до** kill-stop (`KNIFE_VOL_DECAY_CONSECUTIVE_MIN=10` для мягче).
- **`KNIFE_LEG_USD` / `KNIFE_POSITION_USD`:** default **$250** (одна нога).
- Env: `KNIFE_VOL_DECAY_CONSECUTIVE_MIN`, `KNIFE_VOL_DECAY_SAMPLE_SEC`, `KNIFE_VOL_DECAY_METRIC` (`vol1h` | `vol5m`).
- **Откат:** `KNIFE_VOL_DECAY_EXIT_ENABLED=0`, вернуть leg/position в `.env`, `pm2 reload knife-catcher --update-env`.

## [1.11.591] — 2026-07-14

**Тег:** `sa-alpha-1.11.591`

### Volume Awakening (shadow) — min pool age 6h

- **`AWAKENING_MIN_POOL_AGE_HOURS`:** default **6** (было 12 на проде / 24 в ecosystem) — расширяем re-awakening на монеты от ~6ч после миграции (AQD-класс).
- **Откат:** вернуть `AWAKENING_MIN_POOL_AGE_HOURS=12` в `.env` + ecosystem default + `pm2 reload awakening-catcher --update-env`.

## [1.11.590] — 2026-07-14

**Тег:** `sa-alpha-1.11.590`

### Volume Awakening (shadow) — re-awakening pump ignition

- **RCA FeMbDo 12:47–12:50 MSK:** stream поймал всплеск в 12:49:43; vol5m spike 11×/12× прошёл, но `buy_ratio` 31% < 38% отрубил сигнал; 15‑мин cooldown после fail заблокировал повтор до пика.
- **`awakening-signal`:** `AWAKENING_BUY_RATIO_SPIKE_BYPASS` — при подтверждённом ignition (spike 8×/4× + m5↑) не требовать buy_ratio; `AWAKENING_MIN_PRICE_CHANGE_M5_IGNITION_PCT` (default 1%).
- **`awakening-catcher`:** tiered cooldown — near-miss (только buy_ratio/m5) 90s, hard fail 300s, signal 900s.
- **Тест:** fixture FeMbDo Jul-14 ignition + post-peak block.
- **Откат:** `git revert` коммита 1.11.590 + `pm2 reload awakening-catcher --update-env`.

## [1.11.589] — 2026-07-14

**Тег:** `sa-alpha-1.11.589`

### Live Oscar — ужесточение entry-порогов (anti-bounce / anti-chop)

- **RCA:** F4Gp TrumpCoin — покупка на отскоке ~735k после пролива до 700k (16:04 МСК); shallow dip passes в боковике.
- **Пороги (`ecosystem.config.cjs` → `live-oscar`):**
  - `PAPER_DIP_RECOVERY_VETO_MAX_BOUNCE_PCT` 12 → **8**
  - `PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT` 2.5 → **1.0**
  - `PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT` −18 → **−22**
  - `PAPER_DIP_MIN_DROP_PCT` −20 → **−25**
  - `PAPER_DIP_LOCAL_HIGH_VETO_MAX_DISTANCE_PCT` 2 → **4**
  - `PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT` −7 → **−10**
  - `LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT` 10 → **18**
- **Откат:** вернуть значения 1.11.588 в `ecosystem.config.cjs` + `pm2 reload live-oscar --update-env`.

---

## [1.11.588] — 2026-07-14

**Тег:** `sa-alpha-1.11.588`

### Mem-swan KILLSTOP — retry liquidate + emergency sell path

- **Проблема (RCA Jul 14):** swan срабатывал (breadth −8…−10%), но `mem_swan_liquidate_done` давал `liquidated:0 failed:2` — rising-edge один раз, ghost_price блокировал J8PS (−79% vs reference), febu упёрся в sim_err на последнем exit-slice.
- **Что сделано:**
  - Повторная ликвидация каждый tracker-tick пока `swan active` и `open > 0` (внешний + portfolio swan).
  - `emergencyExit` на KILLSTOP (`bypassPolicyBlock`): пропуск ghost-quote gate, single-shot `sell_full` без slicing, агрессивный sim-retry (slippage от 150bps, cap 800bps, delay 100ms).
- **Откат:** `git revert` коммита 1.11.588 + `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.587] — 2026-07-14

**Тег:** `sa-alpha-1.11.587`

### Range-base dip — пролив из боковика (6Nwar-class)

- **Проблема:** после 48h compression dip-окна (`120/360/720m`) дают `dip_no_window_pass` — impulse слишком плоский, хотя свежий пролив от range-low торгуемый.
- **Что сделано:** путь `range_base_dip` при `span48h<15%`, `|net_move|<10%`, drop от 48h low ≥ tier `dipMinDropPct`, live `vol5m/(vol1h/12)≥2x`. Env: `PAPER_DIP_RANGE_BASE_*` (default ON).
- **Откат:** `PAPER_DIP_RANGE_BASE_ENABLED=0` + `pm2 reload ecosystem.config.cjs --update-env`.

### Knife — leg2 на floor-flush ≥15% при открытой leg1

- **Проблема:** reconcile/micro leg1 ($5) не усреднялся на новом −15%+ flush (только `KNIFE_AVG_LEG_ENABLED` @ −8% от leg1).
- **Что сделано:** `KNIFE_FLUSH_LEG2_ENABLED=1`, `KNIFE_FLUSH_LEG2_MIN_DUMP_PCT=15` — rolling flush leg2 независимо от avg-leg.
- **Откат:** `KNIFE_FLUSH_LEG2_ENABLED=0` + `pm2 reload ecosystem.config.cjs --only knife-catcher --update-env`.

---

## [1.11.585] — 2026-07-12

**Тег:** `sa-alpha-1.11.585`

### Live Oscar («Живой Оскар») — prod entry split $4000

- **Изменение:** prod ≥$3M: **8×$500** timed entry split @10s (+3/−5% corridor) = **$4000** (`PAPER_POSITION_USD`); avg @ −10% = 50% entry (**$2000** as 4×$500 slices); max **$6000** (`LIVE_MAX_POSITION_USD`, `PROD_MCAP_MAX_*`).
- **Откат:** вернуть `6×$500` / max `$4500` в `ecosystem.config.cjs` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

### Volume ephemeral — known-mint re-entry tail_wash (6AVA RCA)

- **Проблема:** familiar/known mint обходил `volume_ephemeral` на re-entry при мёртвом vol5m (SCAM 12.07 ~22:00 MSK).
- **Что сделано:** `tail_wash` при `vol5m/vol1h < 8%` на known mint; env `PAPER_VOLUME_EPHEMERAL_KNOWN_MINT_TAIL_WASH_BLOCK_ENABLED` (default `1`). Спека: `docs/strategy/live-oscar/LIVE_OSCAR_KNOWN_MINT_TAIL_WASH_SPEC.md`.
- **Откат:** `PAPER_VOLUME_EPHEMERAL_KNOWN_MINT_TAIL_WASH_BLOCK_ENABLED=0` + `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.584] — 2026-07-12

**Тег:** `sa-alpha-1.11.584`

### Copy-trader — purge stale Oscar handoff after full close

- **Проблема:** после `copy_oscar_exit_handoff` + полного закрытия Oscar зомби `oscarPromotedAt` оставался в RAM copy-trader → лидерские `add` игнорировались (`oscar_promoted_handoff`) при пустом кошельке (ANSEM 12.07 ~21:55).
- **Что сделано:** `purgeStaleOscarHandoffPosition` — если кошелёк пуст и Oscar open snapshot без mint, сброс memory + `finalizeCopyLeaderOscarHandoffClose` на диске перед mirror buy/sell.
- **Откат:** revert коммита; `pm2 reload copy-trader --update-env`.

---

## [1.11.583] — 2026-07-12

**Тег:** `sa-alpha-1.11.583`

### Awakening — early vol5m spike trigger (shadow)

- **Проблема:** сигнал ждал `vol1h ≥ 8k` → вход в конце часового ралли (2vvw3, FeMb#2), не в начале пробуждения.
- **Что сделано:** `evaluateAwakeningSignal` — gate по `vol5mSpikeVs6hMult` (vol5m / prior-6h 5m-avg) и `vol5mSpikeVs1hMult`; убран pass/fail на `minVol1hUsd`. Env: `AWAKENING_VOL5M_SPIKE_MIN_MULT` (8), `AWAKENING_VOL5M_SPIKE_VS_1H_MIN_MULT` (4).
- **Откат:** revert коммита или вернуть старый `awakening-signal.ts`; `pm2 reload awakening-catcher --update-env`.

### Trend veto v2 + Telegram; Mem Swan 2h / top-40 / breadth

- **Trend veto v2:** ski-slope rule, 3d-decline path, смягчённые пороги (`minDaysSinceHigh=3`, `maxPxVsHigh=55%`, ski `42%`). Config + `trend-structure-veto.ts` + тесты.
- **Telegram:** `trend-structure-veto-telegram.ts` — уведомление когда dip и все пороги пройдены, единственный блокер `trend_veto_*`, нет open по mint. `LIVE_TREND_VETO_TELEGRAM_*`.
- **Mem Swan:** окно **2h**, top-**40**, breadth-триггер (65% red + EW −8%); port swan parity.
- **Откат:** `PAPER_TREND_STRUCTURE_VETO_ENABLED=0`, `LIVE_TREND_VETO_TELEGRAM_ENABLED=0`, вернуть `LIVE_MEM_SWAN_ROLL_MIN=360` + reload.

---

## [1.11.581] — 2026-07-12

**Тег:** `sa-alpha-1.11.581`

### pending-leg PG refresh — solo-fetch для open mint с pending entry-split leg

- **Причина:** при 2-минутном `sa-meteora` и `PAPER_LIVE_LERA_STALE_PRICE_BLOCK_MS=120000` вторая нога сплита блокировалась `price_stale_block` (ANSEM 12.07 ~02:04): PG `ts` не молодел между тиками коллектора.
- **Что сделано:** модуль `pending-leg-pg-refresh.ts` — для open mint с pending legs 2–8: DexScreener solo-fetch (cooldown **45s**) → upsert в `{source}_pair_snapshots` с **30s** `ts`-бакетами. Вызов из `entry-split-fast-poll` и `tracker` перед `tryLiveStagedEntryV2TrackerStep`. Env: `PAPER_LIVE_PENDING_LEG_PG_REFRESH_*`.
- **Тесты:** `pending-leg-pg-refresh.test.ts`.
- **Откат:** `PAPER_LIVE_PENDING_LEG_PG_REFRESH_ENABLED=0` + reload, или revert `1.11.581`.

---

## [1.11.580] — 2026-07-11

**Тег:** `sa-alpha-1.11.580`

### knife-catcher — Oscar-style infinite TP grid + BE/trail; kill −30%; leg2 off

- **Причина:** 3-rung ladder с 30% partial TP оставлял слишком много хвоста; entry-path хороший, exit терял на просадках. Нужна лестница как у Live Oscar: бесконечная сетка, break-even после 1-й ступени, ladder-retrace после ≥2, peak trail.
- **Что сделано:** новый модуль `knife-exit-ladder.ts` (+5% grid, sell fracs 50/45/40/35%, BE floor 0%, trail arm +10% / drop 5%, kill **−30%**). Вторая нога avg-down **выключена** по умолчанию (`KNIFE_AVG_LEG_ENABLED=0`). PM2 env обновлён.
- **Тесты:** `knife-exit-ladder.test.ts`.
- **Откат:** revert `1.11.580` или вернуть старые `KNIFE_TP_LADDER_PCT` / `KNIFE_KILL_PCT=50` в `.env` + reload.

---

## [1.11.579] — 2026-07-11

**Тег:** `sa-alpha-1.11.579`

### awakening-catcher — ослаблены shadow-пороги для накопления сигналов

- **Причина:** за 12ч shadow — 398 eval, **0 signals**; главные блокеры: `vol_velocity<0.4`, `pool_age<48h`, `vol24h>250k`, `price_m5<2`.
- **Что сделано:** дефолты и PM2 env: vol5m 3k, vol1h 10k, vol24h cap 800k, pool age **24h**, vol_velocity **0.15**, mcap **150k**, liq **15k**, price_m5 **1%**, h24/h6 caps 120/80%, vol1h/vol6h **0.25**, vol1h/mcap **3.0**.
- **Откат:** revert `1.11.579` или вернуть прежние `AWAKENING_*` в `.env` + `pm2 reload awakening-catcher --update-env`.

---

## [1.11.578] — 2026-07-11

**Тег:** `sa-alpha-1.11.578`

### Live-Oscar discovery — unfreeze on tick timeout + stall alert + volume-leader audit

- **Причина:** зависший `discoveryTick` (PG fan-out > `PAPER_DISCOVERY_TICK_TIMEOUT_MS`) оставлял `discoveryInFlight` навсегда — discovery молчала часами (RCA mint `4ko5…`). Пустой SQL-пул при pinned volume-leaders не аудировался.
- **Что сделано:** при timeout сбрасываем `discoveryInFlight` + bump generation (следующий тик снова бежит). Watchdog `LIVE_DISCOVERY_STALL_ALERT_*` → `risk_note` + Telegram ALERT. Обязательный `live_discovery_eval` audit для volume-leader tier; `universe_miss` когда SQL пуст, а top runners pinned.
- **Флаги (live-oscar PM2):** `LIVE_DISCOVERY_STALL_ALERT_ENABLED=1`, `ALERT_MS=300000`, `BOOT_GRACE_MS=180000`, `REPEAT_MS=600000`.
- **Тесты:** `discovery-stall-health.test.ts`, `discovery-audit-volume-leader.test.ts`.
- **Откат:** revert `1.11.578` или `LIVE_DISCOVERY_STALL_ALERT_ENABLED=0`.

---

## [1.11.577] — 2026-07-11

**Тег:** `sa-alpha-1.11.577`

### Awakening-catcher — Alchemy WS fallback (QuickNode 403 на VPS)

- **Причина:** на Oscar VPS `SA_RPC_WS_URL` в pm2/.env указывал на мёртвый QuickNode → awakening WS 403/EPROTO, сигналы не ловились.
- **Что сделано:** `loadAwakeningConfig` — `AWAKENING_RPC_WS_URL` override; если resolved WS — `quiknode.pro`, автоматически берёт Alchemy WSS из `ALCHEMY_HTTP_URL`/`SA_RPC_HTTP_URL`.
- **Откат:** revert `1.11.577`.

---

## [1.11.577] — 2026-07-11

**Тег:** `sa-alpha-1.11.577`

### Awakening-catcher — Alchemy WS вместо мёртвого QuickNode в pm2 env

- **Причина:** на Oscar VPS `SA_RPC_WS_URL` в pm2 env указывал на QuickNode (403/EPROTO); awakening-catcher не получал stream-пульс.
- **Что сделано:** `loadAwakeningConfig` — `AWAKENING_RPC_WS_URL` override; если resolved WS — `quiknode.pro`, автоматически берёт Alchemy WSS из `ALCHEMY_HTTP_URL`/`SA_RPC_HTTP_URL`.
- **Тесты:** +2 в `awakening-catcher.test.ts`.
- **Откат:** revert `1.11.577`.

---

## [1.11.576] — 2026-07-11

**Тег:** `sa-alpha-1.11.576`

### Awakening-catcher — Telegram в shadow: «поймал сигнал, покупка не выполнена»

- **Причина:** в shadow awakening пишет только в журнал — непонятно, что сигнал пойман, но реальный вход не ставится; LERA по своей воронке может купить ту же монету независимо.
- **Что сделано:** `formatAwakeningSignalTelegramHtml` (`awakening-telegram.ts`) — при прохождении сигнала в **shadow** шлёт в Telegram явное объяснение: гипотетический вход $10, покупка awakening **не выполняется**, live-lera может купить отдельно. В **live** — текст про очередь `dormant_awakening`. `AWAKENING_TELEGRAM_ENABLED` default **ON** (config + ecosystem).
- **Тесты:** `tests/awakening-catcher.test.ts` (+2 на shadow/live текст).
- **Откат:** `AWAKENING_TELEGRAM_ENABLED=0` или `AWAKENING_CATCHER_ENABLED=0`; revert `1.11.576`.

---

## [1.11.575] — 2026-07-11

**Тег:** `sa-alpha-1.11.575`

### Knife-catcher — устранена настоящая причина OOM/«ничего не ловит»: runaway Jupiter-poll → раннауэй общего rate-gate

- **Причина (корень инцидента 1.11.574):** `startKnifeJupiterPoll` крутит `setInterval(pollOnce, 2s)` **без in-flight-гварда** — новый цикл стартует каждые 2с, даже если предыдущий ещё ждёт Jupiter-квоты. Когда квоты медленные, циклы накладываются и каждый резервирует до `maxMintsPerTick` (15) будущих слотов в **общем кросс-процессном Jupiter rate-gate** (`jupiter-api-gate.ts`, файл `data/jupiter-api-gate.json`). У knife-процесса `JUPITER_DEVELOPER_TIER` не задан → `maxRps=1` → каждый резерв двигает `nextAllowedMs` на +1000мс. В итоге `nextAllowedMs` уехал **на ~97 минут в будущее** — это заморозило Jupiter-квоты **у всех** (в т.ч. боевого live-oscar), а в самом knife-процессе накопились тысячи «спящих» промисов/сокетов/AbortController'ов → **~5.8ГБ RSS → kernel OOM** (1.11.574). Параллельно knife сам не получал своевременных квот → `obsTotal:0` → **ноль входов**.
- **Что сделано:** in-flight-гвард в `startKnifeJupiterPoll` — одновременно выполняется **не более одного** цикла опроса (тело вынесено в `pollCycle`, `pollOnce` пропускает тик, пока `inFlight`). Теперь knife физически не может резервировать слоты быстрее, чем gate их выдаёт: gate не раскручивается, live-oscar не голодает, память ограничена одной последовательной цепочкой квот.
- **Инцидент-ремедиация на VPS:** остановлен runaway-poll, сброшено состояние gate (`data/jupiter-api-gate.json`) — `nextAllowedMs` вернулся к `now`, live-oscar сразу возобновил Jupiter buy-probe.
- **Тесты:** `tests/knife-jupiter-poll-guard.test.ts` (гвард: при зависшей квоте — ровно один цикл, `maxActiveQuotes===1`).
- **Откат:** revert коммита `1.11.575`. Изолированный воркер — Oscar/LERA не затронуты (общий `jupiter-api-gate` только выигрывает от снижения нагрузки).

---

## [1.11.574] — 2026-07-11

**Тег:** `sa-alpha-1.11.574`

### Knife-catcher — self-watchdog против утечки памяти → kernel OOM (защита всей VPS) + прунинг states

- **Причина (инцидент 2026-07-11 08:00:35 UTC):** процесс `knife-catcher` утёк по памяти до **~5.8 ГБ RSS** (`total-vm 63GB`) и был убит **ядром** (`Out of memory: Killed process … (node) … oom_score_adj:0`, `redis-server invoked oom-killer`, `global_oom`, exit 137). pm2 `max_memory_restart: 350M` утечку **не поймал** — при тормозящем/тризингующем event-loop телеметрия pm2 не обновляется. Побочно: ловец **угрожал co-tenant'ам** VPS (redis, dc-trader, live-oscar). Из-за постоянных рестартов (kernel OOM + краш-луп) in-memory буфер цен обнулялся, а rolling-flush-детектору нужен 10-мин хай → он почти всегда был в прогреве и **не ловил проливы** («за 6ч 0 flush»).
- **Что сделано:**
  - Новый чистый модуль `src/scripts/knife-watchdog.ts` (`knifeWatchdogVerdict`, без нативных зависимостей → юнит-тестируемый). В `knife-catcher.ts` — таймер-сторож (не `unref`, тик `KNIFE_WATCHDOG_CHECK_SEC`=15с): при `RSS >= KNIFE_WATCHDOG_RSS_MB` (420) **или** «немоте» (нет ни одного observation `>= KNIFE_WATCHDOG_STALL_SEC`=600с при непустом вотчлисте) — пишет `knife_watchdog_exit` в журнал и делает **чистый `process.exit(1)`** задолго до kernel-OOM; pm2 поднимает свежий процесс за 5с.
  - Прунинг `states`: при обновлении вотчлиста снимаемые монеты (idle, без `pendingDump`) удаляются из Map — память ограничена набором наблюдаемых + открытых позиций (раньше Map рос неограниченно по ротации вотчлиста).
  - Снижение утечки в общем gRPC-consumer'е (`shyft-shadow-consumer.ts`): на завершении сессии — `stream.removeAllListeners()` и best-effort `client.close()/destroy()`, чтобы буферы мёртвой сессии освобождались при churn reconnect/resubscribe (обратно совместимо, live-oscar не затронут по поведению).
  - Heartbeat теперь печатает `rssMb`.
- **Флаги (все в ecosystem, `.env`-override):** `KNIFE_WATCHDOG_RSS_MB` (420), `KNIFE_WATCHDOG_STALL_SEC` (600), `KNIFE_WATCHDOG_CHECK_SEC` (15). `0` отключает соответствующий гвард.
- **Тесты:** `tests/knife-watchdog.test.ts` (7).
- **Откат:** `KNIFE_WATCHDOG_RSS_MB=0 KNIFE_WATCHDOG_STALL_SEC=0` (отключить сторож, без деплоя) или revert коммита `1.11.574`. Изолированный воркер — Oscar/LERA не затронуты.

---

## [1.11.573] — 2026-07-11

**Тег:** `sa-alpha-1.11.573`

### Awakening-catcher — ловля «пробуждения» тихих/новых монет (GMGN-style), изолированный воркер

- **Причина:** воронка Oscar/LERA видит только монеты, уже попавшие в PG по порогам ликвы/объёма — то есть на которых **уже** сконцентрирован ритейл. Первые растущие объёмы по **тихим до этого** (или совсем новым) монетам мы структурно пропускаем. GMGN Trending ловит их потому, что это глобальный он-чейн индексер, а не фильтр внешних API.
- **Что сделано:** новый **изолированный** PM2-воркер `awakening-catcher` (`src/scripts/awakening-catcher.ts`, default **OFF**). Гибрид: дешёвый `logsSubscribe` (Alchemy WS, программы pump.fun + pumpswap-amm) детектит активность по минтам (`MintActivityTracker`), затем **по требованию** дёргает DexScreener для метрик (5м/1ч/6ч/24ч объёмы, ликва, mcap, price-change) и оценивает паттерн «dormant-low awakening» чистой функцией `evaluateAwakeningSignal`. Fallback-источник — чтение `stream_events` из PG (`AWAKENING_STREAM_SOURCE=pg`). Плюс GeckoTerminal trending как второй источник кандидатов. Никакой лишней нагрузки на PG и без сжигания RPC-лимитов (батчи, tick 10с, cap кандидатов).
- **Интеграция:** сигналы идут в `live-lera10` через файловую очередь `data/live/awakening-entry-queue.jsonl` (`enqueueAwakeningLiveEntry` → `processAwakeningLiveEntryQueue` в discovery-цикле `main.ts`). Отдельная торговая линия `dormant_awakening` (union в `types.ts`/`live-oscar-scalp-wave.ts`/`live-oscar-mcap-tier.ts`/`dip-clones.ts`), чтобы обойти гварды, которые иначе режут этот паттерн (`old-mint-dormant-volume-spike-guard` и т.п.). On-chain overlay: `shyft-shadow-consumer` теперь пробрасывает `wallet` из декодированного свопа (для кластер-детекта).
- **Безопасность:** default `AWAKENING_MODE=shadow` (гипотетические входы только в журнал), live-вход за флагом `AWAKENING_LIVE_ENTRY_ENABLED` и лимитом `AWAKENING_MAX_OPEN_POSITIONS` (≤3) на линии `dormant_awakening`; проверка denylist/blacklist перед исполнением. RPC резолвится Alchemy-first (`resolve-solana-rpc-url.ts`: `ALCHEMY_WS_URL`/`ALCHEMY_HTTP_URL`). `pumpswap-amm` добавлен в `KNOWN_PROGRAMS`.
- **Флаги (все в `.env.example`):** `AWAKENING_CATCHER_ENABLED`, `AWAKENING_MODE`, `AWAKENING_STREAM_SOURCE` (`ws`|`pg`), `AWAKENING_LIVE_ENTRY_ENABLED`, `AWAKENING_MAX_OPEN_POSITIONS`, пороги/кулдауны/Telegram.
- **Тесты:** `tests/awakening-catcher.test.ts`.
- **Откат:** `AWAKENING_CATCHER_ENABLED=0` (воркер OFF) и/или `AWAKENING_LIVE_ENTRY_ENABLED=0` (live-вход OFF) — мгновенно; либо revert коммита `1.11.573`. Линия изолирована, откат не затрагивает Oscar/остальные линии LERA.

---

## [1.11.572] — 2026-07-11

**Тег:** `sa-alpha-1.11.572`

### Rolling-flush entry veto — не покупать «затухающую горку» / падающий нож

- **Причина:** боевая `live-lera` купила `DEXBULL` (`6xCtR2Eq…`) 2026-07-10 16:22 на свежем 30м/60м-дне (−17%/−21% от хая окна, без отскока), через 16с усреднилась вниз на −21%, затем ликвидность высушили → закрытие `LIQ_DRAIN`, **−99.76% / −$498.82**. Существующие вето это пропускали: recovery-veto молчит без отскока, local-high-veto молчит вдали от хая; dip-логика приняла обвал −31% за «дип».
- **Что сделано:** новое чистое вето входа `evaluateRollingFlushVeto` (`dip-detector.ts`), встроено в единый protector-блок `dip-clones.ts` (после local-high, пропускается для `post_crash_fast`/`stress_kill_reentry`). Логика как у `detectRollingFlush` (knife-flush-detector), но на агрегированных PG-хаях/лоу окон: блок, если по какому-то окну просадка от хая `>= MIN_DUMP%` и `<= MAX_DUMP%`, И цена ещё в пределах `NEAR_LOW%` от лоу окна (не отскочила = нож). Отскочивший дип проходит.
- **Калибровка на реальных минутных снапшотах DEXBULL:** за 10–15м просадка была всего ~4% (быстрый слив был раньше + «стабилизация»), поэтому дефолт окон — `15,30,60`; `MIN_DUMP=10%`, `MAX_DUMP=45%`, `NEAR_LOW=4%`. На этих порогах DEXBULL режется по 30м/60м, обычные дипы — нет.
- **Флаги:** `PAPER_DIP_ROLLING_FLUSH_VETO_ENABLED` (default **OFF** → Oscar не затронут), `..._WINDOWS_MIN`, `..._MIN_DUMP_PCT`, `..._MAX_DUMP_PCT`, `..._NEAR_LOW_PCT`. Включить на LERA: `PAPER_DIP_ROLLING_FLUSH_VETO_ENABLED=true`.
- **Тесты:** `tests/papertrader-dip-rolling-flush-veto.test.ts` (6, вкл. реальный DEXBULL-контекст).
- **Примечание:** общие файлы `dip-clones.ts` / `.env.example` в этом коммите несут также структурные правки awakening-линии (union `dormant_awakening`, awakening env) — сама фича awakening в следующем коммите `1.11.573`.
- **Откат:** `PAPER_DIP_ROLLING_FLUSH_VETO_ENABLED=false` (мгновенно, без деплоя) или revert коммита `1.11.572`.

---

## [1.11.571] — 2026-07-11

**Тег:** `sa-alpha-1.11.571`

### Knife-catcher — rolling-flush trigger + holder-gate unknown-data fix

- **Причина:** ловец ножей входил только на «китовый» слив (одна крупная продажа + падение от 2-мин хая). Плавные/распределённые проливы −10…−14% за 5–15 мин (напр. Cupsey `6Nwar…` 00:04 МСК: пик 0.006685 → 0.005811 = −13%) проходили мимо. Плюс analytics-gate резал почти весь watchlist по `knife_holders<3000(0)`, когда `holder_count` неизвестен (pump.fun-минты не в `tokens`).
- **Rolling-flush:** новый чистый модуль `knife-flush-detector.ts` (`detectRollingFlush`) — вход по просадке от недавнего хая в окне (без единичной whale-продажи). Врезан в idle-фазу `onTrustedPriceTick` только на `jupiter`-тиках; эмитит `knife_flush_detected`. Дефолты: окно 600с, min-dump 10%, `preDumpHighMs` 120→600с, `maxHoldMs` 0→2700с.
- **Holder-gate:** `holderGateSkipWhenUnknown` (default ON) — при `holder_count=0` пропускаем min-holder floor вместо hard-reject (floor фильтрует ИЗВЕСТНЫЙ мусор, не неизвестные данные).
- **Env:** `KNIFE_FLUSH_TRIGGER_ENABLED=1`, `KNIFE_FLUSH_WINDOW_SEC=600`, `KNIFE_FLUSH_MIN_DUMP_PCT=10`, `KNIFE_PRE_DUMP_HIGH_SEC=600`, `KNIFE_MAX_HOLD_SEC=2700`, `KNIFE_HOLDER_GATE_SKIP_WHEN_UNKNOWN=1`.
- **Файлы:** `knife-flush-detector.ts` (new), `knife-catcher.ts`, `knife-analytics-gate.ts`, `tests/knife-flush-trigger.test.ts`.

**Откат:** `KNIFE_FLUSH_TRIGGER_ENABLED=0` + `KNIFE_HOLDER_GATE_SKIP_WHEN_UNKNOWN=0` (env, без redeploy) или redeploy `sa-alpha-1.11.570`.

---

## [1.11.570] — 2026-07-10

**Тег:** `sa-alpha-1.11.570`

### Live Oscar — cross-source quote divergence guard (Meteora phantom-dip fix)

- **Причина:** на минтах с фрагментированной ликвидностью (Meteora, много пулов) живой квот DexScreener/Birdeye мог кратковременно разойтись с ценой пула и перезаписать `price_usd` для дип-гейта → фантомный «−33% дип» → ложный вход (кейс ANSEM `9cRCn9…`: quote 0.1686 vs PG 0.2123, реальная цена ~0.212 по всем пулам; вход и «+11% TP» — оба по битому квоту).
- **Фикс:** перед адаптацией квота как цены входа проверяется расхождение с PG-снапшотом; при `> liveOscarQuoteMaxDivergencePct` (по умолч. 12%) перезапись цены/mcap/liq/vol отклоняется, дип-гейт считает по PG, эмитится `live_quote_divergence_reject`. Наблюдаемость сохранена (`live_birdeye_market_quote` пишется как прежде).
- **Env:** `LIVE_OSCAR_QUOTE_DIVERGENCE_GUARD_ENABLED=1` (default on), `LIVE_OSCAR_QUOTE_MAX_DIVERGENCE_PCT=12`.
- **Файлы:** `pricing/discovery-market-quote.ts`, `config.ts`, `discovery/dip-clones.ts`, `live/events.ts`, `tests/discovery-quote-divergence.test.ts`.

**Откат:** `LIVE_OSCAR_QUOTE_DIVERGENCE_GUARD_ENABLED=0` (env, без redeploy) или redeploy `sa-alpha-1.11.569`.

---

## [1.11.569] — 2026-07-10

**Тег:** `sa-alpha-1.11.569`

### Live Oscar — disable Wave B + hard time-stop

- `PAPER_LIVE_OSCAR_WAVE_B_TIME_STOP_HOURS=0`, `PAPER_LIVE_OSCAR_HARD_TIME_STOP_HOURS=0`.
- Owner: no auto time-stop; manual exit after ~2d if needed. Half8/kill/trail/breakeven unchanged.
- Broad half8 backtest (N≈3500): short flush TS cuts PnL; sit / ~36h ≈ max PnL.

**Откат:** вернуть `WAVE_B_TIME_STOP_HOURS=12`, `HARD_TIME_STOP_HOURS=24` в `ecosystem.config.cjs` и redeploy.

---

## [1.11.568] — 2026-07-10

**Тег:** `sa-alpha-1.11.568`

### Live Oscar staged avg — −20% OFF, −10% = 50% entry, prod 3×$500 slices

- **−20% avg leg OFF** все тиры (`THIRD_LEG_USD=0`, LOW second avg OFF).
- **−10% avg = 50% entry-split** по тиру (resolver в коде): prod $1500, LOW $500, micro $150; max prod **$4500**, LOW **$1500**.
- **Prod only:** avg @ −10% исполняется **3×$500** (delay 10s, corridor +3/−5% vs signal anchor); LOW/micro — один лег.
- **LOW lane ON:** 2×$500 entry + avg $500 @ −10%.
- **Файлы:** `avg-split-legs.ts`, `live-oscar-entry-sizing.ts`, `live-staged-entry-gates.ts`, `live-staged-entry-lifecycle.ts`, `store-restore.ts`, `types.ts`, `ecosystem.config.cjs`, `tests/live-oscar-entry-sizing.test.ts`.

**Откат:** redeploy `sa-alpha-1.11.564`; вернуть `SECOND_LEG_USD` / `THIRD_LEG_USD` / LOW lane env в ecosystem.

---

## [1.11.564] — 2026-07-09

**Тег:** `sa-alpha-1.11.564`

### Live — hot-tick sell probe: cross-check vs independent price anchors (DONALT RCA)

- **Проблема:** ghost Jupiter sell-probe на hot-tick пути триггерил killstop/prearm без проверки (DONALT lera10: −92% в журнале при реальном −23%).
- **Фикс:** перед exec-кэшем, killstop и prearm — probe должен согласоваться **хотя бы с одним** якорем (±25%): `lastObserved`, entry market/avg, **PG snapshot**, **DexScreener/Birdeye**, tick MTM; Shyft — **опциональный** якорь, не обязателен.
- **Журнал:** `live_hot_tick_quote_reject` с `anchorChecks[]`.
- **Файлы:** `hot-tick-price-anchors.ts`, `sell-price-sanity.ts`, `open-position-hot-tick.ts`, `tracker.ts`.

**Откат:** redeploy `sa-alpha-1.11.563`; hot-tick без cross-check (риск ложного killstop на ghost quote).

---

## [1.11.563] — 2026-07-09

**Тег:** `sa-alpha-1.11.563`

### Live Oscar — единый prod tier от $2M: 6×$500 entry, avg −10%/$500 + −20%/$1000

- **Тиры:** micro / low / scalp_wave / runner_probe / runner_lite — **OFF** (без изменений). Discovery min mcap **$2M** — единый prod tier от $2M (low lane OFF).
- **Entry split:** `3×$1000` → **`6×$500`** @ 10s (+3/−5% corridor) = **$3000** на вход (`PAPER_POSITION_USD`).
- **Усреднение (единственные докупки после entry):** −10% → **$500**, −20% → **$1000** (было $1000/$1000).
- **Max cap:** `LIVE_MAX_POSITION_USD` и prod band caps **$5000 → $4500** ($3000 entry + $500 + $1000 avg).
- **Без прочих докупок:** `PAPER_DCA_LEVELS` пуст, `LIVE_ENTRY_SCALE_IN_ENABLED=0` (без изменений).
- **Файлы:** `ecosystem.config.cjs` (live-oscar PM2 env), `tests/live-oscar-entry-sizing.test.ts`.

**Откат:** redeploy `sa-alpha-1.11.562` или вернуть `3×$1000` / avg `$1000/$1000` / max `$5000` в `ecosystem.config.cjs` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.562] — 2026-07-08

**Тег:** `sa-alpha-1.11.562`

### Live Oscar — own-book лебедь / портфельный стоп (второй, независимый детектор; liquidate)

- **Что:** новый модуль `src/live/mem-swan-portfolio.ts` — детектор ликвидации по **нашим собственным открытым позициям**, независимый домен отказа от `mem-swan.ts` (внешний индекс топ-80 по PG-снапшотам). Считает equal-weight просадку открытого портфеля по его **живым маркам** (`curMetric`: snapshot → Jupiter → Shyft), поэтому срабатывает и когда внешний индекс «ослеп» (сбой коллекторов/БД). Триггер: EW ≤ −`EW_DROP_PCT` (25%) за `ROLL_MIN` (6h) при ≥ `MIN_POSITIONS` (8) участвующих позициях; на rising edge — закрытие ВСЕХ позиций (`KILLSTOP`, один раз на эпизод).
- **Зачем (RCA-follow-up):** ответ на риск «анти-фантом внешнего индекса промолчит во время реального лебедя». Own-book сигнал не зависит от вселенной топ-80 и срабатывает ровно тогда, когда бьёт по нашему капиталу.
- **Калибровка (бэктест 608 реальных позиций Оскара, май–июль, цены из `*_pair_snapshots`, hold 24h):** 6h/−25%/≥8 → ≈12 эпизодов за 2 мес (≈6/мес), ликвидация vs холд **+$13.5k** (89/43 в плюс). Отличие от внешнего индекса: own-book структурно НЕ ловит рыночные лебеди при малой нашей экспозиции (их держит внешний индекс) — он де-рискует, когда просаживается именно наш book. Оба детектора дополняют друг друга.
- **Прогрев:** история марок в памяти → после рестарта ~`ROLL_MIN` (6h) нет baseline; в это окно защиту держит внешний индекс (PG-бэкфилл 6h).
- **Анти-фантом:** < `MIN_POSITIONS` участвующих позиций (в т.ч. прогрев) → `valid=false`, не ликвидируем; кэш тика старше `MAX_STALE_SEC` (180s) → rising edge подавляется.
- **Конфиг:** `LIVE_MEM_SWAN_PORT_*` в `config.ts` + `ecosystem.config.cjs` (`MODE=liquidate` по решению владельца) + `.env.example`. Хук в `trackerTick` (tick-top sweep + запись марок в per-mint loop). Юнит-тесты `tests/live-mem-swan-portfolio.test.ts` (pure-логика, rising edge, прогрев, staleness).

**Откат:** `LIVE_MEM_SWAN_PORT_MODE=shadow` (или `LIVE_MEM_SWAN_PORT_ENABLED=0`) в `ecosystem.config.cjs` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`; либо redeploy `sa-alpha-1.11.561`. Внешний `mem-swan` не затрагивается.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.561] — 2026-07-08

**Тег:** `sa-alpha-1.11.561`

### Live Oscar — чёрный лебедь: shadow → **liquidate** (боевой режим)

- **Изменение:** `LIVE_MEM_SWAN_MODE` в `ecosystem.config.cjs` переведён `shadow → liquidate`. На rising edge подтверждённого лебедя (EW ≤ −16% за 6h по топ-80 раннерам, ≥40 валидных, свежий кэш) live-oscar **закрывает все открытые позиции** on-chain (`KILLSTOP`, один раз на эпизод). Только код/логика из 1.11.560 — новых модулей нет.
- **Обоснование:** явное решение владельца. События редкие (бэктест: ~1.8/мес, 4 за 68 дней), риск ложняка низкий; нетто ликвидации vs холд +$2.9k…+$9.4k за 2 мес.
- **Анти-фантом без изменений:** нет срабатывания при < `MIN_RUNNERS` валидных раннеров или устаревшем кэше (`MAX_STALE_SEC`); при ошибке БД состояние не флипается.

**Откат:** `LIVE_MEM_SWAN_MODE=shadow` (или `LIVE_MEM_SWAN_ENABLED=0`) в `ecosystem.config.cjs` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`; либо redeploy `sa-alpha-1.11.560`.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.560] — 2026-07-08

**Тег:** `sa-alpha-1.11.560`

### Live Oscar — детектор чёрного лебедя + ликвидация позиций (RCA просадок июня/июля; shadow, trading unchanged)

- **Проблема (RCA):** большая часть месячного профита съедается **редкими** (~1–2×/мес) событиями, когда топ-раннеры по объёму льются **одновременно и глубоко**. Мем-режимный гейт (`mem-regime.ts`) гейтит **входы** на частом broad risk-off, но не закрывает уже **открытые** позиции при резком синхронном сливе (6–7 июля).
- **Реальный бэктест (608 позиций Оскара, 1 мая–8 июля; только цена входа, дальше — реальные цены `*_pair_snapshots`, `ansum` исключён):** вселенная = топ-80 по пиковому 1h-объёму, equal-weight возврат за 6h. Триггер `EW ≤ −16%` **по одной глубине** (без breadth, без подтверждения — подтверждение продаёт на дне после отскока) даёт **4 события за 68 дней** (~1.8/мес: 29 мая, 26 июня, 1 июля, 7 июля). Ликвидация всех открытых позиций на триггере vs удержание: **+$2.9k (12h) / +$4.6k (24h) / +$9.4k (48h)**, драйвер — 7 июля (+$5.2k); единственный явный ложняк — 26 июня (−$1.6k). Частые/отложенные варианты — в минус (Оскар — дип-байер, большинство просадок отскакивает).
- **Модуль:** `src/live/mem-swan.ts` — equal-weight индекс топ-N раннеров на **фоновом** интервале (вне hot-path), синхронный резолвер читает кэш. Анти-фантом: не срабатывает при `< MIN_RUNNERS` валидных раннеров и при устаревшем кэше (`MAX_STALE_SEC`) — **никогда не ликвидируем на слепых данных**. Триггер — по rising edge (один раз на эпизод).
- **Ликвидация:** `src/live/mem-swan-liquidate.ts` — на rising edge закрывает ВСЕ открытые позиции через `trackerForceFullExitLive` (переиспользован; параметризован `exitReason`/`bypassPolicyBlock`, exit-reason `KILLSTOP` — policy-allowed). Цена продажи — spot из снапшота (fallback Jupiter); без цены — позиция пропускается. Встроено в начало `trackerTick` (после orphan-reconcile), только в live при `LIVE_MEM_SWAN_ENABLED`.
- **Режимы:** `off` | `shadow` (журналит `mem_swan_would_liquidate` — какие позиции закрыл бы, **без продаж**) | `liquidate` (продаёт). Раскатано в **`shadow`**. Новых JSONL-kind нет (переиспользуем `risk_note`/`risk_block`).
- **Конфиг:** `LIVE_MEM_SWAN_*` в `src/live/config.ts` + `.env.example` + `ecosystem.config.cjs`.
- **Тесты:** `tests/live-mem-swan.test.ts` (метрики top-N/equal-weight, классификация глубины, анти-фантом, rising-edge, резолвер).

**Откат:** `LIVE_MEM_SWAN_ENABLED=0` (или `LIVE_MEM_SWAN_MODE=off`) + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`; либо redeploy `sa-alpha-1.11.559` / `git revert` коммита.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.559] — 2026-07-08

**Тег:** `sa-alpha-1.11.559`

### Live Oscar — мем-режимный гейт ликвидности (RCA слива 6–8 июля; shadow, trading unchanged)

- **Проблема (RCA):** 6–8 июля SOL стоял, а вся runner-вселенная мемкоинов просела ~−20% (пик→дно), breadth 55–71% красных. BTC/SOL-гейты молчали — отток был **внутри** мем-сегмента (ритейл ушёл в новые внешние мемкоины на Robinhood). Внешний источник не виден, но **следствие** — синхронный broad risk-off — видно в наших же `*_pair_snapshots`.
- **Модуль:** `src/live/mem-regime.ts` — equal-weight breadth/импульс-индекс по 5 DEX-снапшот-таблицам на **фоновом** интервале (вне hot-path покупок), синхронный резолвер гейта читает кэш. Сигналы risk-off (≥2 из 3): доля красных раннеров ≥ `BREADTH_RED_PCT`, equal-weight средний доход ≤ −`EW_DROP_PCT`, median ≤ −`MED_DROP_PCT`; гистерезис `CONFIRM_WINDOWS`; fail-open при устаревании кэша.
- **Интеграция:** `phase5-gates.ts` — рядом с BTC-гейтом, только для **новых** `buy_open` в live. `gate` → `risk_block` (`limit:'mem_regime_risk_off'`); `shadow` → `risk_note` (`mem_regime_shadow_would_block`); периодические/переходные снимки — `risk_note` (`mem_regime_tick`/`mem_regime_transition`). Новых JSONL-kind не добавлялось (переиспользуем `risk_note`/`risk_block`).
- **Конфиг:** `LIVE_MEM_REGIME_*` в `src/live/config.ts` + `.env.example`; в `ecosystem.config.cjs` раскатано в **`shadow`** (наблюдение/журнал, без блокировки сделок). Переход в `gate` — после ≥48h shadow.
- **Тесты:** `tests/live-mem-regime.test.ts` (чистая логика: метрики/классификация/гистерезис/резолвер).

**Откат:** `LIVE_MEM_REGIME_ENABLED=0` (или `LIVE_MEM_REGIME_MODE=off`) + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`; либо redeploy `sa-alpha-1.11.558` / `git revert` коммита.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.558] — 2026-07-06

**Тег:** `sa-alpha-1.11.558`

### Live Oscar — Shyft gRPC reconnect resilience (RCA Jul-6, trading unchanged)

- **Backoff reset:** reconnect backoff сбрасывается на 5s только после **первого observation** или **30s** стабильного соединения (`SHYFT_STREAM_STABLE_MS`), а не сразу после `subscribe()` — убирает 6s reconnect hammer после resubscribe.
- **Circuit breaker:** после **5** fast-fail (<60s session) за **2 min** → cooldown **15 min** (`SHYFT_STREAM_CIRCUIT_*` env); статус `circuit_open` в журнале.
- **Ping guard:** `writableStream` инвалидируется до `end()` — нет `write after end` при resubscribe.
- **In-place mint update:** при изменении mint-set на ±1 mint и стабильном stream — `stream.write()` вместо full teardown.
- **Trading unchanged:** `SHYFT_PRICE_PRIMARY_*=0`, shadow-only observability.

**Откат:** redeploy `sa-alpha-1.11.557`; либо `git revert` этого коммита + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.557] — 2026-07-06

**Тег:** `sa-alpha-1.11.557`

### Live Oscar — Shyft shadow mode (stream health + vs Dex, trading unchanged)

- **Shadow ON:** `SHYFT_SHADOW_ENABLED=1`, `SHYFT_STREAM_ENABLED=1` (+ legacy `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=1`). gRPC consumer reconnect fixes retained (debounced full reconnect, connect grace 30s, stale watchdog). **Open-mints-only** (`SHYFT_SHADOW_OPEN_MINTS_ONLY=1`, max 64 mints) — anti Jul-4 reconnect storm from discovery churn.
- **Trading unchanged:** `SHYFT_PRICE_PRIMARY_*=0`, `SHYFT_DEFI_MCAP_ENABLED=0`, `BIRDEYE_PRIMARY_ENABLED=0` — prod path Dex→PG.
- **Новые journal kinds:** `live_shyft_stream_health` (reconnects, observations, uptime), `live_shyft_vs_dex_quote` (stream vs DexScreener price/mcap/liq deltas + prod baseline).
- **Модули:** `src/papertrader/stream/shyft-shadow-observe.ts`; health in `shyft-shadow-consumer.ts`.

**Откат:** `SHYFT_SHADOW_ENABLED=0`, `SHYFT_STREAM_ENABLED=0`, `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=0` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`; либо redeploy `sa-alpha-1.11.556`.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.556] — 2026-07-06

**Тег:** `sa-alpha-1.11.556`

### Live Oscar — post-exit re-entry fork (−10% / +20%)

- **Fork после любого exit:** между last exit и −N% dip — block (`reentry_wait_dip_below_exit`); при −N% — re-entry; при +M% breakout — bypass dip-wait, стандартные discovery/dip gates (`reentry_breakout_standard_dip` в observability).
- **Fix manlet-class churn:** profit exit больше не разрешает rebuy на той же цене после истечения 10m cooldown — fork держится в окне `LIVE_REENTRY_GATE_MAX_AGE_HOURS`.
- **Env:** `LIVE_REENTRY_BREAKOUT_ABOVE_EXIT_PCT=20` (alias `PAPER_REENTRY_BREAKOUT_ABOVE_EXIT_PCT`); dip — `LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT=10` (alias `PAPER_REENTRY_MIN_DIP_BELOW_EXIT_PCT`).

**Откат:** `git checkout sa-alpha-1.11.555 -- ecosystem.config.cjs src/papertrader/config.ts src/papertrader/discovery/dip-clones.ts tests/live-reentry-hybrid-gate.test.ts tests/execution-post-exit-reentry-gate.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.555] — 2026-07-06

**Тег:** `sa-alpha-1.11.555`

### Live Oscar — LIQ_DRAIN / liq-watch OFF

- **`PAPER_LIQ_WATCH_ENABLED=0`**, **`PAPER_LIQ_WATCH_FORCE_CLOSE=0`** на live-oscar — нет force-close по просадке ликвидности; tracker не читает liq-watch снапшоты.
- Откат false-positive LIQ_DRAIN (stale PG / DexScreener disagreement).

**Откат:** `PAPER_LIQ_WATCH_ENABLED=1`, `PAPER_LIQ_WATCH_FORCE_CLOSE=1` в `ecosystem.config.cjs` live-oscar; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

## [1.11.554] — 2026-07-06

**Тег:** `sa-alpha-1.11.554`

### Live Oscar — Birdeye primary OFF, free-stack pricing

- **`BIRDEYE_PRIMARY_ENABLED=0`** на live-oscar — discovery/liq-watch: DexScreener → PG; MTM/hot-tick: Jupiter executable (без Birdeye REST на каждый tick).
- **`BIRDEYE_COLLECTOR_ENABLED=0`**, **`BIRDEYE_MARKET_TTL_MS=30000`**, **`BIRDEYE_TELEGRAM_ENABLED=0`** на live-oscar.
- `resolveDiscoveryMarketQuote`: при primary OFF пропускает Birdeye, сохраняет DexScreener fallback; discovery eval всегда вызывает resolver на live-oscar.
- **48h measurement:** сравнить skips, LIQ_DRAIN, PnL vs Birdeye-primary era (journal grep `live_birdeye_market_quote` / `birdeye_tier_insufficient`).

**Откат:** `git checkout sa-alpha-1.11.553 -- ecosystem.config.cjs src/papertrader/pricing/discovery-market-quote.ts src/papertrader/discovery/dip-clones.ts src/papertrader/pricing/liq-watch.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

## [1.11.553] — 2026-07-05

**Тег:** `sa-alpha-1.11.553`

### Collectors — snapshot_stale false-positive + tick SLA

- **`SNAPSHOT_FRESHNESS_MAX_AGE_SEC=1800`** (30 min) в `sa-snapshot-freshness-watch` и `live-oscar` — порог aligned с реальным tick SLA pumpswap/raydium/meteora (16–32 min при DexScreener 429).
- **`BIRDEYE_COLLECTOR_ENABLED=0`** на sa-raydium / sa-meteora / sa-pumpswap — enrich давал +10–25 min/tick; live-oscar сохраняет `BIRDEYE_PRIMARY_ENABLED`.
- Stagger DexScreener: meteora offset 40s, moonshot 80s (raydium 0).

**Откат:** `git checkout sa-alpha-1.11.552 -- ecosystem.config.cjs docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only sa-raydium,sa-meteora,sa-moonshot,sa-pumpswap,sa-snapshot-freshness-watch,live-oscar --update-env`.

## [1.11.552] — 2026-07-04

**Тег:** `sa-alpha-1.11.552`

### Live Oscar — prod tier (≥$3M) entry split 5×$1000 @10s

- **Prod ≥$3M:** entry split **5×$1000** ($5000), interval **10s** (+3/−5% corridor); avg −10% $300, −20% $400; max **$5700**.
- **Low $2M–$3M:** без изменений (5×$300, avg $300/$400, max $2200).
- `deriveLiveOscarProdBandEntryPlan` — leg count из конфигурации env, не hardcoded 8.

**Откат:** redeploy `sa-alpha-1.11.551`; prod: 8×$300 @5s, `PAPER_POSITION_USD=2400`, `LIVE_MAX_POSITION_USD=3100`, `PROD_MCAP_MAX_*=3100`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

## [1.11.551] — 2026-07-03

**Тег:** `sa-alpha-1.11.551`

### Dashboard — NEST Jul 3 wallet-drain PnL (low-slip flush)

**Root cause (NEST Jul 3):** journal показывал TP_LADDER +20.9% ($62.79 net), chain net ≈ −1.8% ($294.53 proceeds − $300 invested). `walletDrainedFlush` с `mtmFlushProceedsUsd` ≈ $180 при chain $112 и slip 0.02% — dashboard MTM-repair (Jun NEST trail logic) завышал closed PnL.

**Fix:**
- `sanitizeWalletDrainPartialCloseForDashboard`: MTM repair только при `slipRealizedPct >= 15%` (Jun trail-dump).
- Low-slip `walletDrainedFlush` + chain net loss → `wallet_drain_chain_net_loss` (sum chain proceeds − invested).
- Тест `nestJul3CloseRaw` в `tests/dashboard-paper2-closed-pnl.test.ts`.

**Oscar journal:** TP_LADDER +20% vs chain −1.8% — slippage/walletDrainedFlush; tracker fix не в scope (только dashboard display).

**Откат:** `git checkout sa-alpha-1.11.550 -- scripts-tmp/dashboard-server.ts tests/dashboard-paper2-closed-pnl.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [Unreleased] — familiar mint gate bypass (manlet/DdPrHY RCA)

**Проблема:** repeat-traded mint (manlet DdPrHY — copy→Oscar +$33, stable vol5m $16.3K) блокировался `pg_stale_now` при прошедших snapshot/dip; новые mint (FREE 82XVW) — корректный `volume_ephemeral` skip.

- **`isFamiliarMint`:** journal lookback (open/close, любой lane) + `PAPER_FAMILIAR_MINT_GATE_BYPASS_ENABLED=1`.
- **`volume_ephemeral`:** familiar mint → полный bypass (new mint без изменений).
- **`pg_stale_now`:** familiar mint + stable vol5m ≥ active-hour floor + `LIVE_PG_COVERAGE_FAMILIAR_MINT_RELAX=1` → bypass; audit `familiarMintStaleBypass` в `pg_data_coverage` features.

**Env:** `PAPER_FAMILIAR_MINT_GATE_BYPASS_ENABLED`, `LIVE_PG_COVERAGE_FAMILIAR_MINT_RELAX` (prod `ecosystem.config.cjs`).

**Откат:** оба env `=0` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.550] — 2026-07-03

**Тег:** `sa-alpha-1.11.550`

### Live Oscar — runner_lite lane + intel gate/TG для всех lane

- **`runner_lite`:** sub-$1M young runners (12–48h), 2×$100, mcap-first tier routing (tier-1 $500k–<$1M; tier-2 только когда probe in-band но не full pass).
- **Intel gate:** `LIVE_OSCAR_INTEL_MODE_RUNNER_LITE=gate` (hard block после tier gates); unified `live-oscar-intel-notify.ts` для prod / runner_probe / runner_lite.
- **Telegram ADVICE:** dedup по mint+intel-reason fingerprint (cooldown `0`, не «попробуем позже»).
- **`PAPER_RUNNER_LITE_ENABLED=1`** в `ecosystem.config.cjs` (live-oscar).

**Откат:** `PAPER_RUNNER_LITE_ENABLED=0`, `LIVE_OSCAR_INTEL_MODE_RUNNER_LITE=shadow` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`; либо redeploy `sa-alpha-1.11.549`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.549] — 2026-07-02

**Тег:** `sa-alpha-1.11.549`

### Live Oscar — активирован гибрид Shyft (Stage 1.2 + 1.3)

**Контекст:** shadow Stage 1.1 собирал лаг PG 24–48 ч; код primary-цены и DeFi mcap уже в репо (1.11.468–469). Владелец запросил полное использование оплаченного Shyft на проде.

- **`ecosystem.config.cjs` (live-oscar):** `SHYFT_PRICE_PRIMARY_ENABLED` `'0'` → **`'1'`** (MTM + discovery dip-eval, freshness-gate 5s + PG/Jupiter fallback); `SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED` `'0'` → **`'1'`**; `SHYFT_DEFI_MCAP_ENABLED` `'0'` → **`'1'`** (TTL 12s + PG fallback). Shadow **`PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED='1'`** остаётся для сравнения лага в журнале.
- **Креды на VPS** уже в `.env` (`SHYFT_GRPC_TOKEN`, `SHYFT_DEFI_API_KEY`/`SHYFT_API_KEY`) — доп. правок `.env` не требуется.
- **Затронутые lane:** pumpswap discovery dip-eval (−5/−10%), MTM/hot-tick exits открытых позиций, runner_probe mcap-гейт; preset-c без изменений (Shyft OFF).

**Наблюдение после деплоя:** `live_shyft_shadow_price`, `live_shyft_price_primary`, `live_shyft_defi_mcap`; меньше `live_stale_price_warn` на входах/MTM.

**Откат:** `SHYFT_PRICE_PRIMARY_ENABLED=0`, `SHYFT_DEFI_MCAP_ENABLED=0` + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`; либо redeploy `sa-alpha-1.11.548`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.548] — 2026-07-01

**Тег:** `sa-alpha-1.11.548`

### Dashboard — RUNNER badge + жёлтые COPY/RUNNER на Live Oscar

**Контекст:** после 1.11.547 copy cycles убраны; runner_probe lane нужен отдельный бейдж в Open positions.

- **Live Oscar Open:** бейдж **RUNNER** для `liveOscarTradeLane: runner_probe` / `isRunnerProbe`.
- **COPY** и **RUNNER** — ярко-жёлтый `#facc15` (класс `pill-lane`).
- **API:** `isRunnerProbe`, `positionSource: runner_probe` в enriched open rows; `DASHBOARD_PAPER2_BUILD_ID` bump.
- **Open row keys:** `copy` / `runner` / `oscar` lane suffix — prod + runner_probe на одном mint не схлопываются в UI.

**Откат:** `git checkout sa-alpha-1.11.547 -- scripts-tmp/dashboard-paper2.html scripts-tmp/dashboard-server.ts tests/live-open-snapshot.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.547] — 2026-07-01

**Тег:** `sa-alpha-1.11.547`

### Dashboard — убрать дублирующий copy UI на Live Oscar

**Контекст:** после 1.11.546 copy cycles/stats дублировали открытые copy-позиции сверху EPSP timeline.

- **Live Oscar:** секции **Copy cycles** и copy-trader stats скрыты; copy-позиции только в **Open positions** с бейджем **COPY**.
- **Copy-trader tile:** cycles/stats без изменений.
- **API:** `augmentLiveOscarLoadWithCopyLeaderOpens` по-прежнему мержит open rows; `copyTrader` в payload Live Oscar больше не отдаётся.

**Откат:** `git checkout sa-alpha-1.11.546 -- scripts-tmp/dashboard-paper2.html scripts-tmp/dashboard-server.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.546] — 2026-07-01

**Тег:** `sa-alpha-1.11.546`

### Dashboard — copy-leader open positions on Live Oscar panel

**Контекст:** copy-trader и live-oscar на общем кошельке (`live-oscar-micro`); copy-ноги живут в `data/copytrader/state.json`, Oscar JSONL их не видит.

- **`/papertrader2` · Live Oscar:** открытые copy-позиции из state+journal — **отдельные строки** с бейджем **COPY** и лидером `498S…aNma`; Oscar-строка на том же mint не сливается.
- **API:** `augmentLiveOscarLoadWithCopyLeaderOpens`, поля `isCopyLeader`, `copySizeUsd`, `copyLeaderWalletShort`; copy cycles/stats на плитке Live Oscar.
- **PM2 `live-oscar-dashboard`:** `DASHBOARD_COPY_TRADER_LEADER_WALLET`.

**Откат:** `git checkout sa-alpha-1.11.545 -- scripts-tmp/dashboard-server.ts scripts-tmp/copytrader-dashboard.ts scripts-tmp/dashboard-paper2.html ecosystem.config.cjs tests/dashboard-copy-leader-opens.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.545] — 2026-07-01

**Тег:** `sa-alpha-1.11.545`

### Live Oscar — ephemeral neighbor-window + known mint vol profile (NEST/world)

**Проблема:** repeat mints (NEST, world) блокировались на одном мёртвом live `vol5m` при стабильном объёме в соседних PG hourly окнах; не хватало трендового профиля в journal.

**Fix:**
- **`volume-ephemeral-guard`:** PG fetch — `vol5m_prev_1h/2h/3h`, median 12h; `neighborVolumeHealthy()` — 2+ соседних часа ≥$8k или median 12h или `activeHours≥10`.
- **Known mint:** spike/narrow/tail_wash — new-mint-only; мёртвый tick + здоровые соседи → pass + `single_tick_stale_ignored`; sustained dead (узкое окно + мёртвые соседи) → `known_mint_sustained_dead`.
- **Journal:** `known_mint_vol_profile` в `live_discovery_eval` (vol5m, vol1h, prev hours, active_hours_24h, holders).
- **Telegram:** ADVICE ephemeral по-прежнему skip для known mint.

**Откат:** `git checkout sa-alpha-1.11.544 -- src/papertrader/discovery/volume-ephemeral-guard.ts src/papertrader/discovery/dip-clones.ts src/papertrader/types.ts tests/volume-ephemeral-guard.test.ts docs/strategy/live-oscar/LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.544] — 2026-07-01

**Тег:** `sa-alpha-1.11.544`

### Live Oscar — volume_ephemeral new-mint-only (NEST/world RCA)

**Проблема:** repeat mints (NEST 68Nq, world FMqh9 — bot торговал в 14d lookback) блокировались `volume_ephemeral` на глубоких дипах (`tail_wash_vol5m_vol1h`, `tail_vol5m`, narrow-window `active_hours`); Telegram ADVICE «подозрительный всплеск» — ложные срабатывания. Новые mint (82XVW FREE) — корректный true positive.

**Fix:**
- **`evaluateVolumeEphemeralGuard`:** при `isKnownMint()` (14d journal lookback) — **skip всех** `volume_ephemeral:*` блоков; spike/narrow-window/tail_wash защита **только для new mint**.
- **Telegram `live_oscar_volume_ephemeral`:** не шлётся для known mint (`volume_ephemeral.knownMint` в features).
- **Audit:** `volume_ephemeral.knownMint` в discovery eval features.

**Clarification vs 1.11.534:** tail_wash на known mint **снят** — repeat coins на dip не режутся wash-ratio; dead-tail wash для known можно вернуть отдельным флагом при необходимости. New mint — полная строгость без изменений.

**Откат:** `git checkout sa-alpha-1.11.543 -- src/papertrader/discovery/volume-ephemeral-guard.ts src/papertrader/discovery/dip-clones.ts src/papertrader/main.ts src/papertrader/types.ts tests/volume-ephemeral-guard.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.543] — 2026-07-01

**Тег:** `sa-alpha-1.11.543`

### Live Oscar — runner_probe lane (fresh runners 12–36h)

- **`PAPER_RUNNER_PROBE_ENABLED`** (default **0**): параллельный lane `positionSource: runner_probe` — **не блокирует** prod staged Oscar на том же mint (composite open-map key `mint::runner_probe`).
- **Discovery:** strict runner guards (vol1h/5m, bs, liq, anti-stale) + dip entry; sybil/ephemeral/wallet-intel BLOCK; age **720–2160 min** (12–36h); ranking `score = vol1hUsd × max(velocity, 1)`.
- **Sizing:** one-shot **$500**, max **2** open, max exposure **$1000**; exit `runner_probe_v1` (TP +12%, kill −15%, timestop 6h).
- **Intel:** `oscar-intel-gate.ts` + `LIVE_OSCAR_INTEL_*` (default OFF); 12–24h band requires intel when `PAPER_RUNNER_PROBE_12H_INTEL_REQUIRED=1`.
- **Tests:** `tests/live-oscar-runner-probe.test.ts`.

**Prod enable (after shadow):** `PAPER_RUNNER_PROBE_ENABLED=1`, `LIVE_OSCAR_INTEL_MODE=shadow` → 48h → `gate`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

**Откат:** `PAPER_RUNNER_PROBE_ENABLED=0` + `LIVE_OSCAR_INTEL_MODE=off` → reload live-oscar; или `git checkout sa-alpha-1.11.542` → NORM deploy.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.542] — 2026-07-01

**Тег:** *(doc-only, tag optional)*

### Live Oscar — Coin Intelligence spec §4 lifecycle scope

- **§4 Scope by coin lifecycle:** матрица age band (0–12h … mature) × intel features; early buyers primary для **12–36h runners**, не для week+ large mcap; mature dip buys → cluster dump exit + holder concentration.
- **Age relaxation policy:** `PAPER_POST_MIN_AGE_MIN` 2160→1440/720 только при intel composite green (no BLOCK_TRADE, no sybil/ephemeral); **7d shadow** на 12h/24h lane до prod; kill `LIVE_OSCAR_INTEL_AGE_RELAX_ENABLED=0`.
- Спека v1.1: [`LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md`](../live-oscar/LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md).

**Откат:** doc-only — `git checkout sa-alpha-1.11.541 -- docs/strategy/live-oscar/LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.541] — 2026-07-01

**Тег:** `sa-alpha-1.11.541`

### Live Oscar — Coin Intelligence spec (superpowers roadmap)

- **Normative spec:** [`docs/strategy/live-oscar/LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md`](../live-oscar/LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md) — mint-scoped intel overlay (L0–L4), rollout shadow→gate, Postgres strategy, collector safety contract, copy-trader fusion, P0–P3 roadmap.
- **Index:** [`docs/strategy/live-oscar/README.md`](../live-oscar/README.md).
- **Рекомендованный MVP:** wallet-intel mint gate (port `smart-lottery-intel` pattern), все флаги default-OFF; код не в этом релизе.

**Откат:** doc-only — `git checkout sa-alpha-1.11.540 -- docs/strategy/live-oscar/ docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`.

Без cross-product изменений. Platform VERSION не менялся.

---

## [1.11.540] — 2026-07-01

**Тег:** `sa-alpha-1.11.540`

### Copy-trader + live-oscar shared wallet (golden-goose)

**Лидер:** `498SWfPJisr26J4oCiZccyzReFrByNE7jsHwbm3caNma` · **кошелёк:** `live-oscar-micro` (общий пул SOL с Oscar).

- **`positionSource: copy_leader`** — параллельный учёт в `data/copytrader/state.json`; Oscar `open` map не видит copy-ноги.
- **Golden-goose:** `copy-leader-attribution.ts` вычитает copy cost basis из `wallet_holds_mint_over_usd_cap` — Oscar может открыть полный 8×$300 ($2400+) на том же mint после $500 copy.
- **Spare-capital gate:** copy покупает только если свободный SOL > Oscar reserve + committed open (читает `live-oscar-open-snapshot.json`).
- **Shared wallet sells:** продаёт только `tokenRaw` copy-ноги, не токены Oscar.
- **PM2:** $500 fixed entry, 5s buy delay, poll 3s, `COPY_TRADER_SHARED_OSCAR_WALLET=1`, `COPY_TRADER_SPARE_CAPITAL_GATE=1`.

**Откат:** redeploy `sa-alpha-1.11.539`; вернуть risky wallet + staged probe/dip в `ecosystem.config.cjs` copy-trader block; `pm2 reload ecosystem.config.cjs --only live-oscar,copy-trader --update-env`.

Без cross-product изменений.

---

## [1.11.539] — 2026-06-30

**Тег:** `sa-alpha-1.11.539`

### Live Oscar — entry sizing: 8-leg prod / 5-leg low + unified avg

**Prod (mcap ≥ $3M):** entry split **8×$300 = $2400** (было 7×$300); staged avg **−10% $300**, **−20% $400** (было −10%/$400 + −20%/$600 для $3–12M; ≥$12M раньше без avg). Max **$3100** для всех prod-бандов включая ≥$12M.

**Low ($2M–$3M):** entry split **5×$300 = $1500** (было 3×$300); staged avg **−10% $300**, **−20% $400** (было только −10%/$350). Max **$2200**.

Коридор +3%/−5%, delay 5s, discovery gates, exit policy — без изменений. `LIVE_MAX_POSITION_USD=3100`.

**Примечание:** band ≥$12M теперь получает те же avg-ноги, что и $3–12M (раньше entry-only $2100).

**Откат:** redeploy `sa-alpha-1.11.538`; prod: `LEG8=0`, `PAPER_POSITION_USD=2100`, avg `$400/$600`, `PROD_MCAP_MAX_12_PLUS=2100`; low: 3 legs, avg `$350`, `LOW_POSITION=900`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.538] — 2026-06-30

**Тег:** `sa-alpha-1.11.538`

### Live Oscar — partial sell slipRealizedPct fix (WORLD RCA)

**Проблема:** при exit-slice ($663 planned, $250 executed) `slipRealizedPct` делил chain proceeds на inflated `tokenSizingUsdForSwap/marketSell` → ложные ~62% вместо ~0%.

- **`tracker.ts`:** `resolvePartialSellTokensSold` — actual `tokenAmountRawSold` / chain proceeds, не planned notional.
- **`phase4-execution.ts` / `exit-slice.ts`:** passthrough + sum `tokenAmountRawSold` across slices.
- **Test:** world-like partial $663→$250 → slip <2%.

**Откат:** `git checkout sa-alpha-1.11.537 -- src/papertrader/executor/tracker.ts src/live/phase4-types.ts src/live/phase4-execution.ts src/live/exit-slice.ts tests/live-partial-sell-slip.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.537] — 2026-06-30

**Тег:** `sa-alpha-1.11.537`

### Deploy safety — shared VPS PM2 (dc-trader)

**RCA:** solana-alpha deploy used ad-hoc **`pm2 stop all`** under **`salpha`**, killing **`dc-trader`** (separate product at `/opt/dc-trader`, same `PM2_HOME`).

- **NORM §5.3:** explicit ban on `pm2 stop all` / `delete all` / `restart all` on shared VPS; scoped `startOrReload` / `--only` only.
- **`scripts/release/verify-dc-trader-pm2.sh`:** read-only post-deploy WARN if `dc-trader` missing/offline; wired into **`post-deploy-smoke.sh`**.
- **`deploy-live-oscar-vps.sh`**, **`.cursor/rules/server-autodeploy.mdc`:** safeguard comments for agents.

**Откат:** revert commit; no runtime change required.

Без cross-product изменений.

---

## [1.11.536] — 2026-06-30

**Тег:** `sa-alpha-1.11.536`

### Live Oscar — volume_ephemeral dead-tail bypass fix (MUSHU RCA)

**Проблема:** MUSHU проходил guard после aging-out narrowWindow при activeHours=5 (<10h sustain): dead vol5m + inflated vol1h, PG safe-skip при отсутствии hourly context.

- **Dead-tail block:** persist until 10h sustain even when narrowWindow aged out (new + known mint).
- **PG safe-skip fallback:** row-only wash gate blocks obvious tail_wash when PG hourly context missing.
- **Telegram ADVICE:** volume_ephemeral alert only when it is the sole blocker; текст уточнён («на этом eval…»).

**Откат:** `git checkout sa-alpha-1.11.535 -- src/papertrader/discovery/volume-ephemeral-guard.ts src/papertrader/main.ts tests/volume-ephemeral-guard.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.535] — 2026-06-30

**Тег:** `sa-alpha-1.11.535`

### Live Oscar — discovery max mcap $50M → $200M

**Проблема:** ANSEM и другие крупные caps блокировались `PAPER_DISCOVERY_MAX_MARKET_CAP_USD=50000000` в discovery pool / eval.

- **`live-oscar` PM2:** `PAPER_DISCOVERY_MAX_MARKET_CAP_USD`: `50000000` → **`200000000`** ($200M ceiling).
- Scalp-wave (`PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD`), runner, preset-c — без изменений.

**Откат:** `PAPER_DISCOVERY_MAX_MARKET_CAP_USD=50000000`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.534] — 2026-06-30

**Тег:** `sa-alpha-1.11.534`

### Live Oscar — known mint tail-wash vol5m/vol1h gate (NEST RCA)

**Проблема:** repeat mint (NEST 68Nq) проходил guards при мёртвом vol5m ($1.4k) и раздутой vol1h ($194k): known-mint bypass снимал vol5m/vol1h wash gate и sybil vol1h-exempt.

- **Ephemeral guard:** vol5m/vol1h ratio < 8% **+** vol5m < min active hour — блок для **всех** mint (включая known); PG gap bypass (#302) и 10h new-mint rule без изменений.
- **Sybil guard:** vol1h alive-exempt только при vol5m/vol1h ≥ 8% (known mint больше не exempt по vol1h alone).

**Откат:** `git checkout sa-alpha-1.11.533 -- src/papertrader/discovery/volume-ephemeral-guard.ts src/papertrader/discovery/volume-sybil-guard.ts tests/volume-ephemeral-guard.test.ts tests/volume-sybil-guard.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.533] — 2026-06-30

**Тег:** `sa-alpha-1.11.533`

### Live Oscar — new mint volume sustain (10h) + MUSHU denylist

- **Volume ephemeral guard:** для **новых** mint (нет сделки бота за 14d) вход только при ≥**10** активных часов vol5m в lookback (`PAPER_VOLUME_EPHEMERAL_NEW_MINT_MIN_ACTIVE_HOURS`); блок spike-only wash (MUSHU: 2h burst + inflated vol1h).
- Дополнительно: new-mint tail block без aging-out, vol5m/vol1h ratio wash gate (shared sybil+ephemeral).
- **MUSHU** (`5Jr9hGmJ…Wpump`) в `live-oscar-permanent-denylist.seed.txt` — permanent block.

**Откат:** `PAPER_VOLUME_EPHEMERAL_NEW_MINT_MIN_ACTIVE_HOURS=0`; убрать mint из seed; `pm2 reload live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.533] — 2026-06-30

**Тег:** `sa-alpha-1.11.533`

### live-oscar: NEW mint volume guards + hard mcap + MUSHU denylist

**Проблема:** новые mint проходили wash (мёртвый vol5m, раздутая vol1h): ephemeral aging-out, sybil vol1h-exempt, stale PG mcap.

- **`known-mint.ts`:** `isKnownMint()` (14d) — строже volume guards; PG gap bypass (#302) без изменений.
- **Ephemeral:** min 10 active hours для NEW mint; tail block без aging-out; vol5m/vol1h ratio ≥ 8%.
- **Sybil:** vol1h exempt для NEW mint только при живом vol5m или ratio.
- **Discovery hard mcap:** `discovery_hard_mcap=…_src=…`; price-primary масштабирует mcap.
- **Denylist seed:** MUSHU `5Jr9hGmJ…Wpump`.

**Откат:** `git checkout sa-alpha-1.11.531 -- src/papertrader/discovery/ known-mint.ts src/papertrader/filters/snapshot-filter.ts ecosystem.config.cjs data/live/live-oscar-permanent-denylist.seed.txt docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.531] — 2026-06-30

**Тег:** `sa-alpha-1.11.531`

### live-oscar: wallet tail flush — не оставлять orphan SPL

**Проблема:** после TP-close и partial exit на кошельке оставались orphan-хвосты (CATWIF, SOLANGELES); post-close tail sweep не выполнялся при `LIVE_POLICY_ONLY_EXITS=1`.

- **`LIVE_TAIL_FLUSH_THRESHOLD_USD=100`:** после partial exit — если остаток mint на кошельке < $100, `sell_full` 100% баланса.
- **Post-close sweep:** всегда планируется (снят gate `livePolicyBlocksHealSyncSells`); любой положительный остаток после close продаётся через 60 s.
- **`wallet-tail-flush.ts` / `tail-flush.ts`:** общий pipeline для post-close, partial exit, periodic heal.
- **Tracker:** `runLivePartialExitTailFlush` после каждого успешного partial sell.
- **JSONL:** `live_tail_flush` event kind.

**Откат:** `git checkout sa-alpha-1.11.530 -- src/live/post-close-tail-sweep.ts src/live/wallet-tail-flush.ts src/live/tail-flush.ts src/live/config.ts src/live/events.ts src/papertrader/executor/tracker.ts ecosystem.config.cjs .env.example tests/live-tail-flush.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.530] — 2026-06-30

**Тег:** `sa-alpha-1.11.530`

### PG data coverage: bypass pg_gap для repeat mints

**Проблема:** `pg_gap_in_recent_history` блокировал повторные входы в монеты вроде Jotchua, которые бот уже торговал — gap в PG snapshots не означает отсутствие монеты, а артефакт collector pin / enrich defer.

- **`evaluatePgDataCoverageGuard`:** known mint (open/close в journal за lookback) → снимает только `pg_gap_*` блоки; `pg_stale_now`, thin coverage, sybil — без изменений.
- **`isPgCoverageKnownMint`:** journal-derived maps (`lastEntryTs`, `lastPostExitBuyCooldown`, exit snapshots).
- **Env:** `PAPER_PG_DATA_COVERAGE_KNOWN_MINT_GAP_BYPASS=1`, `PAPER_PG_DATA_COVERAGE_KNOWN_MINT_LOOKBACK_DAYS=14`.
- **`ecosystem.config.cjs` live-oscar:** включено по умолчанию.
- **Boot:** seed `lastEntryTs` из open trades при live replay.

**Откат:** `PAPER_PG_DATA_COVERAGE_KNOWN_MINT_GAP_BYPASS=0`; `pm2 reload live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.529] — 2026-06-30

**Тег:** `sa-alpha-1.11.529`

### PG collectors: primary-first upsert для raydium/meteora/moonshot

**RCA:** тик коллекторов писал в PG только после 6–7 мин enrich → `MAX(ts)` отставал на 12–15 мин → `snapshot_stale` и `pg_stale_now_worst_age_sec` блокировали покупки.

- **`raydium-collector.mjs`**, **`meteora-collector.mjs`**, **`moonshot-collector.mjs`:** primary search/gecko bucket **upsert до enrich** (как в pumpswap); enrich с `*_ENRICH_MAX_RETRIES=1` (fail-fast на 429)
- **`ecosystem.config.cjs`:** env caps enrich для sa-raydium / sa-meteora / sa-moonshot

**Откат:** `git checkout sa-alpha-1.11.528 -- scripts-tmp/raydium-collector.mjs scripts-tmp/meteora-collector.mjs scripts-tmp/moonshot-collector.mjs ecosystem.config.cjs docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only sa-raydium,sa-meteora,sa-moonshot --update-env`.

Без cross-product изменений.

---

## [1.11.528] - 2026-06-29

**Тег:** `sa-alpha-1.11.528`

### Dashboard — tail-only JSONL, skip discovery_eval, fast `/api/paper2/opens`

**Проблема:** `/api/paper2` на 6.9GB live-oscar journal читал tail 200MB (~2s+) и парсил миллионы `live_discovery_eval`; UI ждал сборку всех 7 плиток.

**Изменение:**
- **`dashboard-server.ts`:** pre-parse skip `live_discovery_eval` / tick_skip / universe_miss; `DASHBOARD_LIVE_OSCAR_TAIL_BYTES`; `DASHBOARD_RECENT_CLOSED_LIMIT`; `GET /api/paper2/opens` (live-oscar opens only, cache 15s).
- **`dashboard-paper2.html`:** параллельный fast refresh opens.
- **`ecosystem.config.cjs`:** tail 64MB, recent closed 20.

**Откат:** `git checkout sa-alpha-1.11.527 -- scripts-tmp/dashboard-server.ts scripts-tmp/dashboard-paper2.html ecosystem.config.cjs tests/dashboard-jsonl-perf.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

Без cross-product изменений.

---

## [1.11.527] - 2026-06-29

**Тег:** `sa-alpha-1.11.527`

### Entry split — fast poll по `ENTRY_SPLIT_DELAY_MS` (не 30s tracker)

**Изменение:** ноги 2–7 entry split проверяются отдельным fast poll (`entry-split-fast-poll.ts`) каждые `min(5s, PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS)` для открытых позиций с pending legs. Коридор +3%/−5% и Jupiter corridor probe без изменений; основной tracker остаётся на `PAPER_TRACK_INTERVAL_MS=30000`.

**Откат:** redeploy `sa-alpha-1.11.526`; `pm2 reload ecosystem.config.cjs --only live-oscar,live-oscar-preset-c --update-env`.

Без cross-product изменений.

---

## [1.11.526] - 2026-06-29

**Тег:** `sa-alpha-1.11.526`

### Jupiter 429 Telegram — только реальные провалы исполнения

**Изменение:** burst HTTP 429 (retry noise при успешных сделках) **не** шлёт `[ALERT][jupiter-429-burst]` в Telegram по умолчанию (`JUPITER_429_BURST_TELEGRAM` default off). `[ALERT][jupiter-429-exhaust]` остаётся при исчерпании retry quote/swap. `sa-rate-429-report`: `RATE_429_REPORT_TELEGRAM=0` в PM2; при явном `=1` — только journal execution fails (`RATE_429_REPORT_FAILURES_ONLY=1`).

**Откат:** redeploy `sa-alpha-1.11.525`; `JUPITER_429_BURST_TELEGRAM=1` + `RATE_429_REPORT_TELEGRAM=1`; `pm2 reload ecosystem.config.cjs --only live-oscar,sa-rate-429-report --update-env`.

---

## [1.11.525] - 2026-06-29

**Тег:** `sa-alpha-1.11.525`

### Jupiter Pro — swap 429 retries on live-oscar

**Изменение:** `live-oscar` PM2 env переведён с `JUPITER_DEVELOPER_TIER_ENV` на `JUPITER_PRO_TRADING_ENV`; в shared envelope добавлен `JUPITER_SWAP_429_MAX_RETRIES=12` (quote retries уже были 12, swap оставался default 3).

| Surface | Swap 429 retries (old→new) |
|---------|----------------------------|
| live-oscar | **3 → 12** |
| live-oscar-preset-c | 12 (unchanged, via envelope) |
| copy-trader | 12 (unchanged, via envelope) |

**Откат:** redeploy `sa-alpha-1.11.524`; `pm2 reload ecosystem.config.cjs --only live-oscar,live-oscar-preset-c --update-env`.

Без cross-product изменений.

---

## [1.11.524] - 2026-06-29

**Тег:** `sa-alpha-1.11.524`

### live-oscar — low tier $2M–$3M: restore owner 3×$300 ($900)

**Причина:** откат ошибочного 1.11.523 (3×$250); канон — 1.11.522 / owner mandate.

| Tier | mcap | Entry | Avg | Max position |
|------|------|-------|-----|--------------|
| **low** | $2M–$3M | 3×$300 ($900) @ 10s (+3/−5%) | −10% **$350** | **$1250** |

**Откат:** redeploy; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

## [1.11.523] — 2026-06-29

**Тег:** `sa-alpha-1.11.523`

### live-oscar — low tier $2M–$3M: correct to 3×$250 entry ($750)

**Изменение:** исправление 1.11.522 (ошибочно 3×$300): low mcap lane — вход **3×$250 = $750** (было 2×$250 = $500). Усреднение, коридор и delay без изменений.

| Tier | mcap | Entry | Avg | Max position |
|------|------|-------|-----|--------------|
| **low** | $2M–$3M | 3×$250 ($750) @ 10s (+3/−5%) | −10% **$350** | **$1100** |

**Env (live-oscar PM2):**
- `PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD` / `…LEG2_USD` / `…LEG3_USD`: **`250`**
- `PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD`: **`750`**

**Откат:** redeploy `sa-alpha-1.11.522`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.522] — 2026-06-29

**Тег:** `sa-alpha-1.11.522`

### live-oscar — low tier $2M–$3M: 3×$300 entry ($900)

**Изменение:** low mcap lane — вход **3×$300 = $900** (было 2×$250 = $500). Усреднение, коридор и delay без изменений.

| Tier | mcap | Entry | Avg | Max position |
|------|------|-------|-----|--------------|
| **low** | $2M–$3M | 3×$300 ($900) @ 10s (+3/−5%) | −10% **$350** | **$1250** |

**Env (live-oscar PM2):**
- `PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD` / `…LEG2_USD` / `…LEG3_USD`: **`300`**
- `PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD`: **`900`** (было `500`)

Boot-инвариант `assertLiveOscarUnifiedEntrySizing`: `position == leg1+leg2+leg3`.

**Откат:** redeploy `sa-alpha-1.11.521`; leg3 `0`, position `500`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.521] — 2026-06-29

**Тег:** `sa-alpha-1.11.521`

### Jupiter Developer ($25/mo) — fill quality over credit savings

**Изменение:** PM2 `live-oscar`, `live-oscar-preset-c`, `copy-trader`, `sa-jupiter` — Pro URLs (`api.jup.ag`), `JUPITER_DEVELOPER_TIER=1`, tighter slippage, max retries, reduced quote throttling.

| Surface | Slippage (old→new) | Retries / 429 (old→new) |
|---------|-------------------|-------------------------|
| live-oscar | verify 400→150 bps; exec stays **10 bps** | 429: 8→**12**; sim x15 unchanged |
| live-oscar-preset-c | 50→**100 bps** + full Pro retry envelope | code defaults → **x15** sim, 429 **12** |
| copy-trader | 400→**100 bps** | sell sim 10→**15**; slippage-class 5→**12**; 429 8→**12** |
| Throttles | partial TP 5s→**1s**; staged sim cooldown 30m→**10m** | copy sell interval 2s→**500ms**; dip quote 12s→**2s** |

**Откат:** redeploy `sa-alpha-1.11.518`; `pm2 reload ecosystem.config.cjs --only live-oscar,live-oscar-preset-c,copy-trader,sa-jupiter --update-env`.

Без cross-product изменений.

---

---

## [1.11.520] — 2026-06-29

**Тег:** `sa-alpha-1.11.520`

### Jupiter Developer tier (10 RPS) + live-oscar retry tuning

**Изменение:** подписка Jupiter Developer ($25/mo, 10 RPS):

- `JUPITER_DEVELOPER_TIER=1` в PM2 (`live-oscar`, `sa-jupiter`, preset-c, copy-trader).
- **sa-jupiter:** `JUPITER_WATCHER_REQUEST_DELAY_MS=500`, `JUPITER_WATCHER_QUOTE_CONCURRENCY=3` (parallel workers, ~6 RPS).
- **live-oscar:** sim retry **x20** (150 ms), slippage-class buy **10** / sell **15** attempts; base slippage **10 bps**; priority fee cap **0.0001 SOL** + `high`.
- `.env.example` — документация Developer tier.
- `src/live/config.ts` — retry cap 15→25.

**Откат:** redeploy `sa-alpha-1.11.519`; `JUPITER_DEVELOPER_TIER=0`, watcher delay 1250, concurrency 1, sim retry 15; `pm2 reload ecosystem.config.cjs --update-env`.

Без cross-product изменений.

---

## [1.11.519] — 2026-06-29

**Тег:** `sa-alpha-1.11.519`

### live-oscar — упрощение prod mcap sub-tiers

**Изменение:** prod tier (mcap ≥ $3M) — две полосы вместо четырёх:

| Mcap | Max | Slices |
|------|-----|--------|
| $3M–$12M | $3100 | 7×$300 + $400@-10% + $600@-20% |
| $12M+ | $2100 | 7×$300 only |

Удалены промежуточные полосы $5–8M ($2800) и $8–12M ($2100). Low ($2M–$3M) **$850** без изменений. Env: `PAPER_LIVE_OSCAR_PROD_MCAP_BAND_12M_USD`, `PAPER_LIVE_OSCAR_PROD_MCAP_MAX_3_12_USD`, `PAPER_LIVE_OSCAR_PROD_MCAP_MAX_12_PLUS_USD`.

**Откат:** redeploy `sa-alpha-1.11.518`; restore 1.11.518 prod mcap band env; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.518] — 2026-06-28

**Тег:** `sa-alpha-1.11.518`

### live-oscar — tiered max position by mcap at entry (prod sub-tiers)

**Изменение:** prod tier (mcap ≥ $3M) — max invest от `signalMarketCapUsd` при входе:

| Mcap | Max | Slices |
|------|-----|--------|
| $3M–$5M | $3100 | 7×$300 + $400@-10% + $600@-20% |
| $5M–$8M | $2800 | 7×$300 + $400@-10% + $300@-20% |
| $8M–$12M | $2100 | 7×$300 only |
| $12M+ | $1500 | 5×$300 only |

Low ($2M–$3M) **$850** без изменений. Env: `PAPER_LIVE_OSCAR_PROD_MCAP_BAND_*`, `PAPER_LIVE_OSCAR_PROD_MCAP_MAX_*`. `LIVE_MAX_POSITION_USD=3100` (верхняя граница).

**Откат:** redeploy `sa-alpha-1.11.517`; unset prod mcap band env; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.517] — 2026-06-28

**Тег:** `sa-alpha-1.11.517`

### live-oscar E+2: open positions inherit avg1 −10% + DIP10_FIRST_TP5

**Проблема:** открытые на момент деплоя позиции могли иметь pending avg1 @ −5%, не иметь `liveWaveDip10ReachedBeforeTp8` при уже пройденном −10% vs signal, и пропускать TP2 @ +5%.

**Изменение:**
- **Reload / tracker tick:** `reconcileE2OpenOnRestore` + `reconcileE2OpenOnTrackerTick` — retarget pending avg1 на −10%, без double-fill.
- **Dip10 backfill (one-time):** PG hourly min/max с `entryTs` + fallback по leg/partial marks → `liveWaveDip10ReachedBeforeTp8`; флаг `liveE2Dip10BackfillAttempted`.
- **Snapshot:** persist dip10 + backfill flags в `serializeOpenTrade` / restore.

**Откат:** redeploy `sa-alpha-1.11.516`.

Без cross-product изменений.

---

## [1.11.516] — 2026-06-28

**Тег:** `sa-alpha-1.11.516`

### live-oscar E+2 parity: low + micro tiers + tier-agnostic TP2

**Изменение:** E+2 (avg1 **−10%**, **DIP10_FIRST_TP5**) распространён на все mcap-тиры с пропорционально меньшими USD. TP2 **не prod-only**: любой `wave_b_v1` + `half8_runner` (prod/low/micro) — при **−10% vs signal до +8% TP** → partial **50% @ +5% vs avg** (`WAVE_B_DIP10_FIRST_TP5_PARTIAL`). Micro lane по-прежнему **OFF**; env готов к включению.

| Tier | mcap | Entry | Avg legs | TP2 | Max position |
|------|------|-------|----------|-----|--------------|
| **prod** | ≥ $3M | 7×$300 ($2100) | −10% $400, −20% $600 | DIP10_FIRST_TP5: 50% @ +5% vs avg | **$3100** |
| **low** | $2M–$3M | 2×$250 ($500) | −10% $350 | DIP10_FIRST_TP5 (global) | **$850** |
| **micro** | $500k–$1.3M (lane OFF) | 2×$150 ($300) | −10% $210 | DIP10_FIRST_TP5 (global) | **$510** |

**Env (live-oscar PM2):**
- `PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG_USD` / `…LEG2_USD`: **`150`** (было 300/200)
- `PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD`: **`300`** (было 500)
- `PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD`: **`210`** (было 200)
- `PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_DROP_PCT`: **`10`** (новый; tier-aware resolver)
- Low/prod/DIP10_* без изменений vs 1.11.515

**Код:** `resolveLiveOscarStagedAvgFirstDropPct` — micro tier; комментарий tier-agnostic в `exit-policy-wave-b.ts`.

**Откат:** redeploy `sa-alpha-1.11.515`; micro env: leg 300/200, position 500, avg 200; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.515] — 2026-06-28

**Тег:** `sa-alpha-1.11.515`

### live-oscar sim E+2: avg1 −10% + dip10-first TP5

**Изменение (prod ≥$3M):** 1-е усреднение **−10% $400** (было −5% $400); −20% $600 без изменений; max **$3100** (7×$300 + $400 + $600). Wave B **half8_runner TP2**: если цена vs **signal** достигла **−10% до +8% TP**, при отскоке к **+5% vs avg** — partial **50%** (`WAVE_B_DIP10_FIRST_TP5_PARTIAL`), вместо ожидания half8 **+8%**. Обычный путь «+8% первым» без изменений. Runtime: `liveWaveDip10ReachedBeforeTp8`, `liveWaveDip10FirstTp5PartialTaken`.

**Env (live-oscar PM2):**
- `PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT`: `5` → **`10`**
- `PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_ENABLED`: **`1`**
- `PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_PARTIAL_PNL_FRAC`: **`0.05`**
- `PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_PARTIAL_FRACTION`: **`0.5`**
- `PAPER_LIVE_OSCAR_DIP10_FIRST_TP5_SIGNAL_DROP_PCT`: **`10`**

**Откат:** redeploy `sa-alpha-1.11.514`; `SECOND_DROP_PCT=5`, unset `DIP10_FIRST_TP5_*` или `…_ENABLED=0`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.513] — 2026-06-28

**Тег:** `sa-alpha-1.11.513`

### live-oscar sizing: 7×$300 entry split; +$100 on all avg tiers

**Изменение:** prod (mcap ≥ $3M): вход **7×$300 = $2100** (было 6×$300); усреднение −5% **$400** (было $300), −20% **$600** (было $500). Low ($2M–$3M): avg −10% **$350** (было $250). `PAPER_POSITION_USD=2100`, `LIVE_MAX_POSITION_USD=3100` (prod max staged $3100; low $850). Код: leg-7 в entry-split (`entry-split-legs.ts`, sizing/gates/restore).

**Откат:** redeploy `sa-alpha-1.11.512`; prod env: `LEG7=0`, `PAPER_POSITION_USD=1800`, avg `$300/$500`, low avg `$250`, `LIVE_MAX_POSITION_USD=2600`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---
## [1.11.512] — 2026-06-27

**Тег:** `sa-alpha-1.11.512`

### live-oscar prod tier: avg −20% leg $300 → $500

**Изменение:** prod (mcap ≥ $3M): вторая усредняющая нога @ −20% **$500** (было $300); −5% @ $300 без изменений. `LIVE_MAX_POSITION_USD=2600` (1800 split + $300 + $500). Env: `SECOND_DROP_PCT=5`, `SECOND_LEG_USD=300`, `THIRD_DROP_PCT=20`, `THIRD_LEG_USD=500`.

**Откат:** redeploy `sa-alpha-1.11.511`; `PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD=300`, `LIVE_MAX_POSITION_USD=2400`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---
## [1.11.511] — 2026-06-26

**Тег:** `sa-alpha-1.11.511`

### Runtime — sa-jupiter watcher quote pacing

- **`sa-jupiter`:** `JUPITER_WATCHER_REQUEST_DELAY_MS=1000` (было 650; снижение нагрузки на Jupiter quote API).

**Откат:** `git checkout sa-alpha-1.11.510 -- ecosystem.config.cjs docs/strategy/release/`; `pm2 reload sa-jupiter --update-env`.

Без cross-product изменений.

---
## [1.11.510] — 2026-06-26

**Тег:** `sa-alpha-1.11.510`

### Dashboard + tracker — wallet-drain partial close PnL (NEST)

**Root cause (NEST):** после TP1/TP2 journal `remainingFraction` ещё 25%, но на кошельке осталось ~3% токенов; trail partial с `usd_capped_by_chain` вернул $64 chain SOL, wallet SPL=0 → `remainingFraction=0`, close посчитал `sum(partial proceeds)−invested = −$64`. Реальная экономика выхода по trail — MTM остатка по `marketPrice` последнего partial (+~22%, trail label +20%).

**Fix:**
- Tracker: на wallet-drain partial — `mtmFlushProceedsUsd` по journal-остатку до partial; `buildClosedTrade` reconciles close proceeds.
- Dashboard: `sanitizeWalletDrainPartialCloseForDashboard` для исторических JSONL; `%` = `netPnlUsd/notional` после repair (согласовано с $).

**Откат:** `git checkout sa-alpha-1.11.509 -- src/papertrader/types.ts src/papertrader/executor/tracker.ts scripts-tmp/dashboard-server.ts tests/dashboard-paper2-closed-pnl.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar live-oscar-dashboard --update-env`.

Без cross-product изменений.

---

## [1.11.509] — 2026-06-26

**Тег:** `sa-alpha-1.11.509`

### Dashboard — closed PnL % vs $ после partial TP/trail

**Root cause (NEST):** `closedRowDisplayPnlPct` брал `(exitPx/entryPx−1)×100` раньше `netPnlUsd/totalInvestedUsd`. После лестницы TP и trail-dump на просадке последняя цена выше средней входа (+~18%), а суммарный PnL отрицательный (−$64 / −3.6%).

**Fix:** для закрытых сделок % PnL = `netPnlUsd / notional × 100` (как $ колонка); fill-ratio только fallback без net.

**Откат:** `git checkout sa-alpha-1.11.508 -- scripts-tmp/dashboard-server.ts tests/dashboard-paper2-closed-pnl.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

Без cross-product изменений.

---

## [1.11.508] — 2026-06-26

**Тег:** `sa-alpha-1.11.508`

### Live Oscar — no RECONCILE_ORPHAN closes; wallet-zero policy sync

**Root cause (NEST RCA):** ghost hot-tick exec sell price (~6e-6 vs ~0.0055 entry) oversized partial sell raw → `usd_capped_by_chain` drained wallet; partial not always synced → `wallet_spl_balance_zero` skip without `execution_result` → **RECONCILE_ORPHAN** paper-close.

**Fix:**
- Live wallet SPL=0: **no RECONCILE_ORPHAN** — `closeOpenTradeWalletZeroPolicySync` closes with last policy reason (TP/TRAIL/KILL); no partials → `risk_note` + keep open.
- Hot-tick exec sell override: sanity band 0.25×–4× ref MTM; ghost quotes cleared.
- After partial sell: `sellAmountSource` / `walletDrained` → `remainingFraction=0`.
- Sell preflight: `sell_price_usd_insane` guard; `execution_skip` paired with `execution_result` status `skipped`.

**Откат:** `git checkout sa-alpha-1.11.507 -- src/live/phase4-execution.ts src/live/wallet-zero-policy.ts src/papertrader/executor/tracker.ts src/live/events.ts src/live/phase4-types.ts docs/strategy/release/` → `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.507] — 2026-06-26

**Тег:** `sa-alpha-1.11.507`

### Live buy: fresh SOL/USD afford gate + partial slice unblock

**Root cause:** afford gate сравнивал баланс с Jupiter `quoteInAmount`, посчитанным по **тому же stale** `getSolUsd()` — drift-check не срабатывал (~2× SOL на ногу при ~$68 vs ~$136); 419 ложных `insufficient_wallet_sol_for_buy` при ~52 SOL на кошельке; partial (1.11.506) не доходил до исполнения.

**Fix:**
- `requireFreshSolUsd()` / `LIVE_SOL_USD_MAX_AGE_MS` (default 30s) — Jupiter price перед каждой buy-попыткой; stale → `buy_sol_usd_stale` retry, не false skip.
- `resolveBuyAffordRequiredLamports`: `required = min(quoteIn, freshEstimate) + LIVE_FREE_SOL_BUFFER_LAMPORTS` — stale-inflated quote не блокирует вход.
- Drift >15% логируется (`buy_quote_sol_usd_drift`), pipeline идёт в afford/partial, не blind-retry.
- Partial slice: fresh SOL/USD для `maxAffordableBuyUsd`; journal `partial_slice_due_to_wallet`.

**Откат:** redeploy `sa-alpha-1.11.506`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.506] — 2026-06-26

**Тег:** `sa-alpha-1.11.506`

### Live buy: partial entry slice при нехватке SOL (reserve 0.05)

**Изменение:** если кошелёк не тянет полный слайс ($300 prod / $250 low), pipeline считает `(balance − LIVE_FREE_SOL_BUFFER_LAMPORTS) × SOL/USD`, исполняет уменьшенную ногу если ≥ `LIVE_PARTIAL_BUY_MIN_USD` (50), не блокируя весь entry-split. Резерв комиссий: **0.05 SOL** (`LIVE_FREE_SOL_BUFFER_LAMPORTS=50000000`). Журнал live: `partial_slice_due_to_wallet`; `executedUsdNotional` в результате buy для корректного journal leg.

**Откат:** redeploy `sa-alpha-1.11.505`; убрать `LIVE_PARTIAL_BUY_MIN_USD` или `0`; `LIVE_FREE_SOL_BUFFER_LAMPORTS=10000000` при необходимости legacy; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.505] — 2026-06-26

**Тег:** `sa-alpha-1.11.505`

### live-oscar prod tier: 6×$300 entry split @5s (+3/−5% corridor)

**Изменение:** prod (mcap ≥ $3M): вход **6 слайсов × $300 = $1800** с **5s** паузой между слайсами и коридором **+3%/−5%** к якорю сигнала (как exit slice timing). Low tier ($2M–$3M) без изменений: **2×$250 @ 10s**. `PAPER_POSITION_USD=1800`, `LIVE_MAX_POSITION_USD=2400` (1800 split + avg $300+$300). Код: legs 4–6 в staged entry (`entry-split-legs.ts`, gates/lifecycle/restore).

**Откат:** redeploy `sa-alpha-1.11.504`; prod env: `ENTRY_SPLIT_LEG{,_2,_3}_USD=400`, `LEG4/5/6=0`, `DELAY_MS=10000`, `PAPER_POSITION_USD=1200`, `LIVE_MAX_POSITION_USD=1800`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.504] — 2026-06-26

**Тег:** `sa-alpha-1.11.504`

### Jupiter: немедленный Telegram при HTTP 429 burst / исчерпании retry

**Изменение:** shared `jupiter-http.ts` + `live/jupiter.ts` записывают HTTP 429 в in-process sliding window; при **≥4** событиях за 60s или при **исчерпании retry** на quote/swap — `[ALERT][jupiter-429-burst]` / `[ALERT][jupiter-429-exhaust]` в операторский Telegram (не ждать 30min `sa-rate-429-report`). Env: `JUPITER_429_BURST_TELEGRAM`, `JUPITER_429_BURST_THRESHOLD`, `JUPITER_429_EXHAUST_TELEGRAM`.

**Откат:** redeploy `sa-alpha-1.11.503`; `JUPITER_429_BURST_TELEGRAM=0` + `JUPITER_429_EXHAUST_TELEGRAM=0`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.503] — 2026-06-26

**Тег:** `sa-alpha-1.11.503`

### live-oscar: slippage optimization — 10 bps base, more retries, adaptive bump до 100 bps

**Изменение:** PM2 `live-oscar` — минимизация slippage для PnL: `LIVE_DEFAULT_SLIPPAGE_BPS=10`, bump +10 bps / cap 100 bps, buy slippage-retry 8 / sell 12, общие sim-retry 15 @ 150 ms, `LIVE_JUPITER_SWAP_PRIORITY_LEVEL=high`, `LIVE_ADAPTIVE_PRIORITY_FEE_ENABLED=0`. Cap priority fee **0.0001 SOL** без изменений; exit slices и sell impact gate без изменений.

**Код:** `liveDefaultSlippageBps` schema min **10 → 1** bps (future ops).

**Откат:** redeploy `sa-alpha-1.11.502`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.502] — 2026-06-26

**Тег:** `sa-alpha-1.11.502`

### live-oscar: exit slicing — max $250 per Jupiter sell, 5s gap

**Изменение:** крупные live-выходы (partial TP, kill stop, trail, full close и др.) при planned notional **> $250** исполняются серией slice'ов ≤ **$250** с паузой **5s** между slice'ами. Последний slice full exit — `sell_full` (chain balance). Env: `LIVE_EXIT_SLICE_MAX_USD` (default **250**, **0** = off), `LIVE_EXIT_SLICE_DELAY_MS` (default **5000**).

**Откат:** redeploy `sa-alpha-1.11.501`; unset slice env или `LIVE_EXIT_SLICE_MAX_USD=0`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.501] — 2026-06-26

**Тег:** `sa-alpha-1.11.501`

### live-oscar: entry-split corridor gate — только TP_LADDER partial

**Исправление:** `entrySplitCorridorBlocked` больше не блокирует timed split-ноги после breakeven trim, defensive trail, derisk и прочих partial sell с reason ≠ `TP_LADDER`. Коридор split (+3%/−5%) продолжает работать до первого partial TP по лестнице или первого усреднения; повторные попытки в коридоре — на каждом тике (не one-shot).

**Открытые позиции:** journal-restored планы без миграции — старые `liveStagedEntry` на открытых сделках не переписываются.

**Откат:** redeploy `sa-alpha-1.11.500`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.500] — 2026-06-26

**Тег:** `sa-alpha-1.11.500`

### live-oscar: min mcap $2M, micro/scalp_wave OFF, новые tier A/B entry rules

**Изменение (live-oscar process):** все входы только при mcap ≥ **$2M**; **micro** и **scalp_wave** lanes выключены. Новые правила staged-entry:

| Tier | Mcap | Entry split (timed @10s, corridor +3%/−5%) | Averaging |
|------|------|---------------------------------------------|-----------|
| **low (A)** | $2M–$3M | 2× **$250** | −10% **$250** (max **$750**) |
| **prod (B)** | ≥$3M | 3× **$400** | −5% **$300**, −20% **$300** (max **$1800**) |

Коридор split-ног: цена в **[anchor×0.95, anchor×1.03]**; повторные попытки, пока не сработает partial TP или первое усреднение. Split-ноги — **time-based** (`ENTRY_SPLIT_TARGET_DROP_PCT=0`), не dip −5%/−10%.

env-ключи (live-oscar) old→new:
- `PAPER_DISCOVERY_MIN_MARKET_CAP_USD`: `500000` → **`2000000`**
- `PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED`: `1` → **`0`**
- `PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED`: `1` → **`0`**
- low: `PAPER_LIVE_OSCAR_LOW_MCAP_MIN_USD` `1300000`→**`2000000`**; split **`250+250`**; `…_POSITION_USD` `800`→**`500`**; avg −10% **`250`**
- prod: split **`400+400+400`**; `PAPER_POSITION_USD` `800`→**`1200`**; `LIVE_MAX_POSITION_USD` `1000`→**`1800`**; corridor max down **`5`**; avg **`300@−5%` + `300@−20%`**

**Откат:** redeploy `sa-alpha-1.11.499`; вернуть env 1.11.499; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.500] — 2026-06-25

**Тег:** `sa-alpha-1.11.500`

### live-oscar: min mcap $2M, scalp_wave OFF, timed entry splits + corridor +3/−5%

**Изменение:** торгуем только mcap ≥ **$2M** (micro и scalp_wave **выключены**). Entry split по **времени** (10 с между ногами) в коридоре **+3% / −5%** от якоря сигнала; коридор для добора ног сплита действует до первого partial TP или первого усреднения.

| Tier | Entry split | Усреднение | Max |
|------|-------------|------------|-----|
| **low** ($2M–$3M) | 2×$250 @ 10s | −10% $250 | **$750** |
| **prod** (≥ $3M) | 3×$400 @ 10s | −5% $300, −20% $300 | **$1800** |

Код: 3-я нога entry split (`entrySplitLeg3`), `entrySplitCorridorBlocked`, tier-aware staged avg drops.

**Откат:** redeploy `sa-alpha-1.11.499`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

---

## [1.11.500] — 2026-06-26

**Тег:** `sa-alpha-1.11.500`

### live-oscar: min mcap $2M, timed entry splits, scalp_wave OFF

**Изменение (live-oscar):** торговля только при mcap > $2M; micro и scalp_wave lanes выключены. Entry split — **time-based** (10s между ногами, коридор +3%/−5% от якоря сигнала до первого partial TP или первого avg), не dip-staged −5%/−10%.

| Tier | Entry split (timed) | Averaging | Max |
|------|---------------------|-----------|-----|
| **low** $2M–$3M | $250 + $250 @ 10s | −10% $250 | **$750** |
| **prod** ≥ $3M | 3× $400 @ 10s | −5% $300, −20% $300 | **$1800** |

**Код:** 3-я нога entry split (`PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG3_USD`), коридор entry split блокируется после partial TP / первого `staged_avg`; low-tier avg drop через `PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_DROP_PCT`.

env (live-oscar) ключевые old→new:
- `PAPER_DISCOVERY_MIN_MARKET_CAP_USD`: `500000` → **`2000000`**
- `PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED`: `1` → **`0`**
- `PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED`: `1` → **`0`**
- prod split: `400/400/400` @ **`ENTRY_SPLIT_TARGET_DROP_PCT=0`**, delay **`10000`**, corridor **`+3/−5`**
- prod avg: **`SECOND_DROP_PCT=5`**, `SECOND_LEG_USD=300`, **`THIRD_DROP_PCT=20`**, `THIRD_LEG_USD=300`
- low: `250/250`, `POSITION=500`, `STAGED_AVG=250` @ **`STAGED_AVG_DROP_PCT=10`**
- `LIVE_OSCAR_ENTRY_SPLIT_USD` / `PAPER_POSITION_USD`: **`1200`**; `LIVE_MAX_POSITION_USD`: **`1800`**
- `PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS`: `1` → **`0`**

**Откат:** redeploy `sa-alpha-1.11.499`; вернуть env 1.11.499 (micro/scalp ON, legs 500/300/200, `PAPER_POSITION_USD=800`, `LIVE_MAX=1000`); `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.499] — 2026-06-24

**Тег:** `sa-alpha-1.11.499`

### live-oscar: «Живой Оскар» канон — ноги 500/300/200, half8_runner flat TP ВКЛ

**Изменение (live-oscar process):** распределение ног staged-entry перебалансировано (бо́льшая нога теперь на SIGNAL) и включён ранее существовавший плоский тейк `half8_runner` (продать 50% @ +8%, раннер на defensive-trail). micro снова трёхногий — нога −5% возвращена (была убрана в 1.11.497). prod = low. scalp_wave без изменений.

| Tier | Leg-1 @ signal | Leg-2 @ −5% | Leg-3 @ −10% | Max |
|------|----------------|-------------|--------------|-----|
| **prod** | $500 | $300 | $200 | **$1000** |
| **low** | $500 | $300 | $200 | **$1000** |
| **micro** | $300 | $200 | $100 | **$600** |
| **scalp_wave** | $300 one-shot | — | — | **$300** |

**Take-profit:** `half8_runner` ВКЛ для wave_b (50% @ +8%, остаток на трейле; kill −50% и брейкэвен-пол сохранены). Открытые на момент включения позиции НЕ переклеймляются.

env-ключи (live-oscar) old→new:
- `LIVE_OSCAR_ENTRY_SPLIT_USD` (`PAPER_POSITION_USD`): `400` → **`800`**
- `LIVE_OSCAR_MAX_POSITION_USD` (`LIVE_MAX_POSITION_USD`): `700` → **`1000`**
- prod: `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD` `200`→**`500`**; `…_ENTRY_SPLIT_LEG2_USD` `200`→**`300`**; `…_FIRST_LEG_USD` `200`→**`500`**; `…_SECOND_LEG_USD` `300`→**`200`**
- low: `PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD` `200`→**`500`**; `…_ENTRY_SPLIT_LEG2_USD` `200`→**`300`**; `…_POSITION_USD` `400`→**`800`**; `…_STAGED_AVG_LEG_USD` `300`→**`200`**
- micro: `PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD` `0`→**`200`** (re-enable −5%); `…_POSITION_USD` `300`→**`500`**; `…_STAGED_AVG_LEG_USD` `300`→**`100`** (leg-1 без изм. `300`)
- TP: `PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP` `0`→**`1`** (`…_MODE=half8_runner` без изм.)

Phase escalation scalp→prod/low/micro переиспользует tier-aware env (scalp $300 → micro: +$200 @ −5% +$100 @ −10% = max $600). `live-oscar-preset-c` (SuperBot) — без изменений. Тесты entry-sizing / phase-escalation обновлены.

**Откат:** redeploy `sa-alpha-1.11.498`; вернуть env: prod/low legs `200/200/300`, `PAPER_POSITION_USD=400`, `LIVE_MAX_POSITION_USD=700`; micro `300/0/300` (`POSITION=300`); `PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP=0`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.498] — 2026-06-24

**Тег:** `sa-alpha-1.11.498`

### live-oscar: micro tier — vol1h порог $20k (Фаза 3)

**Изменение (только micro, $500k–$1.3M):** минимальный объём за 1 час для входа **$20 000** (было $35 000). low/prod/scalp_wave и global `PAPER_VOL_1H_MIN_USD` без изменений.

- `PAPER_LIVE_OSCAR_MICRO_MCAP_VOL_1H_MIN_USD`: **`35000`** → **`20000`**
- schema default `liveOscarMicroMcapVol1hMinUsd`: `75000` → **`20000`**

**Откат:** redeploy `sa-alpha-1.11.497`; `PAPER_LIVE_OSCAR_MICRO_MCAP_VOL_1H_MIN_USD=35000`.

---

## [1.11.497] — 2026-06-24

**Тег:** `sa-alpha-1.11.497`

### live-oscar: micro tier — убрана leg-2 @ −5%

**Изменение (только micro, $500k–$1.3M):** первая покупка **$300** @ signal; **без** entry_split leg-2 @ −5%; одно усреднение **$300** @ −10% (`staged_avg`). Max **$600**. prod/low/scalp_wave без изменений.

| Tier | Leg-1 | Leg-2 @ −5% | Leg-3 @ −10% | Max |
|------|-------|-------------|--------------|-----|
| **micro** | $300 | — | $300 | **$600** |
| **low** | $200 | $200 | $300 | **$700** |
| **prod** | $200 | $200 | $300 | **$700** |
| **scalp_wave** | $300 one-shot | — | — | **$300** |

- `PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD`: **`0`** (split off)
- `PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD`: **`300`**
- Phase escalation scalp→micro: уже вложено $300 scalp + до $300 avg = max **$600**
- `resolveLiveOscarEntrySplitLeg2Usd` / lifecycle / gates; тесты entry-sizing / mcap-tier / phase-escalation

**Откат:** redeploy `sa-alpha-1.11.496`; восстановить micro env leg2=`200`, position=`500`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

Без cross-product изменений.

---

## [1.11.496] — 2026-06-24

**Тег:** `sa-alpha-1.11.496`

### Fix: dc-trader dashboard — real PnL, open vs watching, exit params

**RCA:** плитка 3 была переименована в «DCA Trader», но UI оставался Oscar-адаптером: **268 watching-vault** сливались в Open positions (`open: [...open, ...watchingOpen]`), PnL брался из **price_band / maxPctFromEntry** (+136% на ~$100) вместо on-chain SOL, строка TP/TRAIL/SL — из live-oscar.

- **`dc-trader-dashboard.ts`:** Open = только `entered` + journal `buy`; Monitoring = `watching`; closed PnL SSOT = `pnlSol` / `exitSol − entrySol`; legacy price-only sells без SOL → null, не +136%.
- **`dashboard-server.ts`:** не мержить watching в open; `dcTraderWatching`; dc-trader unrealized без $100 fallback.
- **`dashboard-paper2.html`:** dc-trader params grid, exit breakdown по `exitReason`, секция Monitoring.
- **`tests/dc-trader-dashboard.test.ts`:** regression loader.

**Откат:** `git checkout sa-alpha-1.11.496 -- scripts-tmp/dc-trader-dashboard.ts scripts-tmp/dashboard-server.ts scripts-tmp/dashboard-paper2.html tests/dc-trader-dashboard.test.ts`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

### Fix: `/papertrader2` tile 3 — DCA Trader (dc-trader), not Copy Trader

**RCA:** `ecosystem.config.cjs` уже указывал `DASHBOARD_DC_TRADER_*`, но `scripts-tmp/dc-trader-dashboard.ts` был в `.gitignore` (`scripts-tmp/dc-*`) и не подключался в `dashboard-server.ts` / HTML — после `git reset --hard origin/v2` на VPS оставалась плитка **Copy Trader**.

- **`scripts-tmp/dc-trader-dashboard.ts`:** tracked (exception в `.gitignore`).
- **`dashboard-server.ts`:** `DASHBOARD_PANEL_ORDER` tile 3 → **`dc-trader`**; loader `loadDcTraderForDashboard`; header wallet «DCA Trader».
- **`dashboard-paper2.html`:** fallback order + `STRATEGY_META` для dc-trader.
- **`tests/dashboard-paper2-panels.test.ts`:** порядок плиток.

**Откат:** `git checkout sa-alpha-1.11.495 -- .gitignore scripts-tmp/dc-trader-dashboard.ts scripts-tmp/dashboard-server.ts scripts-tmp/dashboard-paper2.html tests/dashboard-paper2-panels.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

---

## [1.11.495] — 2026-06-24

**Тег:** `sa-alpha-1.11.495`

### pumpswap: PG snapshot freshness — cap enrich, primary-first upsert, alert ts fix

**RCA:** тик `sa-pumpswap` занимал 5–6 мин из‑за ~85 solo-fetch DexScreener + 3 search; при 429 (Retry-After 60s) enrich блокировал upsert → `MAX(ts)` не двигался → STALE alert; в алерте `latest=null` при строковом `ts` из PG driver.

- **`pumpswap-collector.mjs`:** primary search/gecko bucket **upsert до enrich**; enrich с `ENRICH_MAX_RETRIES=1` (fail-fast на 429); интервал PM2 **30s → 60s**
- **`paper2-open-snapshot-enrich.mjs`:** cap solo-fetch (**12**/tick, rotate queue), batch chunks (**8**/tick); приоритет live → paper → whitelist → discovery pin
- **`pair-snapshot-freshness.ts`:** `normalizeSnapshotLatestTs` / `formatSnapshotLatestTs` — строковый `MAX(ts)` больше не даёт `latest=null`
- **`ecosystem.config.cjs`:** env caps для pumpswap enrich
- Тесты alert formatter

**Откат:** `git checkout sa-alpha-1.11.494`; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.494] — 2026-06-23

**Тег:** `sa-alpha-1.11.494`

### live-oscar: унификация входов — только $200 и $300

**Изменение:** все staged-entry ноги приведены к двум размерам **$200** и **$300**; prod leg-3 **$600 → $300**; micro leg-2 **$150 → $200**.

| Tier | Leg-1 | Leg-2 @ −5% | Leg-3 @ −10% | Max |
|------|-------|-------------|--------------|-----|
| **prod** | $200 | $200 | **$300** | **$700** |
| **low** | $200 | $200 | $300 | **$700** |
| **micro** | $300 | **$200** | $300 | **$800** |
| **scalp_wave** | $300 one-shot | — | — | **$300** |

- `PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD`: **`300`** (prod/low leg-3)
- `PAPER_LIVE_OSCAR_MICRO_MCAP_ENTRY_SPLIT_LEG2_USD`: **`200`**
- `PAPER_LIVE_OSCAR_MICRO_MCAP_POSITION_USD`: **`500`** (leg1+leg2)
- `LIVE_MAX_POSITION_USD`: **`700`** (полный prod/low план)
- defaults в `config.ts`; тесты entry-sizing / escalation / labels

После scalp_wave escalation — tier sizing целевого mcap (micro max **$800**, low/prod **$700**).

**Откат:** redeploy `sa-alpha-1.11.493` или восстановить env 1.11.492/493; `pm2 reload ecosystem.config.cjs --update-env`.

Без cross-product изменений.

---

## [1.11.493] — 2026-06-23

**Тег:** `sa-alpha-1.11.493`

### live-oscar: post-close tail sweep — cap only after killstop (P0 SOLANGELES ghost)

**Проблема:** после TP-close ~$503 SPL остались на кошельке; post-close tail sweep пропустил sell из‑за `LIVE_POST_CLOSE_TAIL_SWEEP_MAX_USD=25` (`balance_above_tail_cap`). Tracker считал позицию закрытой; orphan SPL не управлялся.

**Исправление:**
- `livePostCloseTailSweepCapApplies()` — cap $25 только после `KILLSTOP` / `FLASH_CRASH_KILL`; после TP/TRAIL/TIMEOUT всегда sweep remainder
- `tracker.ts` передаёт `exitReason` в tail sweep
- тест `tests/live-post-close-tail-sweep.test.ts`

**Откат:** redeploy `sa-alpha-1.11.492`.

Без cross-product изменений.

---

## [1.11.492] — 2026-06-23

**Тег:** `sa-alpha-1.11.492`

### live-oscar: micro/low leg-3 avg $600 → $300 (prod без изменений)

**Изменение:** 3-я нога staged entry (avg @ −10%) для tier **micro** и **low** — **$300** вместо $600; **prod** остаётся **$600**.

| Tier | Leg-1 | Leg-2 @ −5% | Leg-3 @ −10% | Max |
|------|-------|-------------|--------------|-----|
| **micro** | $300 | $150 | **$300** | **$750** |
| **low** | $200 | $200 | **$300** | **$700** |
| **prod** | $200 | $200 | $600 | **$1000** |

После scalp_wave escalation применяется tier sizing целевого mcap (micro/low/prod).

- `PAPER_LIVE_OSCAR_MICRO_MCAP_STAGED_AVG_LEG_USD`: **`300`**
- `PAPER_LIVE_OSCAR_LOW_MCAP_STAGED_AVG_LEG_USD`: **`300`**
- `PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD`: **`600`** (prod default)
- `resolveLiveOscarStagedAvgLegUsd()` + `applyCanonicalStagedEntrySizing()` синхронизируют avg leg по tier

**Откат:** redeploy `sa-alpha-1.11.491` или unset tier env + `PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD=600`; `pm2 reload ecosystem.config.cjs --update-env`.

Без cross-product изменений.

---

## [1.11.491] — 2026-06-23

**Тег:** `sa-alpha-1.11.491`

### live-oscar: scalp_wave max mcap $2M → $30M (Фаза 4)

**Изменение:** верхний коридор market cap для lane `scalp_wave` расширен с **$2M** до **$30M**; min **$800k** без изменений.

- `PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD`: `2000000` → **`30000000`**
- default в `config.ts`, prod env в `ecosystem.config.cjs`
- skip reason `scalp_wave_mcap_outside_*` подхватывает новые границы из cfg

**Откат:** redeploy `sa-alpha-1.11.490` или `PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_MCAP_USD=2000000` + `pm2 reload ecosystem.config.cjs --update-env`.

Без cross-product изменений.

---

## [1.11.490] — 2026-06-23

**Тег:** `sa-alpha-1.11.490`

### live-oscar: TTL staged-entry не сбрасывает план усреднения на открытой позиции

**Проблема (SOLANGELES):** после leg1+leg2 сплита `liveStagedEntry` снимался по `PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS=1`, хотя avg $600 @ −10% ещё не исполнился; −10% пришёл через 28 мин после TTL — добора не было.

**Исправление:**
- TTL 1 ч остаётся для **pre-entry** (discovery anchor в `main.ts` — без изменений)
- На **открытой** позиции: `liveStagedEntry` не очищается по TTL, пока есть незавершённые ноги (entry split leg2 или staged avg)
- `liveStagedEntryHasPendingLegs`, `liveStagedEntryTtlPreservesPlan`, `liveStagedEntryAddWindowOpen` в `live-staged-entry-gates.ts`
- Паритет в `paper2-strategy-backtest.ts`

**Откат:** `git revert` коммита; redeploy `sa-alpha-1.11.489`.

Без cross-product изменений.

---

## [1.11.489] — 2026-06-23

**Тег:** `sa-alpha-1.11.489`

### dashboard: метка scalp_wave (Фаза 4) на открытых позициях Live Oscar

**Проблема:** scalp_wave-позиции попадали в список open через sidecar snapshot, но UI не показывал, что это скальп — `lane` в API брался из discovery (`post_migration`), а не из `liveOscarTradeLane`.

**Изменения:**
- API `/api/paper2`: поля `isScalpWave` и `liveOscarTradeLane` на open rows (из `openTrade` / snapshot)
- UI: pill **«Скальп · Ф4»** на плитке Live Oscar для активных scalp_wave
- После phase escalation (`liveOscarTradeLane=prod`) badge не показывается; JSONL replay обрабатывает `live_phase_escalation`

**Откат:** `git revert` коммита; redeploy предыдущего SHA на VPS.

---

## [1.11.488] — 2026-06-22

**Тег:** `sa-alpha-1.11.488`

### live-oscar: phase escalation scalp_wave → prod/low

**Проблема:** Фаза 4 (scalp_wave) входила на мелком дипе (−8..−15%), но при углублении просадки mutex блокировал prod/low lane; kill −10% закрывал позицию вместо передачи управления staged-entry / wave_b.

**Исправление:**
- **Phase escalation:** при просадке глубже −15% от входа, timestop 3h без TP, или discovery handoff (prod eval pass при открытом scalp) — `liveOscarTradeLane` → `prod`, `liveExitPolicyId` → `wave_b_v1`, staged entry legs по mcap-tier
- **Kill scalp отключён** (`dcaKillstop=0`); вместо −10% kill — эскалация
- **Mutex:** `phase_escalation_handoff` вместо `lane_mint_mutex` для prod на открытом scalp
- Journal: `live_phase_escalation` (paper + live JSONL schema)

**Rollback:** redeploy `sa-alpha-1.11.487`.

Без cross-product изменений.

---

## [1.11.487] — 2026-06-22

**Тег:** `sa-alpha-1.11.487`

### live-oscar scalp_wave: min age 12h, без верхнего cap 36h

**Проблема:** Фаза 4 отсекала токены старше 36h (`scalp_wave_age_outside_720_2160m`); prod `PAPER_POST_MIN_AGE_MIN=2160` также блокировал scalp на 12–35h на уровне SQL universe и `globalGate`.

**Исправление:**
- scalp_wave: только **min 12h (720 min)**, **max age снят** (default `liveOscarScalpWaveMaxAgeMin=0`)
- skip reason: `scalp_wave_age_below_12h`
- `liveOscarScalpWaveEntryConfig`: `globalMinTokenAgeMin` / `dipMinAgeMin` = 720 (не prod 36h)
- SQL snapshot post lane: при включённом scalp_wave — `min(POST_MIN, scalp_min)` для universe (prod eval по-прежнему 36h через globalGate)

**Rollback:** redeploy `sa-alpha-1.11.486`.

Без cross-product изменений.

---

## [1.11.486] — 2026-06-22

**Тег:** `sa-alpha-1.11.486`

### live-oscar P0: ZERO leg3 — staged entry vs MTM clamp + JSONL schema

**Проблема:** `clampLiveTrackerMtmForExit` (±12%/tick) применялся до staged entry — leg3 (−10% vs signal) не срабатывал при PG −17%; `staged_avg_add` / boot-события 1.11.483 падали на Zod whitelist; редкие `execution_attempt` без `execution_result` при throw из simulate RPC.

**Исправление:**
- Staged entry (leg2/leg3, signal-kill) — **PG snapshot** (fallback: raw MTM до clamp); exit TP/trail/kill vs avg — clamped MTM; `lastObservedPriceUsd` = raw MTM для дашборда.
- JSONL schema: `staged_avg_add`, `entry_split_add`, `live_boot_snapshot_merge`, `live_boot_wallet_orphan_restore`.
- Mirror `entry_split_add` / `staged_avg_add` в live JSONL (всегда, не только discovery audit).
- Buy simulate: `execution_result` при throw из `liveSimulateSignedTransaction`.
- post-deploy-smoke: grep `live-oscar executor start`.

**Rollback:** redeploy `sa-alpha-1.11.485`.

Без cross-product изменений.

---

## [1.11.485] — 2026-06-22

**Тег:** `sa-alpha-1.11.485`

### live-oscar: включить Фазу 4 — scalp_wave lane на prod

Код lane из **1.11.484** уже на prod; этот релиз **включает** её в PM2:

- `PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED`: `0` → **`1`**
- Явные env (паритет с `config.ts` defaults): age **720–2160** min, mcap **$800k–$2M**, dip **−8..−15%**, one-shot **$300**, max **3** concurrent, exit **+10% / −10% / 3h**

**Rollback:** redeploy `sa-alpha-1.11.484` или `PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED=0` + `pm2 reload ecosystem.config.cjs --update-env`.

Без cross-product изменений.

---

## [1.11.484] — 2026-06-22

**Тег:** `sa-alpha-1.11.484`

### live-oscar: scalp_wave lane ($300 shallow dip, mint mutex)

**Новая trade-lane `scalp_wave`** — независима от prod Oscar (staged $200+$200+$600):
- Коридор: age 12–36h, mcap $800k–$2M, dip −8..−15%
- Вход: one-shot **$300**, без staged split / DCA
- Выход `scalp_wave_v1`: TP **+10%** full, kill **−10%**, timestop **3h**
- Max **3** concurrent scalp_wave (env `PAPER_LIVE_OSCAR_SCALP_WAVE_MAX_CONCURRENT`)
- **Mint mutex:** один mint = одна `OpenTrade`; вторая lane → `live_discovery_skip_open: lane_mint_mutex`
- Env: `PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED` (default **0**)

**Rollback:** redeploy `sa-alpha-1.11.483`, set `PAPER_LIVE_OSCAR_SCALP_WAVE_LANE_ENABLED=0`.

Без cross-product изменений.

---

## [1.11.483] — 2026-06-22

**Тег:** `sa-alpha-1.11.483`

### live-oscar P0: boot не теряет open после tail-replay (Jotchua ghost)

**Проблема:** при `LIVE_REPLAY_MAX_FILE_BYTES` (prod 200MB) и журнале ~5.8GB tail-replay не видел `live_position_open`/`partial_sell` старше окна (Jotchua 19.06). Boot перезаписывал sidecar snapshot урезанным replay; `spl_reconcile_removed` не восстанавливал wallet→tracker; orphan reconcile закрывает только «журнал open, кошелёк 0», не наоборот.

**Исправление:**
- **`mergeLiveOpenSnapshotIntoBootReplay`** — при `journalTruncated` подмешивает свежий pre-boot `live-oscar-open-snapshot.json` (кроме mint с событиями в tail, включая close).
- **`restoreWalletOrphanOpensOnBoot`** — SPL на кошельке без open в replay → full-journal replay по mint (`replayLiveStrategyJournalForMints`).
- JSONL: `live_boot_snapshot_merge`, `live_boot_wallet_orphan_restore`.

**Rollback:** redeploy `sa-alpha-1.11.482`.

Без cross-product изменений.

---

## [1.11.482] — 2026-06-22

**Тег:** `sa-alpha-1.11.482`

### dashboard: Live Oscar open positions via sidecar snapshot

**Проблема:** `/api/paper2` для Live Oscar показывал 1 open при 4 в полном replay журнала — tail-only scan последних 200MB из 5.4GB JSONL терял старые `live_position_open`; `openCount` завышался из heartbeat.

**Исправление:**
- **`data/live/live-oscar-open-snapshot.json`** — sidecar, который live-oscar обновляет на boot replay, heartbeat и каждом `live_position_*` (open/close/dca/partial/scale-in).
- **Dashboard** читает snapshot как source of truth для `open[]`; fallback на tail replay если snapshot отсутствует или stale (`DASHBOARD_LIVE_OSCAR_SNAPSHOT_MAX_AGE_MS`, default 24h).
- **`openCount`** = длина фактического списка `open[]`, без `Math.max` с heartbeat.

**Env (optional):** `LIVE_OPEN_SNAPSHOT_PATH`, `DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT`.

**Rollback:** redeploy `sa-alpha-1.11.481`; удалить sidecar snapshot (dashboard вернётся к tail-only replay).

Без cross-product изменений.

---

## [1.11.481] — 2026-06-21

**Тег:** `sa-alpha-1.11.481`

### live-oscar: 3-leg staged entry ($200 + $200 + $600)

Схема входа от якоря сигнала (total **$1000**):

| Нога | USD | Триггер |
|------|-----|---------|
| Leg-1 | **$200** | сразу по сигналу (`FIRST_DROP_PCT=0`) |
| Leg-2 | **$200** | **−5%** от якоря (`ENTRY_SPLIT_TARGET_DROP_PCT=5`) |
| Leg-3 | **$600** | **−10%** от якоря (`SECOND_DROP_PCT=10`, `SECOND_LEG_USD=600`) |

**Env (`ecosystem.config.cjs` → `live-oscar`):**
- `PAPER_POSITION_USD` / split: **$400** (leg1+leg2, boot-инвариант)
- `LIVE_MAX_POSITION_USD`: **$1000** (полный план)
- `..._ENTRY_SPLIT_LEG_USD` / `..._FIRST_LEG_USD`: `250` → **`200`**
- `..._ENTRY_SPLIT_LEG2_USD`: `250` → **`200`**
- `..._SECOND_LEG_USD`: `500` → **`600`**
- Low-mcap lane aligned: split **$200+$200**, position **$400**

**Тесты:** `live-staged-entry-labels`, `live-staged-entry-gates` — prod 3-leg wording/progression.

**Rollback:** redeploy `sa-alpha-1.11.480`; или вернуть env split **$250+$250**, leg-3 **$500**, position **$500**.

Без cross-product изменений.

---

## [1.11.480] — 2026-06-21

**Тег:** `sa-alpha-1.11.480`

### live-oscar: 3-leg staged entry ($250 + $250 + $500)

Новая схема входа от якоря сигнала (total **$1000**):

| Нога | USD | Триггер |
|------|-----|---------|
| Leg-1 | **$250** | сразу по сигналу (`FIRST_DROP_PCT=0`) |
| Leg-2 | **$250** | **−5%** от якоря (`ENTRY_SPLIT_TARGET_DROP_PCT=5`) |
| Leg-3 | **$500** | **−10%** от якоря (`SECOND_DROP_PCT=10`, `SECOND_LEG_USD=500`) |

**Env (`ecosystem.config.cjs` → `live-oscar`):**
- `PAPER_POSITION_USD` / split: **$500** (leg1+leg2, boot-инвариант)
- `LIVE_MAX_POSITION_USD`: **$1000** (полный план)
- `PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT`: `10` → **`0`**
- `..._ENTRY_SPLIT_LEG_USD` / `..._FIRST_LEG_USD`: `500` → **`250`**
- `..._ENTRY_SPLIT_LEG2_USD`: `500` → **`250`**
- `..._ENTRY_SPLIT_TARGET_DROP_PCT`: `10` → **`5`**
- `..._SECOND_DROP_PCT`: `0` → **`10`**, `..._SECOND_LEG_USD`: `0` → **`500`**
- `..._AVG_COOLDOWN_MS`: `180000` → **`0`** (leg-3 без паузы после leg-1)
- Low-mcap lane aligned: split **$250+$250**, position **$500**

**Код:** подписи `live-staged-entry-labels.ts` (3-я нога vs усреднение), описание в `main.ts`.

**Тесты:** `tests/live-staged-entry-gates.test.ts` — 3-leg progression (−5% / −10%, no double-buy flags).

**Rollback:** revert + `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`; или вернуть env 1.11.479 (`FIRST_DROP_PCT=10`, split $500+$500 @ −10%).

Без cross-product изменений.

---

## [1.11.479] — 2026-06-21

**Тег:** `sa-alpha-1.11.479`

### live-oscar: staged-entry TTL — clear anchor, fresh re-eval (не re-anchor)

После истечения `PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS` (1 ч) без входа на −10% бот **сбрасывает** якорь `stagedEntrySignals` и **не** создаёт новый на текущей цене в том же discovery-проходе. Монета должна снова пройти полный discovery/eval pipeline; только при повторном `pass` — новый `live_staged_entry_signal` с якорем на **оцененной** цене того прохода.

**Код:**
- `planLiveStagedEntrySignalResolution` (`live-staged-entry-gates.ts`) — чистая логика: `ttl_expired_clear` vs `create_new` vs `use_existing`.
- `resolveLiveStagedEntrySignal` (`main.ts`) — при TTL expiry: delete anchor, journal `staged_entry_ttl_expired`, skip open.
- Сохранён 1.11.478: при `reanchorBlocked` (buy in-flight / ambiguous cooldown) expired anchor не сбрасывается.

**Observability:** `staged_entry_ttl_expired` в live JSONL schema (`events.ts`).

**Тесты:** `tests/live-staged-entry-gates.test.ts` — TTL clear, no same-tick re-anchor, buy-in-flight preserve.

**Rollback:** `git revert` → push `v2` → NORM §5 deploy.

Без cross-product изменений.

---

## [1.11.478] — 2026-06-21

**Тег:** `sa-alpha-1.11.478`

### live-oscar: SOLANGELES RCA — staged-entry anchor + buy retry (P0–P2)

Исправления по RCA провала входа SOLANGELES (slippage `0x1771` + преждевременный re-anchor).

**P0 staged entry (`src/papertrader/main.ts`):**
- Якорь `stagedEntrySignals` не удаляется при достижении −10%; сброс только после `live_position_open`.
- При `tryExecuteBuyOpen` failure — восстановление прежнего anchor + журнал `staged_entry_restored_after_buy_fail`.
- Re-anchor блокируется при in-flight buy и `live_ambiguous_buy_cooldown`.

**P1 execution retry:**
- `isRetryableBuySimError`: `0x1771`, `rpc_error:`, `qn_rpc_error:`, `Transaction simulation failed`.
- `finalizeLiveSendJsonl`: pre-send sim/slippage → `status: sim_err` (не `failed`).

**P2 observability:** `staged_entry_cleared_for_buy` / `staged_entry_restored_after_buy_fail` в live JSONL.

**Rollback:** `git revert` коммита 1.11.478 → push `v2` → стандартный деплой NORM §5.

Без cross-product изменений.

---

## [1.11.477] — 2026-06-20

**Тег:** `sa-alpha-1.11.477` (следующий за 1.11.476)

### live-oscar: активация entry-wait окна = 1 час (в 1.11.476 был default-OFF)

Чистый follow-up к 1.11.476 (история не переписывалась). Только прод-конфиг (`ecosystem.config.cjs`, app `live-oscar`); код papertrader не менялся.

**Изменение (активно в проде):**
- `PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS`: `'0'` → **`'1'`**.
- Семантика: `liveStagedEntryWaitHours = 1` → `liveStagedEntrySignalTtlMs = 3_600_000` мс. Staged-signal якорь (−10% от сигнального уровня) живёт 1 час; если за 1 ч цена не достигла −10% — сигнал истекает (перестаём ждать). Дополнительная re-monitoring / re-entry логика НЕ включается — только TTL якоря.
- Подтверждено в коде: `src/papertrader/config.ts` (WAIT_HOURS > 0 → TTL = hours × 3_600_000), гейты `src/papertrader/executor/live-staged-entry-gates.ts`.

**Vol1h (унаследовано из 1.11.476, остаётся активным):** micro/low vol1h = 35000, global `PAPER_VOL_1H_MIN_USD` = 35000.

**Rollback:** вернуть `PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS` → `'0'` (или удалить ключ) + `pm2 reload ecosystem.config.cjs --update-env`. Код не трогали — откат чисто по env.

Без cross-product изменений.

---

## [1.11.476] — 2026-06-20

**Тег:** `sa-alpha-1.11.476` (планируется координатором)

### live-oscar: расширение объёма (ВКЛ) + плумбинг entry-wait окна (флаг, default-OFF)

Два независимых изменения поверх 1.11.475. Только продуктовый конфиг + papertrader-код; кросс-продуктовых
изменений нет.

**1. Расширение объёма (одобрено владельцем — АКТИВНО в проде, `ecosystem.config.cjs`, app `live-oscar`):**
- `PAPER_LIVE_OSCAR_MICRO_MCAP_VOL_1H_MIN_USD`: `75000` → **`35000`**
- `PAPER_LIVE_OSCAR_LOW_MCAP_VOL_1H_MIN_USD`: `75000` → **`35000`**
- `PAPER_VOL_1H_MIN_USD`: `36000` → **`35000`**
- PROD-тир `PAPER_LIVE_OSCAR_PROD_MCAP_VOL_1H_MIN_USD=25000` — **без изменений**. Dip-пороги, mcap-коридоры,
  holders — **не трогались**.

**2. Entry-wait окно (плумбинг, флаг, default = текущее поведение / эффективно OFF):**
- Новый флаг `PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS` (`liveStagedEntryWaitHours`, `src/papertrader/config.ts`).
  `0` (default) = OFF → тайминг входа определяется только `PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS` (прод `0` =
  без лимита), т.е. **байт-в-байт текущий live-тайминг входа**. При `> 0` переопределяет staged-signal TTL
  на `hours * 3_600_000` мс (например `1` = 1ч ожидания −10% от сигнального якоря, после — якорь снимается).
- Механизм окна — существующий `liveStagedEntrySignalTtlMs` (`live-staged-entry-gates.ts`,
  `tracker.ts`); флаг — эргономичная «в часах» обёртка, резолвится в `loadPaperTraderConfig` после parse.
  Boot-guard `assertLiveOscarUnifiedEntrySizing` не затрагивается (валидирует только sizing) — зелёный.
- `ecosystem.config.cjs` задаёт `PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS='0'` → **live-тайминг входа на деплое НЕ
  меняется**; владелец флипает в `'1'` когда готов.

**Обоснование (read-only анализ, Part A):** точная модель «релиз обратно в discovery + ре-квалификация
свежим якорем» (`scripts-tmp/_cf_remonitor_entry.py`, `_cf_remonitor_entry_results.json`) показала, что
ре-мониторинг НЕ окупается: на 45д чистый `1ч hard-skip` = +$678 (DD $280) против `1ч+ре-мониторинг` = +$36
(DD $1329); инкрементальные ре-входы −$642, при этом «pump-then-pullback» ветка −$700. Поэтому окно
поставлено как плумбинг default-OFF, а не включено.

**Тесты:** `npm run typecheck` зелёный. OFF-паритет: при `WAIT_HOURS=0` `liveStagedEntrySignalTtlMs`
остаётся прод-значением (`0`) — поведение неизменно.

**Откат:** мгновенно — объём вернуть `MICRO/LOW=75000`, `PAPER_VOL_1H_MIN_USD=36000`; окно — убрать/обнулить
`PAPER_LIVE_STAGED_ENTRY_WAIT_HOURS` (default `0` = текущее поведение) + `pm2 reload ecosystem.config.cjs
--update-env`. Полный откат кода — redeploy `sa-alpha-1.11.475`. Изменения объёма влияют только на новые
discovery-проходы; открытые позиции не затрагиваются.

---

## [1.11.475] — 2026-06-20

**Тег:** `sa-alpha-1.11.475` (планируется координатором)

### live-oscar: ранний/плоский тейк вместо эскалирующей лесенки (Wave B) + тайм-стоп 12ч — TRADING-BEHAVIOR

Осознанное изменение торговой логики ВЫХОДА (одобрено владельцем). По CF-оптимизатору
(`scripts-tmp/_cf_unified_optimizer_ru.md`, `_cf_recent2w_recheck_ru.md`) эскалирующая «бесконечная»
лесенка Wave B — убыточный рычаг на свежем окне (продаёт крошечные доли, отдаёт прибыль на откате),
а ранний/плоский тейк — режим-устойчивый выигрыш.

**Реализация (код, за флагом, default OFF в коде, ВКЛ в проде):**
- Новый флаг `PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP` (`liveOscarWaveBFlatTpEnabled`). При OFF поведение
  **байт-в-байт** = текущая эскалирующая лесенка (все существующие Wave-B тесты зелёные без изменений).
- Режим `PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP_MODE` (`half8_runner` | `flat`); прод = **`half8_runner`**:
  продать 50% на каждом +8% (`WAVE_B_FLAT_TP_HALF8_RUNNER`), остаток ведёт штатный defensive-trail
  (раннер), брейкэвен-пол (+7.5%) и kill (−50%) без изменений. `flat` = продать 100% на +15% без трейла.
- Профиль выбирается в `waveBTpGridProfileFor(ot)` по штампу `ot.liveWaveFlatTpMode`, который ставится
  **только на новые** opens при включённом флаге (`stampLiveOscarExitPolicyOnOpen`). Позиции, открытые
  до включения, **НЕ переклеймляются** — продолжают на эскалирующей лесенке (безопасный переход; их
  выход не меняется). Штамп персистится (snapshot/restore) — переживает reload PM2.
- Wave-B тайм-стоп `PAPER_LIVE_OSCAR_WAVE_B_TIME_STOP_HOURS=12` (`liveOscarWaveBTimeStopHours`): в
  legacy Wave B тайм-стопа НЕТ; добавлен в `tracker.ts`, применяется **только** к заклеймлённым
  (новым) позициям — открытые до включения не закрываются по времени принудительно. `0` = выключить.

**Не трогалось:** вход (R1 1.11.474, FIRST_DROP=10), sizing, kill (−50%), MICRO/LOW-тиры, Shyft-флаги
(shadow `1`, прочие `0`), `.env`/секреты.

**Тесты:** `tests/wave-b-flat-tp.test.ts` (профиль half8/flat, OFF=лесенка, трейл-подавление для flat,
штамп). `npm run typecheck` + `tests/papertrader-exit-policy-wave-b.test.ts` (OFF-паритет) зелёные.

**Откат:** мгновенно — флаг `PAPER_LIVE_OSCAR_WAVE_B_FLAT_TP=0` + `pm2 reload ecosystem.config.cjs --update-env`
(возврат к эскалирующей лесенке, новые opens снова без штампа; тайм-стоп отключается). Полный откода —
redeploy `sa-alpha-1.11.474`. Изменение действует только на новые opens; открытые позиции не затрагиваются.

---

## [1.11.474] — 2026-06-20

**Тег:** `sa-alpha-1.11.474` (планируется координатором)

### live-oscar: вход переведён с немедленного (0%) на −10% от сигнала — TRADING-BEHAVIOR

Осознанное изменение торгового поведения входа (одобрено владельцем). По итогам CF-оптимизатора
(`scripts-tmp/_cf_unified_optimizer_ru.md`, `_cf_recent2w_recheck_ru.md`): немедленный вход (0%)
на свежем окне нетто-минусовой, тогда как вход при −10% от сигнала даёт лучший нетто на сделку
(≈+$92/сделку на 14-дневном окне) при умеренном падении частоты (fill ≈69% за 2 недели).

**Реализация (env-only, новые входы):** `PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT` `0`→`10`.
2-я нога split уже нацелена на −10% (`..._ENTRY_SPLIT_TARGET_DROP_PCT=10`), поэтому теперь обе
клипсы $500 исполняются на одном уровне −10% = единый заход $1000 при −10% без усреднения вниз
(staged-averaging −7/−14 уже выключен). Sizing/notional/fraction **без изменений** ($500+$500,
$1000 notional, fraction 0.5) → boot-инвариант `assertLiveOscarUnifiedEntrySizing` остаётся зелёным;
LOW/MICRO-тиры, kill (−50%), Shyft-флаги (shadow `1`, прочие `0`), `.env`/секреты **не трогались**.

**Примечание:** выходная логика (замена эскалирующей лесенки на плоский/ранний тейк) и тайм-стоп
12ч для Wave B — это **код** (Wave B сейчас вообще не имеет тайм-стопа) и идут отдельным релизом
1.11.475 за флагом.

**Откат:** redeploy тега `sa-alpha-1.11.473` (SHA `bba8713`) — `git fetch && git reset --hard bba8713 && npm ci && pm2 reload ecosystem.config.cjs --update-env`. Изменение влияет только на новые входы; открытые позиции не затрагиваются.

---

## [1.11.473] — 2026-06-18

**Тег:** `sa-alpha-1.11.473` (планируется координатором)

### live-oscar: вход $500+$500 ($1000 notional), leg-1 сразу по сигналу (0%) — TRADING-BEHAVIOR

Осознанное изменение торгового поведения входа (одобрено владельцем). Глобальный staged-entry prod-тира (mcap ≥ $3M) и связанный low-тир ($1.3M–$3M) переведены со схемы **$1000+$500 ($1500 notional), 1-я нога при −5%** на **$500+$500 ($1000 notional), 1-я нога немедленно по цене сигнала (0%)**; 2-я нога (усреднение) без изменений при −10%, kill −50%.

**Изменения env (`ecosystem.config.cjs`, live-oscar):**
- GLOBAL: `PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT` `5`→`0`; `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD` `1000`→`500`; `PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD` `1000`→`500`; консты `LIVE_OSCAR_ENTRY_NOTIONAL_USD` `1500`→`1000` и `LIVE_OSCAR_MAX_POSITION_USD` `1500`→`1000`. `..._ENTRY_SPLIT_LEG2_USD` остаётся `500`, `PAPER_ENTRY_FIRST_LEG_FRACTION` остаётся `0.5`.
- LOW_MCAP (требуется boot-инвариантом `assertLiveOscarUnifiedEntrySizing`: low leg == global leg, low position == global position): `PAPER_LIVE_OSCAR_LOW_MCAP_ENTRY_SPLIT_LEG_USD` `1000`→`500`; `PAPER_LIVE_OSCAR_LOW_MCAP_POSITION_USD` `1500`→`1000`; `..._LEG2_USD` остаётся `500`.
- MICRO_MCAP без изменений ($300+$150/$450). Shyft-флаги без изменений (shadow `1`, остальные `0`). PROD_MCAP dip/vol без изменений. `.env`/секреты не трогались.

**Консистентность (проверено):** boot-guard зелёный — leg1+leg2 = 500+500 = pos 1000 (prod и low); `FIRST_LEG_USD`(500) == `ENTRY_SPLIT_LEG`(500); low leg/pos == global; PAPER_POSITION_USD 1000 ≤ LIVE_MAX_POSITION_USD 1000 (boot в `src/live/main.ts` не падает). `npm run typecheck` зелёный; vitest entry-sizing/staged-entry зелёные.

**Поведение:** затрагивает только НОВЫЕ входы. Уже открытые позиции сохраняют Wave-B выходы (изменение касается только сайзинга/триггера входа).

**Затронутые файлы:** `ecosystem.config.cjs`, `docs/strategy/release/VERSION`, `docs/strategy/release/CHANGELOG.md`.

**Откат:** redeploy тега `sa-alpha-1.11.472` / SHA `8b76511` (`git reset --hard 8b76511 && npm ci && pm2 reload ecosystem.config.cjs --update-env`); либо вернуть ключи к `FIRST_DROP_PCT=5`, `ENTRY_SPLIT_LEG_USD=1000`, `FIRST_LEG_USD=1000`, notional/max `1500`, и LOW_MCAP leg `1000` / position `1500`.

---

## [1.11.472] — 2026-06-18

**Тег:** `sa-alpha-1.11.472` (планируется координатором)

### Этап 1.1 (live-oscar): регистрация shadow-событий в live-схеме журнала (иначе drop)

После фикса консьюмера (1.11.471) он подключается, но события `live_shyft_shadow_status` и `live_shyft_shadow_price` **не появлялись** в журнале: `appendLiveJsonlEvent` (`src/live/store-jsonl.ts`) валидирует тело против `LiveEventBodySchema` (`src/live/events.ts`) и **молча отбрасывает** (только `console.warn`) тела с незарегистрированным `kind`. Оба shadow-kind'а отсутствовали в `discriminatedUnion` (автор 1.11.467 добавил их в билдер/консьюмер, но не в live-схему; не ловилось, т.к. флаг был OFF).

**Фикс:** добавлены `LiveShyftShadowStatusSchema` (`status` ∈ connecting/connected/end/error/decode_error/closed/idle + optional `detail`) и `LiveShyftShadowPriceSchema` (mint/lane/surface/streamPriceUsd/pgPriceUsd/streamTsMs/pgSnapshotTsMs/pgPriceAgeMs/streamVsPgLagMs/streamVsPgPriceDiffPct/streamSlot, PG-поля nullable) в `LiveEventBodySchema`. Теперь shadow-события **журналируются** в `data/live/*.jsonl` (default-fsync = false, как у прочих наблюдательных событий).

**Поведение торговли НЕ меняется** — правка только в схеме валидации журнала + новый тест. Прочие Shyft-флаги остаются OFF.

**Тесты:** `tests/live-jsonl-phase1.test.ts` — новый кейс: оба shadow-kind'а парсятся и не отбрасываются (включая nullable PG-поля). `npm run typecheck` зелёный; vitest live-jsonl 9/9, shyft-shadow 18/18.

**Затронутые файлы:** `src/live/events.ts`, `tests/live-jsonl-phase1.test.ts`, `docs/strategy/release/VERSION`, `docs/strategy/release/CHANGELOG.md`, `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`.

**Откат:** `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=0` + redeploy; либо redeploy тега `sa-alpha-1.11.469`. При OFF поведение торговли байт-в-байт = текущее.

---

## [1.11.471] — 2026-06-18

**Тег:** `sa-alpha-1.11.471` (планируется координатором)

### Этап 1.1 (live-oscar): фикс gRPC-консьюмера Shyft (CJS/ESM interop + явный connect)

После включения shadow-флага в 1.11.470 консьюмер стартовал, но НЕ подключался: в логах `shyft shadow consumer error: "Client is not a constructor"`, backoff-реконнекты. Две причины (обе — дефект кода из 1.11.467, не проявлялся при OFF-флаге):

1. **CJS/ESM interop:** `@triton-one/yellowstone-grpc@5` поставляет dual CJS/ESM-сборку; под tsx/esbuild дефолтный экспорт приходит **двойне обёрнутым** (`namespace.default` = CJS `module.exports`, чей `default` — класс `Client`). Поэтому `import Client from ...` давал не-конструируемый объект. Фикс: `import * as YellowstoneGrpc` + ленивый (мемоизированный) резолвер `resolveYellowstoneClientCtor()`, разворачивающий вложенные `default` до функции-класса. Резолв **ленивый** — любой сбой всплывает внутри flag-gated reconnect-цикла (try/catch + backoff), а НЕ на загрузке модуля → процесс live-oscar не падает.
2. **Явный connect:** в v5 `Client` требует `await client.connect()` перед `subscribe()`/unary (иначе `"Client not connected. Call connect() first"`). Добавлен `await client.connect()` перед `subscribe(...)`.

Подтверждено на проде probe-скриптом (read-only, `/tmp`): резолв класса OK, `connect()` OK, `getVersion()` вернул реальную версию сервера (token принят, endpoint `https://grpc.fra.shyft.to`), `subscribe()` OK.

**Поведение торговли НЕ меняется** — правка только в shadow-консьюмере (`src/papertrader/stream/shyft-shadow-consumer.ts`); стрим-цена по-прежнему НИГДЕ не участвует в гейтах/eval/исполнении. Прочие Shyft-флаги остаются OFF.

**Затронутые файлы:** `src/papertrader/stream/shyft-shadow-consumer.ts`, `docs/strategy/release/VERSION`, `docs/strategy/release/CHANGELOG.md`, `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`.

**Откат:** `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=0` + redeploy (консьюмер отключается); либо redeploy тега `sa-alpha-1.11.469`. При OFF поведение торговли байт-в-байт = текущее.

---

## [1.11.470] — 2026-06-18

**Тег:** `sa-alpha-1.11.470` (планируется координатором)

### Этап 1.1 (live-oscar): включение Shyft shadow-стрима на проде (observability only)

Активирован **Stage 1.1** роадмапа `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`: в `ecosystem.config.cjs` флаг `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED` переведён `'0'` → **`'1'`**. Это запускает Yellowstone gRPC shadow-консьюмер (один на процесс live-oscar, узкий `accountInclude` по watched/open mint'ам), который журналирует `live_shyft_shadow_price` рядом с PG-ценой для измерения лага. **Торговля байт-в-байт не меняется** — стрим-цена НИГДЕ не участвует в гейтах/eval/исполнении.

**Что изменилось:**
- `ecosystem.config.cjs`: **только** `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED` `'0'` → `'1'`. Все прочие Shyft-флаги остаются OFF: `SHYFT_PRICE_PRIMARY_ENABLED='0'`, `SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED='0'`, `SHYFT_DEFI_MCAP_ENABLED='0'`.
- Креды уже на VPS в `/opt/solana-alpha/.env` (`SHYFT_GRPC_TOKEN`, `SHYFT_GRPC_ENDPOINT=https://grpc.fra.shyft.to`). При отсутствии токена консьюмер идлит без падения процесса.

**Наблюдение:** `live_shyft_shadow_price` / `live_shyft_shadow_status` в live-журнале (`data/live/*.jsonl`). Сбор лага PG vs стрим 24–48 ч перед активацией Stage 1.2.

**Откат:** установить `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED` обратно в `'0'` + redeploy; либо redeploy тега `sa-alpha-1.11.469`. При OFF поведение торговли байт-в-байт = текущее — откат по риску не требуется.

**Затронутые файлы:** `ecosystem.config.cjs`, `docs/strategy/release/VERSION`, `docs/strategy/release/CHANGELOG.md`, `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`.

---

## [1.11.469] — 2026-06-18

**Тег:** `sa-alpha-1.11.469` (планируется координатором)

### Этап 1.3 (live-oscar): mcap/liq кандидатов из Shyft DeFi API (TTL-кэш + PG fallback)

Реализован **Этап 1.3** роадмапа `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`: на кандидатах discovery mcap/liq резолвится из **Shyft DeFi API** (`/v0/pools/get_by_token?token=<mint>&dex=pumpFunAmm`, заголовок `x-api-key`) с **in-memory TTL-кэшем** (default 12s, ограничивает req/s бёрст) и **fallback** на текущий PG/pump.fun источник при любой ошибке. **При дефолтных значениях (флаг OFF) источник mcap/liq байт-в-байт = текущий PG-путь.**

**Что построено (всё за флагом default-OFF):**
- Новый модуль `src/papertrader/stream/shyft-defi-mcap.ts`: чистый защитный парсер `parseShyftDefiPools(json)` (пробует распространённые имена полей `marketCap/market_cap_usd/fdv/...`, `liquidity/tvl/...` по нескольким вариантам конверта ответа; возвращает `null`, если не удалось прочитать → caller берёт PG) + async-резолвер `resolveShyftDefiMcap(mint, {ttlMs,...})` с TTL-кэшем, таймаутом (AbortController, 2.5s), graceful fallback (любой сбой/непарс/non-200/нет ключа → `null`), кэшированием miss'ов.
- **Discovery (`src/papertrader/discovery/dip-clones.ts`):** при включённом флаге DeFi-значения переопределяют `refMcap` (tier-резолв `micro/low/prod`) и складываются в `evalRow` (`market_cap_usd`/`liquidity_usd`) рядом с 1.2 price-override — так snapshot mcap/liq-гейт + reported features когерентны. Наблюдение: `live_shyft_defi_mcap` (pg vs defi mcap/liq). При OFF `evalRow === row`, `refMcap` = PG.

**Флаги (env → config, default так, что прод не меняется):**
- `SHYFT_DEFI_MCAP_ENABLED` (`shyftDefiMcapEnabled`, default **0/false**) — мастер-выключатель.
- `SHYFT_DEFI_MCAP_TTL_MS` (`shyftDefiMcapTtlMs`, default **12000**) — TTL кэша.
- Ключ DeFi REST API: `SHYFT_DEFI_API_KEY` (или `SHYFT_API_KEY`) в `.env`; база `SHYFT_DEFI_API_BASE` (default `https://defi.shyft.to`).

**ВАЖНО (для владельца перед активацией):** точную схему ответа DeFi API нужно подтвердить на живом API — парсер защитный, но при несовпадении имён полей вернёт `null` → всегда fallback на PG (override не сработает, но прод-безопасно). Сверить, что tier-резолв не сдвигает входы непреднамеренно (A/B по `live_shyft_defi_mcap`).

**Тесты:** `tests/shyft-defi-mcap.test.ts` (парсер: конверты/алиасы/пустой; резолвер: нет-ключа, success, TTL-кэш одним сетевым вызовом, ре-фетч после TTL, fallback на non-200/throw — 9). `npm run typecheck` — зелёный.

**Затронутые файлы:** `ecosystem.config.cjs`, `src/papertrader/config.ts`, `src/papertrader/discovery/dip-clones.ts`, новый `src/papertrader/stream/shyft-defi-mcap.ts`, `tests/shyft-defi-mcap.test.ts`, `docs/strategy/release/VERSION`, `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`.

**Включение на VPS (после деплоя):** в `/opt/solana-alpha/.env` задать `SHYFT_DEFI_API_KEY=<key>` (Shyft REST), затем `SHYFT_DEFI_MCAP_ENABLED=1`, `pm2 reload ecosystem.config.cjs --update-env`. Наблюдать `live_shyft_defi_mcap` (расхождение PG vs DeFi mcap/liq, свежесть) и убедиться, что число входов по tier не разъезжается.

**Откат:** `SHYFT_DEFI_MCAP_ENABLED=0` + `pm2 reload live-oscar --update-env`; либо redeploy `sa-alpha-1.11.468`. При OFF поведение торговли не менялось — откат по риску не требуется.

---

## [1.11.468] — 2026-06-18

**Тег:** `sa-alpha-1.11.468` (планируется координатором)

### Этап 1.2 (live-oscar): Shyft stream-цена PRIMARY для MTM + discovery dip-eval (freshness-gate + PG fallback)

Реализован **Этап 1.2** роадмапа `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`: стрим-цена Shyft становится **primary** источником в двух точках решения live-oscar — **MTM открытых позиций** и **discovery dip-eval** — с **freshness-gate** (`SHYFT_MAX_STALE_MS`) и **fallback** на текущий PG/Jupiter, когда стрим выключен / не виден / устарел / ≤0. **При дефолтных значениях (мастер-флаг OFF) прод-торговля байт-в-байт = текущий PG/Jupiter-путь.**

**Что построено (всё за флагами default-OFF):**
- Новый чистый резолвер `src/papertrader/stream/price-primary.ts`: `resolvePrimaryPriceUsd({enabled, pgPriceUsd, streamPriceUsd, streamTsMs, nowMs, maxStaleMs})` → `{priceUsd, source:'pg'|'stream', streamAgeMs}`. При `enabled=false` — **дословный passthrough** baseline-цены (`source:'pg'`). Плюс builder события `live_shyft_price_primary` (для A/B-наблюдения, пишется только когда выбран стрим).
- **MTM (`src/papertrader/executor/tracker.ts`):** override `curMetric` стрим-ценой **перед** exec-sell override (свежий исполняемый fill всё ещё выигрывает) и перед ghost-quote clamp. Гейт: `shyftPricePrimaryEnabled && shyftPricePrimaryMtmEnabled && strategyId==='live-oscar' && isShyftShadowEnabled()`.
- **Discovery (`src/papertrader/discovery/dip-clones.ts`):** `evalRow` (клон строки только с подменённым `price_usd` = свежая стрим-цена) подаётся в snapshot-гейт, dip-eval, stress-reentry и `buildFeatures`. Гейт включает дополнительно `shyftPricePrimaryDiscoveryEnabled` (default **0** — раскатка MTM-first). При OFF `evalRow === row` (та же ссылка) → гейты байт-в-байт = текущий PG-путь.

**Флаги (env → config, все default так, что прод не меняется):**
- `SHYFT_PRICE_PRIMARY_ENABLED` (`shyftPricePrimaryEnabled`, default **0/false**) — мастер-выключатель.
- `SHYFT_PRICE_PRIMARY_MTM_ENABLED` (`shyftPricePrimaryMtmEnabled`, default **1**) — scope MTM (активен только при мастере ON).
- `SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED` (`shyftPricePrimaryDiscoveryEnabled`, default **0**) — scope discovery (MTM-first).
- `SHYFT_MAX_STALE_MS` (`shyftMaxStaleMs`, default **5000**) — freshness-gate возраста стрим-цены.
- **Зависимость активации:** требуется работающий Stage 1.1 shadow-консьюмер (`PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=1` + `SHYFT_GRPC_TOKEN` в `.env`), иначе стрим-цены нет и резолвер всегда даёт PG-fallback.

**Тесты:** `tests/shyft-price-primary.test.ts` (OFF-passthrough, freshness-gate, fallback при missing/stale/≤0/future-skew, граница gate, builder события — 12). `npm run typecheck` — зелёный.

**Затронутые файлы:** `ecosystem.config.cjs`, `src/papertrader/config.ts`, `src/papertrader/executor/tracker.ts`, `src/papertrader/discovery/dip-clones.ts`, новый `src/papertrader/stream/price-primary.ts`, `tests/shyft-price-primary.test.ts`, `docs/strategy/release/VERSION`, `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`.

**Включение на VPS (после деплоя):** в `/opt/solana-alpha/.env` уже должен быть `SHYFT_GRPC_TOKEN`; включить Stage 1.1 shadow (`PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=1`), затем `SHYFT_PRICE_PRIMARY_ENABLED=1` (сначала только MTM — discovery остаётся 0), `pm2 reload ecosystem.config.cjs --update-env`. Наблюдать `live_shyft_price_primary` (доля стрим-выборов, `streamVsBaselinePct`) и сверять число входов/выходов и PnL с baseline +$9 481. Discovery включать (`SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED=1`) только после стабильного MTM.

**Откат:** `SHYFT_PRICE_PRIMARY_ENABLED=0` + `pm2 reload live-oscar --update-env` (мгновенно возвращает PG/Jupiter-путь); либо redeploy `sa-alpha-1.11.467`. Поскольку при OFF поведение торговли не менялось, откат по риск-причинам не требуется.

---

## [1.11.467] — 2026-06-18

**Тег:** `sa-alpha-1.11.467` (планируется координатором)

### Этап 1.1 (live-oscar): Shyft shadow-стрим — измерение лага PG (observability only)

Реализован **Этап 1.1** роадмапа `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`: Yellowstone gRPC **shadow**-консьюмер Shyft для измерения реального лага PG-цены **без изменения торговых решений**. База перед Этапом 1.2. **При дефолтных значениях прод-торговля байт-в-байт не меняется** — стрим-цена НИГДЕ не участвует в гейтах/eval/исполнении.

**Что построено (всё за флагами default-OFF):**
- Один gRPC-консьюмер на весь процесс live-oscar (`src/papertrader/stream/shyft-shadow-consumer.ts`): подписка на swap-tx по **watched/open** mint'ам с **узким** `accountInclude` (никакого program-wide firehose — не грузим общий аккаунт Shyft Build / superbot). Ручной reconnect c экспоненциальным backoff+jitter; обновление набора mint'ов пишется в активный стрим без переподключения (анти-RC-4).
- Цена из стрима выводится из резервов пулового vault'а в `postTokenBalances` swap-tx (DEX-agnostic: base-vault = mint, quote-vault = WSOL/USDC/USDT того же владельца), `price = quoteUi·quoteUsd / baseUi`. In-memory last-price по mint с TTL.
- На точках сравнения — рядом с `observeStaleEntryPrice` (вход) и в MTM-цикле трекера — пишется журнал `live_shyft_shadow_price`: `{mint, lane, surface, streamPriceUsd, pgPriceUsd, streamTsMs, pgSnapshotTsMs, pgPriceAgeMs, streamVsPgLagMs, streamVsPgPriceDiffPct, streamSlot}`. `pgSnapshotTsMs` переиспользует `SnapshotFeatures.snapshot_ts_ms` (1.11.466) на входе; для MTM добавлен `snapshotTsMs` в `LatestSnapshotQuote`.

**Флаги (env → config, все default-OFF / byte-for-byte прод):**
- `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED` (`liveOscarShyftShadowEnabled`, default **0/false**) — мастер-выключатель shadow.
- `PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_AGE_MS` (`liveOscarShyftShadowMaxAgeMs`, default **60000**) — макс. возраст хранимой стрим-цены при сопоставлении.
- `PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_MINTS` (`liveOscarShyftShadowMaxMints`, default **256**) — кап размера `accountInclude`.
- Креды (в `.env`, не в ecosystem): `SHYFT_GRPC_ENDPOINT` (default `https://grpc.fra.shyft.to`) + `SHYFT_GRPC_TOKEN` (x-token; та же конвенция, что у pumpswap-flow-sniper).

**Зависимость:** добавлен `@triton-one/yellowstone-grpc@^5.0.9` (Yellowstone gRPC NAPI-клиент; native-биндинг ставится `npm ci` под linux-x64 на VPS).

**Тесты:** `tests/shyft-shadow-price.test.ts` (вывод цены из резервов, lag/age/diff, builder события — 15) + `tests/shyft-shadow-state.test.ts` (enabled/TTL/смена набора mint'ов — 3). `npm run typecheck` — зелёный.

**Test-hygiene (не связано с 1.1, прод-код не тронут):** `tests/papertrader-live-mcap.test.ts` отставал от рефакторинга `fetchLatestSnapshotMcap` (помощник `pricing/mcap-snapshot.ts`: проход за reference-supply + per-table pick = **два** `db.execute`, строки должны нести `price_usd > 0`). Старый мок отдавал один `db`-вызов без `price_usd` → `TypeError: raw is not iterable`. Мок приведён к актуальной реализации (4 теста снова зелёные); правка только в тесте. Это падение **предсуществовало** на `origin/v2` (SHA `b78c967`) и не вносилось Этапом 1.1.

**Затронутые файлы:** `package.json`, `ecosystem.config.cjs`, `src/papertrader/config.ts`, `src/papertrader/pricing.ts`, `src/papertrader/main.ts`, `src/papertrader/executor/tracker.ts`, `src/live/main.ts`, новые `src/papertrader/stream/{shadow-price,shadow-state,shyft-shadow-consumer}.ts`, тесты, `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`.

**Включение на VPS (после деплоя):** в `/opt/solana-alpha/.env` задать `SHYFT_GRPC_TOKEN=<x-token>` (+ при нужде `SHYFT_GRPC_ENDPOINT`); затем в env live-oscar `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=1` → `pm2 reload ecosystem.config.cjs --update-env`. Наблюдать `live_shyft_shadow_price` / `live_shyft_shadow_status` в live-журнале.

**Откат:** `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=0` + `pm2 reload live-oscar --update-env` (мгновенно отключает консьюмер и журнал); либо redeploy `sa-alpha-1.11.466`. Поскольку при OFF поведение торговли не менялось, откат по риск-причинам не требуется.

---

## [1.11.466] — 2026-06-18

**Тег:** `sa-alpha-1.11.466` (планируется координатором)

### Этап 0 (live-oscar): гигиена конфига + observability устаревшей цены входа

Подготовка к гибриду Shyft+PG внутри live-oscar (роадмап: `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`). Принцип «сначала надёжность, потом скорость». **Прод-торговля при дефолтных значениях не меняется байт-в-байт** — только наблюдаемость и комментарии.

**0.1 Гигиена конфига (только комментарии/доки, значения не тронуты):**
- `ecosystem.config.cjs`: исправлен вводящий в заблуждение комментарий у `PAPER_DCA_KILLSTOP` — говорил «−9%», фактическое значение `-0.50` (**−50%**). Приведён к факту.
- `docs/strategy/live-oscar/LIVE_OSCAR_TRADING_SPEC_STREAM.md` (DEPRECATED): числа приведены к проду — `$730+$730/$1460` → **$1000+$500/$1500**, killstop **−9% → −50%**.

**0.2 Алерт/метрика на устаревшую цену входа (observability-only):**
- Новый env `PAPER_LIVE_OSCAR_STALE_PRICE_WARN_MS` (config: `liveOscarStalePriceWarnMs`, дефолт **45000**; `0` = выключить). В пути принятия решения о входе (`src/papertrader/main.ts`, перед `resolveLiveStagedEntrySignal`) при возрасте использованной PG-цены > порога журналируется метрика `live_stale_price_warn` (`priceAgeMs`, `mint`, `lane`, `source`, `priceUsd`, `snapshotTsMs`).
- Источник возраста: новый `SnapshotFeatures.snapshot_ts_ms` (из `*_pair_snapshots.ts`), заполняется в `buildFeatures` (`src/papertrader/discovery/dip-clones.ts`).
- Опц. троттлед Telegram-алерт: `LIVE_OSCAR_STALE_PRICE_TELEGRAM_ENABLED=1` (**default OFF**), cooldown `LIVE_OSCAR_STALE_PRICE_TELEGRAM_COOLDOWN_MS` (дефолт 30 мин).
- Поведение торговли НЕ меняется — это база для замера 30–90s слепоты перед Этапом 1.
- Тест: `tests/stale-price-observability.test.ts` (parse ts, age, stale-predicate + «0 = выключено»).

**Затронутые файлы:** `ecosystem.config.cjs`, `src/papertrader/config.ts`, `src/papertrader/types.ts`, `src/papertrader/discovery/dip-clones.ts`, `src/papertrader/main.ts`, `docs/strategy/live-oscar/LIVE_OSCAR_TRADING_SPEC_STREAM.md`, новый `docs/strategy/live-oscar/OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`.

**Откат:** redeploy `sa-alpha-1.11.465`. Либо точечно: `PAPER_LIVE_OSCAR_STALE_PRICE_WARN_MS=0` (отключает метрику) + `pm2 reload live-oscar --update-env`. Поскольку поведение торговли не менялось, откат не требуется по риск-причинам.

---

## [1.11.465] — 2026-06-18

**Тег:** `sa-alpha-1.11.465`

### Ops: disable Wave B post-TP1 scratch/re-entry on live-oscar (honest A/B revert)

- `PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_ENABLED=0` в `ecosystem.config.cjs` (prod live-oscar).
- Причина: честный A/B на когорте 363 он-чейн покупок с реальным `simWaveBStep` показал, что scratch/re-entry — **не источник альфы**. Реалистично (≤1 re-entry/сделку) дельта ≈ **+$571** (шум); на 36% scratch-событий без повторного входа теряет **−$5 002** против «держать по Wave B»; присутствует churn-баг геометрии (re-entry −30% глубже scratch −15% → зацикливание на одной монете давало миражные +$119k). Чистый Wave B baseline = +$9 481 на той же когорте.
- Артефакты анализа: `scripts-tmp/_cf360_scratch_validation_ru.md`, `_cf360_ab_waveb_vs_flat_ru.md`.

**Откат:** redeploy `sa-alpha-1.11.464` или `ENABLED=1` + `pm2 reload live-oscar --update-env`.

---

## [1.11.464] — 2026-06-17

**Тег:** `sa-alpha-1.11.464`

### Ops: enable Wave B post-TP1 scratch/re-entry on live-oscar

- `PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_ENABLED=1` в `ecosystem.config.cjs` (prod live-oscar).

**Откат:** redeploy `sa-alpha-1.11.463` или `ENABLED=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.463] — 2026-06-17

**Тег:** `sa-alpha-1.11.463`

### Feature: Wave B post-TP1 scratch @ −15% signal → re-entry @ −30% ($1500)

- После первой `TP_LADDER` фиксации: при просадке ≤ **−15% от signal price** (`liveStagedEntry.signalPriceUsd`) — **полное закрытие** (`WAVE_B_POST_TP1_SCRATCH`).
- При просадке ≤ **−30% от того же signal anchor** — повторный вход **$1500**, Wave B + sig50 kill; обходит post-exit re-entry gates.
- Отдельно от partial `POST_TP1_DERISK` (−15% vs avg, 50% peel) и Variant A exit-ref re-entry.
- Backtest (honest sim, combo `scratch15_re30`): **~+$1.5k** vs baseline на том же окне.
- Env (default **OFF**): `PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_*`.

**Откат:** redeploy `sa-alpha-1.11.462`; `PAPER_LIVE_OSCAR_WAVE_B_POST_TP1_SCRATCH_REENTRY_ENABLED=0`.

---

## [1.11.462] — 2026-06-17

**Тег:** `sa-alpha-1.11.462`

### Feature: Live Oscar optimized staged entry ($1000+$500, wait −5% / leg-2 −10%)

- **Асимметричный сплит:** `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG2_USD` (leg-2 USD; `0` = symmetric legacy).
- **Prod:** ждать −5% от сигнала → $1000; 2-я нога $500 при −10%; position **$1500**; kill −50% без изменений; Wave B exit без изменений.
- **Micro tier:** $300+$150 = $450; **low tier:** $1000+$500 = $1500 (aligned with prod).

**Откат:** redeploy `sa-alpha-1.11.461`; вернуть `FIRST_DROP_PCT=0`, `ENTRY_SPLIT_LEG_USD=730`, `ENTRY_SPLIT_TARGET_DROP_PCT=5`, `POSITION_USD=1460`.

---

## [1.11.460] — 2026-06-16

**Тег:** `sa-alpha-1.11.460`

### Feature: Live Oscar micro mcap tier ($500k–$1.3M, $300+$300)

- **Новый tier `micro`:** $500k ≤ mcap < $1.3M; split entry **$300 + $300** (position $600).
- **`below`** при включённом micro-lane: mcap < $500k; discovery SQL pool от **$500k** (`PAPER_DISCOVERY_MIN_MARKET_CAP_USD`).
- **Dip/vol micro:** −30% / vol1h ≥ $75k (как low tier); low/prod без изменений ($730+$730 / $1460).
- **Tier-aware sizing:** `resolveLiveOscarEntrySplitLegUsd`, staged entry, tracker DCA/position, journal restore.

**Откат:** redeploy `sa-alpha-1.11.459`; отключить `PAPER_LIVE_OSCAR_MICRO_MCAP_LANE_ENABLED=0`, вернуть `PAPER_DISCOVERY_MIN_MARKET_CAP_USD=1300000`.

---

## [1.11.459] — 2026-06-16

**Тег:** `sa-alpha-1.11.459`

### Fix: ложный `insufficient_wallet_sol_for_buy` при устаревшем SOL/USD

- **Root cause:** buy-quote sizing использовал кэш `getSolUsd()` (refresh раз в 5 мин); afford gate слепо сравнивал `getBalance` с Jupiter `quoteInAmount` — при stale ~$75 вместо ~$150 quote запрашивал ~2× SOL на ту же ногу $730.
- **Fix:** `refreshSolPrice()` перед каждой buy-попыткой; afford через `resolveBuyAffordRequiredLamports` (estimate vs quote, drift ≤15%); при drift — retry quote (`buy_quote_sol_usd_drift`), не ложный insufficient.
- **Journal:** `execution_skip` detail теперь включает `solUsdUsed`, `estimateLamports`, `driftPct`.

**Откат:** redeploy `sa-alpha-1.11.458`.

---

## [1.11.458] — 2026-06-16

**Тег:** `sa-alpha-1.11.458`

### Phase 1 execution hardening (без Shyft stream / фазы 2)

- **Aggressive retry** — `swap-http-429`, `quote_stale`, `send_failed` ретраятся в buy/sell pipeline (200 ms delay); buy больше не abort'ится на первом swap-build fail.
- **Hot tick open positions** — каждые 2 s executable **sell** quote → cache; tracker использует для kill/exit; при kill — немедленный `trackerTick`.
- **Killstop pre-arm** — за 1 pp до kill порога готовится full sell swap tx (`LIVE_KILLSTOP_PREARM_*`).
- **Jupiter** — без зависимости от Pro-подписки; `api.jup.ag` free-tier + optional key.

**Откат:** redeploy `sa-alpha-1.11.457`; `LIVE_OPEN_HOT_TICK_ENABLED=0`, вернуть `LIVE_*_SIM_RETRY_DELAY_MS=3000`.

---

## [1.11.457] — 2026-05-28

**Тег:** `sa-alpha-1.11.457`

### Copy-trader: mid mcap tier $300+$300 ($500k–$1M)

- **`COPY_TRADER_MIN_MCAP_USD=500000`** — входы от $500k mcap (раньше $1M).
- Mcap **< $1M**: staged entry **$300 probe + $300 dip** (`COPY_TRADER_ENTRY_MID_*`).
- Mcap **≥ $1M**: без изменений **$500+$500** на `COPY_TRADER_POSITION_USD=1000`.
- Tier фиксируется в state (`entryTargetUsd`, `entryMcapUsd`) для deploy-gate и proportional adds.

**Откат:** redeploy `sa-alpha-1.11.456`; вернуть `COPY_TRADER_MIN_MCAP_USD=1000000`, убрать `COPY_TRADER_ENTRY_*_MID_*`.

---

## [1.11.456] — 2026-06-15

**Тег:** `sa-alpha-1.11.456`

### Jupiter Pro: 429 retry on discovery/tracker/verify quote paths

- **`fetchJupiterSwapQuoteGetResult`** — structured GET result with **429 exponential backoff** + `Retry-After`; `fetchJupiterSwapQuoteGetJson` wraps it for existing callers.
- **`price-verify.ts`** — buy/sell impulse quotes now use the shared Jupiter HTTP helper (Pro `x-api-key`, 429 retries) instead of raw `fetch` — fixes rate-limit storms on discovery, tracker, and verify paths that bypassed the live-oscar/copy-trader pipeline.

**Откат:** redeploy `sa-alpha-1.11.455`; revert `src/core/jupiter-http.ts` and `src/papertrader/pricing/price-verify.ts`.

---

## [1.11.455] — 2026-05-28

**Тег:** `sa-alpha-1.11.455`

### Copy-trader: probe сразу после лидера, gate +3% по Jupiter quote

- **`COPY_TRADER_ENTRY_PROBE_BUY_DELAY_MS=0`** — первая нога (probe $500) без 30-сек паузы; adds по-прежнему `COPY_TRADER_BUY_DELAY_MS=30s`.
- Probe/full entry в live: цена для gate берётся из **Jupiter buy quote** (как dip), не только Dex — не покупаем, если исполнимая цена **> leader × 1.03** (`COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT=3`).

**Откат:** redeploy `sa-alpha-1.11.454`; убрать `COPY_TRADER_ENTRY_PROBE_BUY_DELAY_MS` или вернуть probe delay к `buyDelayMs`.

---

## [1.11.454] — 2026-05-28

**Тег:** `sa-alpha-1.11.454`

### Copy-trader: premium Jupiter sell pipeline (fast exit)

- **Sell delay:** `COPY_TRADER_SELL_DELAY` **20–30s → 0–2s** — выход сразу после сигнала лидера, без искусственной паузы.
- **Jupiter Pro path:** copy-trader bridge читает `LIVE_JUPITER_*` / `LIVE_SELL_SIM_*` (veryHigh priority fee, 10 sim-retries, slippage bump до 500 bps) — тот же конверт, что live-oscar.
- **Inner sell retry:** `executeLiveCopySell` — до 10 попыток quote→build→sim→send в одном вызове (раньше один выстрел + внешний retry каждые 6s).
- **Swap 429:** `liveBuildUnsignedSwapTx` — backoff-retry на POST `/swap/v1/swap` (раньше только quote GET).
- **PM2 env:** `LIVE_JUPITER_QUOTE_URL`, `LIVE_JUPITER_SWAP_URL`, priority, 429 tuning в блоке `copy-trader`.

**Откат:** redeploy `sa-alpha-1.11.453`; вернуть sell delay 20–30s и убрать LIVE_* из copy-trader env в `ecosystem.config.cjs`.

---

## [1.11.453] — 2026-06-15

**Тег:** `sa-alpha-1.11.453`

### Post-crash stabilize 25m → 15m (live-oscar)

- `PAPER_POST_CRASH_FAST_PATH_STABILIZE_MIN`: **25 → 15** — раньше разрешаем вход после spike-crash, если остальные post-crash гейты проходят.

**Откат:** вернуть **25** в `ecosystem.config.cjs`; redeploy NORM §5.

---

## [1.11.452] — 2026-06-15

**Тег:** `sa-alpha-1.11.452`

### Jupiter 429 mitigation — live-oscar + copy-trader

- **Live Oscar partial TP:** `LIVE_PARTIAL_TP_MIN_INTERVAL_MS` / `PAPER_LIVE_PARTIAL_TP_MIN_INTERVAL_MS` (prod **5000** ms) — defer `tryExecuteTpPartialSell` via `defer_next` when same mint sold too recently.
- **Live Oscar discovery:** `PAPER_PRIORITY_DISCOVERY_JUPITER_MAX_PER_TICK` **25→5**, near-miss **15→5**.
- **Copy-trader:** `COPY_TRADER_MIN_SELL_INTERVAL_MS` (**5000**), `COPY_TRADER_ENTRY_DIP_JUPITER_MIN_INTERVAL_MS` (**12000**) — sell spacing + cached dip eval quotes.

**Откат:** set throttle env to `0`; restore discovery max-per-tick **25/15**; redeploy NORM §5.

---

## [1.11.451] — 2026-06-14

**Тег:** `sa-alpha-1.11.451`

### Copy-trader: enter on leader rebuy after missed first entry

- **`COPY_TRADER_ALLOW_LATE_ENTRY_ON_LEADER_REBUY=1`** (default on): если мы пропустили первый вход, а лидер докупает/усредняет — ставим обычный entry (probe $500 + dip $500), вместо `leader_buy_ignored` / `missed_entry_leader_already_in`.
- Journal: `leader_buy_scheduled.lateEntryOnLeaderRebuy=true`.

**Откат:** `git checkout sa-alpha-1.11.450 -- src/copytrader/ docs/strategy/release/ ecosystem.config.cjs tests/copytrader/late-entry-on-rebuy.test.ts`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.450] — 2026-06-13

**Тег:** `sa-alpha-1.11.450`

### Live Oscar: post-close tail sweep cap + cancel on re-entry

- **`LIVE_POST_CLOSE_TAIL_SWEEP_MAX_USD`** (default **$25**) — skip tail sweep when on-chain balance est. exceeds cap (prevents selling a fresh re-entry after KILLSTOP).
- Cancel pending tail-sweep timer on new buy pipeline / `live_staged_entry_signal` for the same mint.

**Откат:** `git checkout sa-alpha-1.11.449 -- src/live/post-close-tail-sweep.ts src/live/config.ts src/live/phase4-execution.ts src/papertrader/main.ts tests/live-oscar-config.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.449] — 2026-06-14

**Тег:** `sa-alpha-1.11.449`

### Hotfix: ecosystem.config.cjs syntax (PM2 reload)

- Удалена лишняя `}` после merge — `pm2 reload` снова парсит конфиг.

**Откат:** revert merge commit на `ecosystem.config.cjs`.

---

## [1.11.448] — 2026-06-13

**Тег:** `sa-alpha-1.11.448`

### Copy-trader: probe leg $500 (50% of $1000 position)

- **`COPY_TRADER_ENTRY_PROBE_FRACTION=0.5`** — первая нога **$500** сразу за лидером; dip **$500** @ leader−10%.

**Откат:** `ENTRY_PROBE_FRACTION=0.3`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.447] — 2026-06-13

**Тег:** `sa-alpha-1.11.447`

### Deploy smoke — pgrep false positives

- **`post-deploy-smoke` / process-watch:** `pgrep` only matches `loader.mjs src/scripts/live-oscar.ts` (node), not shell argv echoes.

**Откат:** `git checkout sa-alpha-1.11.446 -- scripts/release/post-deploy-smoke.sh scripts-tmp/process-watch-lib.mjs docs/strategy/release/`.

---

## [1.11.446] — 2026-06-13

**Тег:** `sa-alpha-1.11.446`

### Deploy — singleton live-oscar (запрет /root/.pm2 дубликата)

- **NORM §5.2:** канонический деплой через `scripts/ops/deploy-live-oscar-vps.sh` (`pm2 kill` root → `startOrReload` salpha).
- **`post-deploy-smoke.sh`:** ровно один `live-oscar.ts` под `salpha`, `ENTRY_SPLIT_LEG_USD` = ecosystem, нет online `live-oscar` в `/root/.pm2`.
- **`strategy-process-watch`:** алерт при дубликате / wrong user / stale env / root PM2.

**Откат:** `git checkout sa-alpha-1.11.445 -- scripts/release/post-deploy-smoke.sh scripts/ops/deploy-live-oscar-vps.sh scripts-tmp/process-watch-lib.mjs scripts-tmp/strategy-process-watch.mjs tests/process-watch-lib.test.ts docs/strategy/release/`; деплой по старому §5.2.

---

## [1.11.444] — 2026-06-11

**Тег:** `sa-alpha-1.11.444`

### Live Oscar discovery — Jupiter after dip filters (1.11.244 regression)

- **Jupiter spot refresh** (volume-leader crosscheck, priority refresh, near-miss) runs **after** `fetchDipContextMap`, not on the raw SQL snapshot pool.
- **Priority Jupiter** uses `buildPriorityDiscoveryMintSet` (open / near-ready / recent eval) — not the full per-tick snapshot set.
- **Near-miss dedup** tracks volume-leader + priority refreshed mints, not the expanded reeval set.
- **HTTP 400/404** on Jupiter quote maps to `no-route` (does not count as transport fail for circuit breaker).

**Откат:** `git checkout sa-alpha-1.11.443 -- src/papertrader/discovery/dip-clones.ts src/papertrader/discovery/priority-dip-price-refresh.ts src/papertrader/pricing/price-verify.ts tests/papertrader-price-verify.test.ts docs/strategy/release/`; `pm2 reload live-oscar --update-env`.

---

## [1.11.443] — 2026-06-13

**Тег:** `sa-alpha-1.11.443`

### HL TWAP live — price-% ladder from avg entry

- **`HL_TWAP_LIVE_LADDER_MODE=price`**: TP/DCA triggers on **price % from avg entry**, not HL ROE.
- **TP tiers:** +0.3% → sell 20% gross; +0.5% / +1% / +1.5% / … (every +0.5%) → sell 30% gross.
- **DCA:** single add at **−0.5%** price from avg = **50% of initial gross** (`HL_TWAP_LIVE_LADDER_DCA_PCT_OF_INITIAL=50`).
- Legacy ROE ladder: `HL_TWAP_LIVE_LADDER_MODE=roe`.

**Откат:** `git checkout sa-alpha-1.11.442 -- src/hyperliquid/twap/live/position-ladder.ts src/hyperliquid/twap/live/config.ts src/hyperliquid/twap/live/dynamic-margin.ts src/hyperliquid/twap/live/live-trader.ts ecosystem.config.cjs tests/hl-twap-live-ladder.test.ts tests/hl-twap-dynamic-margin.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.442] — 2026-06-13

**Тег:** `sa-alpha-1.11.442`

### SuperBot dashboard tile + synced journal path

- **`/papertrader2`:** плитка **SuperBot** (pumpswap-flow-sniper) — MSK timeline ext sell → buy → TP/SL; `scripts-tmp/superbot-dashboard.ts`.
- **`ecosystem.config.cjs`:** `DASHBOARD_SUPERBOT_JSONL` → `data/live/superbot-journal.jsonl` (rsync с oscar-stream-de VPS, read-only).
- **Live Oscar:** SPCX в permanent denylist seed; `LIVE_OSCAR_TRADING_SPEC_STREAM.md`.

**Откат:** `git checkout sa-alpha-1.11.441 -- scripts-tmp/superbot-dashboard.ts scripts-tmp/dashboard-server.ts scripts-tmp/dashboard-paper2.html ecosystem.config.cjs tests/superbot-dashboard.test.ts tests/dashboard-paper2-panels.test.ts data/live/live-oscar-permanent-denylist.seed.txt docs/strategy/live-oscar/LIVE_OSCAR_TRADING_SPEC_STREAM.md docs/strategy/release/`; `pm2 reload live-oscar-dashboard --update-env`.

---

## [1.11.441] — 2026-06-13

**Тег:** `sa-alpha-1.11.441`

### Remove pumpswap-combo autonomous bot completely

- **Deleted:** `src/pumpswap-combo/`, `src/scripts/pumpswap-combo-bot.ts`, PM2 `pumpswap-combo-bot`, ops scripts `scripts/ops/pumpswap-combo-*.sh`, dashboard tile + `scripts-tmp/pumpswap-combo-dashboard.ts`.
- **`ecosystem.config.cjs`:** removed `ENABLE_PUMPSWAP_COMBO_PM2` gate and all `PUMPSWAP_COMBO_*` env blocks; `/papertrader2` now **Live Oscar · Copy Trader · HL TWAP** (3 tiles).
- **`qn-feature-usage`:** dropped `pumpswap_combo` QN budget bucket.

**Откат:** `git checkout sa-alpha-1.11.440 -- src/pumpswap-combo/ src/scripts/pumpswap-combo-bot.ts scripts/ops/pumpswap-combo-*.sh scripts-tmp/pumpswap-combo-dashboard.ts scripts-tmp/dashboard-server.ts scripts-tmp/dashboard-paper2.html ecosystem.config.cjs package.json src/core/rpc/qn-feature-usage.ts tests/dashboard-paper2-panels.test.ts docs/strategy/release/`; VPS `pm2 start ecosystem.config.cjs --only pumpswap-combo-bot --update-env` (if wallet/data still present).

---

## [1.11.440] — 2026-06-13

**Тег:** `sa-alpha-1.11.440`

### HL TWAP live — ladder TP/DCA 2% / 30%

- **`HL_TWAP_LIVE_LADDER_STEP_PCT=2`**: TP/DCA triggers at ±2% Hyperliquid ROE (uPnL/margin), not raw price %.
- **`HL_TWAP_LIVE_LADDER_SLICE_PCT=30`**: each TP or DCA slice = 30% of current gross notional.
- Defaults in `config.ts`, prod `ecosystem.config.cjs`, and ladder unit tests updated.

**Откат:** `git checkout sa-alpha-1.11.439 -- src/hyperliquid/twap/live/config.ts src/hyperliquid/twap/live/position-ladder.ts ecosystem.config.cjs .env.example tests/hl-twap-live-ladder.test.ts tests/hl-twap-dynamic-margin.test.ts docs/strategy/release/`; `pm2 reload hl-twap-live --update-env`.

---

## [1.11.439] — 2026-06-12

**Тег:** `sa-alpha-1.11.439`

### Live Oscar — post-exit re-entry gate hardening (KINS audit repeat)

- **`lastRealExitMarketSnapshotByMintMap`**: гейты dip/cooldown читают только реальный exit (не RECONCILE/PERIODIC_HEAL).
- **RECONCILE_ORPHAN**: не мутирует re-entry state при активном cooldown или real exit в grace; stale TP partial не поднимает ref price.
- **Execution pipeline**: `post_exit_reentry_gate` на всех buy intents (`buy_open`, `buy_scale_in`, `dca_add`) — entry_split не обходит gate.

**Откат:** `git checkout sa-alpha-1.11.438 -- src/papertrader/discovery/dip-clones.ts src/live/phase4-execution.ts src/live/main.ts src/papertrader/main.ts src/papertrader/executor/store-restore.ts tests/`; `pm2 reload live-oscar --update-env`.

---

## [1.11.438] — 2026-06-12

**Тег:** `sa-alpha-1.11.438`

### HL TWAP — hold-to-end exit, enter at TWAP start

- **`HL_TWAP_HOLD_TO_END=1`**: timer exit at `lastCycleEtaMs` for all duration buckets (micro, short, standard).
- **Entry** unchanged: `paperOpenAtMs = twapStartMs` (enter at TWAP start, not after first slice).
- **Exit reason** `twap_hold_to_end` in live/paper journals and Telegram labels.
- **Env:** `HL_TWAP_EXIT_EARLY_MINUTES=0`, `HL_TWAP_EXIT_ADAPTIVE=0` in `ecosystem.config.cjs`.

**Откат:** `git checkout sa-alpha-1.11.437 -- src/hyperliquid/twap/ ecosystem.config.cjs tests/hl-twap-schedule.test.ts tests/hl-twap-exit-adaptive.test.ts docs/strategy/release/`; `pm2 reload hl-twap-live --update-env`.

---

## [1.11.437] — 2026-06-12

**Тег:** `sa-alpha-1.11.437`

### Live Oscar — unified $730+$730 entry sizing (SPCX $200/$300 audit)

- **Single split leg** for all mcap tiers / entry paths: always `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD` ($730).
- **Boot validation** (`assertLiveOscarUnifiedEntrySizing`): exit if low-mcap split/position env diverges from prod split.
- **Pre-buy canonicalization** (`applyCanonicalOpenLegUsd`): fixes Jupiter price-verify rebuild downgrading low-mcap to $200.
- **Restore upgrade**: persisted `liveStagedEntry` plan re-synced from env (2-я нога → $730).
- **Labels**: `liveOscarEntryContextNoteV2` reads live env instead of hardcoded $400/$200.

**Откат:** `git checkout sa-alpha-1.11.436 -- src/papertrader/live-oscar-entry-sizing.ts src/papertrader/live-oscar-mcap-tier.ts src/papertrader/executor/live-staged-entry-gates.ts src/papertrader/executor/live-staged-entry-labels.ts src/papertrader/executor/store-restore.ts src/papertrader/main.ts src/live/main.ts tests/`; `pm2 reload live-oscar --update-env`.

---

## [1.11.436] — 2026-06-12

**Тег:** `sa-alpha-1.11.436`

### Live Oscar — stress kill re-entry after KILLSTOP (SPCX audit)

- **`stress_kill_reentry` entry path**: после stress exit (KILLSTOP и др.) — вход при падении ≥40% от last exit и bounce ≤8% от 30m low (пример 1.8M→1.87M mcap).
- **Recovery veto relax**: для stress re-entry только окна ≤30m и relaxed bounce threshold; 60m crash-low не блокирует.
- **Dip max drop relax**: `LIVE_STRESS_REENTRY_DIP_MAX_DROP_PCT=-65` при квалификации stress re-entry.

**Env:** `LIVE_STRESS_REENTRY_ENABLED`, `LIVE_STRESS_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT`, `LIVE_STRESS_REENTRY_RECOVERY_VETO_MAX_BOUNCE_PCT`, `LIVE_STRESS_REENTRY_RECOVERY_VETO_MAX_WINDOW_MIN`, `LIVE_STRESS_REENTRY_DIP_MAX_DROP_PCT`.

**Откат:** `git checkout sa-alpha-1.11.435 -- src/papertrader/discovery/stress-kill-reentry.ts src/papertrader/discovery/dip-clones.ts src/papertrader/dip-detector.ts src/papertrader/config.ts ecosystem.config.cjs tests/stress-kill-reentry.test.ts`; `pm2 reload live-oscar --update-env`.

---

## [1.11.435] — 2026-06-12

**Тег:** `sa-alpha-1.11.435`

### Live Oscar — post-exit re-entry gate at execution layer (KINS audit 04740207)

- **`tryExecuteBuyOpen`**: блок `post_exit_reentry_gate` до `buy_open` (dip + cooldown), parity с discovery.
- **Boot restore**: `lastExitMarketSnapshot` из paper JSONL `close` rows (как cooldown ts).
- **Full close**: сброс `stagedEntrySignals` по mint — staged entry не обходит dip-gate после выхода.

**Откат:** `git checkout sa-alpha-1.11.434 -- src/live/phase4-execution.ts src/papertrader/executor/store-restore.ts src/papertrader/executor/tracker.ts src/papertrader/main.ts tests/execution-post-exit-reentry-gate.test.ts`; `pm2 reload live-oscar --update-env`.

---

## [1.11.434] — 2026-06-11

**Тег:** `sa-alpha-1.11.434`

### Live Oscar — entry $730+$730 ($1460)

- Staged split **$730+$730**, 5 с; `PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` = **$1460**; low-mcap lane aligned.

**Откат:** `git checkout sa-alpha-1.11.433 -- ecosystem.config.cjs`; `pm2 reload live-oscar --update-env`.

---

## [1.11.433] — 2026-06-11

**Тег:** `sa-alpha-1.11.433`

### Live Oscar Wave B — oscillation cycles, −9% hard floor

- **Pre +7.5%:** каждый цикл «вниз &lt; +2.5% → вверх» заново берёт TP (+2.5%/+5%) и **insurance 50%** на 0%; на красном дипе (&lt;0%) метки сбрасываются сразу.
- **Пол −9%:** `waveBAbsoluteKillEligible` (market + avg) всегда, в т.ч. после +7.5%; ниже −9% не держим.
- **Post +7.5%:** trail + BREAKEVEN_EXIT на 0%; partial reset лестницы на откате к +2.5%.

**Откат:** `git checkout sa-alpha-1.11.432 -- src/papertrader/ src/live/strategy-snapshot.ts tests/`; `pm2 reload live-oscar --update-env`.

---

## [1.11.432] — 2026-06-11

**Тег:** `sa-alpha-1.11.432`

### Live Oscar Wave B — breakeven full exit только после +7.5%

- **До +7.5%** (только +2.5%/+5%): insurance **50%** на безубытке, далее kill **−9%** — как в 1.11.429/430.
- **После +7.5%** (touch или TP3): trail + **BREAKEVEN_EXIT 100%** на ≤0%; insurance не мешает полному выходу.

**Откат:** `git checkout sa-alpha-1.11.431 -- src/papertrader/executor/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.431] — 2026-06-11

**Тег:** `sa-alpha-1.11.431`

### Live Oscar Wave B — полное закрытие на безубытке (≤0%)

- **BREAKEVEN_EXIT** на каждой wave_b позиции при **PnL ≤ 0%** vs avg — 100% остатка, без ухода в минус.
- Проверка **до kill −9%**; после +7.5% (trail) откат к цене входа = полный выход.
- Partial breakeven insurance отключён (полный exit заменяет 50% peel).

**Откат:** `git checkout sa-alpha-1.11.430 -- src/papertrader/executor/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.430] — 2026-06-11

**Тег:** `sa-alpha-1.11.430`

### Live Oscar Wave B — ключевая точка +7.5%, повторный TP после отката

- **+7.5%** — единая ключевая точка: снятие kill −9% (`liveWavePreArmReached`), включение defensive trail, 3-я ступень TP.
- **Trail** с **+10%** → **+7.5%** (`WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC`).
- **Повторный TP:** откат **строго ниже +2.5%** после любой взятой ступени → полный сброс меток (+2.5% / +5% / … снова берутся на ралли); после +7.5% — частичный сброс при откате к +2.5%.

**Откат:** `git checkout sa-alpha-1.11.429 -- src/papertrader/executor/exit-policy-wave-b.ts tests/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.429] — 2026-06-11

**Тег:** `sa-alpha-1.11.429`

### Live Oscar — $1k split, kill −9%, loss cooldown (no auto-denylist)

- **Вход:** $500+$500, пауза **5 с**; `PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` = **$1000**; **DCA выкл**.
- **Kill-stop:** `PAPER_DCA_KILLSTOP=-0.09` до первого **+7%** vs entry market; после +7% — Wave B без изменений (TP +2.5% ladder, trail **+10%**, breakeven insurance).
- **Убыток:** `LIVE_NEGATIVE_TRADE_DENY_ENABLED=0`; **10 мин** cooldown (`PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED`); re-entry при цене ≤ last_exit×**0.90**.
- **Код:** `liveWavePreArmReached`, `waveBPreArmKillEligible`; loss-only post-exit cooldown; first-mint-probe split выкл.

**Откат:** `git checkout sa-alpha-1.11.428 -- ecosystem.config.cjs src/papertrader/ src/live/strategy-snapshot.ts tests/wave-b-pre-arm-kill.test.ts tests/post-exit-loss-cooldown.test.ts`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.428] — 2026-06-11

**Тег:** `sa-alpha-1.11.428`

### pumpswap-combo-follow live: relaunch prep ($7 entry, ~$11.7/mint cap)

- **Mirror adds:** `mirrorAddUsdResolved` = first DCA fraction × leg ($7 → ~$2.33/add), not full $7 per leader add.
- **`live-chain.ts`:** SPL mint decimals from chain (fixes wrong `remainingFrac` after partial sells).
- **Live buys:** skip when wallet SOL &lt; 0.03 (`insufficient_sol` journal).
- **Flow gate:** faster pool scan (25ms sleep, `FLOW_POOL_TX_CAP=25`).
- **Portfolio stop:** $55 (was $35) for $7/leg × 8 open.
- **Ops:** `go-live.sh` sets `ENABLE_PUMPSWAP_COMBO_PM2=true`; watchdog default includes `pumpswap-combo-follow-live`.

**Откат:** `git checkout sa-alpha-1.11.427 -- src/pumpswap-combo-follow/ scripts-tmp/process-watch-lib.mjs scripts/ops/pumpswap-combo-follow-go-live.sh ecosystem.config.cjs`; `pm2 delete pumpswap-combo-follow-live`.

---

## [1.11.427] — 2026-06-11

**Тег:** `sa-alpha-1.11.427`

### Copy-trader: $300 probe + $700 dip @ leader−10%

- **Split entry (prod):** `COPY_TRADER_POSITION_USD=1000`, probe **$300** (`ENTRY_PROBE_FRACTION=0.3`), dip leg **$700** when price ≤ leader × **0.90** (`ENTRY_DIP_DISCOUNT_PCT=10`).
- **`ENTRY_DIP_VS_PROBE_PCT=0`:** dip gate is leader-relative only (no extra probe discount cap).
- **Defaults** in `src/copytrader/config.ts` aligned with prod sizing.

**Откат:** `COPY_TRADER_POSITION_USD=950`, `ENTRY_PROBE_FRACTION=0.3684210526315789`, `ENTRY_DIP_DISCOUNT_PCT=4`, `ENTRY_DIP_VS_PROBE_PCT=2`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.426] — 2026-06-11

**Тег:** `sa-alpha-1.11.426`

### HL TWAP live: 3× leverage entry margin $1500 (gross $4500)

- **`HL_TWAP_LIVE_MARGIN_LEV3_USD`:** default **1500** (was 1200) when HL effective max leverage ≤3× → gross **≈ $4500**.
- **5× / 7× tiers unchanged:** $1000 → $5000 gross; $800 → $5600 gross.
- **`ecosystem.config.cjs`:** explicit `MARGIN_LEV3/5/7` in `HL_TWAP_LIVE_ENV`.

**Откат:** `HL_TWAP_LIVE_MARGIN_LEV3_USD=1200`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.425] — 2026-06-11

**Тег:** `sa-alpha-1.11.425`

### hl-twap: skip TWAPs < 9 minutes

- **`twap-duration.ts`:** `HL_TWAP_MICRO_MIN_MINUTES=9`, `HL_TWAP_SHORT_MIN_MINUTES=9` — block whale TWAPs shorter than 9m in unrestricted + short lane gates (`twap_too_short`).
- **`ecosystem.config.cjs`:** prod `HL_TWAP_MICRO_MIN_MINUTES=9`, `HL_TWAP_SHORT_MIN_MINUTES=9`.
- **Tests:** duration + unrestricted gates updated for 9m floor.
- **Analysis:** `scripts-tmp/hl-twap-impact-threshold-backtest.ts` — impact distribution + 2%/4%/5% counterfactual on clean backtest trades.

**Откат:** revert merge → `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`; set `HL_TWAP_MICRO_MIN_MINUTES=6` to restore prior 6m floor.

---


**Тег:** `sa-alpha-1.11.424`

### hl-twap: skip ≤5m TWAPs; exec slices $500 / 2s gap

- **`twap-duration.ts`:** `HL_TWAP_MICRO_MIN_MINUTES=6` — block 5m (and shorter) micro lane in unrestricted + standard gates (`twap_too_short`).
- **`ecosystem.config.cjs`:** prod `HL_TWAP_EXEC_SLICE_USD=500`, `HL_TWAP_EXEC_SLICE_GAP_MS=2000`, `HL_TWAP_MICRO_MIN_MINUTES=6`.
- **Tests:** duration + unrestricted gates updated for 5m block.

**Откат:** revert merge → `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`; set `HL_TWAP_MICRO_MIN_MINUTES=1` to re-enable 5m.

---

## [1.11.423] — 2026-06-11

**Тег:** `sa-alpha-1.11.423`

### hl-twap-live: coin-stack re-anchor (virtual leg transfer)

- **`coin-stack-policy.ts`:** when coin+side stack is full but a stronger TWAP arrives, emit `coin_stack_reanchor` with weakest open/pending slot instead of silent `coin_stack_full`.
- **`live-trader.ts`:** `performCoinStackReanchor()` rewrites journal hash/whale metadata (no exchange order); `scheduleLiveTrade` handles re-anchor path.
- **`journal.ts`:** `journalReanchorRow` + reload helpers for pending schedules after hash swap.
- **`coin-exposure.ts`:** pass pending schedules into stack evaluation; allow re-anchor through gate.
- **`live-exec-worker.ts`:** clear stale `coin_side_open_in_flight` on re-anchor.
- **Tests:** coin-stack re-anchor + unrestricted stack scenarios.

**Откат:** `git revert` merge commit → `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.422] — 2026-06-11

**Тег:** `sa-alpha-1.11.422`

### hl-twap-live: coin_has_opposite_side before unrestricted bypass (XLM incident)

- **`coin-exposure.ts`:** `coinOppositeLegBlockReason()` runs **before** `HL_TWAP_UNRESTRICTED=1` early return — prevents long+short net exposure on same coin (XLM ~$9.50 dust).
- **`resolveLiveEntryAuditPlan`:** same gate in unrestricted audit path.
- **Test:** `canScheduleLiveEntry still blocks opposite side in unrestricted mode`.

**Откат:** `git revert` merge commit → `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.421] — 2026-06-11

**Тег:** `sa-alpha-1.11.421`

### hl-twap-live: variable margin by HL max leverage

- **`margin-by-leverage.ts`:** collateral tiers by effective max leverage — ≤3× → $1200, 4–5× → $1000, ≥6× → $800 (4× uses 5× tier).
- **Opens:** when `HL_TWAP_LIVE_DYNAMIC_MARGIN=0`, entry margin = tier × coin max lev; gross targets ~$3600 / $5000 / $5600 (3×/5×/7×).
- **Stack cap:** `newLegGrossUsd` uses per-coin margin×lev (HL meta `maxLeverageByCoin` at schedule time).
- **Env:** `HL_TWAP_LIVE_MARGIN_LEV3_USD`, `LEV5_USD`, `LEV7_USD` (fallback `NOTIONAL_USD` for 7× tier).

**Откат:** `git revert` merge commit → `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.420] — 2026-06-11

**Тег:** `sa-alpha-1.11.420`

### hl-twap-live: block serial canceller 0xb676 (live PNL ≤0)

- **`whale-blocklist.ts`**: built-in block for `0xb676…7dbf` (🔴100% cancel, 5/5 TWAP, prod live PNL −$6).
- Gate in **`computeCoinEntryPlan`** / **`canScheduleLiveEntry`** → skip reason **`whale_blocklist`**.
- Profitable 🔴100% whales (`0x622f`, `0xa656`, etc.) **not** blocked — live PNL positive.
- Env override: **`HL_TWAP_WHALE_BLOCKLIST`** (comma-separated, merged with built-in).
- Analysis: `scripts-tmp/_hl_whale_blocklist_analysis.json`.

**Откат:** `git checkout sa-alpha-1.11.419 -- src/hyperliquid/twap/whale-blocklist.ts src/hyperliquid/twap/coin-twap-analysis.ts src/hyperliquid/twap/live/coin-exposure.ts tests/hl-twap-whale-blocklist.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md .env.example`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.419] — 2026-06-11

**Тег:** `sa-alpha-1.11.419`

### hl-twap-live: exec-slice leverage cap (GRASS open_fill_too_small)

- **`exec-slice.ts`:** sliced opens use `inner.leverageForCoin(coin)` (HL max per coin, e.g. GRASS 3×) instead of `cfg.leverage` (7×) for gross notional and fill reconciliation — fixes false `open_fill_too_small` cancels when fill $2400 vs target $5600.
- **`types.ts` / exchange clients:** expose `leverageForCoin` on `HlTwapExchangeClient`; test covers $800 margin × 3× = $2400 gross.

**Откат:** `git revert` merge commit → `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.419] — 2026-06-11

**Тег:** `sa-alpha-1.11.419`

### live-oscar Wave B: страховка у безубытка после первых двух TP

- После исполнения TP-сетки **+2.5%** и **+5%** (индексы 0 и 1), если PnL vs avg возвращается к **≤0%**, один раз продаётся настраиваемая доля **остатка** (prod: **50%**). Полный `BREAKEVEN_EXIT` по-прежнему только после TP **≥+7.5%**.
- **`exit-policy-wave-b.ts`:** `waveBFirstTwoTpRungsTaken()`, `waveBBreakevenInsuranceEligible()`; флаг **`liveWaveBreakevenInsuranceTaken`** на open.
- **`tracker.ts`:** partial **`WAVE_B_BREAKEVEN_INSURANCE`**; replay/snapshot в `strategy-snapshot.ts` + `store-restore.ts`.
- **Env (`live-oscar` в `ecosystem.config.cjs`, включено):** `PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_ENABLED=1`, `…_FRACTION=0.5`, `…_PNL_FRAC=0`.

**Откат:** `git revert`; `PAPER_LIVE_OSCAR_WAVE_B_BREAKEVEN_INSURANCE_ENABLED=0` → `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.418] — 2026-06-11

**Тег:** `sa-alpha-1.11.418`

### live-oscar: flash crash kill отключён

- **`ecosystem.config.cjs` (`live-oscar`):** `PAPER_FLASH_CRASH_KILL_ENABLED=0` — velocity/post-fill exit `FLASH_CRASH_KILL` больше не срабатывает (на VPS было `1` с 1.11.309; закрыло SPCX −1.85%% 2026-06-10 23:12 UTC).
- Код включает флаг только при `PAPER_FLASH_CRASH_KILL_ENABLED === '1'`; дефолт в `config.ts` — `false`.

**Откат:** `PAPER_FLASH_CRASH_KILL_ENABLED: '1'` в `ecosystem.config.cjs` → `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.417] — 2026-06-11

**Тег:** `sa-alpha-1.11.417`

### Alchemy-only RPC audit + hourly usage Telegram

- **`resolve-solana-rpc-url`:** primary chain Alchemy-first (`SA_RPC` / `ALCHEMY_HTTP_URL`); Helius fallback только при `SOLANA_RPC_HELIUS_FALLBACK_ENABLED=1`.
- **`ecosystem.config.cjs`:** все RPC-процессы получают `PM2_SOLANA_RPC_ENV` + `SOLANA_RPC_ALCHEMY_ONLY_ENV`; combo-follow Helius fallback=1 исправлен; `ENABLE_PUMPSWAP_COMBO_PM2` (default off) фильтрует `pumpswap-combo*`; QN hourly Telegram на dashboard выкл.; новый `sa-alchemy-usage-watch`.
- **`scripts-tmp/alchemy-usage-hourly-telegram.mjs`:** ежечасный REPORT в Telegram (internal meter + getSlot; публичного Alchemy usage API нет).
- **`copytrader/rpc.ts`:** учёт RPC в internal meter.

**Откат:** `git revert` → deploy `v2`; `ENABLE_PUMPSWAP_COMBO_PM2=true` если нужны combo; вернуть `QUICKNODE_HOURLY_REMAINING_TELEGRAM=1` на dashboard.

---

## [1.11.416] — 2026-06-11

**Тег:** `sa-alpha-1.11.416`

### Live Oscar: Alchemy-only RPC + entry $1200 (2×$600) + DCA $300

- **`ecosystem.config.cjs`:** `SOLANA_RPC_HELIUS_PREFER=0`, `SOLANA_RPC_HELIUS_FALLBACK_ENABLED=0` для live-oscar, copy-trader, dashboard; `PM2_SOLANA_RPC_ENV` пробрасывает `SA_RPC_HTTP_URL` / `LIVE_RPC_HTTP_URL` / `COPY_TRADER_RPC_URL` из `.env` (ключ Alchemy не в git).
- **Sizing:** staged entry **$600+$600** (`PAPER_POSITION_USD=1200`), DCA **−10%/−20% × $300**, cap **`LIVE_MAX_POSITION_USD=1800`**.
- **`strategy-process-watch`:** combo-процессы убраны из default targets (не воскресают после `pm2 save`).

**Откат:** вернуть QN/Helius URL в `.env`, `SOLANA_RPC_HELIUS_FALLBACK_ENABLED=1`; прежние `LIVE_OSCAR_*` / `PAPER_DCA_LEVELS` из `1.11.415`; `git revert` + deploy `v2`.

---

## [1.11.415] — 2026-06-11

**Тег:** `sa-alpha-1.11.415`

### HL TWAP live: hourly Total Balance Telegram

- **`HL_TWAP_BALANCE_HOURLY_TELEGRAM=1`** (default on in `ecosystem.config.cjs` when live): hourly ping to whale Telegram chat with **HL UI Total Balance** (`resolveAccountEquityUsd`: spot USDC + Σ uPnL).
- First message after **UTC hour boundary** (no immediate ping on PM2 restart); then every 60m.
- Optional trailing **peak** (drawdown state) and open positions count.

**Откат:** `HL_TWAP_BALANCE_HOURLY_TELEGRAM=0`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.414] — 2026-06-11

**Тег:** `sa-alpha-1.11.414`

### HL TWAP live: fix unified-account equity for drawdown stop

- **`resolveAccountEquityUsd`:** unified accounts now use **spot USDC + Σ uPnL** (HL UI Total Balance), not perp `marginSummary.accountValue` alone (~$1991 vs ~$5776 on prod).
- Trailing-peak stop logic unchanged: **`peak − equity ≥ threshold`** each 60s poll (not inter-tick delta).
- Peak re-inits on process restart after deploy.

**Откат:** `git revert` merge commit → `v2` deploy; или временно `HL_TWAP_LIVE_DRAWDOWN_STOP_USD=0`.

---

## [1.11.413] — 2026-06-11

**Тег:** `sa-alpha-1.11.413`

### HL TWAP live: trailing-peak drawdown stop (fix 1.11.412)

- **Trailing high-water mark:** each 60s poll reads total equity (incl. uPnL); peak rises with new highs; stop when **`peak − equity ≥ HL_TWAP_LIVE_DRAWDOWN_STOP_USD`** (default $1000).
- Example: $5000 → $6000 peak → stop at **$5000** (6000−1000), not $4000 from initial balance.
- Peak resets on process start or **`HL_TWAP_LIVE_DRAWDOWN_CLEAR_HALT=1`**; removed fixed startup baseline.

**Откат:** `git checkout sa-alpha-1.11.412 -- src/hyperliquid/twap/live/drawdown-stop.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.412] — 2026-06-11

**Тег:** `sa-alpha-1.11.412`

### HL TWAP live: account drawdown stop ($1000 default)

- **`HL_TWAP_LIVE_DRAWDOWN_STOP_USD=1000`:** when total equity (incl. uPnL) falls ≥ threshold below startup baseline → emergency flatten all HL positions, cancel pending schedules, halt new entries.
- **`HL_TWAP_LIVE_DRAWDOWN_CHECK_MS=60000`:** equity poll every 60s via `clearinghouseState` (`accountValue` or unified spot+uPnL).
- **Baseline:** captured at process start (logged); optional **`HL_TWAP_LIVE_DRAWDOWN_BASELINE_USD`** to pin; state in **`data/hl-twap/drawdown-stop.json`**.
- **Telegram:** `🛑 STOP LOSS — trading halted` to live-trades + whale channels.
- **Resume:** set **`HL_TWAP_LIVE_DRAWDOWN_CLEAR_HALT=1`** and restart (re-baselines to current equity).

**Откат:** `git checkout sa-alpha-1.11.411 -- src/hyperliquid/twap/live/drawdown-stop.ts src/hyperliquid/twap/hyperliquid-meta.ts src/scripts/hl-twap-telegram-watch.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.411] — 2026-06-11

**Тег:** `sa-alpha-1.11.411`

### HL TWAP live: coin book gross cap $12k + max 2 legs + driver re-anchor

- **`HL_TWAP_LIVE_MAX_BOOK_GROSS_USD=12000`:** hard cap on exchange gross per coin+side (entries + DCA blocked above cap).
- **`HL_TWAP_LIVE_COIN_MAX_LEGS=2`:** max two concurrent journal legs (incl. pending schedules) per coin+side; 3rd TWAP does **not** open a new leg.
- **3rd active TWAP:** book timer exit (`liveCloseAtMs`) re-anchors to the **best hourly-impact** active whale TWAP on that side (incl. signals without a journal leg).
- **Ladder step (ROE):** TP/DCA triggers at ±3% **Hyperliquid ROE** (`uPnL / margin`), not ±3% price move — aligns with HL UI (fixes late/missing TP on stacked books at 7x).
- Ladder slice unchanged (10% of current gross); $800 margin × 7x entry unchanged.

**Откат:** `git checkout sa-alpha-1.11.410 -- ecosystem.config.cjs src/hyperliquid/twap/live/ docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

---

## [1.11.410] — 2026-06-11

**Тег:** `sa-alpha-1.11.410`

### HL TWAP live: entry margin $500 → $800 (fixed)

- **`HL_TWAP_LIVE_NOTIONAL_USD` / `HL_TWAP_LIVE_MARGIN_MIN_USD` / `HL_TWAP_LIVE_MARGIN_MAX_USD`:** **$800** collateral per entry (`HL_TWAP_LIVE_DYNAMIC_MARGIN=0` unchanged).
- Gross position = **$800 × min(HL coin max leverage, 7x)** (e.g. 7x major → **$5600** gross).
- TP/DCA ladder unchanged: **10% of live gross** per slice; leverage caps and exit exec slices unchanged.

**Откат:** `git checkout sa-alpha-1.11.409 -- ecosystem.config.cjs src/hyperliquid/twap/live/config.ts .env.example docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

## [1.11.409] — 2026-06-10

**Тег:** `sa-alpha-1.11.409`

### HL TWAP live: single book exit + background exec worker

- **Single exit per coin+side:** stacked journal legs share one exchange position — only one `exit_start`/slice pipeline per book; sibling legs link to the driver; finalize closes all legs when book flattens (fixes HYPE 3× `exit_slice 1/3` triple-close).
- **Background exec worker:** `kickLiveExecWorker` decouples `runLiveExchangePass` (impact closes, ladder, timers, residuals) from HypurrScan poll loop — poll stays on interval while exchange I/O runs in one batch.
- **Includes 1.11.408:** exit anchor repair (`exitScheduleTriggerMs`, stale `exit_start` repair).

**Откат:** `git checkout sa-alpha-1.11.408 -- src/hyperliquid/twap/live/chunked-exit-runner.ts src/hyperliquid/twap/live/live-exec-worker.ts src/hyperliquid/twap/live/live-trader.ts src/scripts/hl-twap-telegram-watch.ts tests/hl-twap-single-book-exit.test.ts tests/hl-twap-live-exec-worker.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

## [1.11.408] — 2026-06-10

**Тег:** `sa-alpha-1.11.408`

### HL TWAP live: repair stuck exit_start anchor (HYPE/ETH slices)

- **`exitScheduleTriggerMs`:** early exits (whale ended, impact lost, …) anchor to actual `startedAtMs`, not future `liveCloseAtMs` — prevents first slice scheduled hours ahead.
- **`resolveExitScheduleAnchor`:** journal repair drops whale alignment when first slice due >2 intervals after exit start (unblocks legs stuck at `exit_start` with `slicesSent=0`).

**Откат:** `git checkout sa-alpha-1.11.407 -- src/hyperliquid/twap/live/chunked-exit.ts src/hyperliquid/twap/live/chunked-exit-runner.ts tests/hl-twap-chunked-exit.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

## [1.11.407] — 2026-06-10

**Тег:** `sa-alpha-1.11.407`

### pumpswap-combo-follow live: conditional flush, rug-follow, mirror adds

24h counterfactual: мелкие scalp-sell лидера (~$200) вызывали −$6.8 flush; TP-лестница +$9.5.

- **Conditional flush:** `FLOW8Z_FLUSH_MIN_SELL_USD=500` — не сливаем бag на мелкий sell; TP-лестница и max_hold остаются.
- **Rug-follow:** leader **flat** (post-sell balance 0) → `flow8z_leader_flat_flush` с `FLAT_FLUSH_DELAY_MS=0` (мгновенно вслед за полным выходом hnu5).
- **Killstop:** `FLOW8Z_KILLSTOP_PCT=30` — страховка если лидер ещё держит, а пул уже ломается.
- **Flow gate:** `FLOW_MAX_LAG_SEC=15` (было 5); scan sleep 45ms (было 90).
- **Mirror adds:** `MIRROR_LEADER_ADDS=1` — докуп на add лидера (max 3 legs).

**Anti-rug stack:** min mcap $150k → flat flush → large-sell flush → −30% killstop → 3h max_hold.

**Откат:** `git checkout sa-alpha-1.11.406 -- src/pumpswap-combo-follow/ ecosystem.config.cjs docs/strategy/release/ tests/pumpswap-combo-follow/flow8z-leader-flush.test.ts`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.406] — 2026-06-10

**Тег:** `sa-alpha-1.11.406`

### HL TWAP live: fixed $500 margin per entry (disable dynamic $300 floor)

- **`HL_TWAP_LIVE_DYNAMIC_MARGIN=0`** — every open uses **$500 collateral**; no scale-down to $300 at ≥5 opens.
- **`HL_TWAP_LIVE_MARGIN_MIN_USD=500`** — min=max when dynamic margin re-enabled.
- Gross position = **$500 × min(HL coin max leverage, 7x)** (e.g. ONDO 7x → $3500, 5x coin → $2500).
- TP/DCA ladder unchanged: **10% of live gross** per slice; exit timing and $200/5s exec slices unchanged.

**Откат:** `git checkout sa-alpha-1.11.405 -- ecosystem.config.cjs src/hyperliquid/twap/live/config.ts docs/strategy/release/`; set `HL_TWAP_LIVE_DYNAMIC_MARGIN=1` + `HL_TWAP_LIVE_MARGIN_MIN_USD=300`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

## [1.11.405] — 2026-06-10

**Тег:** `sa-alpha-1.11.405`

### HL TWAP live: TP ladder fix + unified $200 exec slices

- **TP ladder:** allow ±3% TP/DCA while chunked exit is *scheduled* but before the first exit slice fires; block ladder only after `slicesSent > 0`. Fixes missed TP when `exit_start` was written hours ahead of whale-aligned first slice (e.g. HYPE legs blocked ~15h).
- **Poll order:** run `processLiveLadders` before timer/whale exits so profitable books can take TP in the same poll cycle.
- **Exec slices:** all market orders (open, TP, DCA, exit) split into ≤**$200** gross chunks with **5s** gap (`HL_TWAP_EXEC_SLICE_USD`, `HL_TWAP_EXEC_SLICE_GAP_MS`).

**Откат:** `git checkout sa-alpha-1.11.404 -- src/hyperliquid/twap/live/ src/hyperliquid/twap/twap-duration.ts src/scripts/hl-twap-telegram-watch.ts tests/hl-twap-exec-slice.test.ts tests/hl-twap-ladder-exit-block.test.ts tests/hl-twap-flatten.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env`.

## [1.11.404] — 2026-06-10

**Тег:** `sa-alpha-1.11.404`

### pumpswap-combo-follow live: min mcap $150k (was $500k)

- `PUMPSWAP_COMBO_FOLLOW_MIN_MCAP_USD=150000` — blocks sub-150k dust; allows small-cap above floor.

**Откат:** `MIN_MCAP_USD=500000`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.403] — 2026-06-10

**Тег:** `sa-alpha-1.11.403`

### HL TWAP live: unified-account free margin gate

- **Margin gate:** `freeMarginUsd` uses HL **withdrawable** (spot USDC `total − hold`), not `account − max(journal, used)` — fixes false `insufficient_account_margin` when journal over-counts netted perp legs.
- **Withdrawable fetch:** `max(perpWithdrawable, spotFree)` on unified accounts (perp withdrawable is often 0 while USDC is free).
- **Defer log:** show `free`, `need`, `account` (drop misleading standalone `spotUsdc=`).

**Откат:** `git checkout sa-alpha-1.11.402 -- src/hyperliquid/twap/hyperliquid-meta.ts src/hyperliquid/twap/live/account-margin.ts src/hyperliquid/twap/live/live-trader.ts tests/hl-twap-account-margin.test.ts`; `pm2 restart hl-twap-telegram-watch`.

### pumpswap-combo-follow live: min mcap $500k (block micro)

- Entry gate: **`MIN_MCAP_USD=500000`**, **`MAX_MCAP_USD=3000000`** (PG pumpswap snapshot → DexScreener fallback).
- Ignores leader buys on ~30k micro caps; journal `leader_buy_ignored` / `min_mcap_usd`.

**Откат:** `MIN_MCAP_USD=0`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.402] — 2026-06-10

**Тег:** `sa-alpha-1.11.402`

### HL TWAP: $500 first leg + margin-based DCA ladder

- **Entry:** one full **$500 × ~7x** order (no entry slice split); min fill **85%** requested gross.
- **TP / DCA ladder:** one book per **coin+side** — slice **10% of exchange gross** (not per TWAP leg); ±**3% price** move; shared tp/dca levels across stacked legs.
- **Exit:** gradual slices by duration (≤5m→2, 6–15m→2, >15m→3).
- **Entry filter:** unrestricted keeps **only** hourly impact ≥ **2%/h** (policy floor; detect + schedule).

**Откат:** `git checkout sa-alpha-1.11.401 -- src/hyperliquid/twap/ src/scripts/hl-twap-telegram-watch.ts ecosystem.config.cjs tests/hl-twap-*.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 delete hl-twap-telegram-watch; pm2 start ecosystem.config.cjs --only hl-twap-telegram-watch; pm2 save`.

## [1.11.401] — 2026-06-10

**Тег:** `sa-alpha-1.11.401`

### pumpswap-combo-follow live: entry leg $7 (was $3)

- `PUMPSWAP_COMBO_FOLLOW_LEG_USD=7` — first leg + DCA notional base; max ~$7 + 2×~$2.33 ≈ $11.7/mint at 3 legs.

**Откат:** `LEG_USD=3`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.400] — 2026-06-10

**Тег:** `sa-alpha-1.11.400`

### HL TWAP: unrestricted mode — trade all TWAPs + micro exit

- **`HL_TWAP_UNRESTRICTED=1`**: skip duration, momentum, BTC, whale deny, prior-loss gates; **hourly impact ≥ 2%/h remains the only entry filter** (`HL_TWAP_MIN_IMPACT_PCT_HOUR=2`).
- **Micro lane (≤15m)**: single exit slice for ≤10m; **2 whale-aligned slices** for 11–15m (no 10-slice chunked exit).
- **15m gap closed**: micro lane now includes 15m TWAPs (was `twap_too_short`).

**Откат:** `HL_TWAP_UNRESTRICTED=0`; restore gates in `ecosystem.config.cjs` (`HL_TWAP_COIN_MOMENTUM_GATE=1`, `HL_TWAP_BTC_ALIGNED_GATE=1`, `HL_TWAP_LIVE_COIN_PRIOR_LOSS_BLOCK=1`); `git checkout sa-alpha-1.11.399 -- src/hyperliquid/twap/ ecosystem.config.cjs tests/hl-twap-unrestricted.test.ts docs/strategy/release/`; `pm2 delete hl-twap-telegram-watch; pm2 start ecosystem.config.cjs --only hl-twap-telegram-watch; pm2 save`.

## [1.11.399] — 2026-06-10

**Тег:** `sa-alpha-1.11.399`

### pumpswap-combo-follow: late entry when leader adds (we missed first buy)

- **`allowLateEntryOnLeaderAdd`** (default on for flow8z): if we have no bag and hnu5 buys into a coin he already holds, enter via flow gate instead of `missed_entry_leader_already_in`.
- Mirror-adds while we hold stay off — price DCA only.

**Откат:** `ALLOW_LATE_ENTRY_ON_LEADER_ADD=0`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.398] — 2026-06-10

**Тег:** `sa-alpha-1.11.398`

### pumpswap-combo-follow: fix instant sell after buy (stale leader-sell flush)

- **`flow8z_leader_pool_flush`** no longer fires on leader sells that happened **before** our entry; only sells observed while the bag is open arm the 60s flush timer.
- Clear stale `lastLeaderSellByMint` on new entry; unit test `leader-sell-since-open`.

**Откат:** `git checkout sa-alpha-1.11.397 -- src/pumpswap-combo-follow/`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.397] — 2026-06-10

**Тег:** `sa-alpha-1.11.397`

### pumpswap-combo-follow: min leader buy $80 (was $150)

- Unblocks ~60% of hnu5 buys previously ignored as `min_leader_buy_usd`; flow gate unchanged.

**Откат:** `MIN_LEADER_BUY_USD=150`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.396] — 2026-06-10

**Тег:** `sa-alpha-1.11.396`

### pumpswap-combo-follow: hnu5 aggressive scalp exit ladder

- Live ladder **`14:0.7,22:1`** + **`exitLeadPct=2`** → effective **+12%** sell 70%, **+20%** close rest (front-run hnu5 ~+15–20% first scalp).
- Config default for flow8z + hnu5 target when `EXIT_LADDER` unset.

**Откат:** `EXIT_LADDER=13:1`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.395] — 2026-06-10

**Тег:** `sa-alpha-1.11.395`

### pumpswap-combo-follow: front-run DCA + delayed leader-sell exit

- **Front-run DCA** `−8%@first`, `−7%@avg` (not leader mirror) — buy before hnu5 avg-down lifts mark.
- **Leader sell exit delay** `60s` (best in 1–5m selective backtest) then pool flush; TP still active during wait.
- **Removed max leader first-buy cap** (`MAX_LEADER_FIRST_BUY_USD=0`) — no skip on large leader entries.

**Откат:** `git checkout sa-alpha-1.11.394 -- src/pumpswap-combo-follow/ ecosystem.config.cjs docs/strategy/release/`; `pm2 delete pumpswap-combo-follow-live; pm2 start ecosystem.config.cjs --only pumpswap-combo-follow-live`.

## [1.11.394] — 2026-06-10

**Тег:** `sa-alpha-1.11.394`

### Live bots: unified strategy-process-watch (24/7)

- **`strategy-process-watch`** PM2 app watches **hl-twap**, **live-oscar**, **copy-trader**, **pumpswap-combo-follow-live** every 30s (PM2 status + heartbeat file).
- Auto **`pm2 restart`** + Telegram **`[ALERT][strategy_watch]`** on stopped/stale (&gt;5 min).
- **`ops-heartbeat`** (60s) in copy-trader, live-oscar, combo-follow; hl-twap keeps `data/hl-twap/heartbeat.json`.
- Replaces per-app `hl-twap-process-watch`.

**Откат:** `git checkout sa-alpha-1.11.393 -- ecosystem.config.cjs src/core/ops-heartbeat.ts src/scripts/copy-trader.ts src/scripts/live-oscar.ts src/scripts/pumpswap-combo-follow-bot.ts src/pumpswap-combo-follow/main.ts scripts-tmp/strategy-process-watch.mjs scripts-tmp/process-watch-lib.mjs docs/strategy/release/`; VPS `pm2 delete strategy-process-watch; pm2 start ecosystem.config.cjs --only hl-twap-process-watch --update-env; pm2 save`.

---

## [1.11.393] — 2026-06-10

**Тег:** `sa-alpha-1.11.393`

### HL TWAP: 24/7 PM2 + watchdog

- **`hl-twap-telegram-watch`** in `ecosystem.config.cjs`: direct **tsx** (not npm wrapper), `autorestart`, `max_restarts=100`.
- In-process **heartbeat** every 60s → `data/hl-twap/heartbeat.json`; `last-fatal.json` on crash.
- **`hl-twap-process-watch`**: polls PM2 + heartbeat; **auto-restart** + `[ALERT][hl_twap_watch]` Telegram when stopped/stale (&gt;5 min).

**Откат:** `git checkout sa-alpha-1.11.392 -- ecosystem.config.cjs src/scripts/hl-twap-telegram-watch.ts scripts-tmp/hl-twap-process-watch.mjs scripts-tmp/hl-twap-watch-lib.mjs tests/hl-twap-process-watch.test.ts docs/strategy/release/`; on VPS restore manual PM2 entry or `pm2 delete hl-twap-process-watch`; `pm2 save`.

---

## [1.11.392] — 2026-06-10

**Тег:** `sa-alpha-1.11.392`

### pumpswap-combo-follow: fix stale state wipe after buy

- Re-read state before DCA/exits tick (was overwriting fresh buys with empty snapshot).
- Enable DCA eval for any policy with `dcaLevels` configured.

**Откат:** revert `src/pumpswap-combo-follow/main.ts`; reload PM2.

---

## [1.11.391] — 2026-06-10

**Тег:** `sa-alpha-1.11.391`

### pumpswap-combo-follow: flow8z + price DCA for 24h live trial

- Price DCA (−10% / −20%, ⅓ notional each) on `flow8z_antidump` (was oscar_wave_b only).
- Live PM2: `MAX_BUY_LEGS=3`, `$3` entry, flow gate unchanged; `CLEAR_HALT` removed post-unhalt.

**Откат:** `MAX_BUY_LEGS=1`, unset `DCA_LEVELS`; `pm2 reload pumpswap-combo-follow-live --update-env`.

---

## [1.11.390] — 2026-06-10

**Тег:** `sa-alpha-1.11.390`

### pumpswap-combo-follow v2: flow8z profile (no pool stream required)

- Live **`flow8z_antidump`**: TP ladder 13% lead, leader pool flush on leader sell, 1 leg only.
- **MAX_OPEN=8**, **max hold 3h**, portfolio stop **$35** (realized+unrealized).
- Flow gate: ext sell $300–2500, **lag ≤5s**.
- `PUMPSWAP_COMBO_FOLLOW_CLEAR_HALT=1` clears operator halt on boot.

**Откат:** `git checkout sa-alpha-1.11.389 -- src/pumpswap-combo-follow/ ecosystem.config.cjs docs/strategy/release/`; restore oscar_wave_b env; `pm2 reload pumpswap-combo-follow-live --update-env`.

---

## [1.11.389] — 2026-06-09

**Тег:** `sa-alpha-1.11.389`

### Remove sa-wallet-orchestrator from production PM2

- Deleted PM2 app **`sa-wallet-orchestrator`** from `ecosystem.config.cjs` — it will **not** come back on `pm2 reload ecosystem.config.cjs`.
- Removed npm script `sa-wallet-orchestrator` from `package.json`.
- Scripts in `scripts-tmp/` remain for manual one-off only; no autostart.

**Откат:** restore orchestrator block in `ecosystem.config.cjs` + `package.json` from `sa-alpha-1.11.388`; `pm2 start ecosystem.config.cjs --only sa-wallet-orchestrator`.

---

## [1.11.388] — 2026-06-09

**Тег:** `sa-alpha-1.11.388`

### pumpswap-combo-follow: flow entry gate (skip chase entries)

- `PUMPSWAP_COMBO_FOLLOW_ENTRY_GATE=flow` — mirror only when large external pool sell preceded leader buy.
- Skip: no ext sell ≥$300 / 120s, no pool, whale dump >$2500 (configurable).
- Journal: `flow_entry_gate_pass`, `leader_buy_ignored` + `gateReason`.
- Backtest: `scripts-tmp/follow-hnu5-flow-lag-backtest.ts` (lag buckets × sell tiers).

**Откат:** `git checkout sa-alpha-1.11.387 -- src/pumpswap-combo-follow/ docs/strategy/release/`; `PUMPSWAP_COMBO_FOLLOW_ENTRY_GATE=all`; `pm2 reload ecosystem.config.cjs --only pumpswap-combo-follow-live --update-env`.

---

## [1.11.387] — 2026-06-09

**Тег:** `sa-alpha-1.11.387`

### HL TWAP live: dynamic entry margin

- Scale open collateral by **concurrent position count** ($380 at ≤2 opens → $170 at ≥5) and cap by **free margin** minus reserve + DCA headroom (2×10% ladder slice).
- `HL_TWAP_LIVE_NOTIONAL_USD` remains base/floor; startup log `dynamic_margin=1 range=…`.

**Откат:** `git checkout sa-alpha-1.11.386 -- src/hyperliquid/twap/live/dynamic-margin.ts src/hyperliquid/twap/live/config.ts src/hyperliquid/twap/live/live-trader.ts src/scripts/hl-twap-telegram-watch.ts tests/hl-twap-dynamic-margin.test.ts docs/strategy/release/`; `HL_TWAP_LIVE_DYNAMIC_MARGIN=0`; `pm2 restart hl-twap-telegram-watch --update-env`.

---

## [1.11.386] — 2026-06-09

**Тег:** `sa-alpha-1.11.386`

### pumpswap-combo-follow: leader wallet WebSocket ingest

- `logsSubscribe` on hnu5 wallet via `SA_RPC_WS_URL` / `resolveSolanaRpcWsUrl()` — push signature instead of 5s HTTP poll.
- Shared `ingestLeaderSignature`; mutex between WS and poll; HTTP backfill every 30s (`PUMPSWAP_COMBO_FOLLOW_POLL_FALLBACK_MS`).
- Journal: `leader_ws_observed`, `leader_ws_status`, `leader_ws_ingest_error`.
- Live PM2: `PUMPSWAP_COMBO_FOLLOW_LEADER_WS=1`.

**Откат:** `git checkout sa-alpha-1.11.385 -- src/pumpswap-combo-follow/ src/core/rpc/resolve-solana-rpc-url.ts ecosystem.config.cjs docs/strategy/release/`; `PUMPSWAP_COMBO_FOLLOW_LEADER_WS=0`; `pm2 reload ecosystem.config.cjs --only pumpswap-combo-follow-live --update-env`.

---

## [1.11.385] — 2026-06-09

**Тег:** `sa-alpha-1.11.385`

### Copy-trader: treat leader dust as flat; full exit on last sell

- Leader post-exit wallet dust (≤ `COPY_TRADER_LEADER_FLAT_DUST_RAW`, default 10 000 raw) no longer blocks `leader_flat_tail_sweep` (e.g. Jotchua: leader `1` raw, we held ~25%).
- On leader sell, if on-chain post-balance is dust → schedule **100%** our sell instead of proportional 50% of remainder.
- Ledger reconcile zeroes when on-chain is dust.

**Откат:** `git checkout sa-alpha-1.11.384 -- src/copytrader/leader-dust.ts src/copytrader/leader-flat-tail-sweep.ts src/copytrader/main.ts src/copytrader/config.ts tests/copytrader/leader-dust.test.ts tests/copytrader/leader-flat-tail-sweep.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.384] — 2026-06-09

**Тег:** `sa-alpha-1.11.384`

### HL TWAP: coin gates A+B for long entries

- **Gate A:** block long when coin **dd24h ≤ −5%** (Hyperliquid 1h candles vs 24h high).
- **Gate B:** block long after **any prior loss** on same coin+side (live journal).
- Paper/live audit + schedule paths; startup log `coin_momentum=1 coin_prior_loss=1`.

**Откат:** `git checkout sa-alpha-1.11.383 -- src/hyperliquid/twap/coin-momentum-gate.ts src/hyperliquid/twap/live/loss-streak-cooldown.ts src/hyperliquid/twap/live/coin-exposure.ts src/hyperliquid/twap/paper-trader.ts src/scripts/hl-twap-telegram-watch.ts`; `HL_TWAP_COIN_MOMENTUM_GATE=0 HL_TWAP_LIVE_COIN_PRIOR_LOSS_BLOCK=0`; `pm2 reload hl-twap-telegram-watch --update-env`.

---

## [1.11.383] — 2026-06-09

**Тег:** `sa-alpha-1.11.383`

### Follow live: только SOL — без USDC treasury и сделок

- **`pumpswap-combo-follow`**: все покупки/DCA только через **WSOL-пул**; если лидер покупает в USDC-пуле — резолвим тот же mint в SOL-пуле и покупаем там.
- Удалены treasury/rebalance USDC, коридор % USDC на кошельке и связанные env (`PUMPSWAP_COMBO_FOLLOW_TREASURY_*`).

**Откат:** `git checkout sa-alpha-1.11.382 -- src/pumpswap-combo-follow/ src/pumpswap-combo/pool-resolve.ts ecosystem.config.cjs`; `pm2 reload pumpswap-combo-follow-live --update-env`.

---

## [1.11.382] — 2026-06-09

**Тег:** `sa-alpha-1.11.382`

### HL TWAP: adaptive exit timing (standard lane)

- **≤30m:** exit **−10m** before TWAP end (unchanged).
- **>30m:** exit after **75%** of duration (last 25%, e.g. 60m → close at 45m).
- Short lane (<15m) unchanged: instant before last whale slice.

**Откат:** `git checkout sa-alpha-1.11.381 -- src/hyperliquid/twap/twap-duration.ts src/hyperliquid/twap/twap-schedule.ts src/hyperliquid/twap/paper-trader.ts src/hyperliquid/twap/live/live-trader.ts src/scripts/hl-twap-telegram-watch.ts`; `pm2 reload hl-twap-telegram-watch --update-env`.

---

## [1.11.381] — 2026-06-09

**Тег:** `sa-alpha-1.11.381`

### Follow live: $3 entry, Oscar % DCA on leg notional

- Entry остаётся **`LEG_USD=3`**; DCA −10/−20 считается как **`legUsd × 0.333333`** (~$1), не $600/$200.
- Wave B exits и kill −50% без изменений.

**Откат:** `git checkout sa-alpha-1.11.380`.

---

## [1.11.380] — 2026-06-09

**Тег:** `sa-alpha-1.11.380`

### Follow live: параметры live Oscar (wave B + price DCA)

- **`pumpswap-combo-follow`**: политика **`oscar_wave_b`** — TP-сетка wave B (+2.5% шаг, эскалация 5%/10%/…), defensive trail 20% после +10%, breakeven exit после TP ≥+7.5%.
- **DCA по цене** −10% / −20% vs первая нога: `positionUsd × 0.333333` (~$200 при $600), **не** mirror leader add по `$3`.
- **Killstop −50%** vs avg (`PUMPSWAP_COMBO_FOLLOW_DCA_KILLSTOP_PCT=50`).
- Mirror-adds лидера отключены (`MIRROR_LEADER_ADDS=0`); вход по сигналу лидера — **`$600`** entry.
- Legacy `leader_ladder` сохранён за `PUMPSWAP_COMBO_FOLLOW_EXIT_POLICY=leader_ladder`.

**Откат:** `PUMPSWAP_COMBO_FOLLOW_EXIT_POLICY=leader_ladder`, `LEG_USD=3`, `pm2 reload pumpswap-combo-follow-live --update-env`; `git checkout sa-alpha-1.11.379`.

---

## [1.11.379] — 2026-06-09

**Тег:** `sa-alpha-1.11.379`

### Agent: полчасовая сводка 429 в Telegram

- **`scripts-tmp/rate-429-halfhour-report.mjs`** — каждые 30 мин `[REPORT][agent_429]` в операторский канал: счётчик HTTP 429 / rate-limit по PM2-логам + follow journal.
- PM2: **`sa-rate-429-report`** (`RATE_429_REPORT_INTERVAL_MS=1800000`).
- **`scripts/lib/telegram.mjs`** — `skipQuietHours` для scheduled REPORT.

**Откат:** `pm2 delete sa-rate-429-report`; `git checkout sa-alpha-1.11.378`.

---

## [1.11.378] — 2026-06-09

**Тег:** `sa-alpha-1.11.378`

### PumpSwap Combo: откат stream discovery (firehose)

- **Удалён** `pumpswap-combo-stream` (PM2 + `src/pumpswap-combo-stream/` + script) — WS на весь PumpSwap AMM жёг QN credits без полезных снимков.
- Combo bot: **`WATCHLIST_STREAM_PREFER=0`**, **`WATCHLIST_RPC_REFRESH=4`** — снова PG + bounded RPC refresh.
- Combo bot: **`QUICKNODE_NO_DAILY_CAP_ENV`** — локальный дневной потолок не блокирует buy/sell (учёт credits сохраняется).
- QN feature `pumpswap_combo_stream` убран из `qn-feature-usage`.

**Откат:** `git checkout sa-alpha-1.11.377`; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.377] — 2026-06-09

**Тег:** `sa-alpha-1.11.377`

### QuickNode: снять клиентские лимиты (meter-only по умолчанию)

- **`solana-rpc-meter`** — блокировка RPC только при `QUICKNODE_BUDGET_BLOCK=1` (+ опционально `QUICKNODE_DAILY_ENFORCE=1` / hourly / provider cache). Учёт credits и Telegram-алерты без изменений.
- **`qn-feature-usage`** — feature monthly caps не блокируют RPC, пока явно не задан `QN_FEATURE_BUDGET_ENFORCE=1`.
- **`ecosystem.config.cjs`** — `QUICKNODE_NO_DAILY_CAP_ENV` для live-oscar, dashboard, orch, combo-follow; follow-live/paper + `QN_FEATURE_BUDGET_DISABLED=1`.
- **`.env.example`** — `QUICKNODE_DAILY_ENFORCE=0`, документирован `QUICKNODE_BUDGET_BLOCK`.

**Откат:** `git checkout sa-alpha-1.11.376` → deploy `origin/v2` на предыдущий SHA; в `.env` можно снова включить `QUICKNODE_DAILY_ENFORCE=1` (на 1.11.376 блокировало по умолчанию).

---

## [1.11.376] — 2026-06-09

**Тег:** `sa-alpha-1.11.376`

### PumpSwap Combo #1: stream discovery + RPC burst guard (изолировано)

- **`pumpswap-combo-stream`** — WS PumpSwap AMM → bounded `getTransaction` → `pumpswap_pair_snapshots`.
- Combo bot: exit-mark cache (2/tick), batch balances, RPC gap, watchlist RPC off при fresh stream.
- QN features `pumpswap_combo` / `pumpswap_combo_stream` — отдельно от live-oscar.

**Откат:** `git checkout sa-alpha-1.11.375 -- src/pumpswap-combo/ src/pumpswap-combo-stream/ src/core/rpc/qn-feature-usage.ts ecosystem.config.cjs docs/strategy/release/`; `pm2 delete pumpswap-combo-stream`; `pm2 reload ecosystem.config.cjs --only pumpswap-combo-bot --update-env`.

---

## [1.11.375] — 2026-06-09

**Тег:** `sa-alpha-1.11.375`

### PumpSwap Combo Follow: SL только когда лидер вышел

- **`PUMPSWAP_COMBO_FOLLOW_SL_MODE=while_leader_holds_off`** — stop-loss **не** срабатывает, пока hnu5 держит mint (усредняется); TP-лестница на 2% раньше без изменений.
- **`PUMPSWAP_COMBO_FOLLOW_SL_PRE_DCA_PCT=45`** (шире до полного DCA, когда лидер уже flat).
- Журнал: `stop_loss_suppressed` при достижении порога SL при активной позиции лидера.
- Бэктест: `scripts-tmp/follow-hnu5-exit-backtest.ts` (7d hnu5 RPC + PG snapshots).

**Откат:** `PUMPSWAP_COMBO_FOLLOW_SL_MODE=fixed`, `SL_PRE_DCA_PCT=35`; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.374] — 2026-06-09

**Тег:** `sa-alpha-1.11.374`

### PumpSwap Combo: max 15 open positions, QuickNode-only RPC

- `PUMPSWAP_COMBO_MAX_CONCURRENT_OPENS=15`
- Helius fallback **off** for combo bot (monthly cap exhausted — QN only).

**Откат:** `PUMPSWAP_COMBO_MAX_CONCURRENT_OPENS=8` in ecosystem; reload PM2.

---

## [1.11.373] — 2026-06-09

**Тег:** `sa-alpha-1.11.373`

### PumpSwap Combo #1: PG radar + RPC live spot (autonomous visibility)

Bot was blind: strict vol5m PG filter → 5 mints; dump=0 on stale PG prices; 8/8 slots full blocked new entries.

- **PG lookback 6h**, vol5m optional (0), sort by dump % descending.
- **RPC pool spot refresh** (~12/tick) for top dump candidates — no leader wallet.
- **Dump signal** uses max(PG high, rolling high) vs live spot; freshness accepts RPC timestamp.
- **Heartbeat** reports `slotsFree` when max concurrent opens blocks entries.

**Откат:** `git checkout sa-alpha-1.11.372 -- src/pumpswap-combo/ ecosystem.config.cjs`; `pm2 reload pumpswap-combo-bot --update-env`.

---

## [1.11.372] — 2026-06-09

**Тег:** `sa-alpha-1.11.372`

### PumpSwap Combo #1: autonomous only — strip leader/shadow lane

Combo #1 must trade **autonomously** from forensic rules (3 reference bots). Leader copy belongs **only** to `pumpswap-combo-follow-*`.

- **Removed:** shadow wallet poll, `shadow_probe` / `shadow_add`, hnu5 co-trade, RPC leader injection in watchlist.
- **Watchlist:** PG-only (liq / vol5m / mcap / dump band / freshness).
- **DCA add:** only when spot **below** avg fill (no adds on rally).
- **Kept:** dump probe, dip-band DCA, pre-DCA SL, TP ladder — all signal-driven, no wallet mirror.

**Откат:** `git checkout sa-alpha-1.11.371 -- src/pumpswap-combo/ ecosystem.config.cjs`; `pm2 reload ecosystem.config.cjs --only pumpswap-combo-bot --update-env`.

---

## [1.11.371] — 2026-06-09

**Тег:** `sa-alpha-1.11.371`

### PumpSwap Combo: hnu5-like DCA (mirror adds, no invented gap)

Combo #1 stopped out on A4cXNC (−22%) with 1 leg while hnu5 averaged 3 legs and exited in profit. Root cause: invented `addMinGapMs=10m`, tight SL before DCA zone, stale shadow entry, no leader add mirror.

- **`addMinGapMs: 0`** — same as combo-follow; no artificial delay between legs.
- **`slPreDcaPct: 35`** — wide SL while `legs < maxBuyLegs`; −20/−22% only after full DCA.
- **Shadow add mirror:** all hnu5 buy events (`fetchShadowBuyEvents`); `shadow_add` legs before SL/TP in same tick.
- **Fresh shadow entry:** probe only if leader bought within `shadowEntryMaxAgeMs` (3m); signal price from leader fill.
- **DCA band 15–35%** (was 25–32%).
- **combo-follow:** same `slPreDcaPct` pre-DCA SL logic.

**PM2 env:** `PUMPSWAP_COMBO_ADD_MIN_GAP_MS=0`, `PUMPSWAP_COMBO_SL_PRE_DCA_PCT=35`, `PUMPSWAP_COMBO_SHADOW_ADD_ENABLED=1`.

**Откат:** `git checkout sa-alpha-1.11.370 -- src/pumpswap-combo/ src/pumpswap-combo-follow/ ecosystem.config.cjs`; `pm2 reload ecosystem.config.cjs --only pumpswap-combo-bot,pumpswap-combo-follow-paper,pumpswap-combo-follow-live --update-env`.

---

## [1.11.370] — 2026-06-09

**Тег:** `sa-alpha-1.11.370`

### PumpSwap Combo: fix shadow universe (366 was PG-gated)

366 promised hnu5 shadow breadth but shadow mints still required fresh PG snapshots + vol/liq filters — universe stayed ~9 mints.

- **Shadow RPC lane:** hnu5 PumpSwap buys inject watchlist via canonical pool PDA + on-chain spot price — **no PG required**.
- **Discovery relaxed:** PG watchlist fill drops vol5m gate (keeps liq/mcap); shadow PG enrich uses 7d lookback.
- **Shadow entry:** skip probe dip-cap (hnu5 already validated timing).
- **Pool resolve:** canonical PumpSwap PDA fallback chain-wide (buy/sell/exit).

**Откат:** revert `src/pumpswap-combo/` to pre-370; `pm2 reload pumpswap-combo-bot`.

---

## [1.11.369] — 2026-06-09

**Тег:** `sa-alpha-1.11.369`

### PumpSwap Combo #2 follow (paper) + dashboard tile

- **`pumpswap-combo-follow`**: mirror **hnu5** buys/DCA; ladder exits 2% ahead of leader; paper mode with pool-quote marks (no wallet).
- **PM2** `pumpswap-combo-follow-paper` in `ecosystem.config.cjs`.
- **Dashboard** `/papertrader2`: плитка 4 `pumpswap-combo-follow-paper` (journal `data/pumpswap-combo-follow/paper-journal.jsonl`).

**Откат:** `git checkout sa-alpha-1.11.368 -- src/pumpswap-combo-follow/ src/scripts/pumpswap-combo-follow-bot.ts tests/pumpswap-combo-follow/ scripts-tmp/pumpswap-combo-follow-dashboard.ts scripts-tmp/pumpswap-combo-dashboard.ts scripts-tmp/dashboard-server.ts scripts-tmp/dashboard-paper2.html ecosystem.config.cjs`; `pm2 delete pumpswap-combo-follow-paper`; `pm2 reload live-oscar-dashboard ecosystem.config.cjs --update-env`.

---

## [1.11.368] — 2026-06-09

**Тег:** `sa-alpha-1.11.368`

### HL TWAP: short lane (<15m) + instant exit before last slice

- **Short TWAP lane** (1–14m, `HL_TWAP_SHORT_ENABLED=1`): separate schedule + instant flatten at whale slice boundary before last 30s child order.
- Standard lane unchanged (≥16m, chunked exit long 3 / short 10).

**Откат:** `git checkout sa-alpha-1.11.367 -- src/hyperliquid/twap/`; `HL_TWAP_SHORT_ENABLED=0`; `pm2 reload hl-twap-telegram-watch --update-env`.

---

## [1.11.367] — 2026-06-09

**Тег:** `sa-alpha-1.11.367`

### HL TWAP live: side-aware exit slices

- **Long** exits: **3 slices** (`HL_TWAP_LIVE_EXIT_SLICES_LONG`, default 3) — faster than 10× backtest on long book.
- **Short** exits: **10 slices** unchanged (`HL_TWAP_LIVE_EXIT_SLICES=10`).

**Откат:** `git checkout sa-alpha-1.11.366 -- src/hyperliquid/twap/live/ src/scripts/hl-twap-telegram-watch.ts tests/hl-twap-chunked-exit.test.ts`; unset `HL_TWAP_LIVE_EXIT_SLICES_LONG`; `pm2 reload hl-twap-telegram-watch --update-env`.

---

---

## [1.11.367] — 2026-06-09

**Тег:** `sa-alpha-1.11.367`

### PumpSwap Combo: fix shadow universe (366 was PG-gated)

366 promised hnu5 shadow breadth but shadow mints still required fresh PG snapshots + vol/liq filters — universe stayed ~9 mints.

- **Shadow RPC lane:** hnu5 PumpSwap buys inject watchlist via canonical pool PDA + on-chain spot price — **no PG required**.
- **Discovery relaxed:** PG watchlist fill drops vol5m gate (keeps liq/mcap); shadow PG enrich uses 7d lookback.
- **Shadow entry:** skip probe dip-cap (hnu5 already validated timing).
- **Pool resolve:** canonical PumpSwap PDA fallback chain-wide (buy/sell/exit).

**Откат:** `git checkout sa-alpha-1.11.366 -- src/pumpswap-combo/`; `pm2 reload pumpswap-combo-bot`.

---

## [1.11.366] — 2026-06-09

**Тег:** `sa-alpha-1.11.366`

### PumpSwap Combo: hnu5 shadow universe + wider watchlist

- **Watchlist 100** (was 30): top PG vol5m + priority inject from reference wallet recent PumpSwap buys.
- **Shadow lane** (`PUMPSWAP_COMBO_SHADOW_WALLET=hnu5…`): poll signatures ~45s, co-trade entry skips dump-band/freshness for mints hnu5 bought in last 20m (PG filters + probe dip cap remain).
- **`maxConcurrentOpens=8`**: parallel mints like reference bot (was unlimited serial funnel).

**Откат:** `git checkout sa-alpha-1.11.365 -- src/pumpswap-combo/ ecosystem.config.cjs docs/strategy/release/`; `pm2 reload pumpswap-combo-bot`.

---

## [1.11.365] — 2026-06-09

**Тег:** `sa-alpha-1.11.365`

### PumpSwap Combo: live SOL/USD oracle + chain fill accounting

- **`ensureComboSolUsd()`** before boot, each tick, and every buy — fixes undersized legs when Jupiter SOL price ≠ stale $100 default (few tokens for nominal $3).
- **Buy fill from chain:** journal `solSpent`, `solUsdAtFill`, `usdAtMarket`, `tokensReceived`; state leg `usd` = actual USD at fill, not config fiction.
- **`fillPriceUsd`** = `(solSpent × solUsd) / tokens` — matches AMM sell mark basis.

**Откат:** `git checkout sa-alpha-1.11.364 -- src/pumpswap-combo/`; `pm2 reload pumpswap-combo-bot`.

---

## [1.11.364] — 2026-06-09

**Тег:** `sa-alpha-1.11.364`

### PumpSwap Combo: restore module + live dump entry fix

- Re-add `src/pumpswap-combo/` (direct PumpSwap AMM executor, WSOL pools, local Connection sim + skipPreflight) on top of 1.11.363 copy-trader.
- **Entry signal:** probe uses **current dump** `(high_15m − price_now) / high_15m`, not stale max drawdown `(high − low) / high` — fixes bounce buys (e.g. 3KHMZh).
- **Freshness gate:** window low must be ≤ `PUMPSWAP_COMBO_DUMP_FRESHNESS_MS` (default 3m) old.
- PM2 `pumpswap-combo-bot` in ecosystem; deploy script `scripts/ops/pumpswap-combo-deploy.sh` (code only); go-live clears manual halt.

**Откат:** `git checkout sa-alpha-1.11.363 -- src/pumpswap-combo/ ecosystem.config.cjs package.json package-lock.json scripts/ops/pumpswap-combo-*.sh docs/strategy/release/`; `npm install`; `pm2 stop pumpswap-combo-bot`.

---

## [1.11.363] — 2026-06-09

**Тег:** `sa-alpha-1.11.363`

### Copy-trader: suppress tail sweep when leader has Jupiter limit orders

- Before `leader_flat_tail_sweep`, query Jupiter Trigger API (`getTriggerOrders`, `orderStatus=active`, `inputMint`) for the leader wallet.
- If tokens are escrowed in an active sell limit order (wallet ATA = 0 but order remains), **do not** schedule 100% tail sweep; journal `leader_flat_suppressed` with `reason=jupiter_trigger_order_active`.
- Uses existing `JUPITER_API_KEY` (Pro `api.jup.ag`, fallback `lite-api.jup.ag`).

**Откат:** `git checkout sa-alpha-1.11.360 -- src/copytrader/jupiter-trigger-orders.ts src/copytrader/leader-flat-tail-sweep.ts tests/copytrader/jupiter-trigger-orders.test.ts tests/copytrader/leader-flat-tail-sweep.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.360] — 2026-06-09

**Тег:** `sa-alpha-1.11.360`

### Copy-trader: block buys below $1M market cap

- **`COPY_TRADER_MIN_MCAP_USD=1000000`** in prod PM2 env; default in config schema.
- Entry probe, dip leg, and proportional **adds** fail eval when Dex mcap &lt; $1M or mcap missing (`mcap=…<min=1000000` / `mcap_missing_or_zero`).
- **Existing open positions** (e.g. GO) unchanged — sells still mirror leader; no new buys/adds on sub-$1M coins.

**Откат:** `git checkout sa-alpha-1.11.359 -- src/copytrader/config.ts src/copytrader/evaluate.ts tests/copytrader/evaluate.test.ts ecosystem.config.cjs docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.359] — 2026-06-08

**Тег:** `sa-alpha-1.11.359`

### Copy-trader: tail sweep only on confirmed on-chain leader flat

- **`isLeaderFlatForMint`:** no longer treats stale `leaderLedger=0` as flat; requires **two** on-chain zero reads (`COPY_TRADER_LEADER_FLAT_CONFIRM_DELAY_MS`, default 3s).
- **Ledger reconcile:** when on-chain leader balance > ledger, bump ledger up (missed buys) — fixes TOESCOIN-style false tail sweep after partial leader sells (23% + 20% mirrored, then erroneous 100% sweep).
- Journal `leader_flat_tail_sweep` includes `leaderLedgerRaw` for audit.

**Откат:** `git checkout sa-alpha-1.11.358 -- src/copytrader/leader-flat-tail-sweep.ts src/copytrader/config.ts tests/copytrader/leader-flat-tail-sweep.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.358] — 2026-06-08

**Тег:** `sa-alpha-1.11.358`

### Live re-entry gate: RECONCILE_ORPHAN no longer poisons last exit price

- **`RECONCILE_ORPHAN`** после `FLASH_CRASH_KILL` больше не перезаписывает снимок `lastExitMarketSnapshot` ценой `avgEntry` (~+19% vs реальный sell).
- Гейт re-entry берёт **последний partial sell `marketPrice`** и наследует stress-`exitReason` (`FLASH_CRASH_KILL` и др.).
- Ledger PnL reconcile без изменений; правка только в repeat-gate / hybrid dip wait.

**Откат:** `git checkout sa-alpha-1.11.357` на `dip-clones.ts` + `tracker.ts`; `pm2 reload live-oscar`.

---

## [1.11.357] — 2026-06-08

**Тег:** `sa-alpha-1.11.357`

### HL TWAP live: margin $230 per entry (leverage 7x unchanged)

- **`HL_TWAP_LIVE_NOTIONAL_USD`:** default and prod **230** (was 350); position gross ≈ margin × min(coin max lev, 7).
- **`HL_TWAP_LIVE_LEVERAGE=7`** — без изменений.

**Откат:** VPS `HL_TWAP_LIVE_NOTIONAL_USD=350`; `pm2 reload hl-twap-telegram-watch --update-env`.

---

## [1.11.356] — 2026-06-08

**Тег:** `sa-alpha-1.11.356`

### Copy-trader: entry deploy gate uses cost basis, not mark-to-market

- **`entryDeployedCostUsd`:** tracks USD spent on probe + dip legs; proportional adds unlock when cost ≥ 99% of target, not when mtm `sizeUsd` dips after price fall (fixes GO leader adds ignored at `deployedUsd` 690 vs target 950).
- **`resolveEntryDeployedCostUsd`:** legacy open positions infer full staged entry when dip pending is gone.
- Journal `leader_add_ignored` includes `deployedUsdMtm` for audit.

**Откат:** `git checkout sa-alpha-1.11.355 -- src/copytrader/entry-deploy.ts src/copytrader/main.ts src/copytrader/state.ts tests/copytrader/entry-probe.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.355] — 2026-06-08

**Тег:** `sa-alpha-1.11.355`

### HL TWAP: strong-move BTC aligned gate (threshold 1%)

- **`HL_TWAP_BTC_ALIGNED_THRESH_PCT`** (default **1**): block long only when BTC 1h ≤ −T%, short when ≥ +T%; weak moves (|1h| < T) pass — fixes T=0 gate cutting +EV trades on −0.1…−0.5% BTC noise.
- **Prod:** `HL_TWAP_BTC_ALIGNED_GATE=1`, `HL_TWAP_BTC_ALIGNED_THRESH_PCT=1`.

**Откат:** `git checkout sa-alpha-1.11.352 -- src/hyperliquid/twap/twap-btc-gate.ts src/scripts/hl-twap-telegram-watch.ts .env.example tests/hl-twap-btc-gate.test.ts docs/strategy/release/`; VPS `HL_TWAP_BTC_ALIGNED_GATE=0`; `pm2 reload hl-twap-telegram-watch --update-env`.

---

## [1.11.352] — 2026-06-04

**Тег:** `sa-alpha-1.11.352`

### HL TWAP: audit plan matches live schedule gates; BTC aligned gate off on prod

- **`resolveLiveEntryAuditPlan` / `resolvePaperEntryAuditPlan`:** `signals.jsonl` `twap_start.plan` now reflects the same gates as schedule (BTC aligned gate, opposite side, `already_tracked`) — fixes misleading `plan=ok` when live entry blocked.
- **Prod:** set `HL_TWAP_BTC_ALIGNED_GATE=0` (21d EV: gate-opposing trades +$167 vs gate-aligned +$11).

**Откат:** `git checkout sa-alpha-1.11.351 -- src/hyperliquid/twap/live/coin-exposure.ts src/hyperliquid/twap/paper-trader.ts src/scripts/hl-twap-telegram-watch.ts .env.example tests/hl-twap-btc-gate.test.ts docs/strategy/release/`; on VPS `sed -i 's/^HL_TWAP_BTC_ALIGNED_GATE=.*/HL_TWAP_BTC_ALIGNED_GATE=1/' .env`; `pm2 reload hl-twap-telegram-watch --update-env`.

---

## [1.11.351] — 2026-05-28

**Тег:** `sa-alpha-1.11.351`

### Copy-trader: dip must be below probe entry, not only leader −4%

- **`entryDipMaxPriceUsd`:** dip cap = `min(leader × (1 − dip%), probeEntry × (1 − vsProbe%))` when probe leg already filled.
- **`COPY_TRADER_ENTRY_DIP_VS_PROBE_PCT`** (default **2**): second leg only when Jupiter quote is at least 2% below our probe avg entry — fixes GO-style «две ноги по одной цене» when probe fills well below leader.
- Journal `buy_deferred` / confirm reason includes `probe_cap` when probe binding.

**Откат:** `git checkout sa-alpha-1.11.350 -- src/copytrader/entry-probe.ts src/copytrader/evaluate.ts src/copytrader/config.ts src/copytrader/main.ts src/copytrader/entry-dip-gate.ts ecosystem.config.cjs tests/copytrader/entry-probe.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.350] — 2026-05-28

**Тег:** `sa-alpha-1.11.350`

### Live-oscar Wave B: breakeven exit after impulse reset

- **`liveWaveMaxExecutedTpFrac`:** persists max TP grid rung ever executed via partial sell; not cleared by `waveBMaybeResetTpImpulse`.
- **`BREAKEVEN_EXIT`:** eligible at ≤0% avg PnL when historical executed TP ≥ +7.5%, even if ladder marks above +2.5% were reset on pullback (fixes $three-style stuck remainder).
- **Restore:** journal replay + open snapshot backfill from `partial_sell.ladderPnlPct`.

**Откат:** `git checkout sa-alpha-1.11.349 -- src/papertrader/types.ts src/papertrader/executor/exit-policy-wave-b.ts src/papertrader/executor/tracker.ts src/papertrader/executor/store-restore.ts src/live/strategy-snapshot.ts tests/papertrader-exit-policy-wave-b.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.349] — 2026-05-28

**Тег:** `sa-alpha-1.11.349`

### Copy-trader: strict entry dip gate (Jupiter quote + confirm ticks)

- **Dip eval (live/dry_run):** gate uses **Jupiter buy quote** implied price for the dip leg size, not Dex flicker (fixes Bountywork-style fill at probe price).
- **Confirm ticks:** `COPY_TRADER_ENTRY_DIP_CONFIRM_TICKS` (default **2**) — consecutive passes before dip buy.
- **Fix:** dip pending no longer cancelled via `proportional_add_cap` (that check applies to leader adds only).

**Откат:** `git checkout sa-alpha-1.11.347 -- src/copytrader/entry-dip-gate.ts src/copytrader/main.ts src/copytrader/state.ts src/copytrader/config.ts tests/copytrader/entry-dip-gate.test.ts ecosystem.config.cjs docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.347] — 2026-05-28

**Тег:** `sa-alpha-1.11.347`

### Copy-trader: stuck remnants after failed sells / missed leader full exit

- **Sell fraction (без изменений):** частичный sell лидера → пропорциональный наш sell; **100%** кошелька только при полном выходе лидера (`isFullCloseFraction`).
- **Sell retry:** `sim_failed` / `InstructionError` (incl. Jupiter Custom 6024), `quote_stale`, `swap-http-429` — retryable until `sellRetryWindowMs` (aligned with live-oscar sell pipeline).
- **Tail sweep:** leader flat when **on-chain** token balance is zero even if internal ledger is stale (missed poll txs after leader full exit); ledger reconciled, then 100% wallet exit scheduled.
- **`package-lock.json`:** `utf-8-validate@5.0.10` для `npm ci` на Linux (npm 10 / CI / VPS).

**Откат:** `git checkout sa-alpha-1.11.346 -- src/copytrader/pending-sell-retry.ts src/copytrader/leader-flat-tail-sweep.ts tests/copytrader/pending-sell-retry.test.ts tests/copytrader/leader-flat-tail-sweep.test.ts docs/strategy/release/`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.346] — 2026-06-08

**Тег:** `sa-alpha-1.11.346`

### HL TWAP: whale-aligned exit TWAP, faster entry, denylist cleanup

- **Exit TWAP:** chunked reduce-only closes (`HL_TWAP_LIVE_EXIT_SLICES`, default 10×30s) aligned to whale TWAP 30s cycle boundaries (`twapStart + n×interval`); journal `exit_start` / `exit_slice` with crash recovery.
- **Faster entry:** schedule live/paper before Telegram; poll default 2s (`HL_TWAP_POLL_INTERVAL_MS`); open unchanged (single IoC).
- **Denylist:** remove built-in whale block; follow general prod filters; fade env-only override.

**Откат:** `git checkout sa-alpha-1.11.345 -- src/hyperliquid/twap/ src/scripts/hl-twap-telegram-watch.ts tests/hl-twap-*.test.ts .env.example docs/strategy/release/`; prod `.env`: remove `HL_TWAP_LIVE_EXIT_*`, restore `HL_TWAP_POLL_INTERVAL_MS=5000` if desired; `pm2 reload hl-twap-telegram-watch --update-env`.

---

## [1.11.345] — 2026-06-08

**Тег:** `sa-alpha-1.11.345`

### Copy-trader: $950 entry ($350 probe + $600 dip @ −4%)

- **`COPY_TRADER_POSITION_USD=950`** — целевой размер позиции на mint.
- **Probe $350** (`ENTRY_PROBE_FRACTION=350/950`) @ leader+3%; **dip $600** @ leader **−4%** (было $800 / $200 / $600 @ −5%).
- PG grid sim: −4% даёт выше EV и чаще fill dip leg, чем −5%.

**Откат:** `COPY_TRADER_POSITION_USD=800`, `ENTRY_PROBE_FRACTION=0.25`, `ENTRY_DIP_DISCOUNT_PCT=5`; `pm2 reload copy-trader --update-env`.

---

## [1.11.344] — 2026-06-08

**Тег:** `sa-alpha-1.11.344`

### HL TWAP live: actual fills, margin gate, unified account balance

- **Fill accounting:** IoC orders parse HL `filled.totalSz` / `avgPx` and reconcile with exchange `szi` delta; journal logs **actual** notional, not requested.
- **Margin gate:** defer new opens when free collateral &lt; `HL_TWAP_LIVE_NOTIONAL_USD` + reserve; reject micro-fills (&lt;10% requested) with unwind + `open_fill_too_small`.
- **Journal sync:** reconcile `currentNotionalUsd` from exchange `positionValue` after open/TP/DCA when drift &gt;15%.
- **Unified HL account:** margin gate reads USDC from **`spotClearinghouseState`** (canonical balance); perp `clearinghouseState.accountValue` is not used when spot USDC &gt; 0 — fixes false `insufficient_account_margin` with ~$0 free while wallet had USDC.

**Откат:** `git checkout sa-alpha-1.11.343 -- src/hyperliquid/twap/hyperliquid-meta.ts src/hyperliquid/twap/live/`; `pm2 reload hl-twap-telegram-watch --update-env`.

---

## [1.11.343] — 2026-06-07

**Тег:** `sa-alpha-1.11.343`

### Copy-trader: retry quote-failed sells + leader-flat tail sweep

- **`jupiter_sell_quote_failed`** (и `no_quote` / `swap_build:*`) — retryable в окне `sellRetryWindowMs`, как slippage/timeout.
- **Leader-flat tail sweep:** если `leaderLedger` по mint = 0, а в кошельке ещё есть токены и нет pending sell — ставится **100% wallet exit** (`leader_flat_tail_sweep`).
- Full exit sell: `fraction` нормализуется к **1.0** при `leaderSellFraction ≥ 99.9%`.

**Откат:** `git revert` коммита релиза; `pm2 reload copy-trader --update-env`.

---

## [1.11.342] — 2026-06-07

**Тег:** `sa-alpha-1.11.342`

### Copy-trader: abandon dip leg when leader exits early

- Если лидер **продаёт** до полного entry deploy (&lt;99% `positionUsd`), флаг `entryDipAbandoned` — **75% dip leg больше не ставится и не fill’ится**.
- Журнал: `entry_dip_abandoned` / `buy_cancelled` `entry_dip_abandoned`.
- Pending dip по-прежнему снимается на sell; флаг закрывает тему даже после expiry/retry.

**Откат:** `git revert` коммита релиза; `pm2 reload copy-trader --update-env`.

---

## [1.11.341] — 2026-06-07

**Тег:** `sa-alpha-1.11.341`

### Copy-trader: proportional adds after full entry deploy

- **Full-deploy gate:** proportional adds только когда deployed ≥ **99%** `positionUsd` (probe+dip); иначе `entry_not_fully_deployed` даже после expiry dip pending.
- **Add sizing:** доля add считается от **target `positionUsd`**, не от текущего stack (~$200 probe).
- **Add price gate:** `evaluateCopyAdd` — не выше цены add лидера (`COPY_TRADER_ADD_PRICE_MAX_PREMIUM_PCT=0`), без +3% chase.

**Откат:** `git revert` коммита релиза; `pm2 reload copy-trader --update-env`.

---

## [1.11.340] — 2026-06-07

**Тег:** `sa-alpha-1.11.340`

### Copy-trader: split entry probe 25% + dip leg −5%

- **Entry probe:** 25% позиции (`COPY_TRADER_ENTRY_PROBE_FRACTION`) входит в коридоре **+3%** к цене лидера (как раньше).
- **Dip leg:** оставшиеся 75% ждут цену **≤ лидер −5%** (`COPY_TRADER_ENTRY_DIP_DISCOUNT_PCT`), затем добирают в ту же позицию.
- Журнал: `entry_dip_scheduled`, `entryLeg` на `leader_buy_scheduled`.

**Откат:** `git revert` коммита релиза; `COPY_TRADER_ENTRY_PROBE_FRACTION=1` (полный mirror3); `pm2 reload copy-trader --update-env`.

---

## [1.11.339] — 2026-06-07

**Тег:** `sa-alpha-1.11.339`

### Ops: live-oscar + copy-trader — billable RPC back to QuickNode

- **`SOLANA_RPC_HELIUS_PREFER: 0`** для `live-oscar` и `copy-trader` — send/sim/balance/poll снова через платный QuickNode (`SA_RPC_HTTP_URL` в `.env`).
- **`SOLANA_RPC_HELIUS_FALLBACK_ENABLED: 1`** — Helius остаётся запасным при локальном QN budget block.

**Откат:** `SOLANA_RPC_HELIUS_PREFER=1`; `pm2 reload ecosystem.config.cjs --only live-oscar,copy-trader --update-env`.

---

## [1.11.338] — 2026-05-27

**Тег:** `sa-alpha-1.11.338`

### Live Oscar: post-close tail only — periodic self-heal off

- **`LIVE_PERIODIC_SELF_HEAL_MS: 0`** — больше нет повторных проверок хвостов каждые 30 мин по mint из `closed[]`.
- Остаётся **одна** проверка после `live_position_close` через **`LIVE_POST_CLOSE_TAIL_SWEEP_DELAY_MS`** (60 с): баланс → `sell_full` → стоп.

**Откат:** `LIVE_PERIODIC_SELF_HEAL_MS=1800000`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.337] — 2026-05-27

**Тег:** `sa-alpha-1.11.337`

### Fix: dashboard `/papertrader2` — вернуть 3 плитки

- **Плитки:** Live Oscar · Copy Trader · HL TWAP (было 6: + paper risky, DCA live, V2.1, V2.2).
- Восстановлены `dashboard-server.ts`, `dashboard-paper2.html`, `src/hyperliquid/twap/dashboard-aggregate.ts`.

**Откат:** revert commit; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

---

## [1.11.336] — 2026-05-27

**Тег:** `sa-alpha-1.11.336`

### Live Oscar: sizing — сплит $300+$300, DCA ×$200

| Параметр | Было | Стало |
|---|---|---|
| Entry split (2 ноги) | $150 + $150 | **$300 + $300** |
| DCA −10% / −20% | $100 | **$200** |
| Max на mint | $500 | **$1000** |

**Откат:** `LIVE_OSCAR_ENTRY_NOTIONAL_USD=300`, `LIVE_OSCAR_MAX_POSITION_USD=500`, split legs `150`; `pm2 reload live-oscar --update-env`.

---

## [1.11.335] — 2026-05-27

**Тег:** `sa-alpha-1.11.335`

### Fix: live-oscar crash + re-entry 4h + BTC recovery + signal-kill off

| Область | Изменение |
|---|---|
| Signal-kill | `PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT: 0` (было `99` — валидатор max 95, процесс падал) |
| Re-entry | dip **−12%**, гейт **4 ч** (`LIVE_REENTRY_GATE_MAX_AGE_HOURS`), без timer-fallback |
| BTC gate | **72h/peak выкл.**; при `ret1h ≥ 0` — только 1h+4h (`LIVE_BTC_RECOVERY_*`) |

**Откат:** revert commit; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.334] — 2026-05-27

**Тег:** `sa-alpha-1.11.334`

### Live Oscar: Wave B + entry soften + signal-kill off

| Параметр | Было | Стало |
|---|---|---|
| Exit policy | Variant A v2 | **Wave B v1** (`WAVE_B=1`, `VARIANT_A=0`) |
| `PAPER_POST_MIN_BS` | 0.98 | **0.95** |
| `PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT` | −10% | **−7%** |
| `PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT` | 25 (signal-kill) | **99** (выкл) |

**Контекст:** PG-replay 30d — Wave B > Variant A; signal-kill −25% от цены сигнала давал ранние `KILLSTOP` (не timeout 48h). BS/knife — смягчение entry-фильтров по sweep.

**Деплой:** `git fetch origin v2 && git reset --hard origin/v2 && npm ci && pm2 reload ecosystem.config.cjs --update-env` (от `salpha` в `/opt/solana-alpha`).

**Откат:** `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=0`, `PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A=1`, `PAPER_POST_MIN_BS=0.98`, `PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT=-10`, `PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT=25`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.318] — 2026-05-28

### Fix: copy-trader ghost clears + wallet-based mirror sells

- **Ghost reconcile:** 5‑min grace after entry + retry RPC before clearing state (false `wallet_balance_zero` right after buy).
- **Mirror sells/buys:** proportional % from execution-wallet SPL balance; leader sells scheduled even without state row.

**Откат:** revert `src/copytrader/main.ts`, `position-reconcile.ts`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.317] — 2026-06-05

### Live Oscar prod tier (mcap ≥ $3M): relaxed dip/vol for near-miss runners

- **Prod phase only** (`mcap ≥ PAPER_LIVE_OSCAR_LOW_MCAP_MAX_USD`): dip **−18%**, vol1h **≥ $25k** (`PAPER_LIVE_OSCAR_PROD_MCAP_*`).
- **Low tier $1.3M–$3M** без изменений: dip **−30%**, vol1h **≥ $75k**.

**Откат:** unset `PAPER_LIVE_OSCAR_PROD_MCAP_DIP_MIN_DROP_PCT` / `VOL_1H_MIN_USD` or restore `−20` / `36000`; `pm2 reload live-oscar --update-env`.

---

## [1.11.316] — 2026-06-05

### Live: CARDS denylist + BTC gate level 2

- **CARDS** (`CARDSccUMFKo…`) в `live-oscar-permanent-denylist.seed.txt` — permanent block повторных входов.
- **BTC gate level 2** (`buy_open` only): пороги **1h −1%**, **4h −2.5%**, **24h −2%**, **72h −6%**, **от пика 72h −6%** (Binance 1h klines, 73 свечи). Env: `LIVE_BTC_BLOCK_*_DRAWDOWN_PCT`.

**Откат:** убрать CARDS из seed; вернуть level-1 пороги (`1H=2.5`, `4H=5`, `24H/72H/PEAK=0`); `pm2 reload live-oscar --update-env`.

---

## [1.11.314] — 2026-05-28

### Copy-trader: $800 entry + wallet balance as source of truth

- **`COPY_TRADER_POSITION_USD`**: первый вход **600 → 800** (default + `ecosystem.config.cjs`).
- **Пропорциональные докупки и зеркальные продажи** считают долю от **фактического** SPL-баланса execution-кошелька (ручные buy/sell учитываются).
- После buy/sell state **`sizeUsd` / `tokenRaw`** синхронизируется с RPC; продажа лидера ставится в очередь даже без строки в state, если на кошельке есть токены.

**Откат:** `COPY_TRADER_POSITION_USD=600`; revert `src/copytrader/main.ts`, `position-reconcile.ts`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.315] — 2026-06-05

### Live: sizing 2×$150 entry + DCA $100

- `PAPER_POSITION_USD=300` (split $150+$150); `PAPER_DCA_LEVELS` → $100/step; `LIVE_MAX_POSITION_USD=500`.

**Откат:** restore 1.11.314 sizing in `ecosystem.config.cjs`; `pm2 reload live-oscar --update-env`.

---

## [1.11.314] — 2026-06-05

### Live: loss exit → permanent denylist; sizing 2×$350 + DCA $150

- **`LIVE_NEGATIVE_TRADE_DENY_ENABLED=1`**, **`LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED=0`**: любой убыточный полный выход → mint в `live-oscar-permanent-denylist.txt` (вместо 6h cooldown).
- **`LIVE_MINT_LOSS_REENTRY_COOLDOWN_ENABLED=0`** — cooldown снят.
- Entry split **$350+$350** (`PAPER_POSITION_USD=700`); DCA **$150** на ступень (`PAPER_DCA_LEVELS` 0.214286); cap **`LIVE_MAX_POSITION_USD=1000`**.

**Откат:** `LIVE_NEGATIVE_TRADE_DENY_ENABLED=0`, `LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED=1`; restore $1500/$400 sizing; `pm2 reload live-oscar --update-env`.

---

## [1.11.313] — 2026-06-05

### Live: falling-knife re-entry protection (loss cooldown + stricter hybrid)

- **`LIVE_MINT_LOSS_REENTRY_COOLDOWN_*`**: after loss or stress exit (`FLASH_CRASH_KILL`, `SL`, …) block `buy_open` on same mint for 6h; 2 losses in 24h → 24h cooldown.
- **`LIVE_REENTRY_LOSS_MIN_DROP_FROM_LAST_EXIT_PCT`**: after loss, hybrid re-entry requires ≥30% dip from last exit (not 20%).
- **`LIVE_REENTRY_HYBRID_DISABLE_TIMER_AFTER_LOSS`**: after loss, no 20m timer fallback — price dip only.

**Откат:** set `LIVE_MINT_LOSS_REENTRY_COOLDOWN_ENABLED=0`; restore prior hybrid env; `pm2 reload live-oscar --update-env`.

---

## [1.11.312] — 2026-06-05

### Discovery: exclude mcap > $50M from pool and eval

- `PAPER_DISCOVERY_MAX_MARKET_CAP_USD: 50000000` — SQL snapshot, inject tiers, dip eval skip PG on large caps.
- Open positions remain on discovery pin (exempt) so exits/tracker keep working.

**Откат:** unset `PAPER_DISCOVERY_MAX_MARKET_CAP_USD` or set `0`; `pm2 reload live-oscar --update-env`.

---

## [1.11.311] — 2026-06-04

### Fix: copy-trader dashboard PnL (no bogus $100k+ unrealized)

- Open PnL: **price-only** for copy-trader (disable mcap fallback that compared token price ~$0.001 to live mcap ~$500k).
- Cost basis for unrealized: **remaining** notional (`totalInvested × remainingFraction`).
- Closed/timeline: prefer **`pnlPct` from journal** on `copy_sell` rows.

**Откат:** revert `scripts-tmp/copytrader-dashboard.ts` + `dashboard-server.ts`; `pm2 reload live-oscar-dashboard`.

---

## [1.11.310] — 2026-06-04

### Feat: copy-trader — no add/position caps; auto-clear ghost state

| Env `0` | = unlimited |
|---------|-------------|
| `COPY_TRADER_MAX_ADDS_PER_MINT` | 0 |
| `COPY_TRADER_MAX_OPEN_POSITIONS` | 0 |
| `COPY_TRADER_MAX_POSITION_USD` | 0 |
| `COPY_TRADER_MIN_PROPORTIONAL_*` | 0 |

- RPC reconcile: drop `state.positions[mint]` when execution wallet balance = 0 (`position_closed_wallet_empty`).
- `no_token_balance` on sell → close position in state (no ghost retries).

**Откат:** restore caps (adds=3, max pos $6000, open=5); `pm2 reload copy-trader --update-env`.

---

## [1.11.309] — 2026-06-04

### Risk: live-oscar flash-crash kill (aggressive) + LIQ_DRAIN 25%

- **Flash crash kill** (`PAPER_FLASH_CRASH_KILL_*`): velocity exits (−6%/30s, −8%/60s, −12%/3m), post-fill guard after last buy leg (−5%/2m → 75% partial, −7%/3m → full), quote divergence gate; DCA blocked 5m after trigger. Journal reason `FLASH_CRASH_KILL`.
- **LIQ_DRAIN:** `PAPER_LIQ_WATCH_DRAIN_PCT` **35 → 25** (раньше выход при просадке ликвидности от entry).
- Blacklist: GACHA mint `DnnmrZnCTqQn7bYbVAiWdJLreqrhg7HaSTkmhtzu8THy`.

**Откат:** `git revert` коммита 1.11.309; на VPS `git reset --hard` на предыдущий SHA + `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.308] — 2026-06-03

### Fix: discovery SQL — min mcap filter (регресс 1.11.307)

- В CTE `eligible` колонки `fdv_usd` нет (fdv уже в `market_cap_usd` из SELECT) — фильтр `COALESCE(market_cap_usd, fdv_usd, 0)` ломал **каждый** discovery tick (`column "fdv_usd" does not exist`), входы = 0.
- Исправлено: `COALESCE(market_cap_usd, 0) >= min` в `snapshot.ts` и `smart-lottery.ts`.

**Откат:** revert commit 1.11.308 (не рекомендуется — discovery снова падает).

---

## [1.11.307] — 2026-06-03

### Fix: Live Oscar mcap tier — $3M снова prod, SQL mcap с fdv

- **Регресс 1.11.306:** при mcap **ровно $3M** монета попадала в **low** (−30% / vol1h $75k) вместо **prod** (−20% / $36k) — основной коридор Oscar «замолкал» на границе.
- SQL discovery: `COALESCE(market_cap_usd, fdv_usd, 0)` в фильтре min mcap (как в SELECT), чтобы не отбрасывать пары с fdv-only.

**Откат:** cherry-pick revert или вернуть `<=` в `resolveLiveOscarMcapTier` (не рекомендуется).

---

## [1.11.306] — 2026-06-03

### Feat: Live Oscar — двухфазный mcap (узкий коридор $1.3M–$3M)

| Зона mcap | Вход | Размер |
|-----------|------|--------|
| **$1.3M–$3M** (mcap **<** $3M) | dip ≤ **−30%**, vol1h ≥ **$75k**, остальные post-гейты как prod | 2×**$400**, DCA **$300**/ступень (−10/−20) |
| **≥ $3M** | **без изменений** (dip −20%, vol1h $36k, 2×$750, DCA $400) | как было |

- SQL-пул discovery: min mcap **$1.3M** (`PAPER_DISCOVERY_MIN_MARKET_CAP_USD`).
- Выходы (TP grid, trail, Variant A v2) — **общие** для обеих фаз.

**Код:** `live-oscar-mcap-tier.ts`, `dip-clones.ts`, `main.ts`, `live-staged-entry-gates.ts`, `tracker.ts`, `ecosystem.config.cjs`.

**Откат:** `PAPER_LIVE_OSCAR_LOW_MCAP_LANE_ENABLED=0`, `PAPER_DISCOVERY_MIN_MARKET_CAP_USD=3000000`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.305] — 2026-06-03

### Feat: copy-trader — $600 entry, proportional adds/sells unchanged

| Параметр | Было | Стало |
|----------|------|-------|
| `COPY_TRADER_POSITION_USD` | 300 | **600** |
| `COPY_TRADER_MAX_POSITION_USD` | 3000 | **6000** (10× entry) |
| `COPY_TRADER_MIN_PROPORTIONAL_ADD_USD` | 9 | **18** (~3% entry) |

Первый вход — фикс **$600**. Добавки: `ourAddUsd = ourSizeUsd × (leaderBuy / leaderPreBalance)`. Продажи: доля нашего кошелька = `leaderSell / leaderPreBalance` на каждой tx лидера.

**Код:** `ecosystem.config.cjs`, `src/copytrader/config.ts` (defaults).

**Git-тег:** `sa-alpha-1.11.305`

**Откат:** `COPY_TRADER_POSITION_USD=300`, `COPY_TRADER_MAX_POSITION_USD=3000`, `COPY_TRADER_MIN_PROPORTIONAL_ADD_USD=9`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.304] — 2026-06-03

### Feat: Live Oscar — thin-volume flush after first TP (Variant A v2)

После **первого partial TP**, если рынок «высох» по PG (`vol5m < $20k` и `< 50%` от vol5m на входе) **2 тика подряд**, и по **Jupiter MTM** уже был **пик ≥ +8%**, сейчас **≥ +2.5%** — бот **продаёт весь остаток** (`THIN_VOL_FLUSH`). Цель: не сидеть в мёртвом объёме после фиксации (SQUIRE-class), без агрессивного `vol5m<20k + PnL≥+5%` (режет луны).

| Параметр | Значение |
|----------|----------|
| Env | `PAPER_LIVE_OSCAR_THIN_VOL_EXIT_ENABLED=1` |
| Политика | только `variant_a_v2` (новые и in-flight v2) |
| Partial reason | `THIN_VOL_FLUSH` |

**Код:** `exit-policy-variant-a.ts`, `tracker.ts`, `pricing.ts` (`fetchLatestSnapshotQuote`), `open.ts`, `config.ts`, `strategy-snapshot.ts`, `store-restore.ts`, `ecosystem.config.cjs`.

**Git-тег:** `sa-alpha-1.11.304`

**Откат:** `PAPER_LIVE_OSCAR_THIN_VOL_EXIT_ENABLED=0`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.303] — 2026-06-02

### Ops: SPCX обратно в whitelist, снят с blacklist

`E6ifp2mJy8cYQehUGUtFvrXriRKxRuonLmrvTFypump` (SPCX): добавлен в `live-oscar-mint-whitelist.txt` и risky-зеркало; удалён из `live-oscar-mint-blacklist.txt` и risky-blacklist.

**Git-тег:** `sa-alpha-1.11.303`

**Откат:** убрать mint из whitelist; при необходимости вернуть строку в blacklist; на VPS проверить `live-oscar-permanent-denylist.txt`.

---

## [1.11.299] — 2026-06-02

### Fix: copy-trader retry sells on slippage (0x1771) until fill

При slippage-class ошибке продажа остаётся в очереди: повтор каждые **6 с** до **2 ч** (`COPY_TRADER_SELL_RETRY_*`), без ожидания следующей продажи лидера; slippage bps **не** поднимается.

Журнал: `sell_deferred`, `sell_expired`, `sell_failed`.

**Git-тег:** `sa-alpha-1.11.299`

**Откат:** revert; `pm2 reload copy-trader --update-env`.

---

## [1.11.302] — 2026-06-02

### Fix: copy-trader retry sells on confirm_timeout (RKC-class)

Расширен `isSellRetryableError`: кроме slippage (`0x1771`) повторяются **`confirm_timeout`** и transient `send_failed` (429/timeout) — та же очередь 6 с / 2 ч.

**Git-тег:** `sa-alpha-1.11.302`

**Откат:** revert; `pm2 reload copy-trader --update-env`.

---

## [1.11.301] — 2026-06-02

### Tune: Live Oscar max position $3000 per mint

`LIVE_MAX_POSITION_USD` **2300 → 3000** — второй DCA (−20%, +$400) возможен после первого ($1900 invested).

**Git-тег:** `sa-alpha-1.11.301`

**Откат:** `git checkout sa-alpha-1.11.300 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.300] — 2026-06-02

### Fix: Live Oscar v2 TP grid — `PROFILE=0` ломал продажи на +5%/+10%

**Проблема:** `PAPER_TP_GRID_SELL_FRACTION_PROFILE: '0'` парсится как массив `[0]` → **0%** остатка на всех ступенях сетки. На +10% не было первого TP (10% остатка), только trail на откате.

**Исправление:** профиль **пустой** → flat `PAPER_TP_GRID_SELL_FRACTION=0.10` на каждой ступени, как в 1.11.270.

**Git-тег:** `sa-alpha-1.11.300`

**Откат:** `git checkout sa-alpha-1.11.299 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.298] — 2026-05-27

### Revert: PR #52 v2 hybrid harvest + harvest scratch re-entry (полный откат)

**Причина:** неудачный эксперимент; откат «1.11.296» в чате снял только env-отключение, PR #52 остался в коде и на VPS.

**Убрано:** `HYBRID_HARVEST_*` partials, harvest lock после TP +5%, `harvest_reentry` в dip-clones, `LIVE_MINT_SCRATCH_REENTRY` (снова `0`).

**Восстановлено:** variant_a_v2 grid + defensive trail @+10% без harvest-ветки (состояние до `556458e`).

**Git-тег:** `sa-alpha-1.11.298`

**Откат:** `git checkout sa-alpha-1.11.297 -- .`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.297] — 2026-06-01

### Tune: copy-trader buy delay 30s, price gate +3%

| Параметр | Было | Стало |
|----------|------|-------|
| `COPY_TRADER_BUY_DELAY_MS` | 120000 (2 мин) | **30000 (30 сек)** |
| `COPY_TRADER_BUY_PRICE_MAX_PREMIUM_PCT` | 2 | **3** |

**Git-тег:** `sa-alpha-1.11.297`

**Откат:** `git checkout sa-alpha-1.11.296 -- ecosystem.config.cjs src/copytrader/config.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.296] — 2026-06-01

### Tune: copy-trader $300 entry, proportional mirror for adds/sells

| Параметр | Было | Стало |
|----------|------|-------|
| `COPY_TRADER_POSITION_USD` | 100 | **300** |
| Adds | cap $30/add | **пропорционально лидеру** (доля стека × наш размер, до `MAX`) |
| `COPY_TRADER_MAX_POSITION_USD` | 190 | **3000** |
| `COPY_TRADER_MIN_PROPORTIONAL_ADD_USD` | 3 | **9** |

Продажи по-прежнему зеркалят долю лидера; первый вход фикс $300.

**Git-тег:** `sa-alpha-1.11.296`

**Откат:** `git checkout sa-alpha-1.11.295 -- ecosystem.config.cjs src/copytrader/main.ts src/copytrader/config.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.295] — 2026-06-01

### Fix: Live Oscar v2 harvest — только когорта +5% без +10%, TP grid не блокируется

**Проблема:** после PR #52 harvest включался сразу после mark +5% и отключал TP-сетку/trail даже когда цена доходила до +10%.

**Поведение (минимальное):**

| Условие | Действие |
|---------|----------|
| Пик ≥ +5%, никогда не было +10%, откат к +2.5% | Продать 50% остатка |
| Та же когорта, откат к 0% vs avg | Закрыть остаток |
| После полного harvest-exit | Re-entry при −5% от avg (как было) |
| Дошли до +10% | Обычные grid + defensive trail, **без** harvest |

**Код:** `variantAHybridHarvestCohort` / `variantAHybridHarvestActive` (pullback ≤ +5%), снята блокировка TP grid в `tracker.ts`, A/B скрипт `scripts-tmp/live-oscar-harvest-ab-14d.ts` (честное сравнение: один `PROFILE=0`, закрытые сделки журнала).

**Git-тег:** `sa-alpha-1.11.295`

**Откат:** `git checkout sa-alpha-1.11.294 -- src/papertrader/executor/exit-policy-variant-a.ts src/papertrader/executor/tracker.ts src/papertrader/types.ts tests/papertrader-exit-policy-variant-a.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 restart live-oscar`.

---

## [1.11.294] — 2026-06-01

### Fix: copy-trader poll RPC (Helius instead of broken QuickNode SSL)

Copy-trader used `SA_RPC_HTTP_URL` (QuickNode) for leader wallet polling; on VPS QuickNode HTTPS fails with TLS alert → `getSignaturesForAddress` returned empty silently and journal froze for ~10h while leader made new buys.

- `loadCopyTraderConfig`: `COPY_TRADER_RPC_URL` → `liveOscarRpcHttpUrlFromEnv()` (Helius when `SOLANA_RPC_HELIUS_PREFER=1`) → `resolveSolanaRpcUrl()`.
- Poll logs `[copy-trader] poll: getSignaturesForAddress failed` at most 1×/min when RPC errors (vs empty wallet).
- PM2 `copy-trader`: `SOLANA_RPC_HELIUS_PREFER=1`, `SOLANA_RPC_HELIUS_FALLBACK_ENABLED=1`.

**Git-тег:** `sa-alpha-1.11.294`

**Откат:** revert commit; `pm2 reload copy-trader --update-env`; or set `COPY_TRADER_RPC_URL` to a working endpoint.

---

## [1.11.293] — 2026-05-28

### Tune: Live Oscar priority discovery BS 0.75

| Параметр | Было | Стало |
|----------|------|-------|
| `PAPER_PRIORITY_DISCOVERY_MIN_BS` | 0.85 | **0.75** |

`PAPER_POST_MIN_BS` (0.98) и TP-grid (Variant A v2) **без изменений**.

**Git-тег:** `sa-alpha-1.11.293`

**Откат:** `git checkout sa-alpha-1.11.292 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.292] — 2026-05-28

### Tune: copy-trader sizing $100 entry / $30 add cap

| Параметр | Было | Стало |
|----------|------|-------|
| `COPY_TRADER_POSITION_USD` | 50 | **100** |
| `COPY_TRADER_ADD_POSITION_USD` | 15 (только лог) | **30** — потолок одного усреднения |
| `COPY_TRADER_MAX_POSITION_USD` | 95 | **190** (100 + 3×30) |

Пропорциональный add лидера ограничен `min(room, ADD_POSITION_USD)`.

**Git-тег:** `sa-alpha-1.11.292`

**Откат:** `git checkout sa-alpha-1.11.291 -- ecosystem.config.cjs src/copytrader/config.ts src/copytrader/main.ts .env.example docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.291] — 2026-05-28

### Fix: Copy Trader dashboard — stale cycles vs open positions

**Контекст:** после закрытия SHIKOKU/WORLDCUP в «Copy cycles» оставались строки `pending_our_buy` (лидер перезаходил, мы skip) — выглядело как дубль с Recent closes и «висящая» позиция.

| Поведение | Было | Стало |
|-----------|------|-------|
| Циклы после `buy_skipped` + новый leader buy | `pending_our_buy` навсегда | **`missed`**, не показываются без очереди в state |
| Список cycles | все leader buy подряд | **compact**: closed + только mint из `pendingBuys` |
| Open positions | journal-only | без изменений — **open=[]** когда продано (как в state) |

**Git-тег:** `sa-alpha-1.11.291`

**Откат:** `git checkout sa-alpha-1.11.290 -- scripts-tmp/copytrader-dashboard.ts scripts-tmp/dashboard-paper2.html tests/copytrader/dashboard-load.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

---

## [1.11.290] — 2026-05-28

### Feat: Copy Trader dashboard — cycles + Solscan on leader orders

**Контекст:** на плитке Copy Trader нужно видеть полные циклы (leader buy → our mirror → leader sell → our exit) и ссылки Solscan на **ордер лидера**, а не только на наш swap.

| Поведение | Было | Стало |
|-----------|------|-------|
| Solscan в timeline | одна ссылка на **наш** `txSignature` | **Leader order** (`leaderSignature`) + **Our tx** (если был fill) |
| Циклы | нет | секция **Copy cycles** с leader buy/sell и статусом |
| `copy_sell` journal | `exitPriceUsd` = USD proceeds (баг) | per-token price в `live-exec.ts`; dashboard нормализует legacy rows |

**Код:** `scripts-tmp/copytrader-dashboard.ts`, `dashboard-server.ts`, `dashboard-paper2.html`, `src/copytrader/live-exec.ts`, `tests/copytrader/dashboard-load.test.ts`.

**Git-тег:** `sa-alpha-1.11.290`

**Откат:** `git checkout sa-alpha-1.11.289 -- scripts-tmp/copytrader-dashboard.ts scripts-tmp/dashboard-server.ts scripts-tmp/dashboard-paper2.html src/copytrader/live-exec.ts tests/copytrader/dashboard-load.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard,copy-trader --update-env`.

---

## [1.11.289] — 2026-05-30

### Feat: papertrader2 — Copy Trader panel (replaces Live Oscar Risky)

**Контекст:** на `/papertrader2` вторая плитка показывала устаревший Live Oscar Risky; execution wallet теперь занят PM2 `copy-trader`.

| Поведение | Было | Стало |
|-----------|------|-------|
| Плитка 2 | Live Oscar Risky (старый jsonl) | **Copy Trader** — `data/copytrader/journal.jsonl` |
| Метрики | Oscar exits / reconcile | **buys OK/fail**, **sells OK/fail**, pending queue, timeline с Solscan |
| Header wallet | Wallet Risky | **Copy Trader** (тот же `HoFKB…`) |

**Код:** `scripts-tmp/copytrader-dashboard.ts`, `dashboard-server.ts`, `dashboard-paper2.html`, `ecosystem.config.cjs`.

**Git-тег:** `sa-alpha-1.11.289`

**Откат:** `git checkout sa-alpha-1.11.288 -- scripts-tmp/dashboard-server.ts scripts-tmp/dashboard-paper2.html scripts-tmp/copytrader-dashboard.ts ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only live-oscar-dashboard --update-env`.

---

## [1.11.288] — 2026-05-30

### Feat: copy-trader — stop buy retries when leader starts exiting

**Контекст:** pending entry/add продолжали retry после того, как лидер уже начал фиксировать прибыль или убыток (частичная продажа). Покупка «в хвост» выхода лидера нежелательна.

| Поведение | Было | Стало |
|-----------|------|-------|
| Лидер продал ≥ min sell fraction | pending entry отменялся только при **полном** выходе без нашей позиции | **entry + add** снимаются с очереди (`leader_started_exit`) |
| Retry loop | до gate pass / expiry | + проверка `leaderHoldingsRawAtSignal` vs ledger — если баланс лидера **уменьшился**, buy/add **отменяется** |

**Код:** `src/copytrader/main.ts`, `pending-buy-retry.ts`, `state.ts`.

**Git-тег:** `sa-alpha-1.11.288`

**Откат:** `git checkout sa-alpha-1.11.287 -- src/copytrader/ docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `npm ci`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.287] — 2026-05-30

### Feat: copy-trader — retry pending buys until gates pass

**Контекст:** после 2‑мин задержки одна неудачная проверка price gate (`buy_skipped`) навсегда снимала очередь — WORLDCUP и др. пропускались, хотя цена могла вернуться в допуск.

| Поведение | Было | Стало |
|-----------|------|-------|
| Eval/exec fail после `dueTs` | `buy_skipped`, очередь удалена | `buy_deferred`, **retry каждые ~2s** |
| Окно retry | — | **2 ч** после первой попытки (`COPY_TRADER_BUY_RETRY_WINDOW_MS=7200000`) |
| Лидер полностью вышел | — | pending entry **отменяется** (`buy_cancelled`) |
| Истёк retry window | — | `buy_expired` |

**Код:** `src/copytrader/pending-buy-retry.ts`, `main.ts`, `state.ts`, `config.ts`.

**Git-тег:** `sa-alpha-1.11.287`

**Откат:** `git checkout sa-alpha-1.11.286 -- src/copytrader/ ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `npm ci`; `pm2 reload ecosystem.config.cjs --only copy-trader --update-env`.

---

## [1.11.286] — 2026-05-29

### Feat: copy-trader — stealth mirror лидера (PM2, live risky wallet)

**Контекст:** отдельный процесс `copy-trader` копирует сделки лидера (`498SWf…` / `data/copytrader/target-wallet.txt`) на кошелёк `live-oscar-risky` (`HoFKB…`), **изолирован** от `live-oscar`.

| Поведение | Значение |
|-----------|----------|
| Первый вход | фикс **$50** (`COPY_TRADER_POSITION_USD`) |
| Усреднение | **пропорционально** лидеру: add = наш notional × (купил_лидер / был_у_лидера) |
| Продажа | **тот же %** позиции, что продал лидер (partial + full) |
| Задержка buy | **2 мин** (`COPY_TRADER_BUY_DELAY_MS=120000`) |
| Задержка sell | 20–30 с (stealth jitter) |
| Price gate | ≤ leader + 2% на момент исполнения buy |

**Код:** `src/copytrader/*`, `src/scripts/copy-trader.ts`, `src/parser/allowlisted-dex-swap.ts`, PM2 `copy-trader` в `ecosystem.config.cjs`, тесты `tests/copytrader/*`.

**State:** `data/copytrader/state.json` (+ `leaderLedger` per mint), journal `data/copytrader/journal.jsonl`.

**Git-тег:** `sa-alpha-1.11.286`

**VPS (после merge в `v2` или с ветки `feature/copy-trader-stealth`):**

```bash
cd /opt/solana-alpha
git fetch origin feature/copy-trader-stealth   # или v2 после merge
git reset --hard <SHA>
npm ci
pm2 start ecosystem.config.cjs --only copy-trader --update-env   # первый запуск
# или: pm2 reload ecosystem.config.cjs --only copy-trader --update-env
pm2 save
bash scripts/release/post-deploy-smoke.sh
```

Убедиться: `data/copytrader/target-wallet.txt`, `data/live/live-oscar-risky.keypair.json` (chmod 600).

**Откат (полный — выключить copy-trader, вернуть дерево до релиза):**

```bash
pm2 stop copy-trader
pm2 delete copy-trader
pm2 save
git fetch origin v2
git reset --hard sa-alpha-1.11.285   # или SHA до merge copy-trader
npm ci
pm2 reload ecosystem.config.cjs --update-env
```

**Откат (частичный — только логика copy-trader, процесс оставить на старой версии модуля):**

```bash
git checkout sa-alpha-1.11.285 -- src/copytrader/ src/scripts/copy-trader.ts src/scripts/copy-trader-doctor.ts src/parser/allowlisted-dex-swap.ts tests/copytrader/ ecosystem.config.cjs
npm ci
pm2 reload ecosystem.config.cjs --only copy-trader --update-env
```

Journal/state copy-trader (`data/copytrader/*`) при откате можно сохранить или удалить — на `live-oscar` не влияет.

---

## [1.11.285] — 2026-05-27

### Fix: live-oscar billable RPC on Helius (`SOLANA_RPC_HELIUS_PREFER`)

**Контекст:** Helius dashboard 0 credits при активных buy/sell — fallback срабатывал только при локальном QN budget block; у live-oscar caps выключены, все `qnCall` шли на QuickNode.

| Env | Эффект |
|-----|--------|
| `SOLANA_RPC_HELIUS_PREFER=1` | `liveRpcHttpUrl` → Helius; send/simulate/confirm/balance без QN meter |
| `SA_RPC_HTTP_URL` | Без изменений (discovery, holders, ingest) |

**Откат:** `SOLANA_RPC_HELIUS_PREFER=0`; `pm2 reload live-oscar --update-env`.

---

## [1.11.284] — 2026-05-27

### Ops: Helius RPC fallback (QuickNode остаётся primary)

**Контекст:** биллинг QuickNode может исчерпать месячный пул; локальный `solana-rpc-meter` / `qn-feature` режет `qnCall` с `reason: budget`. Live Oscar должен продолжать simulate/send/balance через запасной RPC.

| Компонент | Поведение |
|-----------|-----------|
| Primary | `SA_RPC_HTTP_URL` → `QUICKNODE_HTTP_URL` → `SOLANA_RPC_HTTP_URL` (без замены QuickNode в `.env`) |
| Fallback | `HELIUS_RPC_URL` или `HELIUS_API_KEY`; `SOLANA_RPC_HELIUS_FALLBACK_ENABLED=1` на `live-oscar` |
| `qn-client` | При `budget` после reserve — повтор того же JSON-RPC на Helius (без списания QN meter) |

**Документация:** `.env.example`, `deploy/RUNTIME.md`, `RUNBOOK_LIVE_OSCAR_PHASE7.md` §0.3.

**VPS:** в `/opt/solana-alpha/.env` добавить `HELIUS_API_KEY=…` (секрет не в git); `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

**Откат:** `git checkout sa-alpha-1.11.283 -- src/core/rpc/ ecosystem.config.cjs .env.example deploy/RUNTIME.md docs/strategy/release/`; убрать Helius из `.env`; `pm2 reload live-oscar --update-env`.

---

## [1.11.283] — 2026-05-27

### Tune: stricter Live Oscar entry gates (36h age + −20% dip, fewer injects)

**Контекст:** покупки монет &lt;36h жизни — volume-leader inject не фильтровал `token_age_min`; `PAPER_DIP_MIN_AGE_MIN=0` пропускал dip; после 1.11.282 слишком много входов.

| Параметр | Было (1.11.282) | Стало |
|----------|-----------------|-------|
| `PAPER_DIP_MIN_DROP_PCT` | −16 | **−20** |
| `PAPER_DIP_MIN_AGE_MIN` | 0 | **2160** (36 ч) |
| `PAPER_MIN_TOKEN_AGE_MIN` | (не задан) | **2160** |
| `PAPER_POST_CRASH_FAST_PATH_MIN_DROP_PCT` | −16 | **−20** |
| `PAPER_POST_MIN_LIQ_USD` | 30000 | **300000** |
| `PAPER_VOLUME_LEADER_TOP_N` | 80 | **50** |
| `PAPER_VOLUME_LEADER_SNAPSHOT_LOOKBACK_MIN` | 90 | **30** |

**Код:** `fetchCrossVenueSnapshotRowsByVolumeCanonical` — SQL-фильтр `token_age_min` для volume-leader inject.

**Откат:** `git checkout sa-alpha-1.11.282 -- ecosystem.config.cjs src/papertrader/discovery/snapshot.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.282] — 2026-05-27

### Tune: Live Oscar runner coverage (volume leader + min liq)

**Контекст:** runner coverage audit — top vol mints видны в PG, но часть не inject’илась (`no_snapshot_row_30m`), а топ по vol отсекались `liq<300000`.

| Параметр | Было | Стало |
|----------|------|-------|
| `PAPER_VOLUME_LEADER_SNAPSHOT_LOOKBACK_MIN` | 30 | **90** |
| `PAPER_VOLUME_LEADER_TOP_N` | 50 | **80** |
| `PAPER_POST_MIN_LIQ_USD` | 300000 | **30000** |

**Откат:** `git checkout sa-alpha-1.11.281 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md`; `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`.

---

## [1.11.281] — 2026-05-26

### Fix: discovery pin for collector PG ingest (MANIFEST blind gap)

`live-oscar` writes `data/live/discovery-collector-pin-mints.txt` (SQL + priority tier, cap 200). DEX collectors solo-fetch DexScreener for those mints when missing from trending tick. **Not** a trading whitelist (`LIVE_MINT_WHITELIST_ENABLED` unchanged).

**Rollback:** revert; `PAPER2_SNAPSHOT_DISCOVERY_PIN=0`; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.280] — 2026-05-26

### Fix: snapshot_stale false positive after sa-orca disabled

`snapshot-freshness-watch` and `collector-log-watch` no longer treat **orca** as required: default `SNAPSHOT_FRESHNESS_SKIP_SOURCES=orca`; alert action text drops `sa-orca` restart (runaway CPU since 2025-05-24).

**Rollback:** revert commit; `pm2 reload ecosystem.config.cjs --update-env`; set `SNAPSHOT_FRESHNESS_SKIP_SOURCES=` empty and re-add orca to TABLES if orca collector re-enabled.

---

## [1.11.279] — 2026-05-26

### Fix: ecosystem PM2 collectors (orca off, meteora/pumpswap/orchestrator split)

Duplicate keys in `ecosystem.config.cjs` caused `sa-meteora` to run `orca-collector` and `sa-pumpswap` to run `sa-wallet-orchestrator`. Removed **sa-orca** from ecosystem (runaway CPU); restored one-process-one-script for meteora, pumpswap, wallet-orchestrator.

**Rollback:** revert commit; `git fetch origin v2 && git reset --hard origin/v2 && npm ci`; `pm2 reload ecosystem.config.cjs --update-env`; optionally `pm2 start scripts-tmp/orca-collector.mjs --name sa-orca` if orca needed again.

---

## [1.11.278] — 2026-05-25

### Fix: Telegram blacklist ORCA mint (spike + dips)

`orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` — общий `telegram-alert-mint-blacklist.ts`; pullback/retrace больше не шлют алерты (spike уже блокировал mint).

**Rollback:** revert commit; `pm2 reload ecosystem.config.cjs --update-env` для spike/pullback/retrace watchers.

---

## [1.11.277] — 2026-05-25

### Tune: discovery min mcap $5M → $3M

`PAPER_DISCOVERY_MIN_MARKET_CAP_USD=3000000` для live-oscar (SQL pool + eval gate `mcap<3000000`).

**Rollback:** вернуть `5000000` + `pm2 reload live-oscar --update-env`.

---

## [1.11.276] — 2026-05-25

### Discovery: Volume Leader Jupiter cross-check (Step 3)

**Context:** Volume tier mints могут иметь PG price/mcap с «не того» пула; priority Jupiter refresh делит budget с сотнями mint'ов.

**Change:**
- `volume-leader-jupiter-crosscheck.ts` — отдельный budget (20/tick) Jupiter quote для volume-leader mints.
- Корректирует in-memory price/mcap при расхождении PG vs tradable (0.5–35%).
- Priority refresh пропускает mint'ы, уже обновлённые cross-check'ом.

**Rollback:** `PAPER_VOLUME_LEADER_JUPITER_CROSSCHECK_ENABLED=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.275] — 2026-05-25

### Discovery: snapshot liq/mcap sanity (Step 2)

**Context:** ~17% eval blocks from `liq<300k` on bad PG snapshots (liq≈0 at high mcap, dead pools).

**Change:**
- `snapshot-row-sanity.ts` — reject liq≈0 + high mcap, liq/mcap ratio mismatch, dead pool (<10% mint max liq).
- Applied in SQL lane pool, cross-venue inject fetch, and dedupe before canonical pick.
- Env: `PAPER_DISCOVERY_SNAPSHOT_SANITY_*` (default on).

**Rollback:** `PAPER_DISCOVERY_SNAPSHOT_SANITY_ENABLED=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.274] — 2026-05-25

### Discovery: Volume Leader tier (structural)

**Context:** SQL pool ranks by max liq, not volume; high-volume mints (e.g. RICH) fall out of universe after mcap dip or wrong canonical pool.

**Change:**
- `volume-leader-query.ts` — top-N mints by peak `volume_1h` (24h, cross-DEX), cached 60s.
- `volume-leader-inject.ts` — guaranteed inject + eval every 15s; canonical pair = **max volume_1h**, not max liq.
- `pickCanonicalByVolumeRow` + dedupe override for volume-leader mints.
- Env: `PAPER_VOLUME_LEADER_ENABLED`, `TOP_N=50`, `REEVAL_SEC=15`.

**Rollback:** `PAPER_VOLUME_LEADER_ENABLED=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.273-stable] — 2026-05-24

### Rollback: revert 1.11.274–1.11.284 (restore pre-incident prod)

**Context:** After ROUTER spike (~12:55 MSK 24.05) hotfixes 1.11.274–284 broke collectors, alerts, live-oscar. Restore last known-good **`dedbb9a`**.

**Change:** Revert tree to 1.11.273; remove Jupiter fast-path watcher, collector sanity layers, canonical 360m, PM2 splits from tip.

**Prod:** `git reset --hard dedbb9a && npm ci && pm2 delete market-priority-jupiter-spot-watch; pm2 reload ecosystem.config.cjs --update-env`

**Rollback:** re-apply individual commits from 1.11.274+ after review.

---

## [1.11.273] — 2026-05-21

### Dips Telegram: compact pullback/retrace alerts

**Context:** канал Dips (`-1003504887486`) — короткий формат алертов как у spike: символ, откат %, GMGN, две строки mcap (пик → просадка), ref mcap.

**Change:**
- `market-dips-compact-telegram-format.ts` — общий builder;
- `market-pullback-telegram-watch.ts`, `market-pump-retrace-alert-watch.ts` — убраны mint/dex/holders/price_usd/3 блока «лой–хай–просадка».

**Rollback:** `git revert` коммита; `pm2 reload` `market-pullback-telegram-watch` + `retrace-alert-watch`.

---

## [1.11.272] — 2026-05-21

### Revert prod exit: Variant A v2 hybrid (max-profit backtest winner)

**Context:** PG backtest on 64 closes / 14d / liq ≥ $300k: v3 scratch **+$528** vs v2 hybrid **+$2 104** (same cohort, `scripts-tmp/live-oscar-v3-vs-v2-backtest.ts`).

**Prod (`live-oscar`, `ecosystem.config.cjs`):**

| Area | Change |
|---|---|
| Exit policy | **New opens → `variant_a_v2`** again (in-flight `variant_a_v3` / v1 / wave B unchanged) |
| TP | Infinite +5% grid, **10%** of remainder per rung |
| Trail | Partial stepped trail (20% remainder, −5% from peak); arms @ **+10%** |
| DCA | After any DCA leg → TP rungs reset on new avg |
| Re-arm | After ≥+10% taken, drop to ≤+2.5% → rungs above +2.5% fire again |
| Timed | salvage24 + h48 **loss @ breakeven**; `SMART48=0` |
| Removed from prod | v3 discrete ladder, flush @ 0%, scratch gap tail, mint scratch re-entry |

**Code:** `stampVariantAOnOpen` → v2; `liveOscarHybridStrategyNoteRu()`; dashboard copy v2.

### Откат

Revert to `1.11.271` (v3 scratch env + stamp v3); redeploy NORM §5.

---

## [1.11.271] — 2026-05-21

### Feature: Live Oscar Variant A v3 — scratch-harvest exit + price re-entry

**Prod (`live-oscar`, `ecosystem.config.cjs`):**

| Area | Change |
|---|---|
| Exit policy | New opens → `variant_a_v3` (in-flight v1/v2/wave B/legacy unchanged) |
| TP | Discrete ladder vs avg: +5%→30%, +10%→15%, +15%→15%, +20/25/30%→10% remainder |
| After TP | DCA forbidden; pullback to 0% avg → 100% flush (`scratch_flush0`) |
| Gap | PG gap through 0% → flush at avg when PnL ≤ −3% (`scratch_gap_flush`) |
| Dust | Remainder < $100 → full flush |
| Timed | salvage24 + h48 **loss only if no TP**; no 96h / moon / v2 grid trail |
| Re-entry | Same mint when price ≤ lastExit × 90% (no time cooldown) |
| Timed loss block | 24h mint block after salvage24/h48_loss (unchanged) |

**Dashboard:** `STRATEGY_META` + timeline context for scratch on open/partial/close.

**Code:** `exit-policy-variant-a.ts` (v3), `mint-scratch-reentry.ts`, tracker flush wiring, phase4 buy gate, store-restore v3 fields.

### Откат

Revert to `1.11.270` env block (v2 infinite grid + partial trail) and prior `exit-policy-variant-a.ts`; redeploy NORM §5.

---

## [1.11.270] — 2026-05-21

### Feature: Live Oscar Variant A v2 — infinite TP grid + partial trail @+10%

**Prod (`live-oscar`, `ecosystem.config.cjs`):**

| Area | Change |
|---|---|
| Exit policy | New opens → `variant_a_v2` (in-flight `variant_a_v1` / wave B unchanged) |
| TP | Infinite +5% grid, 10% of remainder per rung |
| Trail | Partial stepped trail (20% remainder, −5% from peak); arms at **+10%**, not +35% |
| DCA | After any DCA leg → **all TP rungs reset** (re-fire from +5% on new avg) |
| Pullback | After ≥+10% taken, drop to ≤+2.5% → re-arm rungs above +2.5% |
| Timed | salvage24 + h48 **loss only**; `SMART48=0` — no forced 96h on winners |
| Removed | Moon +50% full exit, +35% full retrace trail, discrete TP ladder |

**Code:** `exit-policy-variant-a.ts` (v2), tracker partial-trail wiring, `tp-grid-effective` unlimited grid.

### Откат

Revert to `1.11.269` env block (discrete ladder, smart48, moon/trail full exit) and prior `exit-policy-variant-a.ts`; redeploy NORM §5.

---

## [1.11.269] — 2026-05-21

### Feature: Live Oscar Variant A exit stack + DCA cap $1200

**Prod (`live-oscar`, `ecosystem.config.cjs`):**

| Area | Change |
|---|---|
| Entry | $400+$400 staged split (`PAPER_POSITION_USD=800`) |
| Max cap | `LIVE_MAX_POSITION_USD=1200` (DCA −10%/−20% × $200) |
| DCA | `PAPER_DCA_LEVELS=-10:0.25,-20:0.25` |
| Kill | `PAPER_DCA_KILLSTOP=0` (no price kill) |
| TP | Discrete ladder `0.05:0.25,…,0.30:0.15`; grid off |
| Exit policy | `PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A=1`; wave B off for **new** opens |
| Moon / trail | +50% full exit; trail arm +35%, retrace 12% |
| Timed | Salvage24; smart48 (loss @48h, winners to 96h) |
| Min liq | `PAPER_POST_MIN_LIQ_USD=300000` |
| Re-entry | `LIVE_MINT_TIMED_LOSS_COOLDOWN_*` 24h after salvage24/h48_loss |

**Code:** `exit-policy-variant-a.ts`, tracker integration, `mint-timed-loss-cooldown.ts`, notional boot allows entry < max.

### Деплой (NORM §5)

```bash
ssh -i c:/Users/cente/.ssh/botadmin_187_auto root@187.124.38.242 \
  "sudo -u salpha -H bash -lc 'cd /opt/solana-alpha && git fetch origin v2 && git reset --hard origin/v2 && npm ci && pm2 reload ecosystem.config.cjs --only live-oscar --update-env && git rev-parse HEAD && git status -sb'"
```

### Откат

```bash
git checkout sa-alpha-1.11.268 -- ecosystem.config.cjs src/papertrader/executor/exit-policy-variant-a.ts src/live/mint-timed-loss-cooldown.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
# + revert tracker/types/config edits; NORM §5 deploy 1.11.268
```

---

## [1.11.267] — 2026-05-23

**Git SHA (интеграция):** `eb681fc`.

### Tune: hybrid re-entry time fallback 30m → 20m after loss exit

**Prod env (`ecosystem.config.cjs`, live-oscar):**

| Параметр | Было | Стало |
|---|---|---|
| `LIVE_REENTRY_MAX_WAIT_MINUTES` | 30 | **20** |

После убыточного закрытия (в т.ч. KILLSTOP): повторный вход по тому же mint — если цена не просела **−12%** от last exit, разрешён через **20 мин** (было 30). Dip-порог **12%** без изменений.

### Деплой (NORM §5)

```bash
ssh -i c:/Users/cente/.ssh/botadmin_187_auto root@187.124.38.242 \
  "sudo -u salpha -H bash -lc 'cd /opt/solana-alpha && git fetch origin v2 && git reset --hard origin/v2 && npm ci && pm2 reload ecosystem.config.cjs --only live-oscar --update-env && git rev-parse HEAD'"
```

### Откат

```bash
git checkout sa-alpha-1.11.266 -- ecosystem.config.cjs .env.example tests/live-reentry-hybrid-gate.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
npm run typecheck
# NORM §5 deploy SHA 1.11.266
```

---

## [1.11.266] — 2026-05-23

**Git SHA (интеграция):** `628c33b`.

### Tune: entry split $400+$400 only ($800 cap); avg legs off

**Prod env (`ecosystem.config.cjs`, live-oscar):**

| Параметр | Было (1.11.265) | Стало |
|---|---|---|
| `LIVE_OSCAR_FULL_NOTIONAL_USD` / `PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` | $900 | **$800** |
| `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD` | $300 | **$400** |
| `PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD` | $300 | **$400** |
| `PAPER_ENTRY_FIRST_LEG_FRACTION` | 0.7 | **0.5** |
| `PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD` | $150 | **0** (усреднение −7% выкл.) |
| `PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD` | $150 | **0** (усреднение −14% выкл.) |

**Код:** `liveStagedEntrySecondLegUsd` zod → `nonnegative()` (0 = без avg-ног).

### Деплой (NORM §5)

```bash
ssh -i c:/Users/cente/.ssh/botadmin_187_auto root@187.124.38.242 \
  "sudo -u salpha -H bash -lc 'cd /opt/solana-alpha && git fetch origin v2 && git reset --hard origin/v2 && npm ci && pm2 reload ecosystem.config.cjs --only live-oscar --update-env && git rev-parse HEAD'"
```

### Откат

```bash
git checkout sa-alpha-1.11.265 -- ecosystem.config.cjs src/papertrader/config.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
npm run typecheck
# NORM §5 deploy SHA 1.11.265
```

---

## [1.11.265] — 2026-05-23

**Git SHA (интеграция):** `f9382b1`.

### Tune: kill −5% + hybrid re-entry (dip −12% OR 30m); denylist off

**Фон.** 7d backtest на PG + journal: после KILLSTOP −5% deny-list «сжигает» узкий пул (~10 fresh mint); лучший re-entry — **−12% от last exit** или **fallback 30 min** (runner без deep dip).

**Prod env (`ecosystem.config.cjs`, live-oscar):**

| Параметр | Было | Стало |
|---|---|---|
| `PAPER_DCA_KILLSTOP` | −25% | **−5%** |
| `LIVE_REENTRY_MIN_DROP_FROM_LAST_EXIT_PCT` | 0 | **12** |
| `LIVE_REENTRY_MAX_WAIT_MINUTES` | — | **30** (новый) |
| `PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED` | true | **false** (заменён hybrid gate) |
| `LIVE_OSCAR_PERMANENT_DENYLIST_DISABLED` | 0 | **1** |
| `LIVE_NEGATIVE_TRADE_DENY_ENABLED` | — | **0** (stub в коде) |
| `LIVE_FIRST_MINT_PROBE_DENY_ON_LOSS_ENABLED` | — | **0** |
| `LIVE_STAGED_ADD_AUTO_DENYLIST_ENABLED` | 1 | **0** |
| `LIVE_MINT_WHITELIST_REMOVE_AFTER_CONSEC_LOSSES` | 2 | **0** |
| `LIVE_MINT_FIRST_PROBE_KILL_DROP_PCT` | 7 | **5** |

**Код:** hybrid gate `appendLiveReentryHybridGateReasons` / `appendPostExitReentryGateReasons` (`dip-clones.ts`); флаги deny в `live/config.ts`, `mint-whitelist.ts`, `mint-first-probe.ts`; тест `tests/live-reentry-hybrid-gate.test.ts`.

**VPS (ручное):** `live-oscar-permanent-denylist.txt` очищен (backup `*.bak-pre-hybrid`).

### Деплой (NORM §5)

```bash
ssh -i c:/Users/cente/.ssh/botadmin_187_auto root@187.124.38.242 \
  "sudo -u salpha -H bash -lc 'cd /opt/solana-alpha && git fetch origin v2 && git reset --hard origin/v2 && npm ci && pm2 reload ecosystem.config.cjs --only live-oscar --update-env && git rev-parse HEAD'"
```

### Откат

```bash
git checkout sa-alpha-1.11.264 -- ecosystem.config.cjs src/papertrader/config.ts src/papertrader/discovery/dip-clones.ts src/papertrader/discovery/smart-lottery.ts src/live/config.ts src/live/mint-whitelist.ts src/live/mint-first-probe.ts tests/live-reentry-hybrid-gate.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md .env.example
npm run typecheck
# NORM §5 deploy SHA 1.11.264; восстановить denylist из *.bak-pre-hybrid при необходимости
```

---

## [1.11.264] — 2026-05-23

**Git SHA (интеграция):** `c7f1887`.

### Tune: Wave B TP ladder — escalating sell (5%/10%/15%/… per +2.5% rung)

**Изменение.** Для всех `wave_b_v1` open (обе ветки — с усреднением и без):

| PnL rung | Продажа остатка |
|---|---|
| +2.5% | 5% |
| +5% | 10% |
| +7.5% | 15% |
| +10% | 20% |
| … | +5% за ступень, cap 100% |

Trail 20%, breakeven gating, defensive trail, **flush остатка &lt;$100** (TP и trail) — без изменений (`waveBAdjustSellFractionForRemainder`, `WAVE_B_TRAIL_FLUSH_REMAIN_USD=100`).

**Код:** `exit-policy-wave-b.ts`, `tp-grid-effective.ts`, `tests/papertrader-exit-policy-wave-b.test.ts`.

### Деплой (NORM §5)

```bash
ssh -i c:/Users/cente/.ssh/botadmin_187_auto root@187.124.38.242 \
  "sudo -u salpha -H bash -lc 'cd /opt/solana-alpha && git fetch origin v2 && git reset --hard origin/v2 && npm ci && pm2 reload ecosystem.config.cjs --only live-oscar --update-env && git rev-parse HEAD'"
```

### Откат

```bash
git checkout sa-alpha-1.11.263 -- src/papertrader/executor/exit-policy-wave-b.ts src/papertrader/executor/tp-grid-effective.ts tests/papertrader-exit-policy-wave-b.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
npm run typecheck
# NORM §5 deploy SHA 1.11.263
```

---

## [1.11.263] — 2026-05-22

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.263`.  
**Git SHA (интеграция):** `f247308`.

### Tune: Live Oscar entry floor — liq $400k + mcap $5M

**Фон.** Journal counterfactual на закрытиях с `live_discovery_eval` (`pt1-oscar-live.jsonl`): **2d** (26 closes) — losses чаще `liq<400k` (13/16) и `mcap<5M` (9/16); **14d** (102 closes, 91 с eval) — liq≥$400k **и** mcap≥$5M блокирует **36/39 losses (−$2145)** vs **47/52 wins (+$1963)** → kept net **+$38** vs факт **−$726**.

**Prod env (`ecosystem.config.cjs`, live-oscar):**

| Параметр | Было | Стало |
|---|---|---|
| `PAPER_POST_MIN_LIQ_USD` | $140k | **$400k** |
| `PAPER_DISCOVERY_MIN_MARKET_CAP_USD` | $2M | **$5M** |

Priority tier (`evaluateSnapshotPriorityTier`) и SQL lane используют те же пороги (`lanePostMinLiqUsd`, `discoveryMinMarketCapUsd`). Eval-reasons: `liq<400000`, `mcap<5000000`.

### Деплой (NORM §5)

```bash
ssh -i c:/Users/cente/.ssh/botadmin_187_auto root@187.124.38.242 \
  "sudo -u salpha -H bash -lc 'cd /opt/solana-alpha && git fetch origin v2 && git reset --hard origin/v2 && npm ci && pm2 reload ecosystem.config.cjs --only live-oscar --update-env && git rev-parse HEAD'"
```

### Откат

```bash
git checkout sa-alpha-1.11.262 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
# NORM §5 на VPS: git fetch origin v2 && git reset --hard <SHA-1.11.262> && npm ci && pm2 reload ecosystem.config.cjs --only live-oscar --update-env
```

---

## [1.11.262] — 2026-05-22

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.262`.  
**Git SHA (интеграция):** `43cfee2`.

### Fix: Wave B breakeven — только после реального TP rung ≥ +7.5%

**Проблема.** После 1.11.261 MTM стал честным; в позиции оставался ghost `liveWavePeakPnlFrac` от stale snapshot → `BREAKEVEN_EXIT` на WOJAK/USDUC/LOL без исполненного partial TP (каскад продаж ~19:24 UTC 22 мая).

**Код:**

- `src/papertrader/executor/exit-policy-wave-b.ts` — `waveBBreakevenExitEligible()` смотрит `waveBExecutedTpGridThresholdTaken()` (ladder marks), не MTM peak.
- `tests/papertrader-exit-policy-wave-b.test.ts` — регрессия ghost peak vs executed rung.

### Откат

```bash
git checkout sa-alpha-1.11.261 -- src/papertrader/executor/exit-policy-wave-b.ts tests/papertrader-exit-policy-wave-b.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
npm run typecheck
# NORM §5 deploy предыдущего SHA; pm2 reload live-oscar --update-env
```

---

## [1.11.261] — 2026-05-22

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.261`.  
**Git SHA (интеграция):** `ca0e675`.

### Fix: conservative exit MTM при stale-high PG snapshot

**Проблема.** USDUC: PG snapshot ~$0.00569 vs Jupiter ~$0.00524 → phantom +8% MTM → ложный partial TP +5% при фактически flat exit.

**Код:**

- `src/live/mtm-snapshot-guard.ts` — новый guard: Jupiter ниже stale high → MTM = Jupiter; in-band → `min(snapshot, Jupiter)`.
- `src/papertrader/executor/tracker.ts` — убран override «Jupiter ниже snapshot → всё равно snapshot».
- `tests/live-mtm-snapshot-guard.test.ts`.

### Откат

```bash
git checkout sa-alpha-1.11.260 -- src/live/mtm-snapshot-guard.ts src/papertrader/executor/tracker.ts tests/live-mtm-snapshot-guard.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
npm run typecheck
# NORM §5 deploy предыдущего SHA; pm2 reload live-oscar --update-env
```

---

## [1.11.268] — 2026-05-23

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.268`.

### Discovery — канонический пул по max liq (метрики)

- **`snapshot.ts`:** выбор строки снимка на mint — `liquidity_usd DESC` (канонический пул), не «самый свежий ts» на мёртвом Meteora/Pumpswap.
- **`snapshot-canonical-pick.ts`:** общий pick + dedupe после inject whitelist/priority.
- Исправляет кейс pippin: Raydium ~$3.7M вместо Meteora ~$32k в `live_discovery_eval`.

**Откат:** NORM §5 deploy предыдущего SHA; `pm2 reload live-oscar --update-env`.

---

## [1.11.260] — 2026-05-22

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.260`.

### Spike Telegram — эскалация «Вот уже N%»

- **`market-spike-telegram-watch`:** включена эскалация по умолчанию (`SPIKE_ALERT_ESCALATE_ENABLED=1`): если пролив/рост усилился ещё на ≥5 п.п. внутри mint cooldown — follow-up «Вот уже 15%», «Вот уже 20%»… (до 8 апдейтов, gap ≥60 с).
- Формат follow-up: та же компактная раскладка, первая строка `SYMBOL — NAME · Вот уже N%`.

**Откат:** `SPIKE_ALERT_ESCALATE_ENABLED=0` + NORM §5 deploy; `pm2 restart market-spike-telegram-watch --update-env`.

---

## [1.11.256] — 2026-05-22

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.256`.

### Spike Telegram — компактный формат алерта

- **`market-spike-telegram-watch`:** сообщения pump/dump — 4 строки: заголовок + «Пролив/Рост» + Δ%, окно времени, Δ mcap, ссылка GMGN.
- Убраны из текста: `[spike_*]` tag, tier, dex/бары, Δ цены, mint, holders, liq.

**Откат:** NORM §5 deploy предыдущего SHA; `pm2 restart market-spike-telegram-watch --update-env`.

---

## [1.11.251] — 2026-05-22

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.251`.

### Jupiter Pro P0 — entry split corridor + near-miss dip refresh

- **Entry split 2-я нога:** коридор +3%…−10% считается по **Jupiter tradable** (`entrySplitMetricUsd`), MTM/TP/trail по-прежнему на PG-guarded `curMetric`.
- **Near-miss dip refresh:** после PG `dipMap` — Jupiter quote для mint'ов с dip в `(dipMin, dipMin+4%]`; только если tradable **ниже** PG и не пробивает `dipMaxDropPct`.
- Модули: `jupiter-spot-refresh.ts`, `near-miss-dip-jupiter-refresh.ts`; replay: `scripts-tmp/backtest-jupiter-p0-replay.mjs`.

**Prod env:** `PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_REFRESH=1`, `PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_GAP_PCT=4`, `PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_MAX_PER_TICK=15`.

**Откат:** `PAPER_PRIORITY_DISCOVERY_NEAR_MISS_JUPITER_REFRESH=0` + revert entry-split Jupiter metric; NORM §5 deploy.

---

## [1.11.250] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.250`.

### Add: post-crash fast path entry (`post_crash_fast`)

После **vol-spike + резкого падения** в окне lookback (default 180m) — вход по **crash peak**, не дожидаясь 12h dip. Стабилизация: ≥25m после пика, 15m knife ≤−8%, drop −16…−50% от peak. **Local-high-veto bypass** на этом пути.

**Prod env:** `PAPER_POST_CRASH_FAST_PATH_ENABLED=1` (+ `PAPER_POST_CRASH_*` пороги в `ecosystem.config.cjs`).

**Откат:** `PAPER_POST_CRASH_FAST_PATH_ENABLED=0` → NORM §5 deploy.

---

## [1.11.249] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.249`.

### Add: trend structure veto (stale runner protector)

**Новый protector** `trend-structure-veto.ts` — два независимых правила:
- **No high break:** последнее касание high за lookback (14d) ≥ **7** дней назад → skip.
- **Structural decline:** `price / high_14d < 75%` **и** 7d slope ≤ **0%** → skip.

**Prod env:** `PAPER_TREND_STRUCTURE_VETO_ENABLED=0` (выкл до backtest); пороги в `PAPER_TREND_VETO_*`.

**Откат:** `PAPER_TREND_STRUCTURE_VETO_ENABLED=0` или revert коммита.

---

## [1.11.248] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.248`.

### Tune: Wave B TP — flat 10% per rung

**Wave B (`live-oscar`, `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=1`):**
- **Без усреднения** (`dca`/`staged_avg` нет): шаг **+5%**, на каждой ступени **10%** остатка.
- **После усреднения**: шаг **+2.5%**, на каждой ступени **10%** остатка.

**Откат:** revert `exit-policy-wave-b.ts` → NORM §5 deploy.

---

## [1.11.247] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.247`.

### Tune: staged entry split $300+$300 (was $250+$250)

**Prod env (`live-oscar`):** `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD` и `PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD` **300**; полный cap **`LIVE_OSCAR_FULL_NOTIONAL_USD` / `PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` → $900** ($300+$300+$150+$150). Усреднения −7%/−14% без изменений.

**Откат:** split **250**, cap **800** → NORM §5 deploy.

---

## [1.11.246] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.246`.

### Tune: TP grid step +10% sells 20% of remainder (was 30%)

**Prod env (`live-oscar`):** `PAPER_TP_GRID_SELL_FRACTION_PROFILE` **`0.10,0.30,...` → `0.10,0.20,0.50,0.70,0.70`** — только вторая ступень (+10% PnL); остальные без изменений.

**Откат:** вернуть профиль `0.10,0.30,0.50,0.70,0.70` → NORM §5 deploy.

---

## [1.11.245] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.245`.

### Fix: volume sybil guard false-positive on live coins (MANIFEST)

**Причина:** guard считал baseline «мёртвым» только по `p10 vol5m ≤ $3000`. У живых монет с высоким `vol1h` p10 остаётся низким (тихие 5m-бакеты между импульсами), а на дампе recent vol5m даёт 15× spike → ложный `volume_sybil`.

**Код:** `volume-sybil-guard.ts` — «мёртвый» baseline только при **p10 + dead_fraction ≥ 55% + p50 ≤ dead**; exempt при `vol1h ≥ $36k`.

**Priority tier:** `evaluateSnapshotPriorityTier()` — отдельный BS floor **`PAPER_PRIORITY_DISCOVERY_MIN_BS=0.85`** (global POST_MIN_BS 0.98 без изменений).

**Prod env:** `PAPER_VOLUME_SYBIL_MIN_DEAD_FRACTION`, `PAPER_VOLUME_SYBIL_VOL1H_ALIVE_EXEMPT_USD`, `PAPER_PRIORITY_DISCOVERY_MIN_BS`.

**Откат:** `git checkout sa-alpha-1.11.244` → NORM §5 deploy; вернуть env-ключи sybil/priority BS.

---

## [1.11.244] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.244`.

### Feature: priority dip-watch tier (24/7, без ops-whitelist)

**Проблема:** тихие проливы (MANIFEST −17% при vol5m=$7k) выпадали из SQL discovery pool; eval прекращался на 1–2 часа. RPC/Jupiter были куплены, но не использовались для мониторинга dip между PG ticks.

**Код (`src/papertrader/discovery/`):**

- `priority-discovery-registry.ts` — open positions + near-ready + recent eval (180m)
- `priority-discovery-inject.ts` — inject в discovery в обход `snapshotCandidateLimit` / vol5m SQL floor
- `priority-dip-price-refresh.ts` — Jupiter spot refresh для priority mint'ов каждый eval-tick
- `discovery-eval-throttle.ts` — shared eval throttle cache
- `evaluateSnapshotPriorityTier()` — liq/mcap/vol1h/bs без vol5m/buys/sells floor

**Prod env (`ecosystem.config.cjs`, live-oscar + collectors):**

| Параметр | Было | Стало |
|---|---|---|
| `LIVE_MINT_WHITELIST_ENABLED` | `0` | `0` (без изменений — вход без whitelist) |
| `PAPER_POST_MIN_VOL_5M_USD` | $10k | **$2500** |
| `PAPER_SNAPSHOT_CANDIDATE_LIMIT` | 300 (default) | **500** |
| `PAPER_DISCOVERY_REEVAL_SEC` | 60 (default) | **30** |
| `PAPER_PRIORITY_DISCOVERY_REEVAL_SEC` | — | **15** |
| Collectors `*_INTERVAL_MS` | 60s | **30s** |
| `PAPER_LIQ_WATCH_RPC_FALLBACK` | `0` | **`1`** |
| `PAPER_IMPULSE_RPC_MAX_PER_MIN` | 30 | **60** |
| `IMPULSE_QN_ROLLING_MAX_CREDITS` | 0 | **200000** |

### Откат

```bash
git checkout sa-alpha-1.11.243 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md src/papertrader/
pm2 reload ecosystem.config.cjs --update-env
```

---

## [1.11.243] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.243`.

### Tune: staged entry $250+$250, mcap floor $2M

**Изменения в `ecosystem.config.cjs` (live-oscar):**

| Параметр | Было | Стало |
|---|---|---|
| `PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD` | $500 | **$250** |
| `PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD` | $500 | **$250** |
| `PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD` | $150 | $150 (без изменений) |
| `PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD` | $150 | $150 (без изменений) |
| `LIVE_OSCAR_FULL_NOTIONAL_USD` / `PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` | $1300 | **$800** |
| `PAPER_DISCOVERY_MIN_MARKET_CAP_USD` | $3M | **$2M** |

Усреднение (−7% / −14%, $150+$150, cooldowns, kill −25%) **не менялось**.

### Откат

```bash
git checkout sa-alpha-1.11.242 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
pm2 reload ecosystem.config.cjs --only live-oscar --update-env
```

---

## [1.11.242] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.242`.

### Tune: Live Oscar dip canon `−20%` → `−16%` (×1.4 PnL по 14d backtest)

**Фон.** 14-дневный PnL grid backtest (`docs/strategy/refactor/DIP_CANON_GRID_14D.md`):
прогон по сетке `dip%∈{16,18,20}` × `vol1h$∈{15k,25k,36k}` с **реальным prod env**
(Wave B v1, TP-grid, killstop −25%, trail ladder_retrace, holders off).
337 уникальных mint'ов, 1134 пар, 4.48M снапшотов, симуляция через `simulateLifecycle`.

**Открытие**: текущая prod-конфигурация (`−20%` + `$36k`) — **самая консервативная
из 9 квадрантов**, даёт всего 2405 сделок и net $13 266 за 14d. Смягчение порога
дипа до `−16%` при том же `vol1h $36k` даёт **3382 сделок и net $18 508**
(+41% trades, +39% PnL, ROI 36.77 % → 36.48 % — практически не меняется,
WR 83 % → 82 %).

**Параллельно проверили killstop sweep** (`docs/strategy/refactor/KILLSTOP_TRAIL_SWEEP_7D.md`):
текущий `−25%` близок к оптимуму, расширение до `−30%` даёт +$120/неделю — не значимо.
**Trail в режиме `ladder_retrace` не крутится** — `PAPER_TRAIL_DROP` не используется.
В этом коммите killstop/trail **не трогаем**.

### Изменения

**`ecosystem.config.cjs` (один параметр):**

```diff
- PAPER_DIP_MIN_DROP_PCT: '-20',
+ PAPER_DIP_MIN_DROP_PCT: '-16',
```

**`docs/strategy/release/VERSION`**: `1.11.241` → `1.11.242`.

**`docs/strategy/refactor/DIP_CANON_GRID_14D.md`** + `KILLSTOP_TRAIL_SWEEP_7D.md` —
полные таблицы и методология бэктестов.

### Ожидаемый эффект на проде (по 14d backtest, $15/trade)

| Метрика | Текущая prod (−20%) | После (−16%) | Δ |
|---|---|---|---|
| Сделок | 2 405 | 3 382 | +41% |
| Net PnL | $13 266 | $18 508 | +39% |
| ROI % | 36.77% | 36.48% | плоско |
| WR | 83% | 82% | −1 п.п. (в шуме) |
| TIMEOUT/TRAIL | 368/1840 | 611/2537 | те же пропорции |

### Контекст: 6 «защитных фильтров» практически не режут

В новой телеметрии `live_discovery_eval` (1.11.237) видно: за 24h из 44 452 случаев
`dip_not_deep_enough>-20%` recovery_veto / local_high / Policy A+ / volume_sybil
суммарно режут ~200 кандидатов (≈0.5%). То есть **главное узкое горлышко именно
в `-20%` пороге дипа, а не в protector'ах**. Их крутить смысла нет.

### Caveats

- Costs (slippage 1–3% + priority fee) не моделировались — реальный ROI после
  costs снизится на 5–10 п.п., но **относительный ranking ячеек устойчив**.
- Backtest показывает 0 KILLSTOP exits против 45 в реальном журнале за 5d —
  расхождение simulator'а, не блокер для решения.
- Окно 14 дней — короткое. Через 7-14 дней после деплоя — ре-валидация на
  свежих данных + сравнение реального журнала против baseline.

### Откат

```bash
ssh -i c:/Users/cente/.ssh/botadmin_187_auto root@187.124.38.242 "sudo -u salpha -H bash -lc 'cd /opt/solana-alpha && git checkout sa-alpha-1.11.241 -- ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md && pm2 reload ecosystem.config.cjs --only live-oscar --update-env'"
```

или одной правкой обратно:

```bash
# в ecosystem.config.cjs:
# PAPER_DIP_MIN_DROP_PCT: '-16'  →  '-20'
# далее: pm2 reload ecosystem.config.cjs --only live-oscar --update-env
```

---

## [1.11.241] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.241`.

### Fix: ложный [RETRACE] −100% (TOES) — canonical pool + sanity, проливы не режем

**Фон.** TOESCOIN (TOES): алерт `[RETRACE][pump_then_pullback]` с ростом +563996% и «проливом −100%» — артефакт **dead Meteora pool** ($1.28k→$7M→$104), монета на месте ~$7M. Spike-watch уже чинили в 1.11.240; **retrace-alert-watch** и **pullback-watch** — нет.

### Изменения

**`src/scripts/market-pump-retrace-alert-watch.ts`**, **`market-pullback-telegram-watch.ts`:**

- `RETRACE/PULLBACK_ALERT_CANONICAL_POOL_BY_MAX_LIQ=1`: детекция только на пуле с **max liq** (как spike-watch).
- Sanity (`market-retrace-sanity.ts`): отсекаем **битые PG-бары**, не реальные проливы:
  - micro-valley ($1k) + million-% pump при ref mcap ≥$1M;
  - заявленный −100%, но `px_now` на том же пуле всё ещё у пика.

**`src/scripts/market-snapshot-canonical-pool.ts`** — общий выбор canonical pool.

**Тесты:** `market-retrace-sanity.test.ts`, кейс TOES в `market-pump-retrace-alert.test.ts`.

### Откат

```bash
git checkout sa-alpha-1.11.240 -- src/scripts/market-pump-retrace-alert-watch.ts src/scripts/market-pullback-telegram-watch.ts src/scripts/market-snapshot-canonical-pool.ts src/scripts/market-retrace-sanity.ts tests/market-retrace-sanity.test.ts tests/market-pump-retrace-alert.test.ts ecosystem.config.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
npm ci && pm2 reload ecosystem.config.cjs --only retrace-alert-watch,market-pullback-telegram-watch --update-env
```

---

## [1.11.240] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.240`.

### Fix: spike-watch — детекция на каноническом пуле, не skip проливов

**Фон.** 1.11.239 отсекала «мёртвые» пулы фильтрами — это могло терять реальные проливы/пампы и выглядело как «задача решена skip'ом». Нужно **ловить** движения, а не молча отбрасывать.

### Изменения

**`src/scripts/market-spike-telegram-watch.ts`:**

- **`SPIKE_ALERT_CANONICAL_POOL_BY_MAX_LIQ=1`** (default): pump/dump детектируется **только на пуле с max liq** по mint среди всех DEX-таблиц.
- Ложный Goblin +95% на `CK71…` ($38K) больше не анализируется — вместо этого бары pumpswap ($553K).
- **Реальные проливы и пампы** на ликвидном пуле проходят через прежний tier-каскад без доп. skip-фильтров.
- Убраны skip-фильтры `MIN_LIQ_SHARE_OF_MINT_MAX` / `STALE_ZERO_VOL_JUMP_PCT` из пайплайна.
- `primary_pair` refresh сохранён.

**Env:** заменены `SPIKE_ALERT_MIN_LIQ_SHARE_*` / `STALE_ZERO_VOL_*` на `SPIKE_ALERT_CANONICAL_POOL_BY_MAX_LIQ`.

### Откат

```bash
git checkout sa-alpha-1.11.239 -- src/scripts/market-spike-telegram-watch.ts ecosystem.config.cjs ecosystem.market-spike-watch.cjs scripts/spike-watch-pm2-entry.sh tests/market-spike-pool-quality.test.ts docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
npm ci && pm2 reload ecosystem.config.cjs --only market-spike-telegram-watch --update-env
```

---

## [1.11.239] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.239`.

### Fix: ложные spike-алерты на мёртвых пулах + JSONL daily_summary + primary_pair refresh

**Фон.** Алерт `[spike_pump] +95.46%` по Goblin пришёл с dead Meteora pool `CK71NMuP` (liq ~$38K, vol=0), тогда как pumpswap/meteora держали $387K–553K. Live Oscar стратегию не меняем.

### Изменения

**`src/scripts/market-spike-telegram-watch.ts`:**

- Фильтр **dead pool**: не слать алерт, если `liq_usd` пула < `SPIKE_ALERT_MIN_LIQ_SHARE_OF_MINT_MAX` (default 10%) от max liq по mint среди всех DEX-таблиц.
- Фильтр **stale price jump**: якорный бар с `vol_5m=0` и |Δ%| ≥ `SPIKE_ALERT_STALE_ZERO_VOL_JUMP_PCT` (default 30%) — skip.
- В Telegram показывается **liq лучшего пула** mint (`best_pool_liq_usd`), не triggering dead pair.
- **`SPIKE_ALERT_PRIMARY_PAIR_REFRESH=1`**: раз за проход обновляет `tokens.primary_pair` и `liquidity_usd` на пул с max liq.

**`src/live/events.ts`:**

- Добавлен `LiveDailySummarySchema` в `LiveEventBodySchema` — устраняет `Invalid discriminator value` для `live_daily_summary` в PM2 error log.

**`ecosystem.config.cjs` / `ecosystem.market-spike-watch.cjs`:**

- Новые env: `SPIKE_ALERT_MIN_LIQ_SHARE_OF_MINT_MAX`, `SPIKE_ALERT_STALE_ZERO_VOL_JUMP_PCT`, `SPIKE_ALERT_PRIMARY_PAIR_REFRESH`.

**Тесты:** `tests/market-spike-pool-quality.test.ts`.

### Откат

```bash
git checkout sa-alpha-1.11.238 -- src/scripts/market-spike-telegram-watch.ts src/live/events.ts ecosystem.config.cjs ecosystem.market-spike-watch.cjs docs/strategy/release/VERSION docs/strategy/release/CHANGELOG.md
npm ci && pm2 reload ecosystem.config.cjs --update-env
```

---

## [1.11.238] — 2026-05-21

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.238`.

> Замечание: версия 1.11.235 фактически занята параллельным релизом `b0a6d14` (disable runner canon + collector memory limit). Релизы 1.11.236 (`558ed37`, stream JSONL) и 1.11.237 (`0f11d33`, numeric telemetry в live_discovery_eval) также прошли вне этой сессии. Текущий релиз — следующий свободный номер `1.11.238`.

### Fix: silent health-pulse в Telegram при нормальной работе

**Фон.** Пользователь сообщил 21 мая 09:19 МСК:

> «`[HEALTH][live_oscar_pulse]` uptime=7227s open=2 closed=24 mode=live strat=live-oscar ... errors=0 opened_total=0 — вот такие сообщения не надо мне присылать. Мне нужно прислать только сообщения, когда есть проблемы.»

Health-pulse приходил каждые ~10 минут с полной выкладкой счётчиков, даже когда никаких отклонений нет. Это шум в Telegram.

### Изменения

**`src/live/main.ts`:**

- Добавлен новый env-флаг `LIVE_TELEGRAM_HEALTH_PULSE_ONLY_ON_ALERT`.
- `snapshot_stale` ALERT теперь шлётся в любом случае (вынесен ДО проверки на skip pulse).
- При флаге `=1`, pulse шлётся **только** когда хотя бы одно из:
  - `stats.errors > 0` (runtime errors в дискавери/трекере)
  - `simStreak > 0` (consec_sim_fail streak — Jupiter/QN деградация)
  - `snapshot stale` (PG-снимки отстают)
- В остальных случаях pulse **silent**.
- Старый kill-switch `LIVE_TELEGRAM_HEARTBEAT=0` сохраняет поведение (полностью выключить heartbeat вместе с `snapshot_stale` alert'ом — не рекомендуется).

**`ecosystem.config.cjs`:**

```javascript
LIVE_TELEGRAM_HEALTH_PULSE_ONLY_ON_ALERT: '1',
```

### Откат

```bash
env LIVE_TELEGRAM_HEALTH_PULSE_ONLY_ON_ALERT=0
pm2 restart ecosystem.config.cjs --only live-oscar --update-env
# pulse каждый interval вернётся
```

---

## [1.11.234] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.234`.

### Fix: anti-chase guard — abort buy при retry chase

**Фон.** Тот же VIRL-инцидент 20 мая 22:23 мск, продолжение.

Журнал VIRL (`BiywH8Eq2CbGhwMHKwCnfTiccWJwN7r1Q4Qn9hsypump`):

| Событие | ts (мск) | signal_price | mcap |
|---|---|---|---|
| `live_staged_entry_signal` | 22:20:49 | $0.003368 | $3.37M |
| 4× `execution_attempt` (fail) | 22:20:50 – 22:20:59 | — | — |
| **`live_staged_entry_signal`** (новый) | 22:21:58 | **$0.003609** | **$3.61M** |
| 3× `execution_attempt` (fail) | 22:21:59 – 22:22:06 | — | — |
| `live_staged_entry_signal` | 22:22:58 | $0.003609 | — |
| `execution_attempt` (success) | 22:22:59 | — | — |
| `live_position_open` | 22:22:59 | realized $0.003647 | (+1.05% от signal) |

Между signal'ом #1 ($0.003368) и signal'ом #2 ($0.003609) цена ушла **+7.2%**. Это значит мы догоняли уже разогнавшуюся цену. Внутри одного pipeline-вызова retry chase был ~+1%, но между decision'ами — +7%.

Защиты не было: protector'ы (recovery/policy/A+) на тот момент **полностью** обходились runner-путём (фикс в 1.11.233). Anti-chase в pipeline вообще не существовал.

После закрытия позиции (`BREAKEVEN_EXIT, -12.91%, exit mcap ≈ $3.14M`) сразу включились:
- `policy_a_plus:price_change_1h=-24.46%<-20%` (через 5 минут после exit'а)
- `recovery_veto_30m_bounce19.3>=12%` (через 8 минут)

То есть **defaults policy_a_plus и recovery_veto были корректно настроены**, но **не применялись** к runner-пути до 1.11.233.

### Изменения

**`src/live/jupiter.ts` — anti-chase helpers:**

```typescript
export function tokensPerInLamportFromQuote(quoteResponse): number | null
// outAmount / inAmount → относительная метрика цены без знания decimals/solUsd.
// Чем меньше, тем выше цена.

export function isBuyQuoteChasingAnchor({
  anchorTokensPerLamport, currentTokensPerLamport, maxChasePct
}): { chased: boolean; chasePct: number | null }
// chasePct = (anchor / current - 1) * 100
// chased=true, если цена выросла больше чем на maxChasePct % от anchor.
```

**`src/live/phase4-execution.ts` — интеграция в `runSolToTokenPipeline`:**

- Перед retry-loop: `let anchorTokensPerLamport: number | null = null`
- Внутри loop, после `priceImpactCheck`:
  1. Считаем `currentTokensPerLamport`
  2. Если anchor пуст и current валиден — фиксируем anchor (первый успешный quote)
  3. Иначе, если `liveBuyMaxChasePct > 0` и есть оба значения, вызываем `isBuyQuoteChasingAnchor`
  4. При `chased=true` — terminal `chase_aborted`, запись `execution_result.error.message = chase_aborted:buy:X.XX%>+Y.YY%(attempt=N)`, выход из pipeline

**`src/live/phase4-types.ts`:** Добавлен `'chase_aborted'` в `LiveBuyTerminalKind`.

**`src/live/config.ts`:**

```typescript
liveBuyMaxChasePct: z.coerce.number().min(0).max(50).default(0),
// env LIVE_BUY_MAX_CHASE_PCT, в %
```

**`ecosystem.config.cjs`:**

```
LIVE_BUY_MAX_CHASE_PCT='3'    // 3% — нормальный intra-retry drift пропускаем, реальный chase блокируем
```

### Семантика

`chase_aborted` НЕ записывается в `staged-add-sim-cooldown` как `sim_err` (он идёт через `failure('other', ...)`, не через slippage-class). Это значит после chase-abort'а **на следующем discovery-tick'е** mint опять оценится, и если signal-price пересоздался на свежей цене (и протектор пропустил) — войдём заново. Если же протектор (recovery/local-high) триггерится — пропустим. Это правильное поведение: догонять не надо, но и блокировать монету надолго после legitimate retry-failure тоже не стоит.

### Что НЕ вошло в этот релиз (вынесено в 1.11.235)

- **Stale-exit guard для runner-позиций.** Защита на стороне tracker'а: для open trades с `entryPath='runner'` отслеживать затухание `vol_1h` / `bs_1h` и форсировать ранний exit. Требует расширения `OpenTrade`, integration с PG context в трекере и проработки гейтов — отдельный релиз с обкаткой.

### Тесты

- `tests/jupiter-anti-chase.test.ts` — **12 unit-tests:**
  - `tokensPerInLamportFromQuote` parses string/numeric/missing
  - `isBuyQuoteChasingAnchor`: off (`maxChasePct=0`), null inputs, chase detected, below limit, downward price (negative chase), boundary tests
  - Integration: VIRL-подобный сценарий (140e9→133e9 outAmount, +5.26% chase) → blocked@3%
- Все 437 unit-tests проходят (включая 12 новых).

### Откат

```bash
git revert <commit-sha>
git tag -d sa-alpha-1.11.234
# либо: env LIVE_BUY_MAX_CHASE_PCT=0 (отключить guard без отката кода)
```

Откат через `LIVE_BUY_MAX_CHASE_PCT=0` без code-changes — самый дешёвый: anti-chase станет no-op, остальной поведение pipeline'а не меняется.

---

## [1.11.233] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.233`.

### Fix: recovery-veto + local-high-veto + policyA+ теперь работают и для runner-пути

**Фон.** В 1.11.232 Runner Mode был добавлен как параллельный путь discovery, но **полностью обходил protector-фильтры** (recovery-veto, local-high-veto, policyA+, sybil, ephemeral, pg-coverage). Эти protectors были рассчитаны только внутри dip-блока, и runner-путь обходил их вместе со снэп-флором.

**Инцидент VIRL ($Biyw…) 20 мая 22:23 мск:**
- Runner-сигнал на $0.003609, velocity=1.69x
- 8 неудачных execution_attempts за 130 секунд (Jupiter sim/quote retries)
- Купили на 8-й попытке по $0.003647 = **+1.05% slippage от signal**
- Recovery-veto должен был сработать (классический догон отскока), но не сработал, потому что runner-путь не дёргал его
- Через 2.5 минуты позиция в пике +9.14%, сработал TP_LADDER на 10% (+$3.60), затем откат

Пользователь верно заметил: «после отскоков у нас же была фича рекавери вето». Она есть. Я её ошибочно отключил для runner.

### Изменения

**`src/papertrader/discovery/dip-clones.ts` — реструктуризация цикла:**

- Раньше: recovery-veto / local-high-veto / policyA+ / sybil / ephemeral / pg-coverage применялись ВНУТРИ `if (snapshotGatePass && dipEval.reasons.length === 0)`. То есть только когда dip-фильтр уже прошёл.
- Теперь: единый блок protector-checks **после** определения entryPath любым путём (`dip_windows` / `impulse_pg_snap` / `runner`). Если любой protector блокирует — `entryPath=undefined`, причины уходят в reasons.

Логика прохода для runner:
1. dip не прошёл (`dip_no_window_pass`) → entryPath остаётся undefined
2. `evaluateRunner` дал pass → `entryPath = 'runner'`
3. **НОВОЕ:** `evaluateRecoveryVeto` → если триггерится, `entryPath = undefined`
4. **НОВОЕ:** `evaluateLocalHighVeto` → то же
5. **НОВОЕ:** `evaluatePolicyAPlus` (если включён) → то же
6. **НОВОЕ:** `evaluatePgDataCoverageGuard` → то же
7. **НОВОЕ:** `evaluateVolumeSybilGuard` → то же
8. **НОВОЕ:** `evaluateVolumeEphemeralGuard` → то же

Runner по-прежнему **обходит** `evaluateSnapshot` (snapshot-floor `vol5m<10k`, `bs<0.98`, `liq<140k`) — это правильно, потому что 5-минутный snapshot не репрезентативен для оценки магнита интереса. Но protector-фильтры (которые работают на исторических данных) теперь применяются ко всем путям одинаково.

### Что НЕ вошло (вынес в 1.11.234)

- **Anti-chase guard:** если за время retries Jupiter quote'ов цена ушла от signal > X%, abort buy. В случае VIRL мы догнали +1% за 130s execution_attempts. Защита `entrySplitMaxUpPct=3` сейчас работает только для leg2 (вторая нога split'а), не для leg1.
- **Stale-exit guard на tracker** (как обещано в 1.11.232).

### Файлы

- **MOD:** `src/papertrader/discovery/dip-clones.ts` — единый protector-блок для всех путей.
- **MOD:** `docs/strategy/release/VERSION` → `1.11.233`.

### Откат

`git revert <commit>` или вернуть `dip-clones.ts` к предыдущей версии. Runner-фильтр (env-флаг `PAPER_RUNNER_MODE_ENABLED`) при этом продолжит работать, но без protector-защиты. Не рекомендую.

---

## [1.11.232] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.232`.

### Live Oscar — Runner Mode (параллельный путь discovery «магнит открытого интереса»), холдеры отключены

**Фон.** Аналитика показала: за прошлые сутки наш dip-фильтр **видел** трёх свежих раннеров (A1/WORLDCUP, TOESCOIN, MANIFEST/BC, плюс HENRY/DEGEN/ATTENTION в скринере), но **никогда не пускал**. Главный блок — `dip_not_deep_enough>-20%` (на A1: 1321 из 2330 evals). Наша discovery построена вокруг идеи «купить откат -20% за 120/360/720 минут» — но свежий раннер в фазе разгона таких откатов просто не делает, и в итоге мы валимся в тухлые монеты типа TripleT (85 дней, sells>buys, peak vol $30k vs $50–96k у свежих), где dip-сетап формально нашёлся.

Параллельно — холдеры, которые после v1.11.231 показывали 0 событий live-резолва в журнале, превратились в источник ложных блоков `holders<3000` для всех свежих pump.fun токенов (где `tokens.holder_count=NULL` → 0 → авто-блок). Пользователь явно отказался от холдеров как ненадёжного сигнала: «не нужен нам никакой holder count, не умеешь считать — забудь».

**Решение — два больших куска:**

#### 1) Runner Mode — параллельный путь к dip-windows (`src/papertrader/discovery/runner-mode.ts`, `dip-clones.ts`)

Новый discovery-путь, который оценивает кандидата не по dip-окнам, а по **динамике открытого интереса** (поток объёма, чистый buy-flow, ликвидность) за окна 1ч/12ч/24ч. Работает рядом с dip-фильтром, не заменяет его: если хотя бы один из путей даёт `pass=true`, кандидат проходит. Никаких ограничений по возрасту (3-месячная монета со «вторым разгоном» — такой же магнит), никаких холдеров.

**PG fan-out:** один SQL UNION ALL по 5 DEX-таблицам за 24ч, агрегация через `FILTER (WHERE ts >= NOW() - INTERVAL '…')`. Один tick — один запрос на все candidate-mints. Внутри `Promise.all` рядом с dip/policy/sybil/ephemeral/coverage контекстами.

**Параметры (defaults в `ecosystem.config.cjs`):**

| env | default | назначение |
|---|---|---|
| `PAPER_RUNNER_MODE_ENABLED` | `1` | вкл/выкл рядом с dip-путём |
| `PAPER_RUNNER_MIN_PG_SAMPLES_24H` | `36` | минимум PG-строк за 24ч для доверия velocity |
| `PAPER_RUNNER_MIN_VOL_1H_USD` | `80000` | минимум часового объёма ($) |
| `PAPER_RUNNER_MIN_VOL_12H_USD` | `400000` | минимум 12-часового объёма ($) |
| `PAPER_RUNNER_VELOCITY_MIN_X` | `1.5` | `vol_1h / (vol_24h/24)` — последний час в 1.5× выше среднего часа за сутки |
| `PAPER_RUNNER_MIN_VOL_5M_PEAK_1H_USD` | `20000` | пиковый 5-мин объём за час (bursty flow) |
| `PAPER_RUNNER_BS_1H_MIN` | `0.95` | buys/sells за 1ч |
| `PAPER_RUNNER_BS_12H_MIN` | `1.0` | buys/sells за 12ч — кумулятивный buy-side тренд |
| `PAPER_RUNNER_LIQ_VS_P25_MIN` | `0.85` | `liq_now ≥ 0.85 × liq_p25_24h` — ликва не утекла |
| `PAPER_RUNNER_PRICE_HOLD_MIN` | `0.6` | `price_now / price_max_24h ≥ 0.6` — не -40% от 24h-пика |
| `PAPER_RUNNER_MIN_MCAP_USD` | `1000000` | пыль не интересна |
| `PAPER_RUNNER_MAX_MCAP_USD` | `30000000` | upside остался |
| `PAPER_RUNNER_MIN_LIQ_USD` | `80000` | базовый liq-floor |
| `PAPER_RUNNER_STALE_VOL_RATIO_MAX` | `0.5` | **TripleT-test**: если `vol_1h < (vol_24h/24) × 0.5` — внимание утекает, runner отказ |

**Интеграция в discovery loop:** после dip/recovery/localHigh/policyA+/sybil/ephemeral/coverage, если ни `dip_windows`, ни `impulse_pg_snap` не дали `entryPath`, оценивается `evaluateRunner(cfg, row, ctx)`. При `pass=true`:

- `entryPath='runner'`
- `baseReasons=[]` (обходим snapshot-floor `vol5m<10k`, `bs<0.98`, `liq<140k` — это пороги single-tick view, не репрезентативные для оценки магнита интереса; вместо них runner проверяет собственные окна 1h/12h/24h)
- **НЕ обходим** cooldown / whale / permanent denylist / whitelist — это работает дальше как обычно.

Runner features прикреплены к `decisionFeatures.runner` всегда, когда мод включён — даже когда runner не прошёл, мы видим в JSONL все аггрегаты для пост-аналитики и тюнинга порогов.

Если runner не прошёл и dip тоже не прошёл, `runnerReasons` (например `runner_vol1h<80000`, `runner_stale_vol1h<0.5x_of_avg(0.32x)`) дополняют `eval.reasons` для диагностики.

**Telegram-ивент `live_position_open` (`src/papertrader/main.ts`, `src/live/events.ts`):**

- Добавлены поля `entryPath` (`dip_windows`/`impulse_pg_snap`/`runner`/`null`) и `runnerFeatures` (только когда вход через runner) — будет видно прямо в нотификации, каким путём зашли.
- Z-schema `LivePositionOpenSchema` расширена.

**Тесты (`tests/runner-mode.test.ts`, 11 кейсов, все проходят):**

- A1/WORLDCUP, MANIFEST — pass, реальные PG-данные за 20 мая.
- TripleT — fail по `runner_bs1h<` / `runner_bs12h<` / `runner_velocity<`.
- Declining attention — fail по `runner_stale_vol1h<`.
- Liq drained, mcap<min, mcap>max — каждый кейс блокирует отдельной причиной.
- 3-месячный токен со свежим импульсом — pass (нет age-фильтра).
- summariseRunnerPass — компактная читаемая строка для Telegram.
- Disabled mode + coverage skip.

#### 2) Холдеры выключены полностью (`ecosystem.config.cjs`)

```
PAPER_HOLDERS_LIVE_ENABLED: '0'   (было '1')
PAPER_HOLDERS_USE_QN_ADDON:  '0'   (было '1')
PAPER_HOLDERS_MAX_PER_TICK:  '0'   (было '10')
PAPER_HOLDERS_DB_WRITEBACK:  '0'   (было '1')
```

Все pipeline-вызовы становятся no-op (`holdersLiveEnabled=false` → `liveHoldersForObservability=false`, warmup не вызывается, evaluator не пишет `holders<…`).

Это устраняет регресс: для всех свежих pump.fun mint'ов `tokens.holder_count=NULL` → 0 → авто-блок `holders<3000`. Был **корневой** причиной, по которой A1 получил 1371 reasons блока за 2330 evals в `holders<3000`.

#### Что НЕ вошло в этот релиз (вынесено в 1.11.233)

- **Stale-exit guard на tracker'е**: при затухании vol_1h / buy-flow на уже открытой позиции — продавать агрессивнее (сдвиг TP-уровней). Это требует изменений в tracker, и совмещать с новой логикой входа рискованно. Дождёмся, что runner-mode даст наблюдаемые покупки, потом подключим stale-exit отдельно.
- **Отдельный sizing для runner** (`LIVE_RUNNER_BUY_SOL_BASE`). Пока runner использует тот же sizing, что и dip; решим по факту наблюдения.

### Файлы

- **NEW**: `src/papertrader/discovery/runner-mode.ts` — модуль (фетчер + evaluator + summariser).
- **NEW**: `tests/runner-mode.test.ts` — 11 unit-тестов.
- **MOD**: `src/papertrader/discovery/dip-clones.ts` — runner-context в `Promise.all`, runner-eval параллельно dip-windows, features в `decisionFeatures.runner`.
- **MOD**: `src/papertrader/config.ts` — 14 новых полей `runner*` + env-маппинг `PAPER_RUNNER_*`.
- **MOD**: `src/papertrader/types.ts` — `SnapshotFeatures.runner` (полный набор аггрегатов и порогов).
- **MOD**: `src/papertrader/main.ts` — `entryPath` + `runnerFeatures` в `live_position_open`.
- **MOD**: `src/live/events.ts` — Z-schema `LivePositionOpenSchema` расширена.
- **MOD**: `ecosystem.config.cjs` — холдеры выключены, добавлены 14 `PAPER_RUNNER_*` env vars.
- **MOD**: `docs/strategy/release/VERSION` → `1.11.232`.

### Откат

`git revert <commit>` или ручной набор env:

```
PAPER_RUNNER_MODE_ENABLED=0
PAPER_HOLDERS_LIVE_ENABLED=1   # если хотите вернуть холдеры
```

Затем `pm2 reload ecosystem.config.cjs --update-env`. Код модуля runner-mode.ts остаётся в дереве (мертвый при `RUNNER_MODE_ENABLED=0`) — это даёт возможность включить обратно одним env без redeploy.

---

## [1.11.231] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.231`.

### Live Oscar — большая серия оптимизаций: холдеры, throttle pre-fan-out, adaptive priority fee, pre-arm sells, daily summary, file-watch denylist/whitelist

**Фон.** После 1.11.230 (stop sim_err loops, slippage adaptive bump, MTM probe scale-up) Live Oscar заметно стабилизировался — `consec_sim_fail` упал с 472 до 0. Но осталась куча точечных мест, где либо жгутся QN-кредиты впустую, либо данные неточные, либо реакция системы слишком медленная. В этом релизе — **10 оптимизаций в одном батче**, все с минимальным риском регрессии.

#### 1) Холдеры live (`src/papertrader/discovery/dip-clones.ts`, `holders-resolve.ts`)

- `PAPER_HOLDERS_LIVE_ENABLED=1` + `PAPER_HOLDERS_USE_QN_ADDON=1` — пробуем QN add-on `qn_fetchTokenHolders` (Pro/Token API, ~30 credits/call), fallback на native `getProgramAccounts` (100 credits/call), кэш 90s/15s neg.
- `PAPER_HOLDERS_ON_FAIL=warn` (раньше `db_fallback`) — при RPC-ошибке холдеров **не блокируем** покупку, пишем `holders_unknown` в decision.
- Новое разделение: `liveHoldersForObservability` (запрашиваем для всех `cheapPass` mint'ов) vs `liveHoldersForGate` (порог применяется только при `globalMinHolderCount > 0`). Точные холдеры теперь видны в JSONL даже при выключенном гейте (`PAPER_MIN_HOLDER_COUNT=0`).
- В сутки запросы будут только для 5-15 mint'ов, прошедших dip/recovery/vol/sybil — ≤ 0.1% бюджета QN.

#### 2) Pre-check Jupiter `priceImpactPct` ПЕРЕД simulate (`src/live/jupiter.ts`, `phase4-execution.ts`)

- Новые helper'ы `extractQuotePriceImpactPct` + `isQuotePriceImpactTooHigh`.
- `LIVE_BUY_MAX_PRICE_IMPACT_PCT=1.5` — если quote показывает > 1.5% impact, не идём в simulate, terminal `route_too_impactful`. Экономим simulate (`liveSimulateSignedTransaction`) + Jupiter `/swap` calls на глухих маршрутах.
- Sell-сторона по умолчанию off (`LIVE_SELL_MAX_PRICE_IMPACT_PCT=0`) — для exits важно протолкнуть сделку даже с просадкой.
- Новый `LiveBuyTerminalKind = 'route_too_impactful'`.

#### 3) Wallet SPL balance cache (`src/live/reconcile-live.ts`)

- TTL-кэш на `fetchLiveWalletSplBalancesByMint` (`LIVE_WALLET_SPL_BALANCE_CACHE_TTL_MS=15000`).
- Explicit invalidation после **каждого confirmed buy/sell** в pipeline — нет риска stale balance в реальных сделках.
- Снижает `getTokenAccountsByOwner` calls в 5-10× (tracker + sell pipeline). На 4 открытых позициях это ~80 QN-calls/час сэкономлено.

#### 4) Discovery throttle ПЕРЕД PG fan-out (`src/papertrader/discovery/dip-clones.ts`)

- Раньше `shouldEvaluate` throttle применялся внутри eval-loop **после** fan-out 5 PG-контекстов. Теперь throttle pre-filter, и fan-out читает только allowed mint'ы.
- Снижает PG-нагрузку discovery на 60-70% (зависит от throttle ratio).
- Throttled mint'ы из whitelist'а получают свой deep-аудит через отдельный pass.

#### 5) PG fan-out parallelization (`src/papertrader/discovery/dip-clones.ts`)

- 4 независимых PG-контекста (`dipMap`, `policyAPlusMap`, `volumeSybilMap`, `volumeEphemeralMap`) + `globalPgCoverage` теперь читаются через `Promise.all`. Раньше — последовательно (`await ... await ...`).
- Discovery tick latency ↓ в ~5× для PG-фазы. Full CTE-консолидация остаётся в backlog'е.

#### 6) Auto permanent-denylist после N rearm'ов cooldown (`src/live/staged-add-sim-cooldown.ts`)

- Новый счётчик `rearmsByMint` (через все intentKind). При `LIVE_STAGED_ADD_AUTO_DENYLIST_REARMS_THRESHOLD=5` rearm'ов (≈ 2.5 ч глухих sim_err) — mint в локальный permanent-denylist + Telegram ALERT.
- Защищён от двойных записей (`autoDeniedByMint` set).
- Stuck-mint'ы (Cm6fNnMk, BCdwQBAn, CcLd8HTA, etc.) теперь автоматически переезжают в denylist без вмешательства оператора.
- JSONL: `live_staged_add_auto_denylist`.

#### 7) Adaptive priority fee при congestion (`src/live/adaptive-priority-fee.ts`)

- Новый модуль с rolling-window (10 мин) counter'ом `confirm_timeout`. При 5+ подряд → boost `liveJupiterPriorityMaxLamports` × 2.5 на 30 мин.
- Hard cap 50M lamports (0.05 SOL) — защита от runaway boost.
- `LIVE_ADAPTIVE_PRIORITY_FEE_ENABLED=1` (включено по умолчанию).
- `success` сразу обнуляет counter (сеть отошла).
- JSONL: `live_priority_fee_boost`, `live_priority_fee_boost_expired`.

#### 8) Sell quote pre-arm для TP-ladder (`src/live/sell-quote-prearm.ts`)

- In-memory store armed quote per mint. `consumeArmedSellQuote` пробуется в начале sell-pipeline (только на attempt=0): если armed quote fresh + matches intent, пропускаем Jupiter `/quote` + `/swap` calls.
- Это **НЕ pre-signing** — подпись/отправка только при actual TP-trigger. Risk минимальный.
- Tracker integration оставлен как opt-in: модуль готов, но `armSellQuote` пока не зовётся (отдельная итерация после оценки baseline TP-latency).
- JSONL: `live_sell_quote_prearm_armed/consumed/expired`.

#### 9) Hot-reload whitelist + denylist (`src/live/mint-file-watchers.ts`)

- `fs.watch` на whitelist + permanent-denylist (seed + local) + debounce 500 ms.
- При изменении файла: reload, diff (added/removed), JSONL `live_mint_file_watch_change`, Telegram ADVICE с превью.
- Существующий mtime-poll-reload остаётся как fallback.

#### 10) Daily Telegram-сводка по live-oscar (`src/live/daily-summary.ts`)

- Раз в сутки в 00:00 MSK (`LIVE_DAILY_SUMMARY_HOUR_MSK=0`):
  - читает последние 24 ч `LIVE_TRADES_PATH` (хвост, до 50 MB);
  - агрегирует: discovery evaluated/passed, top-5 блокеров, buy attempts, confirmed buys/sells, closed PnL, sim_err total, cooldown rearms, auto-denylist adds, priority-fee boosts;
  - шлёт 1 REPORT message в Telegram + JSONL `live_daily_summary`.
- Используется `nextDailyFireMs` + `setTimeout.unref` — не держит event loop живым.

#### Changes — config & ecosystem

- `src/live/config.ts`:
  - `liveBuyMaxPriceImpactPct` / `liveSellMaxPriceImpactPct` (default 0 = off).
  - `liveWalletSplBalanceCacheTtlMs` (default 0).
  - `liveStagedAddAutoDenylistEnabled` / `liveStagedAddAutoDenylistRearmsThreshold` / `liveStagedAddAutoDenylistTelegramEnabled`.
  - `liveAdaptivePriorityFeeEnabled` / `liveAdaptivePriorityFeeThreshold` / `liveAdaptivePriorityFeeWindowMs` / `liveAdaptivePriorityFeeBoostFactor` / `liveAdaptivePriorityFeeHoldMs`.
- `ecosystem.config.cjs` для `live-oscar`:
  - `PAPER_HOLDERS_LIVE_ENABLED=1`, `PAPER_HOLDERS_USE_QN_ADDON=1`, `PAPER_HOLDERS_ON_FAIL=warn`.
  - `LIVE_BUY_MAX_PRICE_IMPACT_PCT=1.5`, `LIVE_SELL_MAX_PRICE_IMPACT_PCT=0`.
  - `LIVE_WALLET_SPL_BALANCE_CACHE_TTL_MS=15000`.
  - `LIVE_STAGED_ADD_AUTO_DENYLIST_ENABLED=1`, `LIVE_STAGED_ADD_AUTO_DENYLIST_REARMS_THRESHOLD=5`, `LIVE_STAGED_ADD_AUTO_DENYLIST_TELEGRAM_ENABLED=1`.
  - `LIVE_ADAPTIVE_PRIORITY_FEE_ENABLED=1`, `LIVE_ADAPTIVE_PRIORITY_FEE_THRESHOLD=5`, `LIVE_ADAPTIVE_PRIORITY_FEE_WINDOW_MS=600000`, `LIVE_ADAPTIVE_PRIORITY_FEE_BOOST_FACTOR=2.5`, `LIVE_ADAPTIVE_PRIORITY_FEE_HOLD_MS=1800000`.
  - `LIVE_DAILY_SUMMARY_ENABLED=1`, `LIVE_DAILY_SUMMARY_HOUR_MSK=0`, `LIVE_DAILY_SUMMARY_MAX_BYTES=52428800`.
  - `LIVE_MINT_FILE_WATCH_TELEGRAM_ENABLED=1`, `LIVE_MINT_FILE_WATCH_DEBOUNCE_MS=500`.

#### New tests (414 total, 32 new)

- `tests/adaptive-priority-fee.test.ts` — boost/expire/reset, hard cap.
- `tests/sell-quote-prearm.test.ts` — arm/consume/expire, intent/raw mismatch.
- `tests/jupiter-price-impact.test.ts` — extract + threshold check.
- `tests/daily-summary.test.ts` — aggregation, format, fire-time MSK.
- `tests/auto-denylist-rearms.test.ts` — rearms threshold, idempotency.

#### Migration / Rollback

- **Rollback v1.11.230:** `git revert <commit>` + redeploy. Все feature-флаги независимы — можно частично отключить через env (например `LIVE_ADAPTIVE_PRIORITY_FEE_ENABLED=0`).
- При сомнениях по холдерам — `PAPER_HOLDERS_LIVE_ENABLED=0` сразу возвращает поведение pre-1.11.231.

---

## [1.11.230] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.230`.

### Live Oscar — staged-add sim_err cooldown + smart slippage retry + Jupiter Pro tuning

**Фон.** Аналитика журнала за 7 дней: 3 161 execution_attempt → **89.6 % завершились `sim_err`** (2 832 шт.), причём 80 % шума делали 6 mint'ов (Cm6fNnMk 720, BCdwQBAn 430, CcLd8HTA 410, SPCX 360, TripleT 340, HfMbPyDdZH 280) — staged_avg / entry_split на этих mint'ах раз за разом упирался в Jupiter `InstructionError[*,{Custom:1}]` (route/slippage), и 11 retry-попыток впустую сжигали QN-кредиты + блокировали диск­авери. См. `solana-alpha/scripts-tmp/_analytics_probe.mjs`.

#### A.1 — staged-add sim_err cooldown (`src/live/staged-add-sim-cooldown.ts`)

- Новый per-(mint, intentKind) счётчик подряд идущих `sim_err`. При достижении `LIVE_STAGED_ADD_SIM_ERR_THRESHOLD` (default **3**) — заход в `runSolToTokenPipeline` блокируется на `LIVE_STAGED_ADD_SIM_ERR_COOLDOWN_MS` (default **30 мин**); событие `live_staged_add_cooldown` ложится в JSONL.
- Reset на любой не-sim_err исход (success / confirm_timeout / send_failed / gate / quote_stale).
- Применяется к `buy_open`, `dca_add`, `buy_scale_in` — выкатывает все loop'ы из tracker / discovery / staged-entry.

#### A.2 — smart retry classification (slippage = bail fast)

- Распознаём «slippage class» `sim_err`: `"Custom":1}`, `0x1771`, явный `slippage` в тексте (`isSlippageClassSimError`).
- На slippage-class:
  - bump `slippageBps` на `LIVE_SIM_SLIPPAGE_RETRY_BUMP_BPS` (default **50**) каждый retry, cap = `LIVE_SIM_SLIPPAGE_RETRY_MAX_BPS` (default **300**) — Jupiter Pro собирает route с приемлемым impact на разных пулах.
  - кэп slippage-retry: buy = **3 попытки** (50 → 100 → 150 bps), sell = **6 попыток** (50 → 100 → … → 300 bps). Sell кэп выше: exits должны проходить даже в просадке.
- Non-slippage retry-логика не меняется.
- В `execution_result` для sim_err теперь пишется `slippageBps` — увидим в логе, на каком пороге Jupiter в итоге сдался.

#### Jupiter Pro — увеличиваем загрузку (live trading quality)

- **MTM probe**: `[5..45 USD] @12 %` → `[20..200 USD] @10 %` (env `LIVE_TRACKER_MTM_PROBE_MIN_USD` / `_MAX_USD` / `_FRACTION`). Для $1000 позиции probe = $100 (vs $45), точнее USD-цена → tighter TP/SL.
- **`JUPITER_QUOTE_429_MAX_RETRIES`**: 5 → **8** (cap внутри `jupiter-http.ts` поднят 8 → 12). Backoff-лестница: 150 → 270 → 486 → … (Retry-After honoured).

#### QN — экспоненциальный backoff `getSignatureStatuses`

- Раньше: фиксированные **450 ms** между poll → 60 s deadline ≈ **133 QN-вызова**.
- Теперь: лестница `250, 350, 500, 700, 1000, 1500, 2000 ms` (cap) → **≈35 poll'ов** для того же deadline (×4 меньше QN-кредитов). Tx обычно подтверждается за 1-3 s, дополнительные «ещё не finalized» poll'ы после 5 s — пустая трата. Fallback на `getTransaction` (`tryRecoverConfirmedViaGetTransaction`) при истечении остаётся.

#### PG coverage (A.4 verification)

- Проверка живого VPS: `data/snapshot-freshness-watch-state.json` показывает `pgCoverageMode: "relaxed"`, `lastRecoveryAt` 15.7 ч назад. Это **корректное** поведение auto-escalate: `STRICT_AFTER_RECOVERY_HOURS=24` → ещё ≈ 8 ч до перехода в `full`. В последний час `data_coverage:*` блокировок 0 — глобальная проверка проходит на всех mint'ах.
- Артефакт: `strictRecoveryActive` (`pg-data-coverage-guard.ts:238-243`) — мёртвая ветка под auto-escalate; не блокер, остаётся как follow-up.

#### Dip discovery threshold tuning (A.3 — propose only, не реализовано)

Из 87 826 evaluations за 48 ч: pass = 144 (0.16 %), fail = 87 682. `dip_no_window_pass` блокирует 94 % всех fail'ов (`dip_not_deep_enough >-20%` на 120m/360m/720m). Идеи на потом (без кода): (1) добавить 30m/60m окно с менее строгим dip (-10 %); (2) адаптивный dip-порог под mcap (mid-cap -15 %, large-cap -25 %); (3) volume-weighted dip; (4) часовой пояс / market session. Текущие пороги уместны для бокового рынка, обновим когда нужно вход на ралли.

#### Tests

- `tests/staged-add-sim-cooldown.test.ts` (8) — threshold, isolation per-key, success reset, cooldown expiry.
- `tests/phase4-slippage-classifier.test.ts` (5) — Custom:1, 0x1771, text «Slippage», negative cases.
- Все 382 теста проекта проходят.

**Откат:** `git revert` коммита 1.11.230 + `pm2 reload live-oscar`. Окно cooldown в RAM сбрасывается на рестарте (in-memory, не персистится). На VPS остаются накопленные JSONL события `live_staged_add_cooldown` — не блокируют ничего, можно игнорировать.

**Влияние на работу.** Stuck mint'ы (Cm6fNnMk, BCdwQBAn, CcLd8HTA, SPCX, TripleT, HANTA) перестанут раз в 30 с уходить в pipeline и сжигать кредиты QN/Jupiter. По grobой оценке: 2 540 ненужных retry за 7 дней → не более 6 × 3 = 18 за тот же период. Освобождение QN-кредитов на полезные действия + чище execution_result для аналитики.

---

## [1.11.229] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.229`.

### Collectors — whitelist mint PG snapshots (DexScreener batch truncation)

- **`paper2-open-snapshot-enrich.mjs`:** mint из `live-oscar-mint-whitelist.txt` больше **не** идут только в batch `GET /dex/tokens/{m1,…,m10}` — DexScreener обрезает ответ и **теряет хвост списка** (например TOES `6ehEc…` в chunk из 4 mint: 30 пар, 0 с нужным base).
- Whitelist missing → **solo** `GET /dex/tokens/{mint}` на каждый mint; open/paper missing — batch по 10 как раньше.
- «Уже есть снимок» считается только по **`base_mint`** в строке (quote-only в trending больше не блокирует enrich).

**Откат:** `git revert` коммита 1.11.229 + `pm2 reload` всех `sa-*` collectors и `live-oscar`.

---

## [1.11.228] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.228`.

### Wave B TP — averaging-aware fork (без усреднения → первая ступень +7.5%)

- **Без усреднений** (только `open` + `entry_split`/`scale_in` — это и есть 500+500 сплит первой покупки): сетка `WAVE_B_V1_TP_GRID_NO_AVG` со step 0.025 и долями `[0, 0, 0.1, 0.25, 0.25, 0.25, 0.25, 0.25, 0.15]` — **первая активная продажа на +7.5% (10% остатка)**, +10/+12.5/+15/+17.5/+20 по 25%, +22.5 — 15%, дальше unlimited grid B продолжает.
- **После ≥1 усреднения** (`staged_avg` или `dca`): сетка `WAVE_B_V1_TP_GRID` `[0.05, 0.05, 0.05, 0.1]` — TP-ступени с **+2.5% / +5% / +7.5% по 5%**, +10% и выше — по 10% (step 0.025, unlimited).
- Развилка применяется **в runtime** (`tpGridEffective` смотрит на `ot.legs`) — старые in-flight позиции с устаревшими stamped `tpGridOverrides` тоже подхватывают правильный профиль без миграции; после фактического `staged_avg` `live-staged-entry-lifecycle` ре-стэмпит overrides под averaging-ветку.
- Trail/breakeven/defensive arm пороги не меняются: `WAVE_B_BREAKEVEN_EXIT_MIN_TP_FRAC=0.075`, `WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC=0.1`, trail step 0.025, sell fraction 20%.

**Mint затронут (расследование):** `J8PSdNP3…` (TripleT, 12:20 MSK) — открыт под `wave_b_v1` с старым `[0, 0, 0.1, 0.25, …]` без усреднений, +5–6% PnL не дошёл до +7.5% (первая активная ступень), ноль продаж. После апдейта поведение совпадает: **без усреднения первая продажа всегда от +7.5%**, как ожидал оператор.

**Откат:** `git revert` коммита 1.11.228 + `pm2 reload`. Открытые позиции, у которых `staged_avg` сработал между деплоями, в случае отката будут читать stamped overrides averaging-ветки (`[0.05, 0.05, 0.05, 0.1]`) — это безопасно, но если хочется вернуть pre-1.11.228 поведение для них, перезатереть `tpGridOverrides.gridSellFractionByStep` вручную в JSONL до рестарта.

---

## [1.11.227] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.227`.

### PG coverage guard — auto-escalate (relaxed ↔ full без ручного env)

- **`PAPER_PG_DATA_COVERAGE_AUTO_ESCALATE=1`**: во время дыры PG / низкого system ratio / первых 24h после recovery — **упрощённый** режим (recent 6h); когда PG здоров — автоматически **полный** 24h tier (system ratio 70%, strict recovery, full mint history + gap).
- Канонические пороги в env (`MIN_SYSTEM_HOUR_RATIO=0.7`, `STRICT_AFTER_RECOVERY_HOURS=24`) — не нужно вручную ставить 0 после outage.
- Режим пишется в `data/snapshot-freshness-watch-state.json` (`pgCoverageMode`); ADVICE Telegram при переключении (`live_oscar_pg_coverage_mode`).

**Откат:** `PAPER_PG_DATA_COVERAGE_AUTO_ESCALATE=0` + вручную `MIN_SYSTEM_HOUR_RATIO=0` / `STRICT_AFTER_RECOVERY_HOURS=0` как в 1.11.226.

---

## [1.11.226] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.226`.

### PG coverage guard — recent window (6h), не блокировать из‑за вчерашней 24h дыры

- Mint/gap/ephemeral coverage: **последние 6h** (`PAPER_PG_DATA_COVERAGE_RECENT_HOURS`), min **4** часа с данными.
- **24h system hour ratio выключен** по умолчанию на live-oscar (`MIN_SYSTEM_HOUR_RATIO=0`).
- **Strict-after-recovery выключен** (`STRICT_AFTER_RECOVERY_HOURS=0`) — sybil guard (6h) остаётся основной защитой от dead→spike.
- Gap check только в **recent** окне, не по 24h истории с вчерашним outage.

**Откат:** `MIN_SYSTEM_HOUR_RATIO=0.7`, `STRICT_AFTER_RECOVERY_HOURS=24`, убрать `RECENT_HOURS` + reload.

---

## [1.11.225] — 2026-05-20

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.225`.

### Discovery — min mcap на первом пороге; меньше спама в Telegram

- **Deep-audit whitelist inject:** mint с `COALESCE(mcap, fdv) < PAPER_DISCOVERY_MIN_MARKET_CAP_USD` больше **не впрыскиваются** в eval (как SQL lane).
- **`entryPath` / coverage / sybil / ephemeral:** только после **snapshot + global** pass — не тратим PG-запросы на sub-mcap кандидатов.
- **Universe-miss audit:** sub-mcap whitelist mint — **без** минутного `live_discovery_eval` / probe spam.
- **Telegram coverage ADVICE:** только если **единственный** блокер — `data_coverage:*` (не при `mcap<`, `liq<`, …).
- **near-ready pulse:** `mcap<` — hard block.
- **Whitelist:** удалён BABYTROLL (`6qdzMx4…`).

**Откат:** `git revert` коммита 1.11.225; вернуть mint в `live-oscar-mint-whitelist.txt` при необходимости.

---

## [1.11.224] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.224`.

### Telegram — восстановлены три канала (откат 1.11.221)

- **Advice / health / ALERT:** `-1003878024799` (`OPERATOR_TELEGRAM_CHAT_ID`)
- **Pumps (spike):** `-1003633176769`
- **Dips (pullback + retrace):** `-1003504887486`

**Откат:** вернуть 1.11.221 unified channel в ecosystem (не рекомендуется).

---

## [1.11.223] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.223`.

### PM2 — pullback + retrace в `ecosystem.config.cjs`

- **`market-pullback-telegram-watch`** и **`retrace-alert-watch`** в общем ecosystem (как spike); env + `OPERATOR_TELEGRAM_CHAT_ID`.
- Отдельные bash entry и `ecosystem.market-*-watch.cjs` — только справочник env.

**Откат:** удалить apps из `ecosystem.config.cjs`; вернуть `pm2 start scripts/*-pm2-entry.sh`.

---

## [1.11.222] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.222`.

### Live Oscar — PG data coverage guard (auto skip + Telegram)

- **`PAPER_PG_DATA_COVERAGE_GUARD_ENABLED=1`:** блокирует near-entry, если PG minute history gapped/тонкая — volume sybil/ephemeral нельзя доверять.
- Проверки: PG stale now, system hour ratio, mint max gap, insufficient sybil/ephemeral samples; strict min hour ratio 24h после recovery PG.
- **ADVICE `live_oscar_pg_data_coverage`** → `-1003878024799` при skip кандидата из‑за неполных данных.
- `snapshot-freshness-watch` пишет **`lastRecoveryAt`** в state для strict window.

**Откат:** `PAPER_PG_DATA_COVERAGE_GUARD_ENABLED=0` + `LIVE_PG_DATA_COVERAGE_TELEGRAM_ENABLED=0`; `pm2 reload live-oscar --update-env`.

---

## [1.11.221] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.221`.

### Observability — единый Telegram-канал оператора

- Все дефолтные **`TELEGRAM_CHAT_ID`**, **`SPIKE_*`**, **`PULLBACK_*`**, **`RETRACE_*`** и discovery ADVICE → **`-1003878024799`** (`OPERATOR_TELEGRAM_CHAT_ID` в `ecosystem.config.cjs`).
- Health pulse, snapshot stale, collector silence, hourly report, dips/pumps/retrace — один канал.

**Откат:** вернуть прежние chat id в `.env` / ecosystem; `pm2 reload --update-env`.

---

## [1.11.220] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.220`.

### Observability — PG snapshot freshness + collector silence alerts

- **`[HEALTH][live_oscar_pulse]`:** всегда `cand/eval/gate_skip` за окно discovery + `snap_worst_age_min` по dex; при stale PG — **`[ALERT][snapshot_stale]`** на heartbeat.
- **PM2 `sa-snapshot-freshness-watch`:** опрос PG каждые 5 мин, transition **`[ALERT][snapshot_stale]`** / recovery.
- **`sa-collector-watch`:** **`COLLECTOR_WATCH_TELEGRAM=1`**, детект «нет tick completed / mtime лога» > 8 мин → **`[ALERT][dex_collectors]`**.
- Env: **`SNAPSHOT_FRESHNESS_MAX_AGE_SEC=600`**, **`COLLECTOR_WATCH_SILENCE_MAX_MS=480000`**.

**Откат:** `pm2 delete sa-snapshot-freshness-watch`; `COLLECTOR_WATCH_TELEGRAM=0`; убрать snapshot lines из pulse (revert); `SNAPSHOT_FRESHNESS_MAX_AGE_SEC` не задавать.

---

## [1.11.219] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.219`.

### Live Oscar discovery — Volume Ephemeral guard (узкий burst объёма)

- Новый фильтр `volume-ephemeral-guard`: почасовой max `volume_5m` за **24h**; блок, если активных часов ≤4, пик ≥$20k, история разреженная (паттерн GOAT).
- Доп. tail-rule: текущий vol5m ≤30% от пикового часа при узком окне.
- Telegram `-1003878024799` при срабатывании (`LIVE_VOLUME_EPHEMERAL_TELEGRAM_*`, cooldown 30m).

**Откат:** `PAPER_VOLUME_EPHEMERAL_GUARD_ENABLED=0` + `LIVE_VOLUME_EPHEMERAL_TELEGRAM_ENABLED=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.218] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.218`.

### Live Oscar — без 30m cooldown после нехватки SOL

- Убран `markLiveWalletInsufficientForBuy` (30 мин mute TG / память о провале).
- TG про монеты: только **текущий** тик — если SOL сейчас не хватает, алерт не шлём; на следующем discovery-тике (~60s reeval) снова проверяем баланс и пробуем buy.
- Pre-check + no-retry на `Custom:1` внутри одного тика — без изменений.

**Откат:** revert + `pm2 reload live-oscar --update-env`.

---

## [1.11.217] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.217`.

### Live Oscar — без Telegram о монетах при нехватке SOL на покупку

- Проверка баланса кошелька vs Jupiter `quoteInAmount` перед `buy_open`; `execution_skip` `insufficient_wallet_sol_for_buy` без 11 retry на `Custom:1`.
- Канал `-1003878024799`: не шлём discovery TG (staged signal, local-high veto, risky, whitelist miss, `new_on_horizon` в pulse), если SOL не хватает на первую ногу ($500).
- После InsufficientFunds sim — suppress discovery TG 30 мин (`LIVE_DISCOVERY_TG_SUPPRESS_ON_INSUFFICIENT_SOL`, дефолт on).

**Откат:** revert; `LIVE_DISCOVERY_TG_SUPPRESS_ON_INSUFFICIENT_SOL=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.216] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.216`.

### Live Oscar discovery — Volume Sybil guard (dead → spike → dead)

- Новый фильтр `volume-sybil-guard`: смотрит **6 ч** истории `volume_5m` в PG snapshots, baseline p10 vs recent max (45 мин + текущий ряд).
- Блокирует wash/sybil-паттерн «тишина → резкий всплеск с нуля → снова тишина» (как SCAM).
- Env на `live-oscar`: `PAPER_VOLUME_SYBIL_GUARD_ENABLED=1`, lookback 6h, spike ratio ≥6×, baseline p10 ≤$3k.

**Откат:** `PAPER_VOLUME_SYBIL_GUARD_ENABLED=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.215] — 2026-05-19

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.215`.

### Live Oscar discovery — мин. market cap $3M на покупку

- `PAPER_DISCOVERY_MIN_MARKET_CAP_USD=3000000`: SQL universe + `evaluateSnapshot` (ref mcap = COALESCE mcap/fdv снимка).
- Блокирует micro-cap вроде SCAM (~$1.1M mcap при liq $160k+).

**Откат:** env `PAPER_DISCOVERY_MIN_MARKET_CAP_USD=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.214] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.214`.

### Live Oscar — flush хвоста ≤$100 без мелких TP

- `$100` flush для **всех** partial live-oscar (не только wave B).
- Полное закрытие при остатке **≤ $100** или если после плановой доли осталось бы **< $100** (убирает пару TP по ~$12 при хвосте ~$123).

**Откат:** revert; `pm2 reload live-oscar --update-env`.

---

## [1.11.213] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.213`.

### Канал pullback/retrace (−1003504887486) — мин. капа $1M

- `PULLBACK_ALERT_MIN_MARKET_CAP_USD` и `RETRACE_ALERT_MIN_MCAP_USD`: дефолт **1_000_000** (было $2M).
- Tier пролива от пика: порог ref mcap **$1M** (было $1.5M).

**Откат:** env `*_MIN_*_USD=2000000` + restart pullback/retrace entry.

---

## [1.11.212] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.212`.

### Live Oscar — первый вход по mint: kill −7%, без усреднения, denylist при убытке

- Mint **без** записи в `live-oscar-mint-graduated.txt`: split **$500+$500**, signal-kill **−7%** (env `LIVE_MINT_FIRST_PROBE_KILL_DROP_PCT`), **без** доборов −7%/−14%.
- Убыточное полное закрытие → **permanent denylist** + Telegram `live_first_mint_probe_deny`.
- Прибыльное полное закрытие → mint в **graduated**; следующие входы — стандартная prod-логика (−7/−14, kill −25%).

**Откат:** `LIVE_MINT_FIRST_PROBE_ENABLED=0` + `pm2 reload`; удалить graduated/deny строки при необходимости.

---

## [1.11.211] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.211`.

### PM2 prod — только live-oscar (бумажные процессы выключены)

- `paper-oscar-risky`, `paper-oscar-v21`, `paper-oscar-v22` **не попадают** в `pm2 reload`, пока не задан `PM2_PAPER_OSCAR_APPS_ENABLED=1`.
- Конфиги процессов **сохранены** в `ecosystem.config.cjs`; **live-oscar**, дашборд, коллекторы — без изменений.

**Откат:** `PM2_PAPER_OSCAR_APPS_ENABLED=1` + `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.210] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.210`.

### Live Oscar — denylist после убытка только если net PnL ≤ −$150

- `LIVE_NEGATIVE_TRADE_DENY_MIN_LOSS_USD=150`: мелкие минусы (например −$50) **не** блокируют mint; в permanent denylist — только при убытке **строже** −$150.

**Откат:** revert; изменить env или `0` для старого поведения «любой минус».

---

## [1.11.209] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.209`.

### Live Oscar — вход без whitelist, denylist после убытка, тише Telegram

- **`LIVE_MINT_WHITELIST_ENABLED=0`:** новые входы не требуют whitelist; **permanent denylist** и **blacklist** по-прежнему блокируют.
- После **любого** убыточного полного закрытия live → mint в **локальный permanent denylist** + Telegram `live_negative_trade_deny` (ALERT-канал whitelist-бота).
- Выключены ADVICE: **`live_oscar_staged_signal`**, **`live_oscar_local_high_veto`**.

**Откат:** `WHITELIST_ENABLED=1`; убрать env `STAGED_ENTRY`/`LOCAL_HIGH` или поставить `=1`; revert denylist hook.

---

## [1.11.208] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.208`.

### Wave B — flush остатка &lt;$100 на всех partial (TP + trail)

- В `tryExecuteTpPartialSell`: если modeled remainder **&lt; $100**, `sellFraction=1` для Wave B (не только trail).
- Общая функция `waveBAdjustSellFractionForRemainder`.

**Откат:** revert `1.11.208`; `pm2 reload --update-env`.

---

## [1.11.207] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.207`.

### Live Oscar Wave B — защитный трейл, сброс TP, breakeven, kill −25%

- **Защитный трейл** после **≥ +10%** (TP или peak): −2.5% от хая, **20%** остатка, **без пола +7.5%** (trail до нуля).
- **Сброс TP-импульса:** после TP **≥ +7.5%**, откат **≤ +2.5%** — снова доступны ступени **+5% / +7.5% / +10%…** на новом росте.
- **Breakeven:** полный выход при **≤ 0%** к средней только если был TP **≥ +7.5%** (`BREAKEVEN_EXIT`).
- **Kill:** `PAPER_DCA_KILLSTOP=-0.25`; signal staged kill **25%** (`PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT=25`).

**Откат:** revert; ecosystem `KILL_DROP_PCT=23`, `DCA_KILLSTOP=-0.20`; `pm2 reload --update-env`.

---

## [1.11.206] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.206`.

### Live Oscar Wave B — двухфазная TP-сетка + trail 20%

- **Фаза 1:** +2.5% / +5% / +7.5% к средней — по **5%** остатка на ступень.
- **Фаза 2:** с +10% и выше (шаг 2.5%) — по **10%** остатка на ступень.
- **Trail:** −2.5% от якоря хая — **20%** остатка (`PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION=0.20`).
- На ATH трейл не режет — TP продолжается с уже взятых ступеней (one-shot `ladderUsedLevels`).

**Откат:** revert + `TRAIL_SELL_FRACTION=0.30` при необходимости; `pm2 reload`.

---

## [1.11.205] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.205`.

### Live Oscar Wave B — one-shot TP ladder (fix re-arm spam)

- `waveBOnNewHigh` больше **не снимает** `ladderUsedLevels` / `ladderUsedIndices` на новом хае — ступени TP не перепродаются на той же цене.
- TP grid: **не больше одной** cash-partial с `sellFraction>0` за тик (Wave B); нулевые ступени (+2.5% / +5%) по-прежнему только помечаются.

**Откат:** revert; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.204] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.204`.

### Live Oscar Policy A+ — окно «ножа» 30m → 15m

- `PAPER_POLICY_A_PLUS_PRICE_CHANGE_WINDOW_MIN=15`: правило свежего пролива сравнивает цену с якорем **~15 мин назад** (было 30). Порог −10% без изменений.
- В `live_discovery_eval` причина: `policy_a_plus:price_change_15m=…`.

**Откат:** `30` или revert; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.203] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.203`.

### Live Oscar Policy A+ — порог отскока от 30m low 1% → 2.5%

- `PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT=2.5` в `ecosystem.config.cjs` (`live-oscar`).

**Откат:** `1.0` + `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.202] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.202`.

### Live Oscar staged-entry — TTL сигнала выключен

- `PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS=0` (дефолт в коде и `ecosystem.config.cjs`): план сплита/усреднений **не снимается по возрасту сигнала**; второе усреднение на −14% не блокируется из‑за «часа с сигнала».
- Положительное значение TTL по-прежнему включает старое поведение.

**Откат:** `PAPER_LIVE_STAGED_ENTRY_SIGNAL_TTL_MS=3600000` (или `60000`) + revert; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.201] — 2026-05-18

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.201`.

### Live Oscar Wave B — trail flush остатка &lt; $100

- При срабатывании `TRAIL_STEP`, если остаток позиции **&lt; $100** (modeled net), продаётся **100%** хвоста одним partial, а не 30%.
- Константа `WAVE_B_TRAIL_FLUSH_REMAIN_USD`; лог `TRAIL_FLUSH_remain<100$`.

**Откат:** revert; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.200] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.200`.

### Live Oscar — Telegram при BTC gate (новые buy_open)

- При переходе в блок **`btc_dump_1h` / `btc_dump_4h`**: `[ADVICE][live_btc_gate_block]` в канал **`LIVE_MINT_WHITELIST_TELEGRAM_*`** (тот же, что дайвы / whitelist miss).
- При снятии блока: **`live_btc_gate_clear`**. Edge-trigger (без спама на каждый skip).
- Выключение: **`LIVE_BTC_GATE_TELEGRAM_ENABLED=0`**.

**Откат:** revert; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.200] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.200`.

### Pullback/retrace — пик = последний локальный хай ноги

- Пик не глобальный max за 90 мин: max на [пик..текущий бар] (как откат от 22:20, а не от 21:31).
- Та же правка в `findPumpRetraceFromBars` для retrace-watch.

**Откат:** revert; restart pullback + retrace PM2.

---

## [1.11.199] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.199`.

### Telegram market alerts — тикер в начале сообщения

- Spike, pullback и retrace: первая строка — **symbol** (при отсутствии — name).

**Откат:** revert; перезапуск `market-spike-telegram-watch`, `market-pullback-telegram-watch`, `retrace-alert-watch`.

---

## [1.11.198] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.198`.

### Live Oscar — duplicate 2-я нога сплита после PM2 reload

- `reconcileEntrySplitV2FromLegs`: при restore/тике, если в `legs[]` уже есть `entry_split`, выставляется `entrySplitLeg2Done=true` (не повторять $500 при той же цене).
- То же для `staged_avg` → `avgFirstLegDone` / `avgSecondLegDone`.

**Откат:** revert; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.197] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.197`.

### Канал pullback/retrace — один алерт на откат (meteora + pumpswap)

- Дедуп по **mint + 15‑мин bucket пика** (пик 14:37 и 14:38 = одно событие).
- Атомарный `reserveRetracePullbackChannelSlot` под file-lock — нет гонки между pullback и retrace PM2.

**Откат:** revert; перезапуск pullback + retrace entry-скриптов.

---

## [1.11.196] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.196`.

### Live Oscar whitelist — TROLL

- `5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2` (TROLL) в `live-oscar-mint-whitelist.txt` и risky-whitelist; на VPS снят с `live-oscar-permanent-denylist.txt` (после авто-drop по consec-loss).

**Откат:** убрать mint из whitelist; при необходимости вернуть строку в local denylist.

---

## [1.11.193] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.193`.

### 24/7 — whitelist всегда в PG и discovery

- **Коллекторы** (`paper2-open-snapshot-enrich.mjs`): все mint из `live-oscar-mint-whitelist.txt` подмешиваются в DexScreener token-fetch (как open-позиции), снапшоты пишутся в `*_pair_snapshots`.
- **Discovery** (`injectWhitelistDiscoveryCandidates`): mint из WL, выбитые из топ-300 SQL, всё равно получают полный `live_discovery_eval` (lookback PG 60m, env `PAPER_WHITELIST_SNAPSHOT_LOOKBACK_MIN`).

**Откат:** revert; `pm2 reload ecosystem.config.cjs --update-env`.

---

## [1.11.195] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.195`.

### Live Oscar Wave B — ghost MTM больше не сливает позицию trail-ом

- **MTM clamp:** одно тиковое отклонение цены для exit-решений не больше ±12% от последней наблюдаемой (тонкий Jupiter / PG spike).
- **Trail:** не больше одного `TRAIL_STEP` за проход трекера; не стреляет при PnL ниже порога arm (+7.5%); сброс «фантомного» хая на открытых позициях без trail-продаж.
- **Дашборд:** корректные подписи `TRAIL_STEP` (не «TP +3% режим A»).

**Откат:** revert; `pm2 reload ecosystem.config.cjs --update-env` на VPS.

---

## [1.11.194] — 2026-05-17

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.194`.

### Канал pullback/retrace (XMarkt Finances) — один алерт на откат

- Дедуп по **mint + минута пика** (не по DEX-паре): meteora и pumpswap не дублируют.
- Общий файл `data/live/telegram-retrace-pullback-dedupe.json` между `market-pullback-telegram-watch` и `retrace-alert-watch` — не шлём и [MARKET][pullback], и [RETRACE] на одно событие.
- Pullback: один проход, лучший кандидат на mint за цикл.

**Откат:** revert; перезапуск pullback + retrace entry-скриптов на VPS.

---

## [1.11.192] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.192`.

### Spike Telegram — прозрачность расчёта и меньше ложных rolling-проливов

- В алерт: **Δ цена** и **Δ mcap** с метками **до/после** (время МСК, USD), тип сигнала (rolling / 2 бара).
- Rolling-пролив только если опора на **локальном хае** окна; проверка знака Δ mcap vs Δ цена.

**Откат:** revert; `pm2 reload market-spike-telegram-watch --update-env`.

---

## [1.11.191] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.191`.

### Таймлайн Live Oscar — сплит vs усреднение + whitelist

- Подписи open/close/dca: **1-я/2-я нога сплита входа**, **1-е/2-е усреднение** (не путать с DCA и не с «$700 legacy»).
- Live JSONL: `live_position_dca` + `timelineLabelRu` для ног сплита и staged-avg (вместо невалидных `live_entry_split`).
- Дашборд: replay `entry_split_add` / `staged_avg_add`, контекст v2 entry-split.
- Whitelist: `61V8vBaqAGMpgDQi4JcAwo1dmBGHsyhzodcPqnEVpump`, `6qdzMx4c9rL2X3Ns3SwZ8uEo4zReDPjdXpAEmpo7pump`.

**Откат:** revert; `pm2 reload ecosystem.config.cjs --update-env` на VPS.

---

## [1.11.190] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.190`.

### Telegram — дедуп по событию, не по длине cooldown

- **Spike:** повтор того же пампа/пролива не шлётся, пока «нога» та же (опора не откатилась назад); новая нога — снова алерт (cooldown 5 мин не мешает). Ключ poll-dedupe: `anchorTs`, не `ts_new`.
- **Pullback / retrace:** один алерт на пик отката; новый пик — новое сообщение.

**Откат:** revert; перезапуск трёх watcher’ов через entry-скрипты.

---

## [1.11.189] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.189`.

### Telegram spike / pullback / retrace — возраст токена и антиспам

- Минимальный возраст монеты для алертов: **8 ч** (`*_MIN_AGE_HOURS`) во всех трёх watcher’ах.
- Spike: **cooldown 60 мин** по mint (было 5 мин — повторные `[spike_pump]` каждые 5 мин); эскалация **[UPDATE] выключена** — одно сообщение на всплеск/пролив в окне cooldown.
- Pullback / retrace: cooldown по mint **60 мин** (было 30).

**Откат:** revert env в ecosystem и entry-скриптах; `pm2 reload market-spike-telegram-watch market-pullback-telegram-watch retrace-alert-watch --update-env`.

---

## [1.11.189] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.189`.

### Live Oscar — сплит входа $500+$500 и staged-усреднение с кулдаунами

- **Сплит входа (не усреднение):** 1-я нога $500, 2-я через 10 с при цене в +3% / −10% к якорю 1-й ноги (`reason=entry_split`).
- **Усреднение staged:** $150 @ −7% не раньше 3 мин после 1-й ноги сплита и только при drop в (−7%, −14%]; $150 @ −14% не раньше 5 мин после первого усреднения.
- Нотионал `PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` = **$1300**.

**Откат:** revert; ecosystem: прежние `FIRST_LEG_USD=700` и без `ENTRY_SPLIT_*`; `pm2 reload live-oscar --update-env`.

---

## [1.11.188] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.188`.

### Live Oscar — без внутренних капов QN и без гейта holders

- **`QN_FEATURE_BUDGET_DISABLED=1`** на `live-oscar`: месячные ведра `pri_fee` / `holders` / `sim` и др. не режут RPC (учёт в `data/qn-feature-usage.json` остаётся).
- **`PAPER_MIN_HOLDER_COUNT=0`**, **`PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX=0`** — проверка и прогрев holders выключены через env.
- **`PAPER_SIM_STRICT_BUDGET=0`**, **`IMPULSE_QN_ROLLING_MAX_CREDITS=0`** — сняты смежные внутренние лимиты sim / impulse QN.

**Откат:** revert; в ecosystem для `live-oscar` вернуть `PAPER_MIN_HOLDER_COUNT=3000`, убрать `QN_FEATURE_BUDGET_DISABLED`, восстановить прежние `QN_FEATURE_BUDGET_*`; `pm2 reload live-oscar --update-env`.

---

## [1.11.187] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.187`.

### Live Oscar wave B — фокус на зоне +10…+20%

- Профиль TP: **+7.5%** → **10%** остатка; **+10% … +20%** → **25%** каждая ступень; **+22.5%+** → **15%** (хвост).
- **+5%** без продажи (0%), trail arm по-прежнему с **+7.5%**.

**Откат:** revert + `pm2 reload live-oscar --update-env`.

---

## [1.11.186] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.186`.

### Live Oscar — wave B на уже открытой позиции

- При `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=1` первая обработка тиком переводит `legacy_grid` → `wave_b_v1` (остаток, partials, `ladderUsedLevels` сохраняются).
- Лог: `[EXIT_POLICY] … legacy_grid → wave_b_v1`.

**Откат:** `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=0` + reload (новые тики снова pin legacy; уже мигрированная сделка останется wave до закрытия — при откате закрыть вручную или дождаться exit).

---

## [1.11.185] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.185`.

### Live Oscar — включить wave B для новых сделок (prod)

- `ecosystem.config.cjs` (`live-oscar`): `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=1`, trail step sell **30%**.
- Текущие открытые позиции без `liveExitPolicyId` остаются на **legacy_grid** (см. 1.11.184).

**Откат:** `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=0` + `pm2 reload live-oscar --update-env`.

---

## [1.11.184] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.184`.

### Live Oscar — политика выхода «wave B» (поэтапно, безопасно для открытых позиций)

- **`liveExitPolicyId`** на сделке: `legacy_grid` (текущая сетка + `ladder_retrace`) или `wave_b_v1` (сетка 2.5%, stepped trail, без TIMEOUT).
- **Restore / открытые позиции без policy id** → автоматически `legacy_grid` с **закреплённым** prod-профилем `0.05` / `0.10,0.30,0.50,0.70,0.70` в `tpGridOverrides` (не подхватывают новый env после деплоя).
- **Wave B** (флаг `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=1` только для **новых** open): TP `0/10/20%`, trail partial **30%** каждые −2.5% от хая с arm **+7.5%**, повтор TP после нового хая, `TRAIL_STEP` partial, полный `ladder_retrace` и TIMEOUT отключены для wave.
- Env: `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B`, `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION`, `PAPER_TRAIL_MODE=stepped_grid` (для wave через effective cfg).

**Откат:** `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=0`; `git revert`; `pm2 reload live-oscar`. Открытые wave-сделки до revert сохраняют policy id в JSONL.

---

## [1.11.183] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.183`.

### Spike Telegram — короче текст алерта

- **`market-spike-telegram-watch`:** из сообщения убраны `[ROLLING]/[MARKET]`, строки **тип**, **окно**, **dex**, **Market cap →**, футер **Мин. снимки PG** и блоки **1–2–3**; остаются тег `[spike_*]`, %, **tier**, символ, **GMGN**, **holders**, **liq**. Логика детектора без изменений.

**Откат:** `git revert`; `pm2 restart market-spike-telegram-watch`.

---

## [1.11.182] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.182`.

### Канал pullback/retrace — tier пролива по mcap

- Перед отправкой в Telegram: ref mcap **$1.5M–$4M** → пролив **≥17%**; **$4M–$8M** → **≥13%**; **≥$8M** → **≥9%**; ниже **$1.5M** — не слать (`market-pullback-telegram-watch`, `market-pump-retrace-alert-watch`).

**Откат:** `git revert`; `pm2 restart market-pullback-telegram-watch retrace-alert-watch`.

---

## [1.11.181] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.181`.

### Market watch Telegram — два канала по умолчанию

- **Spike** (`market-spike-telegram-watch`, tier по mcap и минутные/rolling окна): дефолтный **`SPIKE_ALERT_TELEGRAM_CHAT_ID=-1003633176769`** в `ecosystem.config.cjs`, `ecosystem.market-spike-watch.cjs`, `scripts/spike-watch-pm2-entry.sh`.
- **Pullback + Retrace** (блоки 1–2–3): дефолтный **`PULLBACK_ALERT_TELEGRAM_CHAT_ID` / `RETRACE_ALERT_TELEGRAM_CHAT_ID=-1003504887486`** в `ecosystem.market-pullback-watch.cjs`, `ecosystem.retrace-alert-watch.cjs` и соответствующих entry-скриптах.
- **`.env.example`:** пояснение, что каналы не смешивать; переопределение через `.env` при необходимости.

**Откат:** `git revert`; на VPS при «залипшем» старом chat id в дампе PM2 — `pm2 delete` + старт из актуального ecosystem/entry или явные значения в `.env`, затем `pm2 restart` / `pm2 save`.

---

## [1.11.180] — 2026-05-16

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.180`.

### Retrace Telegram — тот же каркас, что у market-pullback

- **`retrace-alert-watch` / `market-pump-retrace-alert-watch`:** текст алерта выровнен с **pullback**: шапка с **dex**, строка **lookback + пороги + факт**, имя токена, **Mint + GMGN**, блоки **1 / 2 / 3** (лой, хай, просадка) с датой **МСК**, **mcap** и **price_usd** по барам PG, строка **Ref mcap/fdv · holders** (без отдельной строки pair и без старого «компактного» однострочного таймлайна).

**Откат:** `git revert`; на VPS `pm2 restart retrace-alert-watch` (или полный выкат по NORM).

---

## [1.11.179] — 2026-05-15

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.179`.

### Live Oscar — частичный выход у безубытка после первой TP

- После **≥1** частичной фиксации с причиной **`TP_LADDER`** (TP-сетка или дискретная лестница), если цена относительно **средней эффективной** (`avgEntry`) снова **≤ безубытка** (`xAvg ≤ 1`), **один раз** за сделку продаётся настраиваемая **доля остатка** (по умолчанию **50%**). Лестница TP не помечается как «ещё одна ступень»; **`ladder_retrace`**, staged-доборы и остальные выходы **не менялись**.
- **`PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED`**, **`PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_FRACTION`** — в `config.ts` + **`.env.example`**; в **`ecosystem.config.cjs`** для процесса **`live-oscar`** включено `1` / `0.5`.
- Журнал: причина частичного выхода **`BREAKEVEN_TRIM`**; снапшот открытой позиции: **`liveBreakevenTrimDone`** (`strategy-snapshot` + replay `store-restore`).
- **Дашборд** (`scripts-tmp/dashboard-server.ts`): подпись таймлайна для `BREAKEVEN_TRIM`.

**Откат:** `git revert`; на VPS выставить `PAPER_LIVE_OSCAR_BREAKEVEN_TRIM_AFTER_FIRST_TP_ENABLED=0` (или убрать из ecosystem) и `pm2 reload ecosystem.config.cjs --update-env`. Открытые позиции с уже выставленным `liveBreakevenTrimDone` при откате кода без revert журнала могут потребовать ручной сверки.

---

## [1.11.178] — 2026-05-12

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.178`.

### Market pullback Telegram — снова блоки 1–2–3

- Вернена иерархия **1 / 2 / 3** (лой, хай, просадка с датой, mcap, `price_usd`), как в 1.11.176.
- Сохранены **ссылка GMGN** на mint и **отсутствие строки Pair** в тексте алерта (без «компактного» шаблона вместо пунктов).

**Откат:** `git revert`; `pm2 reload` процесса `market-pullback-telegram-watch`.

---

## [1.11.177] — 2026-05-15

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.177`.

### Market pullback / spike Telegram — отбор ≥$2M, GMGN без pair в тексте

- **Мин. капа по умолчанию $2M:** `PULLBACK_ALERT_MIN_MARKET_CAP_USD` и `SPIKE_ALERT_MIN_MARKET_CAP_USD` (код + `ecosystem*.cjs` + entry-скрипты + `.env.example` для spike).
- **Pullback:** в алерт добавлена ссылка **GMGN** на mint; строка **pair** из сообщения убрана.
- **Spike:** в HTML — ссылка **GMGN** и mint; строка **pair** убрана; в plain — `GMGN: URL` и mint, без pair.

**Откат:** `git revert`; при необходимости вернуть env `*_MIN_MARKET_CAP_USD=1500000`.

---

## [1.11.176] — 2026-05-15

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.176`.

### Telegram: иерархия «лой / хай / пролив» в market watches

- **`market-pullback-telegram-watch`:** сообщение выстроено блоками **1** локальный лой (min до пика), **2** локальный хай (max в окне), **3** просадка от хая; время с меткой **МСК**, mcap из бара PG где есть, `price_usd`; `enrichPullbackPickMcap` подставляет mcap по меткам якоря/пика/последнего бара.
- **`market-spike-telegram-watch`:** те же три уровня для пролива (лой = новый бар, хай = якорь) и для роста (наоборот); строка 3 — «Пролив от хая» / «Импульс от лоя» с Δ% и окном.

**Откат:** `git revert`; `pm2 reload` соответствующих процессов.

---

## [1.11.174] — 2026-05-15

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.174`.

### Market pullback Telegram watch — режим «локальный хай» (второй канал)

- **`PULLBACK_ALERT_SIGNAL_MODE`:** `local_high_retrace` — пик = max `price_usd` в lookback `PULLBACK_ALERT_SCAN_MINUTES` (до **1440** мин), откат считается **от пика к последнему бару**, **без** обязательного роста якорь→пик (`MIN_RISE_PCT` в этом режиме не используется). `rise_then_retrace` — прежнее поведение (по умолчанию в коде, если env не задан).
- **`detectLocalHighRetraceFromBars`**, поле **`PullbackPick.signalMode`**, текст алерта и лог цикла учитывают режим.
- **`ecosystem.market-pullback-watch.cjs`:** для отдельного канала выставлены `local_high_retrace`, `SCAN_MINUTES=360`, `MIN_RETRACE_FROM_PEAK_PCT=6` (порог отката от пика настраивается env).

**Откат:** `git revert`; при необходимости вернуть в PM2 прежние `PULLBACK_ALERT_*` или `rise_then_retrace`.

---

## [1.11.172] — 2026-05-15

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.172`.

### PM2 + Jupiter Pro (квоты и ключ)

- **`ecosystem.config.cjs`:** в начале файла `require('dotenv').config({ path: <repo>/.env') }` — при `pm2 start|reload ecosystem.config.cjs` ключ и прочие переменные из `.env` доступны при сборке блока `env`.
- **`PM2_JUPITER_KEY_ENV`:** во все процессы, которые ходят в Jupiter API (`live-oscar-dashboard`, `sa-jupiter`, `live-oscar`, `paper-oscar-risky`, `paper-oscar-v21`, `paper-oscar-v22`), в `env` мержится **`JUPITER_API_KEY`** из `.env` (если ключ задан). Если ключа нет — одноразовый `console.warn` при разборе конфига.
- **`live-oscar` + все `PAPER_SIM_USE_JUPITER_BUILD=1` в ecosystem (live + три paper-oscar):** `JUPITER_QUOTE_429_MAX_RETRIES=5`, `JUPITER_QUOTE_429_INITIAL_BACKOFF_MS=150`.
- **`sa-jupiter`:** `JUPITER_WATCHER_REQUEST_DELAY_MS=650` (быстрее дефолта 1250 в `jupiter-route-watcher.mjs`).

**Откат:** `git revert` коммита; при необходимости удалить новые ключи из `env` в ecosystem или вернуть прежние строковые значения.

---

## [1.11.171] — 2026-05-15

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.171`.

### Staged entry — дефолт первой ноги

- **`PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT`:** zod-дефолт в `papertrader/config.ts` с **7 → 0**, чтобы без env совпадать с прод-профилем (первая нога сразу; докупки на −7% / −14% задаются второй/третьей ступенью). Комментарии уточнены.
- **Jupiter:** в docstring подчёркнуто, что **`JUPITER_API_KEY`** — это **ваш** ключ из кабинета Developer (заголовок `x-api-key`); код не генерирует отдельный Pro-ключ.

### Market pullback Telegram watch (отдельный процесс / отдельный бот)

- Новый скрипт `src/scripts/market-pullback-telegram-watch.ts`: по минутным барам из тех же PG-снапшотов ищет **рост от якоря до пика** ≥ `PULLBACK_ALERT_MIN_RISE_PCT` (по умолчанию **6%**) и **текущую цену** (последний бар) не менее чем на **10%** ниже пика окна (`PULLBACK_ALERT_MIN_RETRACE_FROM_PEAK_PCT`). Фильтр капы: `PULLBACK_ALERT_MIN_MARKET_CAP_USD` (по умолчанию **$1.5M**), отдельные `PULLBACK_ALERT_TELEGRAM_*` (не `SPIKE_ALERT_*`, не Live Oscar).
- PM2: `ecosystem.market-pullback-watch.cjs`, `scripts/pullback-watch-pm2-entry.sh`; npm-скрипт `market-pullback-telegram-watch`.
- Тесты: `tests/market-pullback-telegram-watch.test.ts` (чистая геометрия баров).

**Откат:** `git revert` коммита; при необходимости явно задать `PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT` в `.env`; для watch — `pm2 delete market-pullback-telegram-watch` или не стартовать процесс.

---

## [1.11.170] — 2026-05-12

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.170`.

### Jupiter Pro — устойчивость quote + трекер + staged Telegram

- **GET `/swap/v1/quote`:** общий helper `fetchJupiterSwapQuoteGetJson` в `src/core/jupiter-http.ts` — повтор при **HTTP 429** с backoff и учётом `Retry-After`; env `JUPITER_QUOTE_429_MAX_RETRIES` (дефолт **3**, `0` = без повторов), `JUPITER_QUOTE_429_INITIAL_BACKOFF_MS` (дефолт **100**). Подключено в `src/live/jupiter.ts` и `src/papertrader/pricing/price-verify.ts`.
- **Live tracker:** `LIVE_TRACKER_INTER_MINT_DELAY_MS` (дефолт **120**, `0` = без паузы) — пауза между mint после Jupiter MTM; для ~10 RPS можно **50–80**. Порог `LIVE_TRACKER_JUPITER_MAX_PREMIUM_OVER_SNAPSHOT_PCT` (дефолт **6**, `0` = выкл.) — MTM-guard против «призрачного» pump на buy-probe (`src/live/mtm-snapshot-guard.ts`).
- **Staged entry Telegram:** если `PAPER_LIVE_STAGED_ENTRY_FIRST_DROP_PCT > 0`, текст поясняет ожидание отката перед первой ногой; при **`0`** (как в `ecosystem` live-oscar) — формулировка «сразу по цене сигнала».

**Откат:** `git revert` коммита; при необходимости `JUPITER_QUOTE_429_MAX_RETRIES=0`, вернуть `LIVE_TRACKER_INTER_MINT_DELAY_MS` к прежнему.

---

## [1.11.169] — 2026-05-15

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.169`.

### Market spike Telegram watch (отдельный процесс / отдельный бот)

- **Tier по market cap (включено по умолчанию):** tier3 (mcap ≥ $7M) dump consec/rolling 8%/10%; tier2 (≥ $3M) 11%/12%; tier1 (≥ $1.5M) 14%/15%; pump ≥ 30%; ниже $1.5M ref — отброс.
- **Несколько пар на mint:** последний снимок по каждой `(mint, pair)` внутри top_mints; выбор лучшего сигнала по `abs(pct)` при слиянии по mint.
- **Эскалация [UPDATE]:** внутри `SPIKE_ALERT_MINT_COOLDOWN_MINUTES` повторное сообщение при росте |pct| на `ESCALATE_DELTA_PCT`, смене tier в сторону жёстче (dump), с лимитом `ESCALATE_MAX_PER_MINT` и минимальным интервалом `ESCALATE_MIN_GAP_SEC`.
- **Теги в Telegram:** `[INSTANT]` / `[ROLLING]` + `[MARKET][spike_*]`; исправлен сброс счётчика апдейтов после нового «первого» алерта.
- **Аудит:** stdout `[market-spike][SENT|…]` + опциональный INSERT в `market_spike_events` (миграция `0023_market_spike_events.sql`; при старте скрипта остаётся `CREATE TABLE IF NOT EXISTS` как fallback).
- **CLI:** `npm run market-spike-telegram-watch -- --diagnose-mint <mint> [--at ISO-8601]` — разбор баров и фильтров без отправки в Telegram.
- **Конфиг PM2** (`ecosystem.market-spike-watch.cjs`, `scripts/spike-watch-pm2-entry.sh`): cooldown 5 мин, `MAX_NEWER_BAR_AGE` 20 мин, `POLL_SEND_DEDUPE` 60 с, tier/escalate/audit env.

**Live Oscar:** код и `ecosystem.config.cjs` стратегии **не менялись**; отдельные `SPIKE_ALERT_TELEGRAM_*` и отдельный лимит Telegram API. Нагрузка на PG — те же read-only запросы к снапшотам с интервалом опроса; при деплое достаточно `pm2 reload market-spike-telegram-watch` (без полного `pm2 reload ecosystem`).

**Откат:** `git revert` коммита 1.11.169; на VPS `git reset --hard` к предыдущему SHA; `pm2 reload market-spike-telegram-watch`. Таблица `market_spike_events` может остаться (не влияет на торговлю).

---

## [1.11.168] — 2026-05-14

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.168`.

Хотфикс exit-профиля 1.11.167 после первой live-сделки $ASTEROID (peak +28.3%, exit +11.88%, Net PnL +$83.19 при теоретических +$122 → leakage $39.30 = 4.78%). Анализ leakage показал две корневые причины:

1. **TRAIL-close съел $22.11 (56% потерь)** — закрывали 25% позиции одним sell-куском с price-impact 11% в тонком Meteora-пуле.
2. **TP-партиалы накопительно $17.20** — по ступеням 1.78% → 3.74% (доллары растут на пампе при том же пуле).

Sandwich-MEV не обнаружен: priceImpactPct в Jupiter-quote стабильно 1-3% (depth-impact самого пула, не атака). Network/priority fee $0.0032 — копейки. Persistent retry x5 из 1.11.167 уже спас 2 ступени ($268 без него ушёл бы в нули).

### Решение — агрессивный скальп-профиль

`PAPER_TP_GRID_SELL_FRACTION_PROFILE: '0.10,0.20,0.30,0.30,0.30' → '0.10,0.30,0.50,0.70,0.70'`

Накопленные доли проданной позиции:

| ступень | sellFrac | продано на ступени | накоплено |
|---------|----------|--------------------|-----------|
| +5%  | 10% | 10.0% | **10.0%** |
| +10% | 30% | 27.0% | **37.0%** |
| +15% | 50% | 31.5% | **68.5%** |
| +20% | 70% | 22.1% | **90.6%** |
| +25% | 70% | 6.6%  | **97.2%** |
| TRAIL | — | 2.8% | 100% |

К ступени 5 продано **97.2% позиции** → хвост 2.8% уходит по TRAIL без заметного price-impact (leakage с $22 до ~$0.10 на типичной сделке). Мотив: на retro 119 закрытых live-oscar-сделок 64% winners пиковали в зоне +5..+15% — именно там должны фиксировать **большие куски** (50% на +15%), а не полагаться на TRAIL для редких пампов 2x+.

Симуляция на $ASTEROID: с новым профилем Net PnL ≈ +$103-107 (vs +$83.19 факт), leakage ≈$15-18 (vs $39.30).

### Slippage 100bps → 50bps + persistent retry x10

Эмуляция ручной торговли в jup.ag UI («тугой слиппедж + долбим до победы»):

- `LIVE_DEFAULT_SLIPPAGE_BPS: '100' → '50'` (1% → 0.5%).
- `LIVE_BUY_SIM_RETRY_ATTEMPTS: '5' → '10'`, `LIVE_SELL_SIM_RETRY_ATTEMPTS: '5' → '10'`.
- `LIVE_BUY/SELL_SIM_RETRY_DELAY_MS: '5000' → '3000'` (быстрее, общая retry-петля укладывается в ~30 с).
- `src/live/config.ts`: schema cap retry max 10 → 15 (запас на случай ещё более тугого слиппеджа).

На $ASTEROID retry уже работал (TP5 прошёл с 3-й попытки, TRAIL-close с 2-й). При 50bps Jupiter будет чаще отказывать quote → больше итераций retry, но мы принципиально не отдаём боту > 0.5% между quote и swap. Price-impact пула (отдельная штука, не настраивается) лечится только меньшим размером sell-куска — именно это делает новый sellFraction-профиль.

Priority fee — без изменений (`LIVE_JUPITER_PRIORITY_MAX_SOL=0.0001 SOL ≈ $0.014`); фактический network cost $0.003 на сделку, оптимизировать нечего.

### Расширенное логирование leakage для retro-аналитики

- `LiveTokenToSolPipelineResult.priceImpactPct` + `retryAttempts` — извлекаются из Jupiter quote.
- `LiveTokenToSolSellResult` (phase4-types) тоже несёт эти поля — passthrough к tracker'у.
- `PartialSell.priceImpactPct` (0..1) + `slipRealizedPct` (% deviation effective vs market) — записываются в JSONL `live_position_partial_sell` и в финальный `live_position_close.closedTrade.partialSells[]`. Раньше было только в `execution_attempt`, требовалось cross-reference по времени.
- `store-restore.ts.mapPartialSell`: pass-through новых полей при restore.

### Тесты / Verify

- `tests/papertrader-tp-grid-profile.test.ts`: новый кейс «aggressive 1.11.168 profile cumulative» с проверкой накопленных долей (10/37/68.5/90.55/97.165%).
- `npm run typecheck`: green; `npm test`: 239/239 pass.

### Откат

- `git checkout sa-alpha-1.11.167`; деплой по NORM §5.2 (`fetch + reset --hard + npm ci + pm2 reload ecosystem.config.cjs --update-env`). После отката: вернётся профиль 0.10/0.20/0.30/0.30/0.30, slippage 100bps, retry x5, partialSells без priceImpactPct/slipRealizedPct.

---

## [1.11.167] — 2026-05-14

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.167`.

Большой пакет «entry + exit tuning» Live Oscar: Policy A+ entry filter, восходящий sellFraction-профиль, 3-leg DCA $700/$150/$150, 1% слиппедж + persistent retry, расширенное логирование. По ретро-выборке 119 закрытых live-oscar сделок: Σ Net **−$70 → +$658**, win-rate 56% → 70%, n=119 → 46 (39% kept).

### Entry — Policy A+ (PG snapshots)

- **Новый фильтр** в `src/papertrader/discovery/policy-a-plus.ts`: 4 независимо-toggleable правила, применяющиеся **после** `evaluateDip + recovery + localHigh`:
  1. `bounce_from_min_30m_pct > 1%` (цена отскочила от 30-мин минимума → не на дне).
  2. `price_change_1h_pct < −20%` (вход в свободное падение часа).
  3. `vol_1h_usd > $1M` (хайп / pump-and-dump хвост).
  4. `price_change_30m_pct < −10%` (свежий 30-мин пролив, не успели стабилизироваться).
- **Реализация**: один SQL на DEX-таблицу `*_pair_snapshots` за тик (batch); coverage-проверка → при отсутствии истории фильтр **не блокирует** (safe-skip).
- **JSONL**: `live_discovery_eval.features.policy_a_plus = { enabled, coverageOk, bounceFromMin30mPct, priceChange30mPct, priceChange1hPct, vol1hUsd, min30m, price30mAgo, price1hAgo, pgSnapsCount, thresholds }` записывается **независимо** от блокировки → ретро-анализ на новые пороги без пере-парсинга PG.
- **PM2 (`live-oscar`)**: `PAPER_POLICY_A_PLUS_ENABLED=1` + 4 пары `*_ENABLED` / порог.
- **Тесты**: `tests/papertrader-policy-a-plus.test.ts` (10 кейсов на каждое правило + safe-skip + disabled).

### Entry — staged-entry: 3 ноги $700/$150/$150

- `LIVE_OSCAR_FULL_NOTIONAL_USD: '800' → '1000'`.
- `PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD: '560' → '700'` (first drop остаётся `0` → leg 1 по сигналу).
- `PAPER_LIVE_STAGED_ENTRY_SECOND_DROP_PCT: '6' → '7'`, `_SECOND_LEG_USD: '240' → '150'`.
- `PAPER_LIVE_STAGED_ENTRY_THIRD_DROP_PCT: '0' → '14'`, `_THIRD_LEG_USD: '0' → '150'`.
- `PAPER_LIVE_STAGED_ENTRY_KILL_DROP_PCT: '15' → '20'` (запас 6пп ниже leg-3, чтобы он успел заполниться).
- `PAPER_ENTRY_FIRST_LEG_FRACTION='0.7'` остаётся (700/1000 = 0.7).
- `PAPER_DCA_KILLSTOP=-0.20` (avg-killstop) остаётся; при заполненных 3 ногах = ~−22.7% от signal-цены.

### Exit — восходящий sellFraction-профиль и 1% slippage

- **TP-grid профиль** (новое): `PAPER_TP_GRID_SELL_FRACTION_PROFILE='0.10,0.20,0.30,0.30,0.30'`. На k-й ступени продаём `profile[min(k-1, len-1)]` доли остатка → бесконечный «хвост 30%» после ступени 5. `PAPER_TP_GRID_SELL_FRACTION='0.10'` оставлен как fallback.
- `PaperTraderConfig.tpGridSellFractionByStep: number[]` + `tpGridEffective().sellFractionForStep(k)`; trader.ts loop теперь передаёт `sellFractionForStep(k)` в `tryExecuteTpPartialSell`.
- `OpenTrade.tpGridOverrides.gridSellFractionByStep?: number[]` — per-open override (готовность к regime-fork).
- `PAPER_TP_GRID_STEP_PNL=0.05`, `PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL=0.03`, `PAPER_TRAIL_MODE='ladder_retrace'` — **не трогаем** (1.11.166 параметры).

### Jupiter — slippage 100bps + persistent retry x5 (buy + sell)

- `LIVE_DEFAULT_SLIPPAGE_BPS: '300' → '100'` (3% → 1%) — защита от sandwich-MEV на крупных partial sells.
- `LIVE_BUY_SIM_RETRY_ATTEMPTS: '1' → '5'` (cap в схеме 3 → 10).
- **Новое** `liveSellSimRetryAttempts/DelayMs` в `LiveOscarConfig`, ENV: `LIVE_SELL_SIM_RETRY_ATTEMPTS=5`, `LIVE_SELL_SIM_RETRY_DELAY_MS=5000`.
- `runTokenToSolPipeline` (sell) обёрнут retry-loop: каждое attempt берёт **свежий** Jupiter quote+swap, simulate, send; retry на `sim_failed:*`, `quote_stale`, `no_quote`, `swap_build`. **Никогда** на `confirm_timeout` (tx уже broadcast → риск double-sell). Каждый attempt — отдельная пара `execution_attempt`/`execution_result` с `quoteSnapshot.sellSimRetryAttempt` и `sellSimRetryMaxAttempts` для аудита.

### Bug fixes / cleanup

- **`store-restore.ts:mapPartialSell`**: `Number(undefined) → NaN → JSON 'null'`-баг для `sellFraction`/`price`/`pnlUsd` исправлен через `coerceNum0(v)` (NaN/Infinity/строки → 0).
- **Dead code A/B legacy** оставлен в `tracker.ts` ради совместимости replay'а исторических `liveExitProfileMode='A'|'B'` сделок (нет преимущества от удаления; следующий релиз).

### JSONL / Dashboard / Logging

- **`live_position_open.liveStagedEntryParams`** теперь содержит: `firstTargetUsd`, `secondTargetUsd`, `thirdTargetUsd`, `killTargetUsd` (расчётные триггер-цены от `signalPriceUsd`), `totalNotionalUsd`, `tpGridProfile`, `tpGridStepPnl`, `tpGridFirstRungRetraceMinPnlPct`, `avgKillstopPct`, `policyAPlusEnabled`, развёрнутый `description` (русский, для retro-аналитики и таймлайна). Это даёт самодостаточный snapshot стратегии в момент open: backtest / re-test не нужно поднимать историю env.
- **Таймлайн-метка `liveStagedOpenLabelRu`**: «Первая нога $700 по сигналу · план DCA: +$150/−7%, +$150/−14% · kill −20% от сигнала».
- **Контекстная подсказка** Live Oscar в `dashboard-server.ts` обновлена: одна детальная строка для новых open-сделок с описанием 3-leg ВХОДА, восходящего ВЫХОДА (10/20/30/30/30%), TRAIL `ladder_retrace`, kill −20%, slip 1% + retry x5, Policy A+ on.

### Тесты / Typecheck

- `tests/papertrader-tp-grid-profile.test.ts` — 6 кейсов на профиль (fallback, инфинит-хвост, clamp, per-open override).
- `tests/papertrader-policy-a-plus.test.ts` — 10 кейсов (4 правила + safe-skip + disabled + индивидуальное отключение).
- `npm run typecheck` — зелёный; полный `npm test` — 238/238 проходят.

### Откат

- `git checkout sa-alpha-1.11.166`; деплой по NORM §5.2 (`fetch + reset --hard + npm ci + pm2 reload ecosystem.config.cjs --update-env`). После отката: вернётся $800-нотионал staged-entry с одним добором на −6%, плоский 5%/sell-frac TP, slip 300bps без retry sell, без Policy A+.

---

## [1.11.166] — 2026-05-13

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.166`.

- **Live Oscar — унификация режимов выхода A/B → один профиль.** По ретро-бэктесту 122 закрытых сессий (`scripts-tmp/live-oscar-universal-strategy-v2.ts`, калибровка против реального journal: модель −$336 vs реал −$86) сравнили kill `−15%` и `−20%` поверх лесенки 5%/5%/∞ при текущей форме входа staged 70/30 @ −6%:
  - `kill = −15%`: на полной выборке Σ Net = **−$496**, MDD $654; на 83 winners = **+$714**, MDD $159.
  - `kill = −20%`: на полной выборке Σ Net = **−$383**, MDD $541; на 83 winners = **+$784**, MDD $89.
  - На этой выборке `−20%` доминирует `−15%` по сумме, хвостам и MDD; `−15%` сжигает временные просадки по позициям, которые далее восстанавливались в плюс.
- **`ecosystem.config.cjs` (`live-oscar`):**
  - `PAPER_LIVE_EXIT_MODE_AB`: `1` → **`0`** (поле `liveExitProfileMode` в новых событиях не проставляется);
  - `PAPER_DCA_KILLSTOP`: `-0.055` → **`-0.20`**;
  - `PAPER_TP_GRID_STEP_PNL`: `0.04` → **`0.05`**;
  - `PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL`: `0.02` → **`0.03`**;
  - `PAPER_TRAIL_TRIGGER_X`: `1.10` → `1.05`;
  - удалены/перестали читаться `PAPER_LIVE_EXIT_MODE_B_*` (значения остались в файле, но при `AB=0` игнорируются `cfgEffectiveForOpen`);
  - `PAPER_TP_GRID_SELL_FRACTION` остаётся `0.05`, `PAPER_TIMEOUT_HOURS` остаётся `8`.
- **Дашборд (`scripts-tmp/dashboard-server.ts`):** обновлены контекстные подсказки таймлайна для **Live Oscar** — единый текст для новых сделок без A/B; для исторических сделок (с уже сохранённым `liveExitProfileMode`) показывается пометка «(legacy)». Таймлайн-меток `· режим A/B` для новых событий Live Oscar не появится автоматически (поле не проставляется в `OpenTrade`). Подсказки Live Oscar Risky и Paper Oscar Idealized V2.x **не тронуты**.
- **Без изменений у других процессов** в `ecosystem.config.cjs`: `live-oscar-risky` отключён и оставлен как есть; `paper-oscar-idealized-v21` / `paper-oscar-idealized-v22` сохраняют свои режимы.
- **Боевые тесты не затронуты**, миграции БД нет, схемы PG не менялись.

### Откат

- `git checkout sa-alpha-1.11.165`; деплой по NORM §5.2 (`fetch + reset --hard + npm ci + pm2 reload ecosystem.config.cjs --update-env`). После отката `liveExitProfileMode='A'/'B'` снова будет проставляться, и старые ветви подсказок дашборда станут активны для новых событий.

---

## [1.11.165] — 2026-05-13

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.165`.

- **`live_whitelist_miss` (Telegram ADVICE):** дефолтный кулдаун **per mint 5 мин** (`LIVE_MINT_WHITELIST_NOTIFY_COOLDOWN_MS`, было `0`); в текст добавлена строка **`market_cap (snapshot)`** из discovery-фич, чтобы при редких повторах видеть динамику капы. Защита от **двух параллельных** отправок по одному mint на одном тике (`inFlight` + прежний `last` по успешному `sendTagged`).
- **PM2 `live-oscar`:** в `ecosystem.config.cjs` выставлено **`300000`** явно.

### Откат

- **`git checkout sa-alpha-1.11.164`**; при необходимости **`LIVE_MINT_WHITELIST_NOTIFY_COOLDOWN_MS=0`** для прежнего поведения; деплой по NORM §5.2.

---

## [1.11.164] — 2026-05-12

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.164`.

- **Live Phase 5 `consec_sim_fail`:** транзиентные отсутствие котировки и устаревание квоты (`no_quote`, `quote_stale:*`) больше **не увеличивают** streak; `confirm_timeout` при финальной записи `execution_result` — тоже нет; `send_failed` и прочие «жёсткие» отказы идут через `notifyLiveExecutionSimErrForTerminal` (см. `phase5-state.ts`, `phase4-execution.ts`). Это убирает ложные **`risk_block` / `consec_sim_fail`** при нормальной волатильности маршрутов Jupiter.
- **PM2 `live-oscar`:** **`LIVE_KILL_AFTER_CONSEC_FAIL=0`** (глобальная пауза новых входов по streak выключена; при необходимости жёсткой защиты задайте целое ≥ 1 вручную).
- **Heartbeat (JSONL + Telegram):** поле **`consecSimFailStreak`** и строка **`consec_sim_fail=`** в `note` / pulse.

### Откат

- **`git checkout sa-alpha-1.11.163`**; при необходимости вернуть **`LIVE_KILL_AFTER_CONSEC_FAIL=3`** в `ecosystem.config.cjs`; деплой по NORM §5.2.

---

## [1.11.163] — 2026-05-12

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.163`.

- **Live mint whitelist:** mint `8J69rbLTzWWgUJziFY8jeu5tDwEPBwUz4pKBMr5rpump` уже был в allowlist; в `live-oscar-mint-whitelist.txt` и зеркале `live-oscar-risky-mint-whitelist.txt` добавлен комментарий к строке для явной трассировки запроса.

### Откат

- **`git checkout sa-alpha-1.11.162`** и при необходимости убрать суффикс-комментарий у строки mint; деплой по NORM §5.2.

---

## [1.11.162] — 2026-05-12

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.162`.

- **Live Oscar staged-entry (PM2):** одна вторая нога усреднения на **−6%** от цены сигнала (**$240**), третья нога **выключена** (`THIRD_* = 0`); первая нога **$560**, нотионал **$800**, signal kill **−15%** без изменений. Тексты Telegram/журнала/дашборда выровнены под фактические `cfg.*`.

### Откат

- **`git checkout sa-alpha-1.11.161`** и вернуть прежние `PAPER_LIVE_STAGED_ENTRY_*` в `ecosystem.config.cjs`; деплой по NORM §5.2.

---

## [1.11.161] — 2026-05-12

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.161`.

- **Live Oscar staged-entry:** оставшиеся ноги усреднения (пороги по `PAPER_LIVE_STAGED_ENTRY_*`) больше **не блокируются после первого частичного TP**; они запрещаются только после **второй** ступени TP-сетки (`reason === TP_LADDER`). Окно **1 ч** от `signalTs` и флаги `secondLegDone` / `thirdLegDone` без изменений (`tracker.ts`, симулятор `paper2-strategy-backtest.ts`).
- **PM2:** процесс **`live-oscar-risky`** удалён из `ecosystem.config.cjs` (не стартует при деплое). На уже работающем хосте: **`pm2 delete live-oscar-risky`**.

### Откат

- **`git checkout sa-alpha-1.11.160`**; вернуть блок `live-oscar-risky` в `ecosystem.config.cjs` при необходимости; деплой по NORM §5.2.

---

## [1.11.160] — 2026-05-12

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.160`.

- **Shadow dynamic kill-stop (PG `*_pair_snapshots`):** на тике открытой позиции считается предлагаемый уровень kill/DCA из почасовых `MIN(price_usd)`; результат пишется в **`OpenTrade.dynamicKillstopShadow`**, live strategy snapshot и восстановление из store (**без изменения реальных выходов**). Env: **`PAPER_DYNAMIC_KILLSTOP_SHADOW_*`**; на **`live-oscar`** / **`live-oscar-risky`** в `ecosystem.config.cjs` включено **`PAPER_DYNAMIC_KILLSTOP_SHADOW_ENABLED=1`** с дефолтными порогами (откат: **`0`**).
- **Jupiter:** общий модуль **`src/core/jupiter-http.ts`** — дефолтные URL **`api.jup.ag`**, заголовок **`x-api-key`** при **`JUPITER_API_KEY`**; live/paper quote, sim-audit, price-verify и дашборд выровнены.
- **Live buy / sim:** короткий ретрай при simulate failure в phase4 (env в ecosystem).
- **PERIODIC_HEAL / stuck force-close:** продажа live open **только по возрасту** выключена по умолчанию; opt-in через **`LIVE_PERIODIC_STUCK_FORCE_CLOSE_ENABLED=1`** (+ **`LIVE_PERIODIC_STUCK_GRACE_HOURS`**). Значения заданы в ecosystem для **`live-oscar`** и **`live-oscar-risky`**.
- **Сборка:** несколько черновых `src/scripts/*` (sweep/bruteforce без актуальных экспортов) исключены из `tsconfig.json` → `tsc`/`typecheck`; на PM2-процессы не влияет.

### Откат

- **`git checkout sa-alpha-1.11.159`**; на хосте **`PAPER_DYNAMIC_KILLSTOP_SHADOW_ENABLED=0`**, при необходимости вернуть прежние Jupiter URL/ключи и **`LIVE_PERIODIC_STUCK_FORCE_CLOSE_ENABLED`**; деплой по NORM §5.2.

---

## [1.11.159] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.159`.

- **Telegram HEALTH `live_oscar_pulse`:** в текст добавлены метрики discovery за скользящее окно (дефолт **30 мин**): **`cand`** (строки снимка SQL), **`eval`** (полный eval без tick-throttle), **`gate_skip`** (`eval − pass` по гейтам на вход), **`opened`** (открытий за тик), **`disc_ticks`** (число циклов discovery в окне). Поле **`ticks`** заменено по смыслу на **`disc_cycles_total`** (все циклы discovery с запуска процесса). Журнал `heartbeat` в live JSONL дополнен теми же счётчиками.
- **`[ALERT][quicknode-balance]`** (PM2 `live-oscar-dashboard`): опционально дописывается строка Oscar из **`data/live-discovery-health.json`** (пишет live-oscar на каждом heartbeat). Выкл.: **`QUICKNODE_HOURLY_APPEND_OSCAR_HEALTH=0`**. Env live-oscar: **`LIVE_DISCOVERY_HEALTH_WINDOW_MS`**, **`LIVE_DISCOVERY_HEALTH_SNAPSHOT_PATH`**.

### Откат

- **`git checkout sa-alpha-1.11.158`**; при необходимости убрать **`QUICKNODE_HOURLY_APPEND_OSCAR_HEALTH`** из ecosystem для дашборда.

---

## [1.11.158] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.158`.

- **Live Oscar — режим B (prod PM2 `live-oscar`):** без изменений режима **A**. В **B**: усреднение по **`PAPER_DCA_LEVELS` −4%** (как было); kill **−8%** (`PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP`); лестница TP **+7%** к avg, **20%** остатка за ступень; ключ **`PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS`** убран — на live-oscar в B по-прежнему действует бесконечная сетка через `tpGridEffective`; трейл **`ladder_retrace`** (откат к предыдущей ступени) не менялся. Обновлены описания на дашборде стратегии Live Oscar (`scripts-tmp/dashboard-paper2.html`, подсказки таймлайна в `dashboard-server.ts`).

### Откат

- **`git checkout sa-alpha-1.11.157`** и в ecosystem для **`live-oscar`** вернуть прежние `PAPER_LIVE_EXIT_MODE_B_TP_GRID_*` (**0.05** / **0.50** / при необходимости **`PAPER_LIVE_EXIT_MODE_B_TP_GRID_MAX_RUNGS=4`**), затем деплой по NORM §5.2.

---

## [1.11.157] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.157`.

- **Cron `jupiter-shadow-hourly.mjs`:** в Telegram больше не шлётся почасовая сводка при **0 ошибок** в окне; сообщение уходит только если `errs > 0`. Восстановить старое поведение: **`JUPITER_SHADOW_HOURLY_SEND_IF_ZERO_ERRORS=1`**.

### Откат

- **`git checkout sa-alpha-1.11.156`** или задать **`JUPITER_SHADOW_HOURLY_SEND_IF_ZERO_ERRORS=1`** в `.env` на хосте.

---

## [1.11.156] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.156`.

- **Live Oscar — whitelist:** после **N** подряд **убыточных** полных закрытий по mint, который **есть в whitelist**, строка удаляется из файла списка и уходит Telegram (**ALERT** по умолчанию, тег `live_whitelist_consec_loss_drop`). Счётчик хранится в `data/live/live-oscar-whitelist-consec-loss.json`. Env: **`LIVE_MINT_WHITELIST_REMOVE_AFTER_CONSEC_LOSSES`** (дефолт **2**, **`0`** = выкл.), опц. **`LIVE_MINT_WHITELIST_DROP_TELEGRAM_CATEGORY`**, **`LIVE_MINT_WHITELIST_LOSS_STREAK_PATH`**.

### Откат

- **`git checkout sa-alpha-1.11.155`** и убрать/обнулить **`LIVE_MINT_WHITELIST_REMOVE_AFTER_CONSEC_LOSSES`** на хосте при необходимости.

---

## [1.11.155] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.155`.

- **Live Oscar — scale-in vs DCA:** `livePendingScaleIn` снимается **после** успешного on-chain DCA; при неудачном свопе усреднения план второй ноги сохраняется.

### Откат

- **`git checkout sa-alpha-1.11.154`**.

---

## [1.11.154] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.154`.

- **Live Oscar — scale-in:** коридор второй ноги **+1% / −2%** к якорю первой ноги; вне коридора — опрос каждые **30 с** (`LIVE_ENTRY_SCALE_IN_OUT_OF_CORRIDOR_POLL_MS`); без принудительной второй ноги после ретраев. Частичный TP или DCA снимают план второй ноги. На тике порядок: **DCA → TP → scale-in**. DCA до второй ноги разрешён (`PAPER_DCA_LEVELS` **−6%** для прод-плитки). Режим **A** при первом TP **+5%**, **B** при усреднении; kill режима B **−12%** (`PAPER_LIVE_EXIT_MODE_B_DCA_KILLSTOP`). SSOT: **`live-oscar`** в `ecosystem.config.cjs`, `entry-scale-in.ts`, `tracker.ts`.

### Откат

- **`git checkout sa-alpha-1.11.153`** и **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`** под **`salpha`** (или вернуть прежние `LIVE_ENTRY_SCALE_IN_*` на хосте).

---

## [1.11.153] — 2026-05-08

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.153`.

- **Live Oscar — нотионал:** `PAPER_POSITION_USD` и **`LIVE_MAX_POSITION_USD`** = **600** USD; доля первой ноги **0.75** (первая нога **$450**, вторая **$150** scale-in). SSOT: блок **`live-oscar`** в `ecosystem.config.cjs`.

### Откат

- **`git checkout sa-alpha-1.11.152`** и вернуть в ecosystem для **`live-oscar`** прежние **`PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD`** (**200**) или задать значения на хосте; **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`**.

---

## [1.11.152] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.152`.

- **Live Oscar — нотионал:** `PAPER_POSITION_USD` и **`LIVE_MAX_POSITION_USD`** = **200** USD; доля первой ноги **0.75** (первая нога **$150**, вторая **$50** scale-in). SSOT: блок **`live-oscar`** в `ecosystem.config.cjs`.

### Откат

- **`git checkout sa-alpha-1.11.151`** и вернуть в ecosystem для **`live-oscar`** прежние **`PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD`** (**160**) или задать нужные значения на хосте; **`pm2 reload ecosystem.config.cjs --only live-oscar --update-env`**.

---

## [1.11.151] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.151`.

- **Live Oscar — KILLSTOP после пополнения:** при `strategyId === live-oscar` и более чем одной ноге (`legs.length > 1`) условие kill-stop требует **два подряд тика** трекера в зоне kill (поле `liveKillstopBelowStreak`). После DCA или успешной второй ноги scale-in счётчик сбрасывается. Одиночная нога и прочие стратегии — немедленный KILLSTOP как раньше. Снимок/восстановление: `serializeOpenTrade` / `restoreOpenTradeFromJson`.

### Откат

- **`git checkout sa-alpha-1.11.150`**, **`pm2 reload ecosystem.config.cjs --update-env`** (или точечный reload `live-oscar`).

---

## [1.11.150] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.150`.

- **Post-exit buy cooldown (все исходы):** `PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES` / `HOURS` теперь отсчитываются от **любого** полного закрытия по mint (TP/SL/trail/…), не только убытка. Реализация: `recordPostExitBuyCooldownIfApplicable`, карта `lastPostExitBuyCooldownTsByMintMap`, причина в eval — `post_exit_buy_cooldown_*`. Восстановление из paper JSONL: `loadStore` → `lastPostExitBuyCooldownTsByMint`. Live-oscar: при старте из replay journal сидим cooldown из `liveStrategyReplay.closed` (макс. `exitTs` на mint), чтобы PM2-restart не «забывал» свежую продажу.
- **Env (имена прежние):** `PAPER_DIP_LOSS_EXIT_COOLDOWN_*` — семантика расширена; в **`ecosystem` (`live-oscar`)** по-прежнему **30** минут.

### Откат

- **`git checkout sa-alpha-1.11.149`**, **`pm2 reload live-oscar --update-env`**.

---

## [1.11.149] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.149`.

- **Telegram — `[ALERT][quicknode-balance]` восстановлен:** в **`ecosystem.config.cjs`** для **`live-oscar-dashboard`** включены **`QUICKNODE_HOURLY_REMAINING_TELEGRAM=1`** и **`QUICKNODE_HOURLY_RECENT_MINUTES_LIST=10,30,60`**. Раз в час уходит сообщение в требуемом формате (биллинг-период + скользящие окна 10m/30m/60m). Источник — QuickNode Admin API (`fetchQuickNodeBillingPeriodSummary` + `fetchQuickNodeRpcUsageWindow`).
- **Telegram — `[REPORT|ALERT][jupiter-shadow]` (новый канал):** добавлен **`scripts-tmp/jupiter-shadow-hourly.mjs`** + cron-установщик **`scripts/cron/install-jupiter-shadow-hourly-cron-salpha.sh`** (`0 * * * *` UTC). Раз в час шлёт сводку по фоновой нагрузке на Jupiter lite-api (`signal-lab.jsonl` + `mtm-shadow.jsonl`): количество событий, ошибок, медианы wallMs / bps. ALERT при `errors / total ≥ JUPITER_SHADOW_HOURLY_ALERT_RATIO` (default 0.2, минимум `JUPITER_SHADOW_HOURLY_MIN_EVENTS=5`); иначе REPORT. Можно форсировать ALERT через `JUPITER_SHADOW_HOURLY_FORCE_ALERT=1`.
- **Откат хламов прошлой попытки:** убран мой временный cron `hourly-telegram-report.mjs` под `salpha` и сопутствующие флаги **`TELEGRAM_HOURLY_REPORT_ENABLED`** / **`HOURLY_APPEND_QN_LEDGER`** в **`/opt/solana-alpha/.env`** (оставались как мусор после неверной интерпретации запроса).
- **Документация:** обновлены **`deploy/RUNTIME.md`** (новая строка cron для `jupiter-shadow-hourly`) и **`.env.example`** (флаги QuickNode hourly + Jupiter hourly).

### Откат

- **`git checkout sa-alpha-1.11.148`**, в **`ecosystem.config.cjs`** вернуть **`QUICKNODE_HOURLY_REMAINING_TELEGRAM='0'`** и убрать **`QUICKNODE_HOURLY_RECENT_MINUTES_LIST`**, **`pm2 reload live-oscar-dashboard --update-env`**. Под `salpha` убрать cron-блок **`# JUPITER_SHADOW_HOURLY_BEGIN`…`END`** через `crontab -e`.

---

## [1.11.148] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.148`.

- **Live-oscar loss cooldown:** **`PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES`** в **`ecosystem.config.cjs`** поднят с **10** до **30** минут (после убыточного `live_position_close` повторный вход по mint блокируется полчаса; часы остаются `0`). Применяется через **`pm2 reload live-oscar --update-env`**.
- **Все накопленные shadow-патчи слиты в `v2`:** код **`src/live/signal-lab.ts`**, **`src/live/mtm-shadow.ts`**, env в **`loadLiveOscarConfig`** (`SIGNAL_LAB_*`, `MTM_SHADOW_*`), вызовы из **`papertrader/main.ts`** и **`tracker.ts`**, hooks bootstrap в **`live/main.ts`**, hourly Telegram блок MTM shadow в **`scripts-tmp/hourly-telegram-report.mjs`**, `npm run jupiter:shadow-watch` + установщик cron `scripts/cron/install-jupiter-shadow-watch-cron-salpha.sh`. Тесты: **`tests/signal-lab.test.ts`**, обновлён **`tests/live-oscar-config.test.ts`**.

### Откат

- **`git checkout sa-alpha-1.11.147`**, **`pm2 reload live-oscar --update-env`**; убрать `MINUTES=30` (вернуть `10`) и удалить SIGNAL_LAB_* / MTM_SHADOW_* env при необходимости.

---

## [1.11.147] — 2026-05-07

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.147`.

- **Cron Jupiter shadow-watch:** **`scripts/cron/install-jupiter-shadow-watch-cron-salpha.sh`** — ставит **`salpha`** задачу **`*/10`** UTC, **`SHADOW_WATCH_TELEGRAM=1`**, лог **`data/logs/jupiter-shadow-watch.log`**. Скрипт грузит **`$SOLANA_ALPHA_ROOT/.env`**; Telegram при пороге ошибок lite-api. Документация: **`deploy/RUNTIME.md`** §2.

### Откат

- **`git checkout sa-alpha-1.11.146`**; `crontab -e` под `salpha` — удалить блок `JUPITER_SHADOW_WATCH_CRON_*`.

---

## [1.11.146] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.146`.

- **`scripts-tmp/jupiter-shadow-watch.mjs` + `npm run jupiter:shadow-watch`:** раз в запуск считает ошибки в **`signal-lab.jsonl`** / **`mtm-shadow.jsonl`** за окно (дефолт 10 мин); опционально **`SHADOW_WATCH_TELEGRAM=1`** — ALERT при высокой доле ошибок **Jupiter HTTP** (не QuickNode). Env и пример cron — **`.env.example`**.

### Откат

- **`git checkout sa-alpha-1.11.145`**; убрать строку cron при необходимости.

---

## [1.11.145] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.145`.

- **Накопление shadow-логов по умолчанию в PM2 live-oscar:** в **`ecosystem.config.cjs`** включены **`SIGNAL_LAB_*`** (100% sample, alt probe 0.55) и **`MTM_SHADOW_*`** (100% sample, alt 0.58), пути под `data/live/*.jsonl`. Торговая логика не меняется — только дополнительные Jupiter-запросы и запись JSONL. **`.env.example`** — профиль для hourly + те же пути.

### Откат

- **`git checkout sa-alpha-1.11.144`** и убрать новые ключи из `ecosystem.config.cjs` при необходимости.

---

## [1.11.144] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.144`.

- **MTM shadow (фон):** после успешного основного Jupiter-probe в **`tracker.ts`** — опциональный **второй** quote другого размера (`MTM_SHADOW_ALT_FRACTION`), запись в **`MTM_SHADOW_PATH`** (`channel: mtm_shadow`). Не меняет `curMetric`, scale-in и выходы. Env: `MTM_SHADOW_ENABLED`, `MTM_SHADOW_SAMPLE_PCT`, `MTM_SHADOW_PATH`.
- **Hourly Telegram:** в **`hourly-telegram-report.mjs`** блок сводки MTM shadow за час (события, медиана bps primary↔alt, `priceDisagreement`, ошибки alt-quote); путь override: **`HOURLY_MTM_SHADOW_JSONL`**; выкл. блока: **`HOURLY_APPEND_MTM_SHADOW=0`**.

### Откат

- **`git checkout sa-alpha-1.11.143`**.

---

## [1.11.143] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.143`.

- **Signal lab:** фоновый JSONL (`SIGNAL_LAB_PATH`, по умолчанию `data/live/signal-lab.jsonl`) — снимок **после** live whitelist и **до** `tryExecuteBuyOpen`: PG price, выборка `SIGNAL_LAB_SAMPLE_PCT`, опциональный второй Jupiter-probe (`SIGNAL_LAB_ALT_PROBE_FRACTION`), bps vs PG, дельта `solanaRpcMeterCounters` (месячные credits). Код: `src/live/signal-lab.ts`, env в `loadLiveOscarConfig`.

### Откат

- **`git checkout sa-alpha-1.11.142`**.

---

## [1.11.142] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.142`.

- **Тайм-аут позиции:** выход **`TIMEOUT`** не ставится, если уже был **хотя бы один** partial TP (**`partial_sells`**) **или** нога **`dca`** (**`tracker.ts`**, `timeoutSuppressedByProgress`). Плановый scale-in тайм-аут не отменяет. **`IDEALIZED_OSCAR_STACK_SPEC.md`** §9.2 — пояснение.

### Откат

- **`git checkout sa-alpha-1.11.141`**.

---

## [1.11.141] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.141`.

- **Live режим B липкий:** после DCA **`liveExitProfileMode = 'B'`** сохраняется до **`close`** — **убран** переход **B→A** на первом partial TP (**`tracker.ts`** `tryExecuteTpPartialSell`). Обновлены **`IDEALIZED_OSCAR_STACK_SPEC.md`**, **`cfg-effective-for-open.ts`**, **`ecosystem.config.cjs`**, подсказки дашборда.

### Откат

- **`git checkout sa-alpha-1.11.140`**.

---

## [1.11.140] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.140`.

- **Live A/B (исправление семантики):** двухногий **scale-in** — сплит ликвидности, **не** DCA; **`liveExitProfileMode`** не переходит в **B** на второй ноге (**`entry-scale-in.ts`** снова фиксирует **A** в журнале). **B** только после **`dca_add`** по **`PAPER_DCA_LEVELS`**. *(В **1.11.140** ошибочно добавлен переход в **A** на первом partial TP — отменён в **1.11.141**.)* Спецификация **`IDEALIZED_OSCAR_STACK_SPEC.md`** §0 / §8.2 / §9.2 / §15 и комментарии **`ecosystem.config.cjs`**.

### Откат

- **`git checkout sa-alpha-1.11.139`** (или **`1.11.138`**, если нужно убрать и ошибочную логику **B** после scale-in из **1.11.139**).

---

## [1.11.139] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.139`.

- **Live A/B после scale-in:** успешная **вторая нога входа** (`entry-scale-in.ts`) выставляет **`liveExitProfileMode = 'B'`** на `OpenTrade` и в событии **`scale_in_add`** — трекер и `cfg-effective-for-open` применяют профиль **`PAPER_LIVE_EXIT_MODE_B_*`** (как после DCA). Обновлена **`IDEALIZED_OSCAR_STACK_SPEC.md`** и комментарий в **`ecosystem.config.cjs`**.

### Откат

- **`git checkout sa-alpha-1.11.138`**.

---

## [1.11.138] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.138`.

- **Повторный вход после убыточного закрытия:** env **`PAPER_DIP_LOSS_EXIT_COOLDOWN_MINUTES`** (приоритет над часами); **`recordLossExitIfApplicable`** учитывает минуты или часы. **`ecosystem` (`live-oscar`):** **`PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED=true`**, **`MINUTES=10`**, **`HOURS=0`**.
- **Меньше шума в Telegram:** **`LIVE_JUPITER_TRACKER_TELEGRAM=0`** (нет `live-jupiter-tracker-diverge` / fallback); **`live-oscar-dashboard`:** **`QUICKNODE_USAGE_TELEGRAM=0`**, **`QUICKNODE_HOURLY_REMAINING_TELEGRAM=0`**, **`QUICKNODE_BILLING_MILESTONES=0`**; **`hourly-telegram-report.mjs`** шлёт только при **`TELEGRAM_HOURLY_REPORT_ENABLED=1`** (дефолт выкл.); **`paper2-healthcheck.mjs`** — алерт в TG только при **`PAPER2_HEALTH_TELEGRAM_ON_ALERT=1`**.

### Откат

- **`git checkout sa-alpha-1.11.137`** и прежние env-флаги в ecosystem / `.env`.

---

## [1.11.137] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.137`.

- **Двухногий вход live-oscar:** полная позиция **$120** — первая нога **$90**, вторая **$30** через **`LIVE_ENTRY_SCALE_IN_DELAY_MS`** (5 с); **`PAPER_ENTRY_FIRST_LEG_FRACTION=0.75`**. **`LIVE_MAX_POSITION_USD`** / **`PAPER_POSITION_USD`** = **120**. **`LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD`** = **30**.
- **Whitelist skip → Telegram:** переменная **`LIVE_MINT_WHITELIST_TELEGRAM_CATEGORY`** (дефолт в коде **ADVICE**, в ecosystem для live-oscar — **ADVICE**), чтобы не засорять канал ALERT; при необходимости жёсткого будильника — **ALERT**.
- Прод **`.env`:** оператор записал **`TELEGRAM_BOT_TOKEN`** / **`TELEGRAM_CHAT_ID`** на VPS (не в git).

### Откат

- **`git checkout sa-alpha-1.11.136`** и прежние USD/доля в ecosystem или env.

---

## [1.11.136] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.136`.

- **`data/live/live-oscar-mint-whitelist.txt`:** добавлен mint **EITHER** `HmBdm8vbisABUjkxms6ZUnoaXbfwFM6ymxShWfAENaoi` (был в `live_position_close`, не было в списке).

### Откат

- **`git checkout sa-alpha-1.11.135`** и восстановить предыдущую версию whitelist на сервере при необходимости.

---

## [1.11.135] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.135`.

- **Live whitelist → Telegram:** дефолт **`LIVE_MINT_WHITELIST_NOTIFY_COOLDOWN_MS=0`** (без кулдауна; каждый проход гейтов может снова отправить алерт по тому же mint). В **`ecosystem.config.cjs` (`live-oscar`)** выставлено **`0`**.
- **`ecosystem.config.cjs` (`live-oscar`):** **`PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` = 90**, **`LIVE_MAX_OPEN_POSITIONS` = 30** (при сохранённой **`PAPER_ENTRY_FIRST_LEG_FRACTION`** ≈ $62 + $28 scale-in).

### Откат

- **`git checkout sa-alpha-1.11.134`**.

---

## [1.11.134] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.134`.

- **Live mint whitelist:** при **`LIVE_MINT_WHITELIST_ENABLED=1`** после всех paper-гейтов и перед **`buy_open`** mint должен быть в файле (**`LIVE_MINT_WHITELIST_PATH`**, по умолчанию `data/live/live-oscar-mint-whitelist.txt`). Иначе — строка **`live_whitelist_skip`** в live JSONL, покупка не выполняется, в Telegram уходит **`[ALERT][live_whitelist_miss]`** (опциональный троттлинг per-mint: **`LIVE_MINT_WHITELIST_NOTIFY_COOLDOWN_MS`**; с **1.11.135** дефолт **0**). Файл подхватывается заново при изменении mtime. (У live-oscar **`journalAppend`** — no-op; бумажный **`eval-skip-open`** в журнал не попадает.)
- **`scripts/compare-live-closes-whitelist.mjs`** — сравнение уникальных mint из **`live_position_close`** в JSONL с whitelist (аргументы: путь к JSONL, путь к whitelist).
- **`ecosystem.config.cjs` (`live-oscar`):** whitelist включён, путь на `data/live/live-oscar-mint-whitelist.txt`.

### Откат

- **`git checkout sa-alpha-1.11.133`** и в PM2 убрать **`LIVE_MINT_WHITELIST_ENABLED`** или выставить **`0`**.

---

## [1.11.133] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.133`.

- **`PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED`** — явный master-switch (default **`true`**); при **`false`** часы **`PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS`** не применяются (`dip-clones`, smart-lottery, запись `lastLossExit`).
- **`ecosystem` (`live-oscar`):** **`PAPER_DIP_LOSS_EXIT_COOLDOWN_ENABLED=false`**, **`PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS=12`** сохранены для временного отключения.

### Откат

- **`git checkout sa-alpha-1.11.132`**.

---

## [1.11.132] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.132`.

- **`tracker.ts` (live partial TP):** после подтверждённого partial sell, если SPL-баланс mint на кошельке **0**, выставляется **`remainingFraction = 0`**, чтобы журнал не оставлял «фантомный» остаток и следующий тик не давал **`RECONCILE_ORPHAN`**. Причина: Phase 4 при **`computedBn > chainAmt`** продаёт **все** атомы (`usd_capped_by_chain`), а бумажная модель раньше уменьшала долю только на **`sellFraction`**.

### Откат

- **`git checkout sa-alpha-1.11.131`**.

---

## [1.11.131] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.131`.

- **`ecosystem.config.cjs` (`live-oscar`):** **`LIVE_MIN_WALLET_SOL`** и **`LIVE_MIN_WALLET_SOL_EQUITY_USD`** заданы пустыми — Phase 5 не режет входы по порогам нативного SOL / equity (те же RPC-оценки, что вызывали недоверие).

### Откат

- **`git checkout sa-alpha-1.11.130`**.

---

## [1.11.130] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.130`.

- **Phase 5:** новый флаг **`LIVE_PHASE5_FREE_SOL_GATE_ENABLED`** (дефолт **`0`** / выкл.). Пока выкл., **`phase5AllowIncreaseExposure`** **не** вызывает оценку свободного SOL и **не** режет входы по **`k·X`**, **нет** **`capital_skip`**/**`CAPITAL_ROTATE`** на этом пути. Включает старое поведение: **`1`**.
- **`LIVE_CAPITAL_ROTATE_ENABLED`** — дефолт в коде сменён на **`0`**; имеет смысл только при включённом гейте.
- **`ecosystem` (`live-oscar`):** вместо отдельного ротация-флага — явный **`LIVE_PHASE5_FREE_SOL_GATE_ENABLED=0`**.

### Откат

- **`git checkout sa-alpha-1.11.129`**.

---

## [1.11.129] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.129`.

- **Phase 5 (`phase5-gates.ts`):** флаг **`LIVE_CAPITAL_ROTATE_ENABLED`** (дефолт **`1`** для обратной совместимости). При **`0`** при нехватке свободного SOL под **k·X** новый вход блокируется событием **`capital_skip`** `capital_rotate_disabled` — открытые позиции **не** продаются «ради места».
- **`ecosystem.config.cjs` (`live-oscar`):** **`LIVE_CAPITAL_ROTATE_ENABLED=0`** — отключить массовые закрытия по ротации на типичном узком кошельке; при необходимости освобождать SOL вручную или снизить **`LIVE_ENTRY_MIN_FREE_MULT`**.
- **`.env.example`:** пояснение к **`LIVE_ENTRY_MIN_FREE_MULT`** и ротации.

### Откат

- **`git checkout sa-alpha-1.11.128`**.

---

## [1.11.128] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.128`.

- **`tracker.ts`:** после успешного live `sell_full` пересчёт итогового PnL из фактических SOL→USD последней ноги (`applyLiveFullCloseProceedsFromChain`), затем заново строится `exitContext` и в журнал уходит скорректированный `exit_effective_price` (тот же guard «implausible vs modeled», что у частичных выходов).
- **`dashboard-server`:** подписи режима A/B в подсказках таймлайна и синтетическая строка scale-in — **B только после DCA**; после второй ноги явно **«· режим A»**.
- **`IDEALIZED_OSCAR_STACK_SPEC.md`:** §0 / §8.2 / §9.2 / §15 — режим **B** только после DCA; scale-in остаётся в **A**.
- **`ecosystem.config.cjs`:** комментарий к `PAPER_LIVE_EXIT_MODE_AB` приведён к той же семантике.

### Откат

- **`git checkout sa-alpha-1.11.127`**.

---

## [1.11.127] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.127`.

- **`live-oscar`:** нотионал **$80** — первая нога **$55**, вторая **$25** (`PAPER_ENTRY_FIRST_LEG_FRACTION=0.6875`); **`LIVE_MAX_POSITION_USD`**, **`LIVE_MIN_WALLET_SOL_EQUITY_USD`**, **`LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD`** согласованы с большим размером.
- **`dashboard-paper2.html`:** текст стратегии под **$55 + $25**.

### Откат

- **`git checkout sa-alpha-1.11.126`**.

---

## [1.11.126] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.126`.

- **`live-oscar`:** режим **B** по IDEALIZED §9.2 — отдельная TP-сетка: **`PAPER_LIVE_EXIT_MODE_B_TP_GRID_*`** (шаг **+5%**, **50%** остатка за ступень, retrace **2%**, макс. **4** ступени); режим **A** без изменений (**15%** / retrace **2.5%**).
- **`dashboard-server` / paper2 HTML:** в таймлайнах open / partial / close явные подписи **«· режим A/B»** и расширенный `contextNote`; частичные продажи live подтягивают `liveExitProfileMode` из `openTrade`.
- **`IDEALIZED_OSCAR_STACK_SPEC.md`:** §8.2 статус, §9.2 — таблица численного паритета с ecosystem.

### Откат

- **`git checkout sa-alpha-1.11.125`**.

---

## [1.11.125] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.125`.

- **`live-oscar` (PM2):** **`PAPER_DIP_LOSS_EXIT_COOLDOWN_HOURS=0`** — отключена пауза после убыточного выхода по mint (раньше 12 ч).
- **`scripts-tmp/report-live-opens-vs-wallet.ts`** — отчёт «replay журнала open mints» vs **`getTokenAccountsByOwner`** торгового кошелька (для сверки дашборда с реальными SPL).

### Откат

- **`git checkout sa-alpha-1.11.124`**.

---

## [1.11.124] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.124`.

- **`live-oscar`:** микро-позиция **$30** (**$20 + $10**), `PAPER_ENTRY_FIRST_LEG_FRACTION` ≈ **⅔**; **`LIVE_MIN_WALLET_SOL_EQUITY_USD` → 28**; **`LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD` → 8**.
- **`live-oscar-dashboard`:** **`DASHBOARD_PAPER2_LIVE_OSCAR_ONLY=1`** — `/api/paper2` отдаёт только Live Oscar (раньше пять колонок получались из `mergeDashboardStrategyPanels` даже без pt1-журналов).
- **`sa-collector-watch`:** **`COLLECTOR_WATCH_TELEGRAM=0`** — без `[ALERT][dex_collectors]` в Telegram.
- **`hourly-telegram-report.mjs`:** выключение через **`TELEGRAM_HOURLY_REPORT_ENABLED=0`** в окружении cron (по умолчанию отчёт как раньше включён).

### Откат

- **`git checkout sa-alpha-1.11.123`**.

---

## [1.11.123] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.123`.

- **`tracker.ts` (live):** убран глобальный **`PAPER_LIVE_MIN_HOLD_MS_BEFORE_EXIT`** — он блокировал законные **KILLSTOP / SL / TRAIL / TP / TIMEOUT** в окне удержания. Вместо этого MTM для решений берётся из **Jupiter** при каждом тике, если котировка не противоречит якорю входа (**≤2×** расхождение с `avgEntryMarket` / `avgEntry`); иначе fallback на PG или якорь. Jupiter запрашивается **даже если PG ещё не дал строку** (нет ложного **NO_DATA** из‑за отставания снимка).
- **`config.ts` / `ecosystem.config.cjs`:** ключ **`PAPER_LIVE_MIN_HOLD_MS_BEFORE_EXIT`** удалён из схемы и из **`live-oscar`**.

### Откат

- **`git checkout sa-alpha-1.11.122`**.

---

## [1.11.122] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.122`.

- **`live-oscar` (`ecosystem.config.cjs`):** **`PAPER_LIVE_MIN_HOLD_MS_BEFORE_EXIT=120000`** — первые две минуты после входа трекер не исполняет частичные TP и полный выход по обычным причинам (защита от «купил–сразу продал» из‑за расхождения цены PG snapshot и Jupiter); **`LIQ_DRAIN`** по-прежнему без задержки.
- **`PAPER_IMPULSE_PG_MIN_DROP_PCT`:** **5 → 12** — импульс по двум PG-снимкам реже срабатывает на шуме между тиками коллектора.

**Заменено в 1.11.123:** окно min-hold убрано в пользу Jupiter-first MTM в трекере.

### Откат

- **`git checkout sa-alpha-1.11.121`**.

---

## [1.11.121] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.121`.

- **`ecosystem.config.cjs`** (`live-oscar-dashboard`): **`STORE_PATH`** снова **`data/paper2/organizer-paper.jsonl`**. Путь **`dashboard-store.jsonl`** не распознаётся как organizer-журнал в **`dashboard-server.ts`**, из‑за этого отключались курсор организатора и связанный режим UI (в логах: «not organizer journal»).
- **`deploy-live-oscar-vps.sh`**: вместо пустого **`touch`** под live — **`mkdir -p data/paper2`** и **`touch`** **`organizer-paper.jsonl`** только если файла ещё нет.

### Откат

- **`git checkout sa-alpha-1.11.120`**.

---

## [1.11.120] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.120`.

- Скрипт **`scripts/ops/deploy-live-oscar-vps.sh`**: PM2 только под **`salpha`** — явные **`PM2_HOME=/home/salpha/.pm2`**, **`HOME=/home/salpha`**, неинтерактивный **`bash -c`** (login-shell ломал домашний каталог PM2); перед деплоем **`pm2 kill`** от root гасит случайный демон в **`/root/.pm2`**; удаление устаревших имён **`pt1-*`** из дампа; **`pm2 startOrReload`** на **`ecosystem.config.cjs`**.

### Откат

- **`git checkout sa-alpha-1.11.119`**.

---

## [1.11.119] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.119`.

- Дашборд PM2 переименован **`live-oscar-dashboard`** (старое имя убираем); `STORE_PATH` → `data/live/dashboard-store.jsonl` (файл создаётся деплоем, каталог `data/` в git не трекается).
- Скрипт деплоя VPS: **`scripts/ops/deploy-live-oscar-vps.sh`** (от root: fetch → reset на `v2` → `touch` store → `npm ci` → удалить старый `dashboard-organizer-paper` → `pm2 reload`).

### Откат

- **`git checkout sa-alpha-1.11.118`**.

---

## [1.11.118] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.118`.

### Прод-стек Live Oscar (PM2)

Полный набор процессов для Live Oscar: дашборд, collectors снимков, orchestrator, watch, **live-oscar** (все прежние env). Удалены только лишние **отдельные** paper-процессы `pt1-*` из списка PM2. `LIVE_PARITY_PAPER_TRADES_PATH` убран — отдельный бумажный Oscar на VPS больше не крутится; поле в коде опционально и нигде не использовалось кроме конфига.

**VPS:** `pm2 reload ecosystem.config.cjs --update-env && pm2 save` под **`salpha`**; старые `pt1-*` из дампа — **`pm2 delete <name>`**.

### Откат

- **`git checkout sa-alpha-1.11.117`** (полный **`ecosystem.config.cjs`** из того тега).

---

## [1.11.117] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.117`.

### Live Oscar — ложный KILLSTOP и гонка scale-in / ротация

- **Трекер:** Jupiter MTM (`tokenUsdFromBuyQuote`) зависит от `tokenDecimals`. При неверной разрядности (например safety fail-open без `decimals`) цена занижалась на порядки; при расхожении с PG snapshot >3.5% код доверял Jupiter → мгновенный **KILLSTOP ~−100%** при реальной цене у входа.
- **`tokenUsdFromBuyQuoteFitDecimals`:** подбор `decimals` 0…24 по минимальному отклонению от якоря **`avgEntryMarket` / `avgEntry`**; запись исправленных decimals в `OpenTrade`; если после подгонки Jupiter всё ещё противоречит якорю входа (>2×), остаётся **PG snapshot** для решений.
- **Phase 5:** расчёт unrealized для ротации капитала использует тот же fit по котировке.
- **Гонка:** перед второй ногой (**scale-in**) и перед **DCA** buy проверяется, что позиция всё ещё в `open` (чтобы не докупать после **CAPITAL_ROTATE**, пока трекер держит устаревший `ot`).

### Откат

- **`git checkout sa-alpha-1.11.116`**.

---

## [1.11.116] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.116`.

### W9.0 dip_bot — добить «оконные» дыры + максимальный список кандидатов

- **`npm run dip-bot-intel:export-candidates`:** все кошельки из **`dip_bot_intel_observations`** (сортировка по числу наблюдений); **`--csv`**; **`--detail`** — до **80** **`anchor_mint`** на кошелёк для ручного отбора «настоящих» ботов.
- **`dip-bot-intel:run`:** при **0** байт в JSONL и ненулевом watermark — **сохраняем** offset (гонки/ротация журнала).
- **`scripts-tmp/_vps_dip_bot_gap_max_closure.sh`:** до **`DIP_BOT_GAP_MAX_ITERATIONS`** циклов: **`anchor-gaps`** → **`sigseed:enqueue-mints`** → глубокий **`sigseed:run`** (env: **`DIP_BOT_MAX_SIG_PAGES`**, **`DIP_BOT_MAX_SIG_TX`**, **`DIP_BOT_MAX_SIG_CREDITS_RUN`**, …) → resweep paper+live с **`DIP_BOT_GAP_T_PRE_MS`** по умолчанию **2 ч**; финально **`coverage`**, **`anchor-gaps`**, файлы **`data/logs/dip_bot_candidates_detail.json`** и **`dip_bot_candidates.csv`**.

### Откат

- **`git checkout sa-alpha-1.11.115`**.

---

## [1.11.115] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.115`.

### Paper Smart Lottery (`smart_lottery`)

- **`runSmartLotteryDiscovery`:** молодые пулы по порогам **`SMLOT_*`** (migration/post lane); **`evaluateSnapshotSmartLottery`** + те же BS и vol5m/1h guard, что у paper2.
- **Intel-гейт:** ранние покупатели в **`swaps`** после первого buy в окне **`SMLOT_EARLY_BUY_WINDOW_SEC`**; блок при **`BLOCK_TRADE`**, плохих **`wallet_tags`**, **`entity_wallets.cluster_id`**, **`scam_farm_meta_cluster_members`** (флаги **`SMLOT_BLOCK_*`**); опционально **`SMLOT_REQUIRE_EARLY_SWAP_COVERAGE`**.
- **`main.ts`:** **`PAPER_STRATEGY_KIND=smart_lottery`** использует тот же открывающий/трекер-путь, что dip.
- **PM2:** **`pt1-smart-lottery`** в **`ecosystem.config.cjs`** (журнал **`data/paper2/pt1-smart-lottery.jsonl`**; TP ×20, trail ×5, timeout 48 ч, без DCA).
- **Дашборд:** **`buildPaper2StrategyRowFromLoad`** на уровне модуля; **`pt1-smart-lottery.jsonl`** исключён из **`/api/paper2`**; **`/api/smart-lottery`**, **`/smart-lottery`**, **`/SmartLottery`**, **`dashboard-smart-lottery.html`**.
- **`package.json` `version`:** синхронизирован с **`VERSION`** (**1.11.115**).

### Откат

- **`git checkout sa-alpha-1.11.114`**; при необходимости **`pm2 delete pt1-smart-lottery`**.

---

## [1.11.114] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.114`.

### Три контура Oscar — явное разделение

| Процесс | Назначение |
|---------|------------|
| **`live-oscar`** | Реальные сделки; пост-lane как в prod (**лиq ≥ $200k**, vol **20k / 36k**, holders **≥3000**); выходы A/B (**B** после DCA, двухногий вход — **A**); **без** TP-regime классов. |
| **`pt1-oscar`** | Бумага **$100**; **лиq строго $100k–$200k**; holders **≥1000**; vol **17k / 32k**; **`PAPER_TP_REGIME_ENABLED=0`**. |
| **`pt1-oscar-regime`** | Те же входные пороги, что **`pt1-oscar`**, но **`PAPER_TP_REGIME_ENABLED=1`** (классы **down / sideways / up / unknown** → overrides сетки TP / kill); журнал **`data/paper2/pt1-oscar-regime.jsonl`**. |

- **PM2:** добавлено приложение **`pt1-oscar-regime`** в **`ecosystem.config.cjs`** (отдельный **`PAPER_PRIORITY_FEE_CACHE_PATH`**).
- **Дашборд:** обновлены описания карточек **`pt1-oscar`** и **`pt1-oscar-regime`** в **`scripts-tmp/dashboard-paper2.html`**.

**Деплой:** после `git reset --hard origin/v2` и `npm ci` — первый запуск:  
`pm2 start ecosystem.config.cjs --only pt1-oscar-regime --update-env`  
далее достаточно `pm2 reload ecosystem.config.cjs --update-env`.

### Откат

- **`git checkout sa-alpha-1.11.113`**; `pm2 delete pt1-oscar-regime` при необходимости.

---

## [1.11.112] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.112`.

### Paper Oscar (pt1-oscar) — недельный эксперимент «хрупкие пулы» vs live

- **Паритет с live-oscar** по пост-lane возрасту (48 ч), BS 0.98, spike-guard 7×, дипу / recovery veto / китам / выходам (trail 10%/1.10, timeout 8 ч, без DCA-между-ногами), impulse (PG 5%), price-verify + exit defers, **sim-audit**, **liq-watch** force-close.
- **Отличия только:** бумага **$100**, ликвидность **$100k–$200k** (`PAPER_POST_MAX_LIQ_USD`), holders **≥1000**, объёмы **17k / 32k** (5m / floor 1h) vs live **20k / 36k**.
- **`PAPER_POST_MAX_LIQ_USD` / `PAPER_MIG_MAX_LIQ_USD`:** новые env (0 = без потолка); SQL snapshot + `evaluateSnapshot`.
- **Сброс журнала дашборда перед неделей:** на VPS `bash scripts-tmp/archive-pt1-oscar-journal.sh` (или вручную `mv`/`touch`), затем `pm2 reload` только **`pt1-oscar`**.

### Откат

- **`git checkout sa-alpha-1.11.111`**; вернуть прежний блок **`pt1-oscar`** в `ecosystem.config.cjs` из истории; при необходимости восстановить journal из `*.bak-*`.

---

## [1.11.111] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.111`.

### Discovery — возраст пула ближе к GMGN

- **`fetchSnapshotLaneCandidates`:** `age_min` и `token_age_min` считаются от **`COALESCE(pair_snapshots.launch_ts, tokens.first_seen_at, snapshot_ts)`** вместо игнора **`launch_ts`** (раньше в SQL всегда подставлялся `NULL`). Это согласует пост-lane возраст с **`pairCreatedAt`** там, где коллекторы уже пишут **`launch_ts`** (Orca, Moonshot, PumpSwap и т.д.).
- **`launch_ts`** из строки снепшота пробрасывается в **`SnapshotCandidateRow`**.
- **Холдеры:** опциональный прогрев **`PAPER_HOLDERS_SNAPSHOT_WARMUP_MAX`** — до N минтов с **`holder_count=0`** в SQL перед eval вызывается **`resolveHolderCount`** (writeback в **`tokens`** как при включённом **`PAPER_HOLDERS_DB_WRITEBACK`**); строки кандидатов в памяти обновляются для того же тика.
- **Collectors `mergePaper2OpenMintSnapshots`:** объединение mint из **Live Oscar JSONL** (**`LIVE_TRADES_PATH`** / **`PAPER2_SNAPSHOT_LIVE_JSONL`**) с paper opens; DexScreener **`/tokens/`** добор для открытых live-позиций. Отключить только live: **`PAPER2_SNAPSHOT_LIVE_OPENS=0`**. У процессов **`sa-*`** в **`ecosystem.config.cjs`** задан **`LIVE_TRADES_PATH`** рядом с репо.

### Откат

- **`git checkout sa-alpha-1.11.110`**.

---

## [1.11.110] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.110`.

### W9.0 — конвейер «дыры dip_bot → sigseed → пересчёт»

- **`npm run sigseed:enqueue-mints`:** ставит в **`signatures_seed_queue`** минты из **`--from-dip-anchor-gaps`**, **`--mints=a,b`**, или **`--stdin`** + JSON как у **`dip-bot-intel:anchor-gaps`** (не требует **`SA_SIGSEED_ENQUEUE_ENABLED`**).
- **`scripts-tmp/_vps_dip_bot_gap_sigseed_resweep.sh`:** якорные gaps → enqueue → несколько раундов **`sigseed:run`** → сброс только **`dip_bot_intel_anchors_processed`** + watermark → серия **`dip-bot-intel:run`** → **`coverage`** + **`anchor-gaps`**.

### Откат

- **`git checkout sa-alpha-1.11.109`**.

---

## [1.11.109] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.109`.

### W9.0 dip_bot intel — «перешерстить всё»: любые стратегии + якоря без `swaps`

- **`DIP_BOT_ANCHOR_STRATEGY_IDS`:** значения **`*`** или **`all`** (регистр не важен), либо **`DIP_BOT_ANCHOR_ANY_STRATEGY=1`** — из журнала берутся все якоря **`live_position_open`** / paper **`open`**, без фильтра по `strategyId`.
- **`npm run dip-bot-intel:run`:** в JSON-лог добавлено поле **`anchorStrategyFilter`** (`*` или CSV).
- **`npm run dip-bot-intel:anchor-gaps`:** список **`anchor_mint`**, у которых в **`dip_bot_intel_anchors_processed`** только строки с **`buyer_rows = 0`** (дыра инжеста `swaps` → дальше sigseed/backfill по [`deploy/RUNTIME.md`](../../../deploy/RUNTIME.md)).
- **`scripts-tmp/_vps_dip_bot_exhaustive_sweep.sh`:** бумага + live, полный сброс intel; по умолчанию один проход максимального recall (`*` стратегии, **`T_PRE_MS=1800000`**, **`MIN_USD=0`**). Списки **`DIP_BOT_EXHAUSTIVE_T_PRE_LIST`** / **`DIP_BOT_EXHAUSTIVE_MIN_USD_LIST`** задают сетку (каждая ячейка — заново очищает intel).

### Откат

- **`git checkout sa-alpha-1.11.108`**.

---

## [1.11.108] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.108`.

### W9.0 dip_bot intel — якоря из paper JSONL (`kind: open`)

- **`pt1-oscar.jsonl`** в основном содержит нативные события paper (**`kind: "open"`**), а не **`live_position_open`** (зеркало live). Джоба теперь извлекает якорь из **`open`** при совпадении **`strategyId`** с allowlist.
- **`extractDipBotJournalAnchors`**: сначала **`live_position_open`**, затем paper **`open`**.

### Откат

- **`git checkout sa-alpha-1.11.107`**.

---

## [1.11.107] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.107`.

### W9.0 dip_bot intel — якоря paper Oscar (`pt1-oscar`)

- **`DIP_BOT_ANCHOR_STRATEGY_IDS`:** теперь **CSV-список**; джоба принимает **`live_position_open`** с любым из перечисленных `strategyId` (по умолчанию **`live-oscar,pt1-oscar`**), чтобы один и тот же конвейер мог читать **live**-журнал или **paper** (`PAPER_STRATEGY_ID=pt1-oscar`).
- **`.env.example`:** комментарии про paper-путь и CSV.

### Откат

- **`git checkout sa-alpha-1.11.106`** — вернуть одиночный фильтр только `live-oscar` (до этого коммита).

---

## [1.11.106] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.106`.

### Live Phase 5 — убран лимит совокупного PnL стратегии

- **`src/live/phase5-gates.ts`:** удалены **`LIVE_MAX_STRATEGY_LOSS_USD`** / **`risk_block` `max_strategy_loss`**, **`mtm_unavailable`** на этом пути и **`LIVE_HALT_CLOSE_ALL_ON_MAX_LOSS`** (принудительное закрытие всех позиций при лимите).
- **`src/live/config.ts`**, **`.env.example`:** переменные **`LIVE_MAX_STRATEGY_LOSS_USD`**, **`LIVE_HALT_CLOSE_ALL_ON_MAX_LOSS`** больше не читаются.
- Спеки **W8.0** (live oscar, Phase 5, Phase 7, Phase 1 JSONL), **RUNBOOK**, **IDEALIZED**, дашборд **`scripts-tmp/dashboard-paper2.html`**, тесты JSONL / reconcile — синхронизированы.

### Откат

- **`git checkout sa-alpha-1.11.105`** и восстановить переменные в **`.env`** / PM2 при необходимости.

---

## [1.11.104] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.104`.

### Live tracker · Jupiter tradable price + Telegram

- **`src/core/telegram/jupiter-alerts.ts`:** тегированные алерты для live-трекера (fallback на PG при сбое quote, расхождение snapshot vs Jupiter) и при открытии circuit breaker price-verify (`jupiter-quote-resilience`). Управление env: `LIVE_JUPITER_TRACKER_TELEGRAM`, `JUPITER_QUOTE_CIRCUIT_TELEGRAM`, `LIVE_JUPITER_TRACKER_TG_THROTTLE_MS`.
- **`tracker.ts` (live):** для Oscar live при наличии позиции — проба Jupiter SOL→token; решения TP/trail/scale-in по tradable цене; при ошибках — алерты и откат на snapshot.
- **`jupiter-quote-resilience.ts`:** Telegram при первом открытии sliding-window circuit (не спам при продлении того же окна).
- **`.gitignore`:** разовые отчёты `scripts-tmp/*.sql` / `run-*.sh` из сессий оператора не засоряют `git status`.

### Откат

- **`git checkout sa-alpha-1.11.103`**; при необходимости удалить блок импортов/пробы Jupiter в `tracker.ts` и импорт алертов в `jupiter-quote-resilience.ts` по diff тегов.

---

## [1.11.105] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.105`.

### W9.0 dip_bot intel — операционное смягчение порогов v1

- **`.env.example`:** явный блок **`DIP_BOT_*`** с рекомендуемым **bootstrap-профилем**: **`DIP_BOT_T_PRE_MS=180000`** (3 мин пре‑окна), **`DIP_BOT_MIN_USD_ONE_EVENT=15`**, **`DIP_BOT_MIN_HITS=2`** (дефолты кода без env остаются 60 с / 50 USD / 3 якоря).
- **`deploy/RUNTIME.md`:** когда смягчать пороги и как **безопасно пересчитать** якоря (очистка **`dip_bot_intel_*`** + сброс **`last_jsonl_offset_bytes`**).

### Откат

- Убрать или вернуть прежние значения **`DIP_BOT_*`** в **`.env`** на VPS; при необходимости восстановить строки **`dip_bot_intel_*`** / теги из бэкапа БД.

---

## [1.11.103] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.103`.

### Live Oscar · канон нотионала в Git (`ecosystem.config.cjs`)

- **`live-oscar`:** **`PAPER_POSITION_USD` / `LIVE_MAX_POSITION_USD` → 80** (две ноги **$55 + $25**, **`PAPER_ENTRY_FIRST_LEG_FRACTION` → 0.6875**); **`LIVE_MIN_WALLET_SOL_EQUITY_USD` → 65**. Интервал второй ноги без изменений (**`LIVE_ENTRY_SCALE_IN_DELAY_MS` = 5 с**).
- **`scripts-tmp/dashboard-paper2.html`:** текст карточки Live Oscar приведён к тем же числам.
- **Операционно:** правки нотионала допускаются **только через коммит в `v2` и деплой по NORM** (`fetch` + `reset --hard origin/v2` + `npm ci` + `pm2 reload … --update-env`). Рутинный **`scp`** `ecosystem.config.cjs` на VPS без записи в Git запрещён нормативом и даёт расхождение с **`git reset --hard`**.

### Откат

- **`git checkout sa-alpha-1.11.102`** и восстановить прежний блок **`live-oscar`** в **`ecosystem.config.cjs`** из того тега (было **40 USD**, **0.7**, **`LIVE_MIN_WALLET_SOL_EQUITY_USD` = 50**).

---

## [1.11.102] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.102`.

### Hourly Health · `swaps` — ингест vs chain_lag (устранение ложного STALE)

- **`scripts-tmp/hourly-telegram-report.mjs`:** для **`swaps`** OK/STALE считается по **`max(created_at)`** и **`HOURLY_HEALTH_SWAPS_INGEST_MAX_MIN`** (default **30** мин); в строку отчёта добавлен **`chain_lag`** по **`max(block_time)`** (контекст при backfill/sigseed, не отдельный порог STALE). Защита от пустой таблицы (`ts` NULL → STALE).
- **`deploy/RUNTIME.md`:** нормативная семантика + **чеклист инцидента** (вставки за 15 мин, логи backfill/sigseed, ledger).
- **`docs/strategy/specs/W6.4_observability_port.md`**, **`.env.example`:** синхронизация контракта hourly Health.

### Откат

- **`git checkout sa-alpha-1.11.101`**; задать прежнюю логику Health только при необходимости — откат файла `hourly-telegram-report.mjs` из тега **1.11.101**.

---

## [1.11.101] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.101`.

### Операции (прод VPS, W9 + инжест `swaps`)

- Репозиторий **`/opt/solana-alpha`** выровнен с **`origin/v2`** на кодовой базе **1.11.100** (расширенный allowlist DEX); **`npm ci`**, **`db:migrate`** под **`salpha`**; устранён **`EACCES`** на `node_modules` через **`chown -R salpha:salpha /opt/solana-alpha`** (см. [`deploy/RUNTIME.md`](../../../deploy/RUNTIME.md)).
- **Боевой прогон `sigseed:run`** (`SA_SIGSEED_ENABLED=1`): **22** mint, **352** `getTransaction`, **~11,2k** кредитов QN за прогон, **229** новых вставок в **`swaps`** (новый декодер).
- **`npm run dip-bot-intel:coverage`:** частичное покрытие якорных mint по **`swaps`** (не «все ноль»); **`npm run dip-bot-intel:run`** — без ошибок, **0** billable RPC.
- Предупреждение воркера: суммарные объявленные дневные потолки компонентов > 70% от `SA_QN_GLOBAL_CREDITS_PER_DAY` — см. env / [`W6.13`](../Smart%20Lottery%20V2/) при необходимости снизить потолки.

### Откат

- Документация только: **`git checkout sa-alpha-1.11.100`**.

---

## [1.11.100] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.100`.

### Изменено

- **`swaps` allowlist (sigseed / wallet-backfill):** добавлены программы **Jupiter v4** (`JUP4…`), **Raydium CPMM** + **route** (docs.raydium.io), **Meteora DAMM v2** (`cpamdp…`, docs.meteora.ag), **Phoenix**, **Lifinity v2**, **Moonit/Moonshot** launchpad (`MoonCV…` — `tokenLaunchpadIdlV4.address` в gomoonit/moonit-sdk). Поле **`dex`** в строках: `moonshot` / `phoenix` / `lifinity` / пр. по `inferDex`.
- **`src/core/constants.ts` `DEX_PROGRAMS`**, **`known-addresses` `PROGRAM_ADDRESSES`**, **`deploy/RUNTIME.md`** — синхронизировано.

### Откат

- **`git checkout sa-alpha-1.11.99`**.

---

## [1.11.99] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.99`.

### Исправлено / инжест `swaps`

- **Корневая причина пустых `swaps` по якорям Live Oscar:** в **`sigseed-run`** и **`wallet-backfill`** использовался только **`decodePumpfunSwap`** (bonding curve); маршруты **Jupiter → PumpSwap / Raydium / Orca / Meteora** не попадали в таблицу.
- **`src/parser/allowlisted-dex-swap.ts`:** после pump.fun‑декода — разрешённый список program id + **балансовый** разбор сделки (quote: WSOL, лампорты, USDC, USDT); подключено к **`sigseed:run`** и **`wallet-backfill`**.
- **`src/core/known-addresses.ts`:** в **`PROGRAM_ADDRESSES`** добавлен **PumpSwap AMM** (`pAMMBay…`).
- **`deploy/RUNTIME.md`**, **W9.0 §11.8:** аналитика и пост-деплой шаги (`sigseed` / backfill → `dip-bot-intel:coverage`).

### Откат

- **`git checkout sa-alpha-1.11.98`**; при необходимости откатить только код парсера — уже вставленные строки **`swaps`** не трогаются.

---

## [1.11.98] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.98`.

### Документировано / операционная приёмка

- **W9.0 dip_bot intel v1:** зафиксирован **провал боевой приёмки на проде** — якоря Live Oscar обработаны, но по якорным mint в **`swaps`** **нет** строк `buy`, поэтому **нулевые** наблюдения и теги; это **разрыв покрытия инжеста**, а не доказательство отсутствия ботов. Нормативно: **§11.8** в [`W9.0_dip_bot_intel_spec.md`](../specs/W9.0_dip_bot_intel_spec.md), блок в [`deploy/RUNTIME.md`](../../../deploy/RUNTIME.md).
- **`npm run dip-bot-intel:coverage`** — проверка пересечения **`dip_bot_intel_anchors_processed`** с наличием покупок в **`swaps`**; код выхода **2**, если все якорные mint без покрытия (продукт v1 в таком виде **не поставлен**).

### Откат

- **`git checkout sa-alpha-1.11.97`** — при необходимости убрать только док/скрипт; на данные джобы откат не влияет.

---

## [1.11.97] — 2026-05-06

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.97`.

### Изменено

- **`scripts/cron/install-dip-bot-cron-salpha.sh`:** расписание задаётся переменными **`DIP_BOT_CRON_SCHEDULE`** (5 полей cron) или **`DIP_BOT_CRON_BOOTSTRAP=1`** → **`25 2 * * *`** (ежедневный bootstrap по §11.3); по умолчанию без env — steady **`25 2 * * 2`** (§11.4).
- **`deploy/RUNTIME.md`:** команды установки для bootstrap и кастомного cron.

### Откат

- **`git checkout sa-alpha-1.11.96`**; при необходимости переустановить cron прежней версией скрипта.

---

## [1.11.96] — 2026-05-01

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.96`.

### Исправлено

- **dip_bot intel:** запрос к **`swaps`** — границы окна по **`block_time`** передаются как **ISO-строки** (драйвер `postgres` в tagged template не принимает объекты **`Date`**).

### Добавлено

- **W9.0 dip_bot intel (v1):** миграция **`0022_dip_bot_intel`** (`dip_bot_intel_state`, `dip_bot_intel_anchors_processed`, `dip_bot_intel_observations`); джоба **`npm run dip-bot-intel:run`** — якоря **`live_position_open`** только **`live-oscar`** из JSONL (`DIP_BOT_LIVE_JSONL` / `LIVE_TRADES_PATH`), покупатели в пре-окне из **`swaps`** (Postgres-first, **0 billable RPC** в v1); продвижение в **`wallet_tags`** с `tag=dip_bot`, `source=dip_bot_intel` при **`DIP_BOT_MIN_HITS`**. Установщик cron: **`scripts/cron/install-dip-bot-cron-salpha.sh`** (steady: вт **02:25** UTC). См. [`W9.0_dip_bot_intel_spec.md`](../strategy/specs/W9.0_dip_bot_intel_spec.md).

### Откат

- `VERSION` **`1.11.95`**; `git checkout sa-alpha-1.11.95`; при необходимости откатить миграцию **`0022`** и строки **`wallet_tags`** с **`source=dip_bot_intel`**; убрать блок **`DIP_BOT_CRON_*`** из crontab **`salpha`**.

---

## [1.11.95] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.95`.

### Hourly Telegram — блок детектива (PG-only) + сдвиг cron bot-bucket

- **`scripts-tmp/hourly-telegram-report.mjs`:** в том же сообщении, что Coverage / оркестратор / Health — секция **«Детектив · bot-bucket / backfill»**: за последний час и всего по тегу **`bot`** (строки и уник. кошельки), узкие теги **`mev_bot`**, **`bot_farm_boss`**, **`bot_farm_distributor`**, **`sniper`**, очередь **`wallet_backfill_queue`** (pending/running/done/error), топ **`error_message`**. Без доп. RPC. Выкл: **`HOURLY_APPEND_DETECTIVE_INTEL=0`**.
- **`scripts/cron/install-detective-data-plane-salpha.sh`:** **`intel:bot-bucket`** перенесён с **04:14** на **04:12** UTC (развести пик PG с **`scam-farm:detect`** в **04:15**). После pull на VPS: повторный запуск install-скрипта.
- **`deploy/RUNTIME.md`**, **`.env.example`:** env и описание.

### Откат

- **`git checkout sa-alpha-1.11.94`**; на VPS переустановить cron из скрипта предыдущей версии при необходимости; **`HOURLY_APPEND_DETECTIVE_INTEL=0`** отключает блок в hourly.

---

## [1.11.94] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.94`.

### Wallet backfill — двухслотовый потолок кредитов в метриках (SSOT)

- **`src/intel/wallet-backfill-cron-presets.ts`:** пресеты утреннего и дневного **wallet-backfill:pilot** (синхронно с **`scripts/cron/install-detective-data-plane-salpha.sh`**); функция **`pilotSlotCeilingCredits`**.
- **`wallet-backfill:metrics`:** поля **`credits_upper_bound_pilot_slots`** (слоты + **`daily_sum_ceiling`**), **`interpretation.sa_parser_stream`**, **`spec_ref`**.
- **`tests/wallet-backfill-cron-presets.test.ts`:** контроль суммы потолков при 30 кредитах/RPC.
- **W6.12 S06** §7.1, **`.env.example`**, комментарий в install-cron.

### Откат

- **`git checkout sa-alpha-1.11.93`**.

---

## [1.11.93] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.93`.

### Wallet backfill — операторские метрики без RPC

- **`npm run wallet-backfill:metrics`** (`src/scripts/wallet-backfill-metrics.ts`): очередь, `swaps` по источникам (24h/7d), превью enqueue gate, верхняя оценка кредитов одного прогона из env — **0 вызовов QuickNode**.
- Спека **W6.12 S06** §7.1 — ссылка на команду.

### Откат

- **`git checkout sa-alpha-1.11.92`** для удаления скрипта и записи в `package.json`.

---

## [1.11.92] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.92`.

### Wallet backfill — W6.12 S06 enqueue gate

- **`src/intel/wallet-backfill-enqueue-gate.ts`:** расчёт эффективного батча по **`pending`**, **`SA_BACKFILL_ENQUEUE_GATE_PENDING_MAX`**, **`SA_BACKFILL_ENQUEUE_SOFT_CAP`**.
- **`src/scripts/wallet-backfill-run.ts`:** перед enqueue — подсчёт `pending`, режим **`--dry-run`** для диагностики без INSERT; ветка enqueue не требует RPC URL.
- **`tests/wallet-backfill-enqueue-gate.test.ts`:** покрытие веток gate / soft cap.
- **`scripts/cron/install-detective-data-plane-salpha.sh`:** в строке enqueue выставлены **`SA_BACKFILL_ENQUEUE_GATE_PENDING_MAX=1500`**, **`SA_BACKFILL_ENQUEUE_SOFT_CAP=2400`** (подстройка под фактическую очередь — через env на VPS или правка скрипта).
- **`.env.example`**, спека **S06** — синхронизация с реализацией.

### Откат

- Убрать переменные gate из cron или задать пустые; **`git checkout sa-alpha-1.11.91`** для кода.

---

## [1.11.91] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.91`.

### Документация — W6.12 S06 (bounded completeness ingest без stream)

- Новая нормативная спека `docs/Smart Lottery V2/W6.12_S06_bounded_completeness_swap_ingest_plan_spec.md`: вселенная **U**, сходимость **`wallet_backfill_queue`**, gate enqueue, формулы кредитов (S01), метрики SQL, фазы месяца **M0–M3**, согласование окон scam-farm / bot-bucket.
- Обновлены `docs/Smart Lottery V2/W6.12_OVERVIEW_detective_without_chain_firehose.md` (таблица §3) и `docs/Smart Lottery V2/README.md` (блок W6.12).
- **`.env.example`:** закомментированные заготовки **S06** (`SA_BACKFILL_ENQUEUE_*`) до появления реализации gate в коде.

### Откат

- Документы: **`git checkout sa-alpha-1.11.90`** для указанных путей или revert коммита.

---

## [1.11.90] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.90`.

### Детектив — свежесть `swaps`, bot-bucket окно, backfill ширина

- **Диагностика:** `scripts/diag/swaps-pipeline-diagnostics.sql` — разрез `swaps.source` + очередь `wallet_backfill_queue`.
- **`install-detective-data-plane-salpha.sh`:** `intel:bot-bucket` с **`BOT_LAYER_B_SINCE_HOURS=168`**; **`wallet-backfill:pilot`** — утренний прогон с **`SA_BACKFILL_MAX_WALLETS_PER_RUN=160`** / **`MAX_TX=32`**, второй прогон **15:17 UTC** (**120** кошельков / **28** tx) для разгрузки очереди; верхняя оценка QN на оба прогона порядка **~2.8×10⁵** billable RPC-кредитов при 30/вызов (реально ниже).
- **`src/intel/bot-bucket/constants.ts`:** комментарий — предложение подтегов под `bot` (`bot_hf_swap`, `bot_spray_mints`, `bot_sol_hub`, `bot_combo_full`, фильтр `pump:*`).
- **`.env.example`:** зафиксировано: в **`swaps`** попадает только **pump.fun** из стрима/backfill/sigseed; без **`sa-parser`/стрима** основной объём замирает.

### Откат

- **`git checkout sa-alpha-1.11.89`** или прежняя строка cron без второго pilot и без `BOT_LAYER_B_SINCE_HOURS`.

---

## [1.11.89] — 2026-04-30

**Git-тег продукта (рекомендуемый):** `sa-alpha-1.11.89`.

### Wallet intel — W6.10 bot-bucket в прод-контуре

- **`src/intel/bot-bucket/*`**, **`src/scripts/intel-bot-bucket.ts`**: модуль уже в дереве; добавлены **`npm run intel:bot-bucket`**, хук **`WALLET_INTEL_RUN_BOT_BUCKET`** в **`wallet-intel-pipeline`**, политика **`classifyWallet`**: тег **`bot`** → **UNKNOWN** (`bot_umbrella_tag`).
- **`scripts/cron/install-detective-data-plane-salpha.sh`**: ежедневный cron **04:14 UTC** с **`BOT_BUCKET_ENABLED=1 BOT_BUCKET_DRY_RUN=0`** перед **`scam-farm:detect`**.
- **`.env.example`**: переменные **`BOT_*`** и **`WALLET_INTEL_RUN_BOT_BUCKET`**.

### Откат

- Удалить строку **`intel:bot-bucket`** из crontab вручную или переустановить блок без неё из предыдущего коммита; **`git checkout sa-alpha-1.11.88`**.

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
