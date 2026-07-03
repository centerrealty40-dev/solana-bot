# Live Oscar — «Первый выстрел» (First Shot): спецификация tier

**Продукт:** `solana-alpha` / PM2 `live-oscar`  
**Ветка:** `v2`  
**Статус:** **DRAFT** (целевая архитектура; не normative до shadow evidence)  
**Версия спеки:** 0.4 (2026-07-04)  
**Код:** env contract + config stub (≥ **1.11.549**); eval lane — PR3

## Changelog (spec)

| Версия | Дата | Изменение |
|--------|------|-----------|
| **0.4** | 2026-07-04 | **Position 2×$25** ($50/mint, staged entry как runner_lite); exposure **MAX_CONCURRENT=4**, **MAX_EXPOSURE_USD=200**; env scaffolding в `ecosystem.config.cjs` + `live-oscar-pervyy-vystrel-config.ts`; shadow-first, lane `pervyy_vystrel_v1` |
| **0.3** | 2026-07-04 | §17 **disk forensics** (read-only SSH 22:50 UTC); §17.3 options **A–D пересмотрены**; §17.5 «Пересмотр: отдельный VPS + repo»; §17.6 **revised verdict** + pragmatic tiers (cleanup → B/D → C/D) |
| **0.2** | 2026-07-04 | §6.4 **Volume authenticity analyzer** (wash vs real); §17 **Appendix** — VPS load snapshot (2026-07-04), Wallet Intel roadmap status, architecture verdict (PM2 worker + schema lane) |
| 0.1 | 2026-07-04 | Первая DRAFT spec tier «Первый выстрел» |

**Связанные нормативы:**

| Документ | Роль |
|----------|------|
| [`LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md`](./LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md) | L0–L4 intel overlay, §4 lifecycle, collector safety, rollout |
| [`../specs/W8.0_IMPLEMENTATION_PHASES.md`](../specs/W8.0_IMPLEMENTATION_PHASES.md) | Фазы Live Oscar |
| [`../../Smart Lottery V2/W6.9_wallet_intel_detective_trading_spec.md`](../../Smart Lottery V2/W6.9_wallet_intel_detective_trading_spec.md) | BLOCK vs SMART, Atlas clusters |
| [`../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md) | Deploy, shadow→gate, `pm2 reload` |

**Предшествующий анализ (Wallet Intel runner strategy):** subagent [af6a5611](af6a5611-e056-4f30-a455-9357990c84ed) — текущий intel **denylist-only**; кейс hYhqi имел **0 PG snapshots / 0 swaps** на prod; для micro-runner нужны **ingest + positive organic gate (L3)**.

**Существующий код (переиспользовать, не дублировать):**

| Модуль | Назначение |
|--------|------------|
| `src/papertrader/live-oscar-runner-lite.ts` | Параллельный lane, composite open-map key, tier routing |
| `src/papertrader/live-oscar-runner-probe.ts` | Strict runner gates, intel wire pattern |
| `src/papertrader/discovery/runner-mode.ts` | vol1h/12h, velocity, bs, price_hold features |
| `src/papertrader/discovery/oscar-intel-gate.ts` | Mint-scoped denylist gate (BLOCK/cluster) |
| `src/papertrader/whale-analysis.ts` | Creator dump, group sell, seller profiles |
| `src/papertrader/discovery/volume-sybil-guard.ts` | Wash dead→spike (PG snapshots) |
| `src/papertrader/discovery/mint-volume-authenticity.ts` (**NEW, PR2**) | Swap-graph wash vs organic; см. §6.4 |
| `src/intel/scam-farm-detective/*` | Atlas `entity_wallets`, meta-clusters |
| `src/papertrader/live-oscar-pervyy-vystrel-config.ts` | Typed env contract (v0.4); eval lane — PR3 |
| `src/papertrader/executor/exit-policy-runner-lite.ts` | `half8_runner` exit canon (pervyy_vystrel inherits) |

---

## §1. Постановка задачи и intent оператора

### 1.1. Проблема

Существующие runner-lane (`runner_lite`, `runner_probe`) и prod Oscar ловят **dip / momentum** на **зрелых** band ($500k–$30M+) с entry path **dip −20…−45%** от локального high. Они **не** заточены под узкий паттерн:

```text
органический разгон → cluster-driven dump (−50%…−75% от пика) → re-ramp (early buyers усредняются + late retail)
```

Оператор хочет **отдельный tier «Первый выстрел»**, который:

1. Начинает **наблюдение** с первого появления mint с **хорошим объёмом** на **низком mcap** (якоря $100k / $150k / $200k).
2. Строит **карту ранних покупателей** (cluster graph) на первом qualifying sighting.
3. **Ждёт** сильный dump, но входит **только** если dump **кабальный** (creator / early cabal), а не разрозненный retail panic.
4. Входит в **re-ramp phase** после cluster dump — когда ранние кошельки начинают усредняться и подключается late retail.

**Цель:** надёжно ловить фазу **post-cluster-dump re-entry** на early runners, не смешивая с FOMO-entry на первом spike и не покупая retail-only panic dumps.

### 1.2. Референс-кейс: hYhqi (HAAL9K)

| Поле | Значение |
|------|----------|
| Mint | `hYhqiS8iEM5z5ZunyjbzzYTCdFeXeuJncBJ6Ln8pump` |
| Symbol | HAAL9K |
| Паттерн mcap | **~$800k → ~$200k → ~$600k** (пик → cluster dump → re-ramp) |
| Дата (оператор) | 2026-07-03, MSK ~16:00–20:00 |
| Drop от пика | ~75% ($800k→$200k) — попадает в band «cluster dump» |
| Re-ramp | ~3× от дна ($200k→$600k) — целевая **Phase D entry** |

**Почему текущие lane не сработали (prod forensics, af6a5611):**

| Блокер | Деталь |
|--------|--------|
| **Data coverage** | 0 строк в `pumpswap_pair_snapshots`, нет `tokens` row, 0 journal events — mint **не в universe** |
| **Mcap floor** | runner_lite ≥ $500k; runner_probe ≥ $1M; SQL pool ≥ $2M |
| **Entry model** | dip −20…−45% + price_hold ≥ 0.55 — **не** cluster-dump attribution + re-ramp |
| **Intel** | `ALLOW_SCAN` (нет swaps) — denylist не блокировал, кандидата не было |

**Вывод для спеки:** tier «Первый выстрел» бесполезен без **PR1 visibility/ingest**; логика cluster dump / re-ramp — **PR2–PR3**.

### 1.3. Принципы (наследуют Coin Intelligence §1.2)

| # | Принцип | Для First Shot |
|---|---------|----------------|
| P1 | BLOCK > SMART | Cluster scam / farm BLOCK перекрывает re-ramp entry |
| P2 | Mint-scoped | Watchlist + state machine только per mint |
| P3 | Read-only overlay | Live-oscar не пишет в collector; cluster graph — batch/cron |
| P4 | Collector safety | Surveillance SQL ≤ budget discovery (§11 Coin Intel) |
| P5 | Default-OFF | `PAPER_PERVYY_VYSTREL_ENABLED=0` → shadow 7d → gate |
| P6 | Organic overlays | Positive gate из `swaps` + `entity_wallets`, materialized L3 |
| P7 | Trading-first precision | Ложный **пропуск** cluster dump (FN) хуже ложного входа в retail panic |

---

## §2. Определение tier vs runner_lite / runner_probe / prod

### 2.1. Сравнительная таблица

| Измерение | **prod Oscar** | **runner_probe** | **runner_lite** | **«Первый выстрел»** |
|-----------|----------------|------------------|-----------------|----------------------|
| **Стадия жизни** | Post-lane dip 36h+ | Fresh runner 12–48h | Fresh runner 12–48h | **Micro runner 6–48h** (watch с $100k) |
| **Mcap band** | $1.3M–$50M | $1M–$30M | $500k–<$1M | **$100k–$800k** (watchlist anchors; entry до $1M re-ramp) |
| **Entry trigger** | Staged dip −10% | Dip −20…−45% + strict runner | Dip −20…−45% + relaxed runner | **Cluster dump → re-ramp** (не первый spike) |
| **Dump attribution** | Whale creator dump block | Whale + intel denylist | Intel denylist | **Обязательна:** cluster sell ratio |
| **Positive intel** | Нет | Нет | Нет | **Да:** organic buyer diversity + early cluster map |
| **Surveillance** | Per-tick discovery | Per-tick discovery | Per-tick discovery | **Persistent watchlist** после first sighting |
| **Position** | Staged $300+ | $500 (+ DCA) | 2×$100 | **2×$25** (staged entry, $50/mint) |
| **Exit** | wave_b / staged | runner_probe_v1 | half8_runner | **half8_runner** (default) |
| **Open-map key** | `mint` | `mint::runner_probe` | `mint::runner_lite` | `mint::pervyy_vystrel` |
| **Lane id** | `prod` | `runner_probe` | `runner_lite` | `pervyy_vystrel` |
| **Exit policy id** | `wave_b_v1` | `runner_probe_v1` | `runner_lite_v1` | `pervyy_vystrel_v1` |

### 2.2. Позиционирование

- **Не заменяет** runner_lite/probe: параллельный lane, mutex только по capital slots (`max concurrent` / exposure).
- **Ниже** runner_lite по mcap: ловит раннюю фазу, которую lite отсекает (`mcap < $500k`).
- **Позже** runner_lite по таймингу: lite входит на dip в runner band; First Shot **ждёт** cluster dump и re-ramp.
- **Ближе к Coin Intel §4.1** age band **0–12h / 12–24h** — primary window для early-buyer graph, но с **ослабленным age** только после shadow.

### 2.3. Что tier явно НЕ делает

| ❌ | Почему |
|----|--------|
| Entry на первом vol spike | FOMO / wash spike без dump attribution |
| Entry на retail panic dump | Нет cluster sell concentration → skip |
| Chain-wide graph scan | Budget / scope violation |
| Holders live RPC каждый tick | QN budget; batch holder delta |
| Override prod / probe на том же mint | Composite key; независимые legs |

---

## §3. Phase machine (норматив)

State machine per mint в in-memory watchlist + optional PG table `pervyy_vystrel_watch` (Phase 2).

```text
                    ┌──────────────────────────────────────────┐
                    │  Phase 0 — DISCOVERY / WATCHLIST ONBOARD   │
                    │  first sighting: mcap ∈ anchor band + vol  │
                    └────────────────────┬─────────────────────┘
                                         │ qualify
                                         ▼
                    ┌──────────────────────────────────────────┐
                    │  Phase A — ORGANIC MOMENTUM                │
                    │  build early-buyer cluster map; NO entry   │
                    └────────────────────┬─────────────────────┘
                                         │ peak tracked
                                         ▼
                    ┌──────────────────────────────────────────┐
                    │  Phase B — SURVEILLANCE                    │
                    │  vol 1h cadence + holder 5m cadence      │
                    └────────────────────┬─────────────────────┘
                                         │ dump detected
                                         ▼
                    ┌──────────────────────────────────────────┐
                    │  Phase C — CLUSTER DUMP DETECT             │
                    │  attribute: cabal vs retail panic          │
                    └────────────┬─────────────┬─────────────────┘
                                 │ cluster     │ retail-only
                                 │ confirmed   │ dump
                                 ▼             ▼
                    ┌────────────────────┐   WATCHLIST_DROP
                    │  Phase D — ENTRY   │   (или COOLDOWN 24h)
                    │  RE-RAMP           │
                    └────────────────────┘
```

### Phase 0 — Discovery / watchlist onboard

**Триггер:** mint **впервые** попадает в eval universe (PG snapshot row или volume-leader inject) с:

- `ref_mcap_usd` ∈ **[anchor_min, anchor_max]** — default **$100k–$250k** (якоря $100k / $150k / $200k — точки логирования, не отдельные sub-tier);
- `vol1h_usd ≥ min_vol_qualify` — default **$50k**;
- `age_min` в band **360–2880** (6h–48h) для shadow; prod candidate **720–2880** (12h–48h);
- sybil / ephemeral guards pass (или exempt при high unique buyers — §6).

**Действия:**

1. Добавить mint в `pervyyVystrelWatch: Map<mint, WatchState>`.
2. Journal: `pervyy_vystrel_watch_onboard`.
3. Запросить async/batch: **early buyer cluster snapshot** (если swaps есть).

**Не entry.**

### Phase A — Organic momentum

**Цель:** подтвердить органический поток **до** пика и построить cluster map.

**Условия удержания в Phase A:**

| Сигнал | Порог (default) |
|--------|-----------------|
| `vol1h` | ≥ **$50k** (sustain ≥2 consecutive hourly samples) |
| `vol1h_velocity` | ≥ **1.5×** avg24h |
| `bs1h` | ≥ **0.85** |
| `unique_buyers_1h` | ≥ **25** (NEW — positive gate) |
| `cluster_buyer_ratio` | ≤ **0.35** |
| Intel denylist | no BLOCK / scam / meta-cluster on early buyers |

**Действия:**

- Зафиксировать `peakMcapUsd`, `peakPriceUsd`, `peakTs` (rolling max).
- Materialize **early buyer cluster map**: wallets из первых `early_buy_window_sec` (default 180s) + transfers `money_flows` + `entity_wallets.cluster_id`.
- Journal: `pervyy_vystrel_phase_a_tick` (throttled 15m/mint).

**Переход:** `peakMcapUsd ≥ $400k` OR elapsed **≥ 4h** in Phase A with sustained vol → Phase B.  
**Сброс:** sybil/ephemeral hard block → `WATCHLIST_DROP`.

### Phase B — Surveillance

**Цель:** непрерывное наблюдение после qualifying sighting; измерения по двум cadence.

| Cadence | Метрика | Источник |
|---------|---------|----------|
| **1h** | vol1h, vol12h, velocity, bs1h, mcap, liq | PG `*_pair_snapshots` |
| **5m** | `holder_count` delta, unique buyers 15m | `tokens.holder_count` batch + `swaps` |

**Правила:**

- Watchlist **не выпадает** при кратковременном vol dip < $50k, если `peakMcapUsd` уже ≥ $300k (grace 2h).
- `holder_growth_30m` не должен быть **отрицательным** > **−3%** на пути к dump (иначе organic decay).
- Journal: `pervyy_vystrel_surveillance_tick` (hourly).

**Переход в Phase C:** `mcap_now ≤ peak_mcap × (1 − dump_pct_min)` — default **−50%** от tracked peak, **или** `mcap_now ≤ peak_mcap / dump_multiple_min` — default **÷3** (пример hYhqi: $800k→$200k).

### Phase C — Cluster dump detect

**Цель:** отличить **cabal dump** от **retail panic**.

**Обязательные условия dump (оба):**

1. **Price/mcap:** Phase B trigger fired (≥50% от peak или ≥3× drop).
2. **Sell pressure:** `sell_usd_30m ≥ $15k` и `sells_30m / (buys_30m + sells_30m) ≥ 0.55`.

**Cluster attribution (все must pass для cluster-driven):**

| Сигнал | Порог | Rationale |
|--------|-------|-----------|
| `cluster_sell_ratio` | ≥ **0.55** | Доля sell-USD от wallets ∈ early-buyer cluster map |
| `cluster_unique_sellers` | ≥ **3** | Не один кит |
| `early_buyer_sell_concentration` | top-3 cluster sellers ≥ **40%** dump window sell USD | Cabal coordinated |
| `retail_panic_score` | ≤ **0.45** | Доля sells от wallets **вне** cluster и **вне** early map, не creator |
| Creator dump | creator не единственный seller >80% | Иначе whale-analysis path |

**Retail-only dump → NO Phase D:** journal `pervyy_vystrel_dump_retail_skipped`, watchlist → COOLDOWN 24h.

**Cluster dump confirmed:** journal `pervyy_vystrel_cluster_dump_confirmed`, → Phase D armed.

### Phase D — Entry (re-ramp)

**Arm window:** 30–180 min после Phase C confirm.

**Entry gates (все AND):**

| # | Gate | Порог |
|---|------|-------|
| D1 | **Re-ramp mcap** | `mcap_now ≥ dump_bottom_mcap × 1.35` (мин +35% от дна) |
| D2 | **Re-ramp cap** | `mcap_now ≤ peak_mcap × 0.85` (ещё не full recovery — не FOMO top) |
| D3 | **Vol persistence** | `vol1h ≥ $50k` и `vol1h ≥ vol_at_dump_bottom × 0.7` |
| D4 | **Buy flow flip** | `bs_15m ≥ 1.05` (покупки доминируют на re-ramp) |
| D5 | **Early buyer accumulation** | ≥ **2** wallets из cluster map с `buy` в 30m после dump bottom (averaging down) |
| D6 | **Late retail** | `unique_buyers_15m ≥ 12` и ≥ **60%** buyers без cluster_id |
| D7 | Intel denylist | green (как runner_lite gate) |
| D8 | Capital | slots / exposure не исчерпаны |
| D9 | Mutex | нет открытой `pervyy_vystrel` позиции на mint |
| D10 | **Volume authenticity** | `authentic_pass` (§6.4): `organic_score ≥ 0.50`, `wash_score ≤ 0.55` |

**hYhqi mapping:** dump bottom ~$200k → re-ramp $600k = **+200%** от дна, `mcap_now ≤ 0.85 × $800k` = $680k — **вход разрешён** в Phase D.

**Entry execution:** 2 legs × **$25** (staged entry: leg1 market, leg2 optional на +5% pullback или сразу 2× при strong bs — config `PAPER_PERVYY_VYSTREL_STAGED_ENTRY=1` default).

Journal: `pervyy_vystrel_entry_signal` → `live_position_open` с `positionSource: pervyy_vystrel`, `liveExitPolicyId: pervyy_vystrel_v1`.

---

## §4. Таблица порогов (defaults + rationale)

| Параметр | Default | Env (primary) | Rationale |
|----------|---------|---------------|-----------|
| **Mcap anchor min** | $100,000 | `PAPER_PERVYY_VYSTREL_ANCHOR_MIN_MCAP_USD` | Начало watchlist на micro runner |
| **Mcap anchor max (onboard)** | $250,000 | `PAPER_PERVYY_VYSTREL_ANCHOR_MAX_MCAP_USD` | Выше — runner_lite/probe domain |
| **Mcap entry max** | $1,000,000 | `PAPER_PERVYY_VYSTREL_ENTRY_MAX_MCAP_USD` | Re-ramp не выше probe floor |
| **Min vol qualify (1h)** | $50,000 | `PAPER_PERVYY_VYSTREL_MIN_VOL_1H_USD` | Отсечь noise micro-cap |
| **Min vol sustain (1h)** | $50,000 | `PAPER_PERVYY_VYSTREL_SURVEILLANCE_MIN_VOL_1H_USD` | Surveillance hold |
| **Vol measure cadence** | 1h | — | PG hourly windows (existing runner SQL) |
| **Holder measure cadence** | 5m | `PAPER_PERVYY_VYSTREL_HOLDER_POLL_MIN` | `tokens.holder_count` batch refresh |
| **Age min / max** | 720 / 2880 min | `PAPER_PERVYY_VYSTREL_MIN_AGE_MIN` / `_MAX` | 12–48h; shadow may test 360 min |
| **Dump % from peak** | 50% | `PAPER_PERVYY_VYSTREL_DUMP_MIN_PCT` | hYhqi −75% попадает |
| **Dump multiple from peak** | 3× | `PAPER_PERVYY_VYSTREL_DUMP_MIN_MULTIPLE` | 800k→200k = 4× |
| **Cluster sell ratio** | 0.55 | `PAPER_PERVYY_VYSTREL_CLUSTER_SELL_RATIO_MIN` | Cabal vs retail |
| **Retail panic max** | 0.45 | `PAPER_PERVYY_VYSTREL_RETAIL_PANIC_MAX` | Inverse cluster attribution |
| **Unique buyers 1h (organic)** | 25 | `PAPER_PERVYY_VYSTREL_MIN_UNIQUE_BUYERS_1H` | Positive gate |
| **Max cluster buyer ratio** | 0.35 | `PAPER_PERVYY_VYSTREL_MAX_CLUSTER_BUYER_RATIO` | Organic momentum |
| **Re-ramp min from bottom** | +35% mcap | `PAPER_PERVYY_VYSTREL_RERAMP_MIN_FROM_BOTTOM_PCT` | Confirm recovery |
| **Re-ramp max vs peak** | 85% peak | `PAPER_PERVYY_VYSTREL_RERAMP_MAX_VS_PEAK_PCT` | Anti-FOMO top |
| **Position total** | $50 (2×$25) | `PAPER_PERVYY_VYSTREL_POSITION_USD` | Staged micro-cap sizing (не runner_lite $200) |
| **Leg USD** | $25 | `PAPER_PERVYY_VYSTREL_LEG_USD` | |
| **Max concurrent** | 4 | `PAPER_PERVYY_VYSTREL_MAX_CONCURRENT` | 4×$50 = $200 cap |
| **Max exposure** | $200 | `PAPER_PERVYY_VYSTREL_MAX_EXPOSURE_USD` | |
| **Watchlist TTL** | 72h | `PAPER_PERVYY_VYSTREL_WATCH_TTL_HOURS` | Evict stale watches |
| **Vol auth wash max** | 0.55 | `PAPER_PERVYY_VYSTREL_VOL_AUTH_WASH_MAX` | §6.4 composite |
| **Vol auth organic min** | 0.45 | `PAPER_PERVYY_VYSTREL_VOL_AUTH_ORGANIC_MIN` | §6.4 composite |
| **Vol auth round-trip max share** | 0.45 | `PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_ROUND_TRIP_SHARE` | Circular flow |

**Alias env (English):** дублировать те же значения с префиксом `PAPER_FIRST_SHOT_*` — parser в `live-oscar-pervyy-vystrel-config.ts` принимает **один** canonical (`PERVYY_VYSTREL`), alias — fallback read-only (PR1+).

---

## §5. Требования к данным

### 5.1. Матрица: есть vs нужно построить

| Данные | Статус | Использование в tier |
|--------|--------|----------------------|
| `*_pair_snapshots` (PG) | ✅ есть | vol/mcap/liq cadence 1h; discovery onboard |
| `swaps` (buy/sell) | ⚠️ частично | hYhqi: **0 rows** — ingest gap; нужен для organic + dump attribution |
| `money_flows` | ⚠️ частично | Trace funding early buyers |
| `wallet_intel_decisions` | ✅ batch | Denylist gate (BLOCK_TRADE) |
| `wallet_tags` | ✅ batch | bot/scam tags |
| `entity_wallets.cluster_id` | ✅ batch (Atlas) | Cluster map + sell ratio |
| `tokens.holder_count` | ✅ batch | 5m delta surveillance |
| **Early buyer cluster map per mint** | ❌ нет | **PR2:** `pervyy_vystrel_cluster_snapshots` или `mint_intel_snapshot` extension |
| **Unique buyers 1h/15m** | ❌ нет live | **PR2:** SQL aggregate + tick cache |
| **Watch state persistence** | ❌ нет | **PR3:** in-memory + optional PG `pervyy_vystrel_watch` |
| **Holder 5m delta** | ❌ нет live | Batch refresh job or `tokens` writeback cron |
| **L3 organic flow score** | ❌ spec only | Coin Intel §2.1 L3 — **positive** gate |
| **Volume authenticity snapshot** | ❌ нет | **PR2:** `mint_volume_authenticity_snapshot` — §6.4 |

### 5.2. Ingest prerequisites (blocking)

Перед любым shadow:

1. Pump mint появляется в `pumpswap_pair_snapshots` ≤ **15 min** от заметного vol (collector health).
2. `sigseed` / wallet-backfill: `swaps` для mint ≤ **2h** от first buy.
3. Discovery SQL: lane-specific `discoveryMinMarketCapUsd` **$100k** для pervyy_vystrel eval (не глобальные $2M).

**Проверка:** `wallet-intel:doctor` + `SELECT count(*) FROM pumpswap_pair_snapshots WHERE base_mint = $1` > 0 на 20 последних watch onboard.

### 5.3. L3 organic flow (связь с Coin Intelligence)

Реализация positive gate из [LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md §2.1 L3](./LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md):

```text
mint_organic_flow_snapshot(mint, unique_buyers_1h, cluster_buyer_ratio,
  unclustered_buyers_1h, holder_delta_30m, computed_at)
```

- Refresh: batch cron каждые **15 min** для watchlist mints; tick read из cache.
- First Shot **потребляет** L3; не дублирует wallet-intel denylist.

---

## §6. Cluster dump detection (детализация)

### 6.1. Early buyer cluster map (строится в Phase A)

**Input window:** первые `PAPER_PERVYY_VYSTREL_EARLY_BUY_WINDOW_SEC` (default **180**) от first swap buy.

**Алгоритм:**

1. `early_wallets` = top N buyers by USD (cap 60).
2. Join `entity_wallets` → `cluster_id`; пометить `is_cluster`.
3. Expand 1-hop: `money_flows` source/target ∈ early_wallets (transfer graph).
4. Persist snapshot `cluster_wallet_ids[]`, `creator_wallet`, `funding_roots[]`.

### 6.2. Сигналы cabal dump vs retail panic

| Признак | Cabal dump | Retail panic |
|---------|------------|--------------|
| Sellers ∈ early cluster map | **≥55%** sell USD | <40% |
| Unique cluster sellers | ≥3 | 1–2 random |
| Sell timing | Burst <30m | Diffuse >60m |
| Early buyer PnL | Underwater (price < avg buy) | Mixed |
| Transfer out pre-sell | Spike `money_flows` out | Low |
| Creator sell share | 20–60% (coordinated) | >80% solo (whale path) |
| New wallets selling | Low | High share |
| `panic_random` profile (whale-analysis) | Low | High |

### 6.3. Интеграция whale-analysis

- `fetchWhaleAnalysis` на Phase C: `group_sell_pressure` + seller profiles.
- **Block Phase D** если `creator_dump_block` без cluster quorum (solo creator rug).
- **Allow Phase D** если `group_sell_pressure` + cluster map overlap ≥ threshold.

### 6.4. Volume authenticity analyzer (wash vs real)

**Проблема:** на micro-cap ($100k–$800k) высокий `vol1h` часто **не органический** — кошельки крутят одни и те же токены туда-обратно (circular flow), создавая иллюзию ликвидности без роста держателей. Существующие `volume-sybil-guard` / `volume-ephemeral-guard` ловят **dead→spike** по snapshots; tier «Первый выстрел» дополнительно нуждается в **swap-graph** анализе churn.

**Модуль (proposed):** `src/papertrader/discovery/mint-volume-authenticity.ts`  
**Batch materializer:** `src/scripts/mint-volume-authenticity-materialize.ts`  
**PG table (NEW):** `mint_volume_authenticity_snapshot(mint, window_hours, payload jsonb, wash_score, organic_score, computed_at)`

#### 6.4.1. Сигналы

| ID | Сигнал | Определение | Источник |
|----|--------|-------------|----------|
| V1 | **unique_buyer_seller_ratio** | `unique_buyers / unique_sellers` за окно; wash → ratio ≈ 1.0 при малом `unique_wallets` | `swaps` |
| V2 | **round_trip_wallet_pairs** | Доля USD от wallets с ≥1 buy **и** ≥1 sell в окне ≤ `round_trip_max_min` (default 60m) | `swaps` |
| V3 | **swap_graph_cycles** | 2–3 hop cycles в directed graph buy→sell→buy (same wallet set); `cycle_volume_usd / total_volume_usd` | `swaps` + in-memory graph |
| V4 | **volume_without_holder_growth** | `vol1h_usd ≥ min_vol` AND `holder_delta_30m ≤ holder_stall_pct` (default ≤ +0.5%) | `swaps` + `tokens.holder_count` |
| V5 | **sybil/ephemeral overlap** | Hard veto если `volume_sybil` или `volume_ephemeral` blocked (reuse existing guards) | PG snapshots |
| V6 | **net_new_wallet_share** | Доля buy-USD от wallets без prior swap на mint | `swaps` history |
| V7 | **self_trade_ratio** | Buy+sell same wallet same 5m bucket / total vol | `swaps` |

**Composite scores (0..1, materialized):**

```text
wash_score     = weighted_max(V2, V3, V7) + penalty(V4)
organic_score  = clamp01( V6 × unique_buyer_seller_ratio_norm × (1 − wash_score) )
authentic_pass = organic_score ≥ ORGANIC_MIN AND wash_score ≤ WASH_MAX AND NOT V5
```

#### 6.4.2. Default пороги

| Параметр | Default | Env |
|----------|---------|-----|
| Lookback window | **1h** (Phase A/B); **30m** (Phase C/D dump window) | `PAPER_PERVYY_VYSTREL_VOL_AUTH_WINDOW_H` |
| Min swaps for eval | **20** | `PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_SWAPS` |
| Max round_trip_wallet_share | **0.45** | `PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_ROUND_TRIP_SHARE` |
| Max cycle_volume_share | **0.35** | `PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_CYCLE_SHARE` |
| Min unique_buyer_seller_ratio | **1.15** (buyers > sellers) | `PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_BS_RATIO` |
| Max self_trade_ratio | **0.25** | `PAPER_PERVYY_VYSTREL_VOL_AUTH_MAX_SELF_TRADE` |
| Min net_new_wallet_share | **0.40** | `PAPER_PERVYY_VYSTREL_VOL_AUTH_MIN_NET_NEW_SHARE` |
| Holder stall (V4) | vol1h ≥ $50k, holder_delta_30m ≤ **+0.5%** | `PAPER_PERVYY_VYSTREL_VOL_AUTH_HOLDER_STALL_PCT` |
| Wash score block | **≥ 0.55** | `PAPER_PERVYY_VYSTREL_VOL_AUTH_WASH_MAX` |
| Organic score pass | **≥ 0.45** | `PAPER_PERVYY_VYSTREL_VOL_AUTH_ORGANIC_MIN` |
| Missing swaps | **fail-open** shadow; **fail-skip** Phase A sustain | `PAPER_PERVYY_VYSTREL_VOL_AUTH_FAIL_OPEN=1` |

#### 6.4.3. Cadence и data sources

| Режим | Cadence | Scope |
|-------|---------|-------|
| **Batch materialize** | каждые **15 min** (cron, off-peak bias 03:00–05:00 UTC для heavy recompute) | все mints в `pervyyVystrelWatch` |
| **Tick read** | discovery / phase eval — **cache hit only**, TTL **120s** | per mint |
| **On-demand** | Phase C dump window — optional **30m** window recompute (1 SQL/mint max) | только mint в Phase C/D |

**Data sources (read-only):**

- `swaps` — primary (`base_mint`, `side`, `wallet`, `usd_amount`, `block_time`)
- `tokens.holder_count` — holder delta (batch, 5m cadence §3 Phase B)
- `*_pair_snapshots` — cross-check vol1h vs swap-derived vol
- Reuse eval from `volume-sybil-guard.ts`, `volume-ephemeral-guard.ts` — **не дублировать** SQL snapshots

**Query budget:** ≤ **1** swap aggregate SQL / mint / 15m batch; tick path **0 SQL** (cache only). Forbidden: unbounded graph traversal — cap wallets **200** / mint / window.

#### 6.4.4. Интеграция с Phase A / B / C / D

| Phase | Роль volume authenticity | Действие при fail |
|-------|--------------------------|-------------------|
| **Phase 0 onboard** | Soft check only | Journal `vol_auth_insufficient_data` if swaps < min; **не блокирует** onboard (ingest gap) |
| **Phase A — Organic momentum** | **Hard gate** на sustain | `wash_score ≥ WASH_MAX` OR `organic_score < ORGANIC_MIN` → не переходить в Phase B; journal `vol_auth_wash_blocked` |
| **Phase A sustain** | V1+V6 must pass **2 consecutive** hourly samples | Иначе `WATCHLIST_DROP` (fake momentum) |
| **Phase B — Surveillance** | Monitor V4 (vol without holders) | 2 consecutive hourly V4 fail → `vol_auth_decay_flag`; grace не продлевает >2h |
| **Phase C — Cluster dump** | V2/V3 distinguish **fake churn dump** vs real sell pressure | Если `cycle_volume_share ≥ 0.5` AND `cluster_sell_ratio < 0.40` → `vol_auth_fake_dump_skipped` (не Phase D) |
| **Phase D — Entry** | **D10 (NEW):** `authentic_pass` AND `organic_score ≥ 0.50` | Block entry; journal `pervyy_vystrel_shadow_skip` reason `vol_auth` |

**Overlap с sybil/ephemeral (V5):** если snapshot-guards уже blocked — volume authenticity **не override** (BLOCK > organic). Если snapshot-guards pass но swap-graph wash high — **block** (positive wash detection beyond snapshots).

#### 6.4.5. Journal events (volume authenticity)

| kind | Когда | Ключевые поля |
|------|-------|---------------|
| `pervyy_vystrel_vol_auth_snapshot` | Batch refresh | `mint`, `wash_score`, `organic_score`, `round_trip_share`, `cycle_share`, `net_new_share` |
| `pervyy_vystrel_vol_auth_wash_blocked` | Phase A/B hard block | `wash_score`, `reasons[]` |
| `pervyy_vystrel_vol_auth_decay_flag` | Phase B V4 fail | `vol1h`, `holder_delta_30m` |
| `pervyy_vystrel_vol_auth_fake_dump_skipped` | Phase C fake churn | `cycle_share`, `cluster_sell_ratio` |
| `pervyy_vystrel_vol_auth_insufficient_data` | swaps < min | `swap_count` |

Расширение `live_discovery_eval.pervyy_vystrel`: поля `volAuth: { wash_score, organic_score, pass }`.

---

## §7. Entry gates (сводка) и sizing

### 7.1. Полный checklist buy

См. §3 Phase D (D1–D9). В **shadow mode** логировать `would_enter` без `live_position_open`.

### 7.2. Position sizing

| Параметр | Value |
|----------|-------|
| Legs | 2 × $25 |
| Total cap | $50 / mint |
| DCA | **Нет** (staged 2-leg, как runner_lite pattern) |
| Max concurrent | 4 positions |
| Max exposure | $200 (4×$50) |
| Wallet | Shared `live-oscar-micro` (как runner_lite) |

### 7.3. Ranking при crowded discovery

При >N watchlist mints в Phase D одновременно: rank по `reramp_velocity × vol1h × (1 − retail_panic_score)`; top `PAPER_PERVYY_VYSTREL_MAX_ENTRIES_PER_TICK` (default 1) per discovery tick.

---

## §8. Exit policy

### 8.1. Default: inherit `half8_runner`

Как `runner_lite_v1`:

- `liveExitPolicyId = pervyy_vystrel_v1`
- `liveWaveFlatTpMode = half8_runner`
- Sell **50%** at each **+8%** vs entry avg
- Kill **−50%** (configurable `PAPER_PERVYY_VYSTREL_KILL_PCT`, default 0.50)
- Trail / breakeven machinery from `exit-policy-wave-b.ts`

**Rationale:** re-ramp phase волатильна; быстрая фиксация partial profits; symmetric с runner_lite risk envelope.

### 8.2. Optional custom overlay (Phase 2+)

| Env | Effect |
|-----|--------|
| `PAPER_PERVYY_VYSTREL_EXIT_MODE=half8_runner` | Default |
| `PAPER_PERVYY_VYSTREL_EXIT_MODE=cluster_dump_exit` | Tighten trail if cluster sells resume (reuse Coin Intel I3 coordinated dump exit) |
| `PAPER_PERVYY_VYSTREL_TIME_STOP_HOURS=8` | Hard time stop |

Custom exit — только после 14d shadow evidence; default остаётся half8.

---

## §9. Риски false positive / false negative

### 9.1. False positive (вошли — неудача)

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| «Fake re-ramp» после cabal dump (bull trap) | Средняя | D5 early buyer accumulation + D6 late retail |
| Wash volume выглядит organic | Средняя–высокая на micro | sybil/ephemeral + unique buyers |
| Coordinated unclustered wash | Высокая | Ограниченно нефильтруемо; sizing $50 cap |
| Late entry близко к peak | Низкая–средняя | D2 reramp max 85% peak |

### 9.2. False negative (пропустили — упущенная прибыль)

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| **Нет PG data** (hYhqi class) | **Критическая** | PR1 ingest |
| Retail dump но успешный re-ramp | Средняя | By design — tier ловит только cluster pattern |
| Cluster dump <50% | Средняя | Config dump multiple 3× |
| Slow re-ramp >180m arm window | Средняя | Extend arm window via env |
| Intel BLOCK на good mint | Низкая | permissive swap coverage |

### 9.3. Операторский trade-off

Tier **жертвует** retail-only dip recoveries ради **точности** cluster re-ramp. Ожидаемый hit rate: **1–3** quality entries / week при watchlist 20–50 mints (оценка, не KPI до shadow).

---

## §10. План внедрения

### PR1 — Visibility + ingest (P0)

**Цель:** mint в universe; watchlist onboard возможен.

| Deliverable | Файлы / сервисы |
|-------------|-----------------|
| Lane-specific discovery mcap floor $100k | `snapshot.ts`, `snapshot-row-sanity.ts` |
| Volume-leader inject alignment | `volume-leader-inject.ts` |
| Collector / sigseed health check для pump mints | ops scripts, `deploy/RUNTIME.md` note |
| Env block all OFF | `ecosystem.config.cjs`, `live-oscar-pervyy-vystrel-config.ts` |
| Journal kinds registered | `src/live/events.ts` |
| Forensic script | `scripts-tmp/pervyy-vystrel-mint-timeline.mjs` |

**Acceptance:** hYhqi-class mint → `count(*) snapshots > 0` within 24h of operator alert; discovery eval rows в journal.

### PR2 — Cluster graph + organic gate (P0)

**Цель:** Phase A/C logic в shadow.

| Deliverable | Файлы |
|-------------|-------|
| `mint-organic-flow-gate.ts` (или L3 table) | `src/papertrader/discovery/` |
| `mint-volume-authenticity.ts` + materialize job | `src/papertrader/discovery/`, `src/scripts/` |
| `pervyy-vystrel-cluster-snapshot.ts` | `src/papertrader/discovery/` |
| Batch job refresh cluster map | `src/scripts/pervyy-vystrel-cluster-materialize.ts` |
| Unit tests | `tests/pervyy-vystrel-*.test.ts` |

**Acceptance:** replay hYhqi (when PG data exists) → Phase C `cluster_dump_confirmed` in shadow journal.

### PR3 — Live eval lane (P1)

**Цель:** full phase machine + optional entry.

| Deliverable | Файлы |
|-------------|-------|
| `live-oscar-pervyy-vystrel.ts` | parallel to runner-lite |
| Wire `dip-clones.ts` after runner lanes | discovery eval |
| `exit-policy-pervyy-vystrel.ts` | half8 stamp |
| Open-map `mint::pervyy_vystrel` | `resolveOpenMapKey` extension |
| Dashboard badge | Open positions API |

**Lane env:** `PAPER_PERVYY_VYSTREL_ENABLED=1`, `PAPER_PERVYY_VYSTREL_MODE=shadow`.

**Acceptance:** 7d shadow, ≥95% eval без SQL timeout; manual review FP/FN samples.

---

## §11. Переменные окружения

### 11.1. Master flags

| Env | Default | Описание |
|-----|---------|----------|
| `PAPER_PERVYY_VYSTREL_ENABLED` | `0` | Мастер lane |
| `PAPER_PERVYY_VYSTREL_MODE` | `off` | `off` \| `shadow` \| `gate` |
| `LIVE_OSCAR_INTEL_MODE_PERVYY_VYSTREL` | `shadow` | Override intel mode для lane |
| `PAPER_PERVYY_VYSTREL_FAIL_OPEN` | `1` | PG error → no block в shadow |

### 11.2. Thresholds (см. §4)

Полный список: `PAPER_PERVYY_VYSTREL_*` — см. таблицу §4. Ключевые:

```text
PAPER_PERVYY_VYSTREL_ANCHOR_MIN_MCAP_USD=100000
PAPER_PERVYY_VYSTREL_ANCHOR_MAX_MCAP_USD=250000
PAPER_PERVYY_VYSTREL_MIN_VOL_1H_USD=50000
PAPER_PERVYY_VYSTREL_DUMP_MIN_PCT=50
PAPER_PERVYY_VYSTREL_DUMP_MIN_MULTIPLE=3
PAPER_PERVYY_VYSTREL_CLUSTER_SELL_RATIO_MIN=0.55
PAPER_PERVYY_VYSTREL_POSITION_USD=50
PAPER_PERVYY_VYSTREL_LEG_USD=25
PAPER_PERVYY_VYSTREL_MAX_CONCURRENT=4
PAPER_PERVYY_VYSTREL_MAX_EXPOSURE_USD=200
```

### 11.3. Intel namespace

Наследует `LIVE_OSCAR_INTEL_*` с lane override. Дополнительно:

| Env | Default |
|-----|---------|
| `PAPER_PERVYY_VYSTREL_ORGANIC_GATE_ENABLED` | `0` |
| `PAPER_PERVYY_VYSTREL_ORGANIC_GATE_MODE` | `shadow` |
| `PAPER_PERVYY_VYSTREL_CLUSTER_DUMP_MODE` | `shadow` |
| `PAPER_PERVYY_VYSTREL_VOL_AUTH_ENABLED` | `0` |
| `PAPER_PERVYY_VYSTREL_VOL_AUTH_MODE` | `shadow` |

---

## §12. Journal events (observability)

| kind | Когда | Ключевые поля |
|------|-------|---------------|
| `pervyy_vystrel_watch_onboard` | Phase 0 qualify | `mint`, `mcap`, `vol1h`, `anchor_band` |
| `pervyy_vystrel_phase_a_tick` | Phase A (15m throttle) | `peakMcap`, `unique_buyers_1h`, `cluster_ratio` |
| `pervyy_vystrel_surveillance_tick` | Phase B hourly | `mcap`, `vol1h`, `holder_delta_30m` |
| `pervyy_vystrel_cluster_dump_confirmed` | Phase C pass | `dump_pct`, `cluster_sell_ratio`, `sellers[]` |
| `pervyy_vystrel_dump_retail_skipped` | Phase C fail retail | `retail_panic_score` |
| `pervyy_vystrel_phase_d_armed` | Phase D window open | `bottom_mcap`, `reramp_pct` |
| `pervyy_vystrel_entry_signal` | All D gates pass | `would_enter` (shadow) / `enter` (gate) |
| `pervyy_vystrel_shadow_skip` | Gate blocked | `reasons[]` |
| `pervyy_vystrel_watch_evicted` | TTL / drop | `reason` |
| `pervyy_vystrel_vol_auth_snapshot` | Batch §6.4 | `wash_score`, `organic_score`, `round_trip_share` |
| `pervyy_vystrel_vol_auth_wash_blocked` | Phase A/B block | `wash_score`, `reasons[]` |
| `pervyy_vystrel_vol_auth_fake_dump_skipped` | Phase C fake churn | `cycle_share` |
| `live_discovery_eval` (extended) | Каждый eval | `pervyy_vystrel: { phase, reasons, pass, volAuth }` |

**Dashboard / hourly report:** counters `pervyy_vystrel_watch_count`, `cluster_dump_confirmed_24h`, `entry_signal_24h`, `would_enter_24h`.

---

## §13. Shadow mode rollout

### 13.1. Стадии (обязательный порядок)

| Стадия | Env | Мин. длительность | Критерий продвижения |
|--------|-----|-------------------|----------------------|
| S0 off | `ENABLED=0` | — | PR1 merged |
| S1 watchlist shadow | `ENABLED=1`, `MODE=shadow`, organic/cluster shadow | **3d** | Snapshots >0 для ≥80% pump alerts |
| S2 full shadow | all subgates shadow | **7d** | eval p95 <200ms; ≥10 cluster_dump events |
| S3 advisory | Telegram ADVICE on Phase D would_enter | 48h | Operator review |
| S4 gate | `MODE=gate` | — | FP manual review ≤20% would_enter |

### 13.2. Kill switches

1. `PAPER_PERVYY_VYSTREL_ENABLED=0`
2. `PAPER_PERVYY_VYSTREL_MODE=off`
3. `PAPER_PERVYY_VYSTREL_ORGANIC_GATE_ENABLED=0`
4. `pm2 reload ecosystem.config.cjs --only live-oscar --update-env`

### 13.3. Откат

Без git rollback: env OFF + reload. С git: redeploy предыдущий product tag по NORM §5.

---

## §14. Связь с Wallet Intel L3 organic flow

| Coin Intel слой | First Shot usage |
|-----------------|------------------|
| L2 `wallet_intel_decisions` | Denylist (Phase A, D7) |
| L2 `entity_wallets` | Cluster map |
| L3 `mint_organic_flow_snapshot` (**новый**) | Phase A positive gate |
| L3 + §6.4 vol-auth | Shared batch layer — **не дублировать** |
| L4 `evaluateOscarIntelGate` | Shared denylist path |
| I3 coordinated dump exit | Optional Phase 2 exit overlay |

**Отличие от af6a5611 proposal «Runner Lite v2»:** First Shot **не** снижает только mcap/vol пороги runner_lite — он добавляет **обязательную** state machine cluster dump → re-ramp. Runner Lite v2 momentum+dip остаётся ортогональным; возможна конвергенция L3 organic gate в общий модуль.

---

## §15. Anti-patterns

| ❌ | Почему |
|----|--------|
| Включить gate без PR1 ingest | 100% FN (hYhqi) |
| Entry на Phase A momentum | FOMO / wash |
| Entry без cluster attribution | Retail panic trap |
| Holders live RPC в discovery tick | Budget |
| `pm2 stop all` при rollout | NORM §5.3 |
| Bump platform VERSION за product doc | Только `docs/strategy/**` |

---

## §16. Версионирование документа

| Версия | Дата | Изменение |
|--------|------|-----------|
| **0.4** | 2026-07-04 | Position **2×$25** ($50/mint); exposure **4×$50=$200**; env contract + config stub; shadow-first `pervyy_vystrel_v1` |
| **0.3** | 2026-07-04 | §17 disk forensics + architecture revision (options A–D, separate VPS reassessment) |
| **0.2** | 2026-07-04 | §6.4 volume authenticity; §17 infrastructure/architecture appendix; D10 gate; journal + PR2 |
| 0.1 | 2026-07-04 | Первая DRAFT spec tier «Первый выстрел» |

---

## §17. Appendix — Infrastructure & architecture decision (2026-07-04)

### 17.1. VPS load & disk snapshot (`salpha-v2`, read-only SSH 2026-07-04 ~22:50 UTC)

#### Runtime

| Метрика | Значение | Оценка |
|---------|----------|--------|
| Uptime | 38d | Stable |
| Load average | **7.8 / 6.6 / 6.6** (2 vCPU) | **Elevated** — ~3–4× per-core |
| CPU steal (`vmstat st`) | **~39%** | **Критично** — oversubscription / noisy neighbor |
| RAM | 7.8 GiB total, **2.0 GiB used**, **5.7 GiB available** | Headroom OK |
| Swap | **1.4 GiB / 4.0 GiB used** | Эпизоды pressure |
| **`live-oscar` PM2** | ~104 MB log + ~16 MB proc, ~0.3% CPU | **Не перегружен** |
| Collectors | `sa-moonshot`, `sa-meteora`, `sa-raydium` — доминируют CPU | Узкое место — **aggregate collectors**, не trading hot path |

#### Disk forensics (`df -h /` → **96G, 74G used, 23G free — 77%**)

| Категория | Путь | Размер | Комментарий |
|-----------|------|--------|-------------|
| **JSONL live journal** | `data/live/pt1-oscar-live.jsonl` | **7.7G** | Рабочий prod journal — **не удалять** без rotation policy |
| **Stale JSONL backup** | `data/live/pt1-oscar-live.jsonl.bak-world-*` | **6.7G** | Одноразовый backup — **кандидат на удаление / off-VPS** |
| **bscpulse journal** | `data/bscpulse/bscpulse-journal.jsonl` + `.tmp` | **5.0G + 2.9G** | Журнал + orphan `.tmp` — **кандидат на truncate/archive** |
| **PM2 logs (total)** | `/home/salpha/.pm2/logs` | **6.2G** | **`hl-twap-telegram-watch-out.log` = 5.2G** — нет ротации |
| **PG data dir** | `/var/lib/postgresql/16/main` | **13G** (`solana_alpha` DB **12 GB**) | Легитимные данные |
| **Local PG backups** | `/home/salpha/backups/postgres/` | **12G** | **12 daily dumps** ~970 MB (Jun 23 – Jul 3) — retention **>7d on-box** |
| **Live backups** | `/home/salpha/backups/live/` | **2.8G** | Старые journal/runtime копии |
| **Прочие data/** | `superbot-journal.jsonl`, `basepulse`, copytrader | **~0.5G** | Мониторинг |
| **node_modules + npm cache** | `node_modules`, `~/.npm` | **~0.7G** | `npm cache clean` — мелкий win |
| **/var/log** | journal + postgres + syslog | **~0.7G** | journal 416M — норма |

**Сумма «дешёвых» reclaim-кандидатов (без потери prod journal):**

| Действие | Оценка освобождения |
|----------|---------------------|
| Удалить `pt1-oscar-live.jsonl.bak-world-*` | **~6.7G** |
| Truncate/rotate `hl-twap-telegram-watch-out.log` + `pm2-logrotate` | **~5.2G** |
| Архив/удалить `bscpulse-journal.jsonl` + `.tmp` (если tier не active) | **~7.9G** |
| PG backup retention: оставить 2–3 последних, старые → off-VPS | **~9G** |
| Retention `/home/salpha/backups/live` | **~2G** |
| **Итого потенциал** | **~25–31G** → usage **~45–52%** без нового сервера |

**Вывод по диску:** 77% — **реальная проблема**, но **не structural**. Накопление backups, PM2 logs без ротации и stale JSONL — **не** нехватка места под collectors/PG growth. **Immediate cleanup бесплатен** и снимает «imminent collector failure» до batch jobs.

**Вывод по CPU:** steal **39%** — аргумент **за** выделенный VPS **сильнее**, чем диск. Collectors + batch analyzers конкурируют за oversubscribed 2 vCPU.

### 17.2. Wallet Intel roadmap status (из [`LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md`](./LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md))

**Phase 1 (MVP) — частично выполнен:**

| ID | Фича | Статус prod |
|----|------|-------------|
| I1 | Wallet-intel mint gate | ✅ `oscar-intel-gate.ts`, gate на prod/runner lanes |
| I2 | Scam-farm / serial rug awareness | ✅ subset I1 via tags |
| **L3** | `mint_organic_flow_snapshot` / positive gate | ❌ **spec only** — блокирует First Shot Phase A |
| **runner_lite** | Sub-$1M lane | ✅ shipped 1.11.549 |

**Phase 2 — не завершён:** I3–I7 ❌; **Phase 3** — backlog.

**First Shot PR1–PR3 (§10)** пересекается с Coin Intel L3 + vol-auth — **один batch-modul layer**, не дублировать.

### 17.3. Architecture options (v0.3 framework)

> **Mapping v0.2 → v0.3:** старый «Option A (отдельный bot)» ≈ новый **C/D**; старый «B (lane)» ≈ **A**; старый «C (PM2 worker)» ≈ **B**; старый «D (schema lane)» — подмножество **A/D**.

| Option | Описание | Disk | CPU steal | Collector coupling | Ingest | Deploy | Wallet Intel | $/mo |
|--------|----------|------|-----------|-------------------|--------|--------|--------------|------|
| **A. Cleanup + shared lane** | Disk hygiene + `pervyy_vystrel` lane в `live-oscar`, shared PG | ✅ **+25–31G** после cleanup | ❌ steal ~39% | **Tight** — 2 vCPU shared | ✅ Single ingest | ✅ Один `v2` deploy | ✅ Shared pipeline | **$0** |
| **B. Separate PM2, same VPS + PG** | `pervyy-vystrel-materialize` — отдельный PM2 reload | Как A | ⚠️ reload isolation only | Tight CPU | ✅ Single ingest | ✅ 1 repo, 2 PM2 | ✅ Shared PG | **$0** |
| **C. Separate VPS + clone repo + own PG** | Полный клон на KVM, свой PG, свои collectors | ✅ Новый disk | ✅ Dedicated vCPU* | ✅ Decoupled | ❌ **2× ingest** | ❌ 2 pipelines, drift | ❌ Duplicate or RO feed | **$7–50** |
| **D. Platform product + VPS2 + schema PG** | `products.yaml` entry, monorepo, новый PG per `DB_TOPOLOGY.md` | Как C | Как C | Decoupled compute | ⚠️ RO replica or duplicate | ⚠️ VERSION bump + 2 targets | ⚠️ RO `core`/intel | **$10–50** |

\* Dedicated только если plan не oversubscribed.

#### KVM sizing (ориентир Hostinger-class)

| Plan | Spec | Достаточно для | Недостаточно для |
|------|------|----------------|------------------|
| **KVM1** ~$4–7/mo | 1 vCPU, 4 GB, 50 GB | **Только** batch worker + RO PG reads | Full collectors + 12 GB PG + live-oscar |
| **KVM2** ~$10–15/mo | 2 vCPU, 8 GB, 100 GB | Batch + materialize + лёгкий RO replica | Full duplicate collector fleet |
| **KVM4+** ~$30–50/mo | 4 vCPU, 16 GB | Standalone First Shot + own PG + selective collectors | Still need shared ingest or 2× RPC cost |

**Текущий VPS:** 2 vCPU, 8 GB, 96 GB — **диск recoverable**, **CPU contested** (steal 39%).

### 17.4. Roadmap sequencing

| Последовательность | Рationale |
|--------------------|-----------|
| **0. Disk cleanup** (immediate, ops) | 25–31G free; снимает false blocker |
| **1. PR1 ingest** (blocking) | Без snapshots/swaps — 100% FN (hYhqi) |
| **2. Shared L3 + vol-auth batch** (PR2) | Один pipeline для Coin Intel + First Shot |
| **3. PR3 live eval shadow** | После 1–2 |
| **4. Option B PM2 split** | Если batch p95 >200ms **после** cleanup |
| **5. Option C/D VPS** | Steal/load sustained **или** operator mandate |

### 17.5. Пересмотр: отдельный VPS + repo (ответ на pushback оператора)

Оператор прав в **диагнозе** («диск ~80%, collectors под угрозой»), но **лечение «новый сервер» — не первый рычаг**.

#### Когда оператор **прав**, что нужен отдельный VPS

| Условие | Почему C/D оправданы |
|---------|---------------------|
| После cleanup usage **>70%** через 30d | Structural growth (PG 12G+, JSONL) |
| Steal **>30% sustained** + load avg **>8** | Collectors голодают; First Shot batch ухудшит |
| Materialize + collectors conflict (p95 >500ms) | Dedicated compute |
| Mandate: независимый wallet / release cadence | Организационный |
| RPC budget позволяет **2× ingest** | Иначе C = **хуже** coverage чем A |

#### Когда отдельный VPS **не окупается**

| Факт | Implication |
|------|-------------|
| **~31G reclaimable** без downtime | 77% → **~50%** — breathing room **сегодня** |
| `live-oscar` **16 MB / 0.3% CPU** | Trading path не нуждается в отдельном bot |
| Full clone = **duplicate sigseed + collectors** | **2×** RPC; hYhqi FN **хуже** при drift |
| Wallet Intel / Atlas — batch upstream | Clone без RO feed = **empty L3** |
| Lane ≠ product (`runner_lite` precedent) | `products.yaml` не обязателен для tier |

#### Downside full repo clone (Option C)

```text
2× ingest   → QN bill, rate limits, sync drift
2× sigseed  → backfill races, inconsistent swaps
2× deploy   → два SHA, два .env, два pm2 reload
2× ops      → disk на VPS2 тоже растёт
Wallet Intel → duplicate Atlas OR fragile RO replica
$7 KVM1     → только batch-only; не full stack
```

**Компромисс C′ (batch-only VPS, ~$7/mo KVM1):** monorepo **один**, deploy **один** на prod; на KVM1 — **только** `pervyy-vystrel-materialize` + RO PG. Ingest **не** дублируется. **Лучше** full clone при steal problem.

### 17.6. Revised verdict & pragmatic tiers (2026-07-04 v0.3)

#### Tier 0 — Immediate (free)

| Действие | Effort |
|----------|--------|
| Удалить `pt1-oscar-live.jsonl.bak-world-*` | 5 min |
| Truncate/rotate `hl-twap-telegram-watch-out.log`; `pm2-logrotate` | 15 min |
| Audit `bscpulse-journal.jsonl` + remove `.tmp` | 15 min |
| PG backup retention: keep **3** on-box, rest off-VPS | 30 min |

**Verdict:** **сделать до любого architecture fork**.

#### Tier 1 — Short-term: **Option A + B**

| Решение | Verdict |
|---------|---------|
| Full clone repo + Postgres | **❌ Нет сейчас** |
| Lane + shared PG | **✅ Да** — `pervyy_vystrel` |
| Separate PM2 batch | **✅ Да** — off-peak materialize |

#### Tier 2 — Medium: **C′ or D**

| Trigger | Action |
|---------|--------|
| Steal **>35%** после cleanup | **C′:** KVM1 batch + RO PG (**~$7/mo**) |
| PG **>18 GB** или disk **>65%** sustained | KVM2 100 GB |
| Full capital isolation mandate | **D:** `products.yaml` + VPS2 schema |

#### Cost / when summary

| Tier | Option | Cost/mo | When |
|------|--------|---------|------|
| **0** | Disk cleanup | **$0** | **Now** |
| **1** | A+B shared lane + PM2 batch | **$0** | Default path |
| **2a** | C′ batch KVM1 + RO PG | **~$7** | Steal/load contention |
| **2b** | C full clone KVM2+ | **~$30–50** | Mandate + 2× ingest budget |
| **2c** | D platform product VPS2 | **~$30–50** | Standalone product |

**Final verdict v0.3:** отдельный сервер **не обязателен сегодня**. Disk — **ops debt**. Separate VPS имеет смысл после cleanup при sustained steal/load — предпочитать **C′** над full clone, **D** над fork.

**Triggers → Tier 2:** load **>10** / steal **>40%** / RAM **<800 MiB** / p95 **>500ms** / disk **>70%** через 30d post-cleanup / operator mandate.

---

*Продукт: solana-alpha only. Cross-product changes: none. Platform VERSION: не меняется (products.yaml не тронут).*
