# План: единый SSOT рыночных данных (price / mcap / liq)

**Продукт:** solana-alpha (Oscar VPS) + зеркало на Lera VPS  
**Язык:** русский  
**Дата:** 2026-07-07  
**Статус:** actionable roadmap (не спецификация реализации)  
**Cross-product:** Oscar ведёт норматив; Lera — отдельный VPS, тот же паттерн ([`LERA_DEX_QUOTE_FETCHER_SPEC.md`](./LERA_DEX_QUOTE_FETCHER_SPEC.md))

---

## 0. Честно про «идеал»

**Идеал ≠ волшебный API.** Идеал = **измеримые SLA свежести**, **один канонический источник котировок на VPS**, **одно правило выбора пула**, **явный fail (block buy)**, а не «тихий» PG fallback на 30‑минутном снимке.

Мы не получим бесконечно свежие mcap/vol без затрат (Dex RPM, PG tick, Jupiter CU). Цель — **нулевая слепота на buy-path**: если данных нет или они старше SLA — **skip/block с auditable reason**, а не покупка по устаревшей цене.

---

## 1. Текущее состояние (baseline на `origin/v2`, Jul 2026)

### 1.1. Уже merged (строим поверх)

| PR / SHA | Что дало | Статус |
|----------|----------|--------|
| **#404** (`eb50bc70`) | Dex quote cache L1→L2→gate; `fetchDexScreenerQuoteViaCache`; env `DEX_QUOTE_CACHE_*`, `DEXSCREENER_GLOBAL_*` на live-oscar + sa-raydium/meteora/moonshot/pumpswap | ✅ merged |
| **#407** (`c347f034`) | Wallet SoT: boot/heal close-not-buy, exit slice по chain | ✅ merged (не pricing, но снимает journal-driven blind buy) |
| **#408** (`cea8716c`) | copy-trader → `fetchDexScreenerQuoteViaCache` | ✅ merged |
| **#405** | Lera Dex fetcher spec | ✅ docs |
| **#409** (`bbca819a`, commit `accee604`) | Collector hotfix: **gate до HTTP abort timer**; shared `collector-http-fetch.mjs` | ✅ merged на `v2` |

### 1.2. Hotfix `d2ba736b`

**SHA `d2ba736b` в локальном клоне / `origin/v2` не найден** (malformed object). Эквивалентный fix уже в **`accee604`** → merged **PR #409**. **P0 blocker снят** после деплоя `bbca819a` на Oscar VPS.

> Если `d2ba736b` — черновик из другой ветки/форка, игнорировать; канон — `accee604`.

### 1.3. Оставшиеся дыры (почему ещё не SSOT)

| Область | Проблема |
|---------|----------|
| **Call sites** | `dashboard-server.ts`, `paper2-open-snapshot-enrich.mjs`, `mint-file-watch-telegram-format.ts`, `market-spike-telegram-watch.ts`, collectors `/dex/search` — часть **минует** quote cache |
| **Gate на copy-trader** | `DEX_QUOTE_CACHE_ENV` есть; **`DEXSCREENER_GATE_ENV` нет** → риск параллельных HTTP в обход gate |
| **Pool pick** | Dex: **max liq** (`pickBestSolanaPair` ×2 в TS); PG eval: **max liq** (`pickCanonicalSnapshotRow`); volume-leader tier: **max volume_1h** — **три правила** |
| **Discovery resolver** | `pickDiscoveryMarketQuote`: Dex fresh → OK; иначе **тихий fallback на PG** даже при `coverageGap` только как flag, не всегда block buy |
| **PG stale SLA** | `SNAPSHOT_FRESHNESS_MAX_AGE_SEC=1800` (30 min) на watch + live-oscar — **расширяет** терпимость к stale warehouse, не ужесточает buy-path |
| **MTM / tail / heal** | Jupiter executable vs Dex discovery quote — **разные контракты** ([`ARCHITECTURE_AUDIT_2026-07-07.md`](../live-oscar/ARCHITECTURE_AUDIT_2026-07-07.md) §3.3–3.4) |
| **Метрики** | 429 report есть (`rate-429-halfhour-report.mjs`); **нет** единого dashboard cache hit rate / snapshot age / `pg_stale_now` counter |

---

## 2. END STATE — архитектура

### 2.1. Один quote SSOT на VPS (расширение паттерна #404)

```
┌──────────────────────────────────────────────────────────────┐
│  MarketQuoteService (логический модуль; физически — cache+mjs) │
│  Единая точка: fetchMarketQuote(mint, { purpose, maxAgeMs })   │
└────────────────────────────┬─────────────────────────────────┘
                             │
     L1 in-process Map       │  TTL = DEX_QUOTE_CACHE_TTL_MS (12–60s)
     L2 file cache           │  data/dexscreener-quote-cache.json + flock
     L3 gate                 │  data/dexscreener-api-gate.json
     L4 HTTP                 │  GET /latest/dex/tokens/{mint}
                             │
     PG warehouse (read-only)│  только purpose=warehouse|backtest
     Jupiter (executable)    │  только purpose=mtm|exit|buy_quote
```

**Потребители (все через SSOT или явный purpose-split):**

| Consumer | Purpose | Источник в END STATE |
|----------|---------|----------------------|
| live-oscar discovery eval | `discovery_gate` | SSOT Dex cache → block если stale |
| live-oscar MTM / hot-tick | `mtm` | Jupiter quote (+ SSOT Dex для mcap/liq display) |
| sa-* collectors enrich | `collector_enrich` | SSOT batch/cache; gate-first |
| copy-trader | `discovery_gate` | SSOT (cache + gate) |
| dashboard / paper2 enrich | `display` | SSOT read-only; **не** raw HTTP |
| PG writers | `warehouse` | collectors primary upsert; SSOT для enrich полей |

**Не делаем отдельный daemon в P0–P1:** file cache + shared mjs/ts достаточно (проверено #404). **P3 опция:** thin HTTP sidecar только если file lock contention измерен > p99 SLA.

### 2.2. Один canonical pool pick rule

**Решение (зафиксировать в коде + docs, одна функция):**

| Контекст | Правило |
|----------|---------|
| **Default (99% путей)** | **max `liquidity.usd`** среди Solana-пар mint; tie-break: `ts DESC`, `volume_5m DESC`, `market_cap_usd DESC` — как `pickCanonicalSnapshotRow` |
| **Volume-leader inject tier** | **max `volume_1h`** — **только** для mint из `volumeLeaderMintSet`; явный flag `poolPickMode: 'volume_leader'` в eval features |
| **Dex HTTP parse** | Тот же `pickCanonicalPoolFromDexPairs(pairs, mint, mode)` — **экспорт из одного модуля**, удалить дубликат в `discovery-market-quote.ts` |

**Запрещено:** silent mix «Dex max liq price + PG max volume row mcap» в одном eval без audit поля `poolPickMode` + `pairAddress`.

### 2.3. Freshness SLA (измеримые, per use-case)

| Use-case | Поле | SLA (target) | Env / константа | При нарушении |
|----------|------|--------------|-----------------|---------------|
| **Discovery buy gate** (price/mcap/liq/vol для skip/pass) | `quoteAgeMs` | **≤ 60 s** | `DISCOVERY_QUOTE_MAX_AGE_MS=60000` | **block buy** (`data_coverage:quote_stale` / `coverage_gap`) |
| **Dex cache entry** (SSOT L2) | `fetchedAtMs` | **≤ 20 s** default TTL | `DEX_QUOTE_CACHE_TTL_MS=20000` | miss → gate fetch; fetch fail → block |
| **PG row для gate** | `pgSnapshotAgeMs` | **≤ 10 min** для **исполнения** gate | `PG_EXECUTION_MAX_AGE_MS=600000` | не использовать PG для buy; только warehouse hint |
| **PG warehouse health** (`pg_stale_now`) | `MAX(ts)` per table | **≤ 20 min** hard block | `SNAPSHOT_FRESHNESS_MAX_AGE_SEC=1200` (откат от 1800) | `pg_stale_now` block (кроме audited bypass) |
| **Collector tick** (write path) | tick duration | **≤ 25 min** p95 | ops metric | alert; не расширять block threshold до 30 min «чтобы замолчать» |
| **MTM / open position** | Jupiter quote age | **≤ 5 s** | `LIVE_JUPITER_QUOTE_TIMEOUT_MS` + hot-tick 2s | skip kill trigger, retry; **не** PG price |
| **Dashboard display** | any | **≤ 120 s** | `DASHBOARD_QUOTE_MAX_AGE_MS` | show stale badge; never drive execution |

**Принцип:** discovery gate и execution **не** читают PG snapshot старше `PG_EXECUTION_MAX_AGE_MS`. PG старше — только фоновый warehouse + alerts.

### 2.4. Fail behavior (stale = block buy, не blind buy)

| Сценарий | Сейчас | END STATE |
|----------|--------|-----------|
| Dex 429 / miss | fallback PG / skip eval | **block** + `discovery_eval` reason `dex_unavailable` |
| PG `pg_stale_now` | block (OK) | block; familiar bypass **только** с fresh external quote audit |
| PG row 15 min, Dex fresh 10 s | часто OK | OK — source=`dexscreener` |
| PG row 15 min, Dex miss | **blind: PG price in pick** | **block buy**; `coverageGap=true` → `blockedReasons` |
| «Расширим SNAPSHOT_FRESHNESS до 30 min» | было в 1.11.553 | **откатить для buy-path**; 30 min только для **non-blocking** watch Telegram |

**Контракт `resolveDiscoveryMarketQuote`:**

1. Fetch SSOT Dex (обязательно на live-oscar buy path).
2. `pickDiscoveryMarketQuote` — если нет fresh Dex **и** PG старше `PG_EXECUTION_MAX_AGE_MS` → **`blocked: true`**, не возвращать PG price для gate.
3. Jupiter buy quote — отдельный path; если Jupiter fail → **не buy**, не подставлять PG.

### 2.5. Метрики и алерты

| Метрика | Источник | Алерт порог | Куда |
|---------|----------|-------------|------|
| Dex HTTP **429** rate | PM2 logs + gate state | > N/30min per process | `[REPORT][agent_429]` (расширить на все sa-*) |
| **Cache hit rate** L1/L2 | counters в `dexscreener-quote-cache.mjs` | L2 hit < 70% при stable load | stdout + `data/market-quote-metrics.json` |
| **Snapshot age** per table | `fetchDexSnapshotFreshness` | any table age > SLA | `snapshot_stale` ALERT (уже есть) |
| **`pg_stale_now` eval count** | grep journal `data_coverage:pg_stale_now` | spike > baseline 3× / 1h | Telegram + dashboard tile |
| **coverage_gap blocks** | journal `coverage_gap` / features | trend up после deploy | release post-check |
| **Gate queue wait** p95 | timer around `acquireDexScreenerSlot` | > 10 s | ↑ `DEXSCREENER_GLOBAL_MAX_RPM` или ↓ parallel collectors |
| **eval blind buy proxy** | buys where `quote.source=pg_snapshot` && age > 60s | **any in prod** | P0 incident |

**PM2:** включить/расширить `rate-429-halfhour-report` + новый `market-quote-metrics-watch.mjs` (P1).

### 2.6. Что НЕ делать

| Anti-pattern | Почему |
|--------------|--------|
| **Homegrown volume indexer** (свой агрегатор vol из chain) | Дорого, дублирует PG collectors + Dex; не SSOT |
| **Birdeye primary без CU cap** | 1.11.554 OFF по RCA; включать только с `BIRDEYE_*` budget + tier guard |
| **NFS/rsync Oscar cache → Lera** | разные IP/квоты; coupling |
| **Расширять PG stale threshold вместо fix collectors** | маскирует enrich/gate баги (Jul 2026 RCA) |
| **Dashboard raw Dex** | обходит gate; duplicate HTTP |
| **Два `pickBestSolanaPair` в разных файлах** | drift mcap/liq между eval и cache |
| **pg_snapshot fallback на buy без audit** | прямой blind buy |

---

## 3. Фазовый roadmap (P0 → P3)

### P0 — «Stop blindness» (1–2 PR, deploy blockers)

**Предусловие:** ✅ PR #409 (`accee604`) на prod Oscar.

| # | PR | Scope | Files (ориентир) |
|---|-----|-------|------------------|
| P0-1 | **`fix/market-quote-block-stale-pg`** | Buy-path: `resolveDiscoveryMarketQuote` + dip-clones — **no PG fallback** if Dex miss & PG age > `PG_EXECUTION_MAX_AGE_MS`; emit `coverage_gap` block | `discovery-market-quote.ts`, `dip-clones.ts`, `pg-data-coverage-guard.ts`, tests |
| P0-2 | **`fix/dex-ssot-remaining-call-sites`** | copy-trader + dashboard + paper2 enrich → cache+gate; **`DEXSCREENER_GATE_ENV` on copy-trader** | `ecosystem.config.cjs`, `dashboard-server.ts`, `paper2-open-snapshot-enrich.mjs`, `copytrader/dex-info.ts` |
| P0-3 | **`fix/snapshot-freshness-buy-sla`** | `SNAPSHOT_FRESHNESS_MAX_AGE_SEC`: **1200** for blocking; document 1800 → watch-only | `ecosystem.config.cjs`, `pair-snapshot-freshness.ts` |

**Verify:** journal 24h — zero `buy` with `quote.source=pg_snapshot` & `pgSnapshotAgeMs>60000`.

### P1 — «One brain» (2–3 PR)

| # | PR | Scope |
|---|-----|-------|
| P1-1 | **`refactor/canonical-pool-pick-ssot`** | Export `pickCanonicalPoolFromDexPairs` + use in cache, discovery, tests; align SQL order docs |
| P1-2 | **`feat/market-quote-metrics`** | L1/L2 hit counters, gate wait histogram, `data/market-quote-metrics.json`, watch script |
| P1-3 | **`fix/tail-heal-dex-pricing`** | tail flush / copy adopt → `resolveDiscoveryMarketQuote` ([audit](../live-oscar/ARCHITECTURE_AUDIT_2026-07-07.md) §1.4, §2.3) |
| P1-4 | **`fix/collector-search-via-gate`** | `/dex/search` in collectors through `collector-http-fetch.mjs` |

### P2 — «SLA hardening»

| # | PR | Scope |
|---|-----|-------|
| P2-1 | **`feat/discovery-quote-sla-env`** | Unified env schema in `.env.example` + `ecosystem.config.cjs` |
| P2-2 | **`feat/pg-stale-dashboard-tile`** | `/api/paper2/health` — snapshot ages, cache stats, pg_stale count |
| P2-3 | **`fix/mtm-dex-alignment`** | MTM display mcap/liq from same SSOT snapshot as discovery (Jupiter price only for PnL %) |

### P3 — «Optional scale»

| # | PR | Scope |
|---|-----|-------|
| P3-1 | **`feat/market-quote-sidecar`** | Only if file-lock p99 > 200ms — localhost HTTP read-through cache |
| P3-2 | **Lera full parity** | Execute [`LERA_DEX_QUOTE_FETCHER_SPEC.md`](./LERA_DEX_QUOTE_FETCHER_SPEC.md) checklist on `/opt/lera` |
| P3-3 | **Cross-VPS observability** | Dashboard Lera tile reads Lera `/api/health` quote metrics (no shared cache) |

---

## 4. Lera VPS (отдельный хост)

**Принцип:** тот же **3-layer stack** (L1/L2/gate), **свой** `data/dexscreener-quote-cache.json` на `/opt/lera`, **не** Oscar file.

| Шаг | Действие | Ref |
|-----|----------|-----|
| 1 | Port gate + quote-cache mjs/ts | Lera spec §3 |
| 2 | `collector-http-fetch.mjs` gate-before-abort | Lera `0cf6a79`, Oscar `accee604` |
| 3 | PM2 env на **каждый** Dex consumer | `DEXSCREENER_GATE_ENV`, `DEX_QUOTE_CACHE_ENV` |
| 4 | Recon grep всех `api.dexscreener.com` | Lera spec §4.1 |
| 5 | Staging: 429 before/after | Lera spec §7 |

**END STATE Lera = END STATE Oscar** по контрактам SLA §2.3–2.4; физические файлы не shared.

---

## 5. Definition of Done (release checklist)

- [ ] Все `api.dexscreener.com` на Oscar VPS идут через cache+gate (grep CI guard)
- [ ] Одна exported pool-pick function; volume-leader — explicit mode only
- [ ] Buy path: stale → block; journal auditable reasons
- [ ] Metrics file + 429 report покрывают sa-* + live-oscar + copy-trader
- [ ] `npm run verify` green; post-deploy smoke + 24h journal audit
- [ ] Lera: spec checklist §11 complete on prod

---

## 6. Связанные документы

| Документ | Роль |
|----------|------|
| [`LERA_DEX_QUOTE_FETCHER_SPEC.md`](./LERA_DEX_QUOTE_FETCHER_SPEC.md) | Lera execution spec |
| [`ARCHITECTURE_AUDIT_2026-07-07.md`](../live-oscar/ARCHITECTURE_AUDIT_2026-07-07.md) | Pricing gaps PR-B–D |
| [`CHANGELOG.md`](../release/CHANGELOG.md) | #404–#409, 1.11.553–554 RCA |
| [`snapshot-canonical-pick.ts`](../../../src/papertrader/discovery/snapshot-canonical-pick.ts) | PG pool pick |
| [`dexscreener-quote-cache.ts`](../../../src/papertrader/pricing/dexscreener-quote-cache.ts) | Dex cache SSOT |

---

**Итог:** SSOT = shared cache module + единый pool pick + SLA per purpose + block-not-fallback. Не magic API — **измеримая дисциплина данных** на buy path.
