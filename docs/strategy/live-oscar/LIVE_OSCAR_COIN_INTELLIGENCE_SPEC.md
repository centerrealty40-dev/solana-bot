# Live Oscar — Coin Intelligence (superpowers): полная спецификация

**Продукт:** `solana-alpha` / PM2 `live-oscar`  
**Ветка:** `v2`  
**Статус:** normative (целевая архитектура и поэтапный rollout)  
**Версия спеки:** 1.1 (2026-07-01), продукт ≥ **1.11.542**

**Связанные нормативы:**

| Документ | Роль |
|----------|------|
| [`../specs/W9.0_dip_bot_intel_spec.md`](../specs/W9.0_dip_bot_intel_spec.md) | `dip_bot`, якоря Live Oscar, RPC-батчи |
| [`../../Smart Lottery V2/W6.9_wallet_intel_detective_trading_spec.md`](../../Smart Lottery V2/W6.9_wallet_intel_detective_trading_spec.md) | Слои L0–L4, BLOCK vs SMART |
| [`../../Smart Lottery V2/W6.11_intel_policy_dashboard_operator_spec.md`](../../Smart Lottery V2/W6.11_intel_policy_dashboard_operator_spec.md) | ENV, permissive/strict, K=1000 |
| [`../../Smart Lottery V2/W6.10_bot_umbrella_and_intel_pipeline.md`](../../Smart Lottery V2/W6.10_bot_umbrella_and_intel_pipeline.md) | Пайплайн tagger → scam-farm → policy |
| [`OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md`](./OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md) | Гибрид Shyft+PG; флаги default-OFF |
| [`LIVE_OSCAR_TRADING_SPEC_STREAM.md`](./LIVE_OSCAR_TRADING_SPEC_STREAM.md) | DEPRECATED-снимок prod-параметров Oscar |

**Существующий код (не дублировать вслепую):**

| Модуль | Назначение |
|--------|------------|
| `src/papertrader/discovery/smart-lottery-intel.ts` | **Эталон** mint-gate по early buyers + `wallet_intel_decisions` |
| `src/papertrader/whale-analysis.ts` | Entry-side: creator dump, group sell, DCA profiles |
| `src/papertrader/discovery/volume-sybil-guard.ts` | Wash dead→spike (PG snapshots) |
| `src/papertrader/discovery/volume-ephemeral-guard.ts` | Spike-only / tail wash |
| `src/intel/wallet-intel/*` | Policy materialize, `mintDecision`, CLI |
| `src/intel/scam-farm-detective/*` | SQL-детектив, Atlas, meta-clusters |
| `src/scripts/wallet-intel-pipeline.ts` | Cron-пайплайн (~4h / daily блок) |
| `src/live/copy-leader-attribution.ts` | Copy-trader ↔ Oscar shared wallet |

---

## §1. Видение и принципы

### 1.1. Задача

Добавить к **Live Oscar** слой **coin intelligence** — mint-scoped сигналы «можно / нельзя / осторожно» и **органические оверлеи** на выход, **не переписывая** discovery/collector/open-position hot path.

Oscar **сегодня** торгует **зрелые post-lane проливы** ($1.3M–$50M mcap, pool age ≥36h). Intelligence здесь — не «найти всю альфу Solana», а **отсечь координированный скам, бот-сети и скрытый дамп** на **конкретном mint** в момент решения.

**Ключевой инсайт оператора (2026-07-01):** для **зрелых** монет (крупный mcap, 10k+ holders, неделя–год жизни) early-buyer intel **мало полезен** — граф ранних кошельков уже «размыт» временем и вторичным рынком. Максимальная ценность intel — **свежие runners**, только что входящие в Oscar-фазу (текущий age gate 36h). При уверенных сигналах intel можно **безопасно опускать** минимальный возраст до **12h или 24h**, если mint не farm/wash. Матрица применимости — **§4**.

### 1.2. Принципы (жёсткие)

| # | Принцип | Формулировка |
|---|---------|--------------|
| P1 | **BLOCK > SMART** | Любой достаточно уверенный негатив (`BLOCK_TRADE`, scam-тег, meta-cluster) **перекрывает** позитивные smart-сигналы. Smart-tier **не обязателен** для входа Oscar. |
| P2 | **Mint-scoped, не chain-wide** | Запросы и политика только по **кандидату / открытой позиции / watched mint**. Запрещены full-scan графа и ad-hoc RPC по всей сети из `live-oscar`. |
| P3 | **Read-only overlay** | Intel **не пишет** в collector tables, **не меняет** снимки пар, **не блокирует** tick коллектора. Запись — только в intel-таблицы асинхронными job. |
| P4 | **Collector safety first** | Новые SQL/RPC **не в** discovery loop 10s и **не в** tracker hot-tick 2s без явного budget + кэша (§11). |
| P5 | **Default-OFF, reversible** | Каждый сигнал: env-флаг OFF → shadow (journal only) → advisory (Telegram) → hard gate. Откат = env + `pm2 reload`. |
| P6 | **Organic overlays** | Предпочитать **материализованные** решения (таблицы, MV, tick-cache), обновляемые cron, а не live JOIN тяжёлых графов на каждом eval. |
| P7 | **Trading-first precision** | Для denylist допустимы ложные запреты легче, чем ложные разрешения перед rug. Метрики FP/FN — по journal, не по «идеальной истине». |

### 1.3. Что уже есть в prod (baseline guards)

Эти механизмы **не заменяются** intelligence-слоем; новый слой **дополняет** после них или на exit-side:

- Volume sybil / ephemeral (PG `*_pair_snapshots`, 6–24h)
- PG data coverage guard
- Recovery / local-high / Policy A+ veto
- Whale analysis **на входе** (`PAPER_DIP_WHALE_ANALYSIS_ENABLED=1`, creator dump block, group pressure)
- Holders live **выключен** (`PAPER_HOLDERS_LIVE_ENABLED=0`)

---

## §2. Архитектура: intel как READ-ONLY overlay

### 2.1. Слои данных (L0–L4, адаптация W6.9 под Oscar)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ L0  Источники (существующие, не трогать hot path)                        │
│     • DEX collectors → *_pair_snapshots (60s cadence)                    │
│     • sigseed / wallet-backfill → swaps, money_flows                     │
│     • Gecko orchestrator → wallets                                       │
│     • Live Oscar JSONL → якоря dip_bot, copy-trader state                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ L1  Canonical facts (Postgres public)                                    │
│     swaps, money_flows, wallets, tokens, *_pair_snapshots               │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ L2  Batch enrichment (cron, отдельные процессы)                          │
│     wallet-tagger, scam-farm-detective, wallet-intel-policy, dip_bot     │
│     → wallet_tags, wallet_intel_decisions, scam_farm_*, dip_bot_*        │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ L3  Mint-scoped aggregates (новое / расширение)                          │
│     mint_intel_snapshot (кэш на mint), holder_top_pct MV, exit_whale_*   │
│     обновление: batch job + TTL invalidation, не per-tick full recompute │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ L4  Trading surfaces (live-oscar READ ONLY)                              │
│     • Entry: evaluateOscarIntelGate(mint) — после cheap gates            │
│     • Exit: evaluateCoordinatedDumpExit(mint, position) — tracker/async  │
│     • Shadow/advisory events → live JSONL                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2. Поток решения на входе (целевой порядок)

```text
discovery SQL pool (PG snapshots, 10s tick)
  → snapshot / global / dip / protectors (sybil, ephemeral, coverage)  [без изменений]
  → whale analysis (если cheap pass)                                     [существует]
  → **Oscar intel gate** (NEW, mint-scoped, 1 лёгкий SELECT или cache hit) [фаза MVP]
  → holders / cooldown / staged entry
```

**Инвариант:** intel-gate вызывается **только** если `preIntelReasons.length === 0` (аналог `cheapPass` перед holders в `dip-clones.ts`).

### 2.3. Поток на exit-side (фаза 2+)

```text
tracker hot-tick (2s) / open-position-hot-tick
  → существующая exit policy (Wave B, kill, trail)
  → **coordinated dump overlay** (READ swaps за lookback, cache TTL ≥30s на mint)
  → optional: partial de-risk / tighten trail (advisory → hard)
```

Exit-overlay **никогда** не добавляет синхронный multi-query RPC в hot-tick; только PG read + in-memory TTL cache.

### 2.4. Процессы и границы ответственности

| Процесс | Роль | Может писать в PG |
|---------|------|-------------------|
| `live-oscar` | READ intel cache / decisions; journal shadow/block | **Нет** (кроме JSONL) |
| `wallet-intel-pipeline`, `scam-farm:*`, `dip-bot-intel:*` | Materialize L2–L3 | Да, intel-таблицы |
| DEX collectors | Snapshots | Да, `*_pair_snapshots` |
| `copy-trader` | Sidecar; Oscar читает `state.json` | Свой state file |

---

## §3. Модель изоляции и rollout

### 3.1. Feature flags (мастер-иерархия)

| Env | Default | Уровень |
|-----|---------|---------|
| `LIVE_OSCAR_INTEL_ENABLED` | `0` | Мастер-выключатель всего слоя |
| `LIVE_OSCAR_INTEL_MODE` | `off` | `off` \| `shadow` \| `advisory` \| `gate` |
| `LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED` | `0` | Mint gate по wallet_intel (MVP) |
| `LIVE_OSCAR_INTEL_EXIT_DUMP_ENABLED` | `0` | Coordinated dump exit (фаза 2) |
| `LIVE_OSCAR_INTEL_HOLDER_CONC_ENABLED` | `0` | Top-holder concentration (фazа 2) |
| `LIVE_OSCAR_INTEL_REQUIRE_SWAP_COVERAGE` | `0` | Strict: нет swaps → block (debug) |

Подфлаги наследуют семантику Smart Lottery (`SMLOT_*`) где применимо; для Oscar — префикс `LIVE_OSCAR_INTEL_*`.

### 3.2. Режимы

| Режим | Поведение торговли | Journal |
|-------|-------------------|---------|
| `off` | Байт-в-байт текущий prod | — |
| `shadow` | **Не блокирует** | `live_oscar_intel_shadow` с `{mint, wouldBlock, reasons, ruleSetVersion}` |
| `advisory` | Не блокирует | + Telegram ADVICE (throttled) |
| `gate` | Hard block на entry / optional exit action | `live_oscar_intel_block` |

Переход только **вперёд по ступеням** с минимум **48h shadow** на prod перед `gate`.

### 3.3. Kill switches

1. `LIVE_OSCAR_INTEL_MODE=off` — мгновенное отключение всех эффектов.
2. `LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED=0` — точечно entry gate.
3. `pm2 reload ecosystem.config.cjs --only live-oscar --update-env` — без git rollback.
4. Git tag rollback — по [`../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md).

---

## §4. Scope by coin lifecycle (normative)

Intel **не одинаково полезен** на всех стадиях жизни mint. Спека фиксирует, какие сигналы применять в каком age-band, и при каких условиях допустимо **ослабление age gate** для ранних runners.

### 4.1. Матрица: age band × intel features

| Age band | Типичный профиль | Wallet-intel / early buyers (I1) | Sybil / ephemeral (existing) | Coordinated dump exit (I3) | Holder concentration (I4) | dip_bot advisory (I5) | Age gate relaxation |
|----------|------------------|----------------------------------|------------------------------|----------------------------|---------------------------|----------------------|---------------------|
| **0–12h** | Pre/post-lane, высокий rug risk | **Primary** — farm/scam operators видны в первых buy | **Primary** — wash/spike | Shadow only (мало истории) | Low value (holders ещё копятся) | Advisory if anchor exists | **Candidate lane** — только при intel green + shadow ≥7d |
| **12–24h** | Runner entering Oscar window | **Primary** — core MVP target | **Primary** | Entry shadow; exit Phase 2 | Batch only (no live RPC) | Advisory | **Candidate lane** — shadow first, then prod |
| **24–36h** | Текущий нижний порог prod (`PAPER_POST_MIN_AGE_MIN=2160`) | **Primary** — sweet spot | **Primary** | Entry + exit overlay | Batch gate optional | Advisory | Baseline prod gate; intel **обязателен** перед дальнейшим снижением age |
| **36h–7d** | Зрелый runner / mid-cap dip | Secondary (early graph ещё читаем) | Active | **Primary** on open positions | Useful | Useful | **No relaxation** — default Oscar lane |
| **7d+** | Established, часто 10k+ holders | **Deprioritized** — шум, stale early wallets | Active | **Primary** | **Primary** | Low | **No relaxation** |
| **Mature** (large mcap, week–year+, 10k+ holders) | «Старые» Oscar dip buys | **Not recommended** — early buyer graph не даёт edge | Active | **Primary** — cluster dump while holding | **Primary** — top-holder % / gini | Low | **No relaxation**; intel = exit + concentration, не mint gate по early buyers |

**Legend:** *Primary* = основной источник edge; *Secondary* = дополняет; *Deprioritized / Not recommended* = не тратить budget hot path; shadow/gate по §3.

### 4.2. Разделение стратегий по lifecycle

| Сценарий | Что использовать | Чего не делать |
|----------|------------------|----------------|
| **Fresh runner (12–36h)** | Wallet-intel mint gate, sybil/ephemeral, whale entry; optional SMART quorum | Полагаться только на mcap/holders без swap graph |
| **Mature large-cap dip** | Coordinated dump **exit**, holder concentration, whale group sell on position | Early buyer BLOCK как единственный gate — высокий FP, низкий edge |
| **Pre-lane (<12h)** | Только shadow journal + batch; **не** prod gate без отдельного lane | Снижать `PAPER_POST_MIN_AGE_MIN` без intel composite green |

### 4.3. Age relaxation policy (normative)

Текущий prod: `PAPER_POST_MIN_AGE_MIN=2160` (36h) для `live-oscar` (`ecosystem.config.cjs`).

**Ослабление до 720 (12h) или 1440 (24h) допускается только если:**

1. **Intel composite score = green** на mint в момент eval:
   - нет `BLOCK_TRADE` среди early buyers (wallet-intel gate);
   - нет срабатываний sybil / ephemeral guards;
   - нет scam-farm / meta-cluster tags на ранних кошельках;
   - smart accumulation (`SMART_TIER`) — **optional**, не обязателен для relax.
2. **Shadow mode first:** новый 12h/24h lane **минимум 7d shadow** (`LIVE_OSCAR_INTEL_MODE=shadow`) с journal `live_oscar_intel_shadow` + counterfactual «would have entered» до любого prod `PAPER_POST_MIN_AGE_MIN` change.
3. **Rollback:** вернуть `2160` одним env + `pm2 reload --only live-oscar --update-env`; отдельный флаг `LIVE_OSCAR_INTEL_AGE_RELAX_ENABLED=0` (default **0**) — мгновенный kill без трогания глобального post age.

| Target age | `PAPER_POST_MIN_AGE_MIN` | Preconditions |
|------------|--------------------------|---------------|
| 24h lane | `1440` | §4.3 green + 7d shadow on 24h cohort |
| 12h lane | `720` | §4.3 green + 7d shadow on 12h cohort + operator sign-off |

**Запрещено:** снижать age gate **без** intel layer enabled (`LIVE_OSCAR_INTEL_WALLET_GATE_ENABLED=1` at least shadow); blanket `PAPER_POST_MIN_AGE_MIN=720` для всех mint без per-mint composite.

### 4.4. Operator quote (essence)

> Для зрелых монет с большим mcap и 10k holders early buyer intel бесполезен. Intel нужен для **свежих runners** на входе в Oscar-фазу. Если intel показывает, что монета может пампить и это не farm/wash — можно **смело опускать age до 12–24h**, но сначала shadow.

---

## §5. Playbook отката по фазам

| Фаза | Что включено | Откат (оператор) | Критерий «откатить срочно» |
|------|--------------|------------------|----------------------------|
| **MVP shadow** | Wallet gate shadow only | `INTEL_MODE=off`, reload | N/A (no trade impact) |
| **MVP gate** | Wallet BLOCK on mint | `WALLET_GATE=0` или `MODE=shadow` | FP rate >5% blocked entries / 7d OR discovery p95 latency +>500ms |
| **Phase 2 shadow** | Exit dump overlay shadow | `EXIT_DUMP=0` | N/A |
| **Phase 2 gate** | Early exit on coordinated dump | `EXIT_DUMP=0` | Median PnL open positions −>15% vs 14d baseline |
| **Phase 3** | Holder conc + dip_bot fusion | Per-flag OFF | RPC/PG budget breach |

**После каждого rollout:** зафиксировать `git rev-parse HEAD`, строку env в CHANGELOG, 24–48h мониторинг `live_oscar_intel_*` + `disc=0` rate + PG `pg_stat_activity`.

---

## §6. Стратегия PostgreSQL

### 6.1. Оценка ёмкости VPS

| Ресурс | `salpha-v2` (187.124.38.242 / Tailscale) |
|--------|------------------------------------------|
| RAM | **7.8 GiB** total, ~**5.5 GiB** available |
| CPU | **2** vCPU |
| Disk `/` | **96G**, **65G used** (67%) |
| PG | Единый инстанс, schema **`public`** (solana-alpha v2); platform doc `schema-per-product` — целевой layout для multi-product, фактически Oscar/intel в **public** |

**Вывод:** отдельный VPS под intel **не требуется** на горизонте MVP–Phase 2. Риск — **конкуренция за RAM/IO** с collectors + `live-oscar`, не raw CPU.

### 6.2. Варианты размещения

| Вариант | Вердикт | Обоснование |
|---------|---------|-------------|
| **A. Текущий PG, public schema** | **✅ MVP–Phase 2** | Таблицы intel уже здесь; минимальный ops overhead |
| **B. Schema `intel` на том же PG** | **Phase 3 optional** | Изоляция прав `role_intel_ro`; миграции отдельной папкой; Oscar подключается RO |
| **C. Read replica** | **Deferred** | Нет replica сейчас; имеет смысл при p95 discovery SQL >200ms **из-за intel** |
| **D. Отдельный VPS + PG** | **❌ Not now** | 2 vCPU / 7.8G RAM уже shared; дублирование ingest дороже, чем batch+MV |

### 6.3. Query budget и pools

| Consumer | Budget | Механизм |
|----------|--------|----------|
| `live-oscar` discovery tick | **≤3** intel SQL / tick, **≤150ms** p95 суммарно | Cache hit → 0 SQL; miss → 1 mint query |
| `live-oscar` tracker | **≤1** intel read / mint / 30s | TTL cache in-process |
| Batch jobs | Off-peak UTC 03:00–05:00 | Существующий cron-блок RUNTIME.md |
| Collectors | **0** intel queries | Жёсткий запрет |

**Connection pool:** `live-oscar` использует существующий drizzle pool; intel reads **не** открывают отдельный pool до Phase 3. При введении schema `intel` — опционально второй pool max **3** connections RO.

### 6.4. Materialized views vs batch vs tick cache

| Паттерн | Когда | Пример |
|---------|-------|--------|
| **Tick cache (in-memory)** | Live read, TTL 30–120s | `mintIntelCache: Map<mint, {decision, ts}>` |
| **Table materialize (cron)** | Wallet-level policy | `wallet_intel_decisions` (exists) |
| **Mint snapshot table (NEW)** | Агрегат per mint | `mint_intel_cache(mint, rule_set_version, payload jsonb, computed_at)` — optional Phase 2 |
| **Materialized view** | Тяжёлые join swaps+tags | `mv_mint_early_buyer_flags` REFRESH CONCURRENTLY каждые 4h — только если p95 без MV плохой |
| **On-demand per tick** | **Запрещено** для L2+ joins | — |

### 6.5. Индексы (минимум для MVP)

Уже есть: `wallet_intel_decisions(decision, rule_set_version)`, `swaps(base_mint, side, block_time)`.

Добавить при gate rollout (миграция):

- `CREATE INDEX CONCURRENTLY IF NOT EXISTS swaps_base_mint_buy_time_idx ON swaps (base_mint, block_time) WHERE side = 'buy';`
- При MV — отдельная spec миграции с `REFRESH` job.

---

## §7. Рекомендуемая ПЕРВАЯ фича (MVP)

### 7.1. Выбор: **Wallet-intel mint gate для Live Oscar**

**Primary window:** age band **12–36h** (§4) — свежие runners на входе в Oscar-фазу. Для mature large-cap (7d+, 10k holders) wallet gate **не** первая фича; там Phase 2 exit + holder conc.

**Не** coordinated dump exit и **не** holder concentration первыми.

| Кандидат | Зрелость кода | Edge | Риск hot path | Данные |
|----------|---------------|------|---------------|--------|
| **Wallet-intel wire** | ★★★★★ `smart-lottery-intel.ts`, pipeline cron | Высокий: BLOCK scam/farm early buyers | Низкий: 1 SQL / mint, cache | `swaps` + `wallet_intel_decisions` |
| Coordinated dump exit | ★★★ `whale-analysis.ts` entry-only | Средний на exit; нужен tracker overlay | **Средний–высокий** (hot-tick) | `swaps` sells |
| Holder concentration | ★★ `safety/` W7.2, holders OFF | Средний | **Высокий** если RPC live | RPC / thin PG |

### 7.2. Обоснование данными

1. **Эталон уже в prod-коде:** `evaluateSmartLotteryIntelGate` — proven SQL pattern; Oscar = port + env namespace + placement после whale gate.
2. **Операторская политика зафиксирована:** W6.11 — `BLOCK_TRADE` > SMART; permissive при отсутствии swaps (`REQUIRE_SWAP_COVERAGE=0`).
3. **Пайплайн materialize работает:** cron `wallet-intel-pipeline` / `scam-farm:detect` (RUNTIME.md); решения **precomputed**, не в discovery loop.
4. **Урок W9.0 dip_bot:** провал из-за **дыр в swaps ingest**, не из-за gate logic. Перед `gate` — проверить `SELECT count(*) FROM swaps WHERE base_mint = $anchor` > 0 на выборке 20 последних Oscar opens.
5. **Whale analysis уже блокирует creator dump на входе** — wallet-intel закрывает **другой класс** (farm operators, meta-cluster), не дублирует whale.

### 7.3. MVP scope (implementation spec summary)

1. Новый модуль `src/papertrader/discovery/oscar-intel-gate.ts` — refactor shared core с `smart-lottery-intel.ts` **или** thin wrapper.
2. Вызов из `dip-clones.ts` после whale block, до holders — только при `LIVE_OSCAR_INTEL_*`.
3. Journal kinds: `live_oscar_intel_shadow`, `live_oscar_intel_block`.
4. Env block в `ecosystem.config.cjs` — **все OFF**.
5. Tests: `tests/oscar-intel-gate.test.ts` — mock DB, режимы off/shadow/gate.
6. **Не включать** `SMLOT_*` на live-oscar; отдельные `LIVE_OSCAR_INTEL_*`.

**Acceptance (MVP gate):**

- [ ] 48h shadow: ≥95% candidate evals без intel SQL timeout
- [ ] Documented FP samples in journal (manual review)
- [ ] `npm run typecheck` + tests green
- [ ] No increase in discovery tick wall time p95 >200ms (measured via log)

---

## §8. Дорожная карта P0–P3 и фазы MVP→Phase 3

### 8.1. Приоритеты superpowers (P0–P3)

| Tier | ID | Фича | Тип | Фаза |
|------|-----|------|-----|------|
| **P0** | I1 | Wallet-intel mint gate (`BLOCK_TRADE`, scam tags, meta-cluster) | Entry block | **MVP** |
| **P0** | I2 | Scam-farm / serial rug dev awareness (read tags) | Entry block | MVP (subset of I1) |
| **P0** | I3 | Coordinated dump **exit** overlay | Exit de-risk | Phase 2 |
| **P1** | I4 | Holder concentration gate (top holder % / gini proxy) | Entry block | Phase 2 |
| **P1** | I5 | Dip_bot presence in pre-window (W9.0) | Entry advisory→block | Phase 2 |
| **P1** | I6 | Усиление whale **exit** (group dump while holding) | Exit | Phase 2 |
| **P2** | I7 | `mint_intel_cache` + dashboard operator | Observability | Phase 2 |
| **P2** | I8 | SMART_TIER positive quorum (optional entry boost) | Entry soft | Phase 3 |
| **P2** | I9 | Copy-trader fusion rules (§10) | Both | Phase 2–3 |
| **P3** | I10 | Cross-mint operator graph (meta-cluster v2) | Batch only | Phase 3 |
| **P3** | I11 | ML / score calibration по journal FP/FN | Offline | Backlog |

### 8.2. MVP (Phase 1) — Wallet gate

**Deliverables:** §7.3, shadow → gate rollout.

**Metrics:**

- `intel_shadow_would_block_rate` = wouldBlock / candidates
- `intel_gate_block_rate` = blocked / candidates
- `intel_swap_coverage_rate` = mints with swaps / evaluated
- Discovery latency p50/p95 (existing + new field `intelMs`)

**Kill switch:** §3.3.

### 8.3. Phase 2 — Exit + enrichment

**Deliverables:**

1. **Coordinated dump exit** — reuse whale group_sell logic on **open positions**, lookback 10–30 min, min 2 sellers, sum ≥$2.5k configurable; mode shadow first.
2. **Holder concentration** — prefer **batch** top-holder from PG `tokens` / safety batch job (W7.2 path), not live RPC until budget proven; gate if top1 >40% (configurable).
3. **dip_bot advisory** — read `wallet_tags.tag=dip_bot` for early buyers; default advisory only (W9.0 steady state).
4. Optional **`mint_intel_cache`** table refreshed by `wallet-intel:mint-snapshot` job every 4h for watched mints.

**Acceptance:**

- [ ] Exit overlay shadow 7d without tracker tick regression
- [ ] PG intel queries during 03:00–05:00 UTC only for heavy refresh
- [ ] Holder gate does not enable `PAPER_HOLDERS_LIVE` on discovery tick

### 8.4. Phase 3 — Fusion + smart path

**Deliverables:**

1. SMART_TIER entry quorum (optional size bump, never override BLOCK).
2. Copy-trader fusion (§10) in `gate` mode.
3. Schema `intel` RO role if query contention measured.
4. Counterfactual tooling: `% blocked mints that would have been +PnL` from journal.

**Acceptance:**

- [ ] Operator sign-off on FP/FN review
- [ ] No cross-product schema writes
- [ ] Platform VERSION unchanged unless `docs/platform/**` touched

---

## §9. Что НЕ делать (anti-patterns из roadmap)

| ❌ | Почему |
|----|--------|
| Новые SQL/RPC **внутри** collector loop 60s | Блокирует ingest snapshots; ломает sybil/ephemeral |
| Chain-wide graph в `live-oscar` | Budget, latency, scope violation |
| Синхронный `wallet-intel-pipeline` из discovery | Pipeline = minutes; decisions must be precomputed |
| Блокировать mint **только** из-за umbrella `bot` без scam signal | W6.10 / W6.11 explicit |
| Strict `REQUIRE_SWAP_COVERAGE=1` on prod без swaps backfill | Повтор провала W9.0 |
| Holders live RPC on every candidate tick | QN budget; включать только batch + cache |
| Отдельный stream product / `oscar-stream` | Закрыт; гибрид Shyft — см. OPTIMIZATION_ROADMAP |
| Писать intel verdicts из `live-oscar` | Нарушает L2/L4 separation |
| `pm2 stop all` / restart collectors for intel deploy | NORM §5.3 — only targeted reload |
| Smart-tier **override** BLOCK | Принцип P1 |
| MV refresh **CONCURRENTLY** без monitoring disk | 67% disk used — schedule + `pg_size_pretty` watch |

---

## §10. Интеграция с copy-trader (fusion rules)

Copy-trader (`copy-trader` PM2) делит кошелёк `live-oscar-micro` с Oscar (1.11.540+). Intelligence **обязан** учитывать sidecar state.

### 10.1. Атрибуция позиций

- Oscar discovery: `copy-leader-attribution.ts` вычитает copy cost basis из cap gates — **без изменений**.
- Intel gate оценивает **mint**, не wallet path: copy-leader leg **не exempt** от scam block (farm на mint опасен для обоих).

### 10.2. Fusion rules (normative)

| Rule | Behavior |
|------|----------|
| **F1** | Intel **entry block** на mint → copy-trader **не открывает** новую ногу на этом mint (copy process reads same cache file or PG read — implementation choice; prefer shared `mint_intel_cache`). |
| **F2** | Copy-leader open + Oscar intel **exit dump** shadow fired → Telegram ADVICE on both channels; gate mode → copy **may** exit independently via its own sell rules (do not block copy sell). |
| **F3** | Oscar entry allowed + copy leader buys same mint → copy follows leader; intel **не** дублирует eval if cache hit <60s. |
| **F4** | Shared wallet sell: intel exit **не** триггерит sell copy leg unless `COPY_TRADER_INTEL_EXIT_FOLLOW=1` (default **0**). |
| **F5** | Kill switch `LIVE_OSCAR_INTEL_MODE=off` → copy-trader intel follow **off** regardless of copy env. |

### 10.3. Env (copy-trader namespace)

| Env | Default |
|-----|---------|
| `COPY_TRADER_INTEL_GATE_ENABLED` | `0` |
| `COPY_TRADER_INTEL_CACHE_PATH` | optional shared JSON cache written by live-oscar shadow |
| `COPY_TRADER_INTEL_EXIT_FOLLOW` | `0` |

---

## §11. Collector safety contract (normative)

### 11.1. Явные правила

1. **Zero intel queries** in: `scripts-tmp/*-collector.mjs`, `sa-grws-collector`, sigseed enqueue/run hot paths.
2. **Zero intel queries** in discovery tick **кроме** разрешённого `evaluateOscarIntelGate` (max 1 SELECT/mint, cache TTL ≥60s, timeout 2s → fail-open to `ok` in shadow/advisory, configurable fail-closed in gate).
3. Intel **jobs** run only via cron / manual CLI (`npm run wallet-intel:*`, `dip-bot-intel:*`).
4. Rate limits: max **500** distinct mints/day touched by batch mint snapshot job.
5. Fail-open default for Oscar money path: if PG error → log `intel_pg_error`, **do not block** unless `LIVE_OSCAR_INTEL_FAIL_CLOSED=1` (default 0).
6. Open position management (`tracker.ts`, `open-position-hot-tick.ts`): intel reads **async deferred** — schedule after tick work, or read cache only.
7. No new **writes** to `*_pair_snapshots` from intel layer.
8. JSONL fsync rules unchanged; intel events are **non-critical** append.

### 11.2. Allowed query shape (entry gate)

One statement equivalent to `smart-lottery-intel.ts`:

- Probe: `COUNT(*) FROM swaps WHERE base_mint = $1 AND side = 'buy'`
- Main: early wallets CTE + EXISTS on `wallet_intel_decisions`, `wallet_tags`, optional meta tables

**Forbidden:** unbounded `JOIN` on `money_flows` without `mint` filter; sequential scan on `swaps` without `base_mint` predicate.

### 11.3. Observability

- Hourly report (`hourly-telegram-report.mjs`): append line `intel_gate_blocks_24h` when enabled.
- `wallet-intel:doctor` before each gate promotion.

---

## §12. Органические оверлеи (концепт)

**Органический** = сигнал вырос из **наших** данных (swaps, snapshots, journal anchors), без paid third-party API.

| Overlay | Источник | Refresh |
|---------|----------|---------|
| Sybil / ephemeral | PG snapshots | realtime on tick (existing) |
| Whale entry/exit | PG swaps | tick + cache |
| Wallet intel | Batch policy | 4h pipeline |
| dip_bot | JSONL anchors + RPC batch | daily/weekly |
| Holder conc | safety batch / tokens | 6h |
| Scam meta-cluster | scam-farm graph phase B | daily |

Оверлеи **комбинируются** логическим OR на block, AND на «safe» только если явно включено (не по умолчанию).

---

## §13. Связь с Shyft hybrid roadmap

Coin intelligence **ортогонален** Shyft price primary (OPTIMIZATION_ROADMAP этап 1). Общие правила:

- default-OFF flags
- shadow before gate
- не смешивать stale-price metrics с intel metrics в одном alert без разделения

При `SHYFT_PRICE_PRIMARY_ENABLED=1` intel gate **не меняет** источник цены — только pass/fail на mint.

---

## §14. Чеклист исполнителя (первый PR MVP)

- [ ] Extract/shared `evaluateMintIntelGate(mint, cfg, namespace: 'oscar' | 'smlot')`
- [ ] Wire in `dip-clones.ts` behind `LIVE_OSCAR_INTEL_*`
- [ ] JSONL schema kinds registered in `src/live/events.ts`
- [ ] `ecosystem.config.cjs` live-oscar block documented, all OFF
- [ ] Tests + typecheck
- [ ] Entry in `docs/strategy/release/CHANGELOG.md` on enablement (not on spec-only doc)
- [ ] Run `wallet-intel:doctor` on VPS before shadow enable
- [ ] 48h shadow evidence attached to follow-up PR for gate

---

## §15. Версионирование документа

| Версия | Дата | Изменение |
|--------|------|-----------|
| 1.1 | 2026-07-01 | §4 Scope by coin lifecycle: age-band matrix, mature vs runner intel, age relaxation policy (12h/24h shadow-first) |
| 1.0 | 2026-07-01 | Первая полная spec (superpowers roadmap consolidation) |

---

*Продукт: solana-alpha only. Cross-product changes: none.*
