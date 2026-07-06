# SPEC — Lera: единый DexScreener fetcher (как Oscar)

**Назначение:** инструкция для агента, работающего **только на продукте Lera** (`/opt/lera`, VPS `72.62.152.201`).  
**Язык:** русский (plain language + технический чеклист).  
**Референс Oscar:** реализация в репозитории `solana-alpha` (VPS `100.82.221.89`, `/opt/solana-alpha`).  
**Где живёт этот документ:** `docs/strategy/pricing/LERA_DEX_QUOTE_FETCHER_SPEC.md` в `solana-alpha`. Lera **не** зарегистрирована в `docs/platform/products.yaml` — отдельный продукт на отдельном VPS; Oscar-сторона ведёт cross-product spec, Lera-агент исполняет на своём клоне.

---

## 0. Статус Oscar (контекст, не трогать)

| Изменение | Статус |
|-----------|--------|
| Tier sizing (mcap tiers, scalp_wave escalation) | **Merged PR #403** на Oscar |
| Dex quote cache + gate (`DEX_QUOTE_CACHE_*`, `DEXSCREENER_GLOBAL_*`) | **Может быть in flight** — файлы есть локально в Oscar-репо, деплой на Oscar VPS проверить по `git rev-parse HEAD` и наличию `data/dexscreener-quote-cache.json` |

Lera **не ждёт** merge Oscar dex-cache PR для старта: копирует **паттерн**, не общий файл кэша.

---

## 1. Проблема

На Lera VPS несколько процессов (live-trader, collectors, enrich-скрипты) независимо бьют в DexScreener REST:

```
GET https://api.dexscreener.com/latest/dex/tokens/{mint}
```

**Симптомы:**

- HTTP **429** (rate limit) в логах collectors / discovery eval
- Один и тот же mint запрашивается **2–5× за секунду** разными PM2-процессами с **одного egress IP** Lera VPS
- Пропуски eval / `coverage_gap` / stale PG fallback из-за пустых Dex-ответов после 429
- Журнал `data/live/pt1-lera-live.jsonl` — eval/consistency страдает, хотя Oscar на другом IP может быть здоров

**Корневая причина:** нет **cross-process** dedup и **глобального** rate gate на одном VPS. In-process `Map` в каждом процессе не видит соседей.

**Важно:** Oscar file cache (`/opt/solana-alpha/data/dexscreener-quote-cache.json`) **недоступен** Lera — другой хост, другой IP, другой `cwd`. NFS/rsync Oscar→Lera для hot cache **не** использовать в фазе 1.

---

## 2. Референс-архитектура Oscar

Oscar решил проблему трёхуровневым стеком на **одном VPS / одном egress IP**.

### 2.1. Слои кэша (L1 → L2 → HTTP)

```
┌─────────────────┐
│  PM2 process A  │──┐
│  (live-oscar)   │  │  L1: in-process Map<mint, {at, val}>
└─────────────────┘  │       TTL = DEX_QUOTE_CACHE_TTL_MS
┌─────────────────┐  │
│  PM2 process B  │──┼──► L2: JSON file + flock
│  (sa-raydium)   │  │       data/dexscreener-quote-cache.json
└─────────────────┘  │       + .lock для атомарных read-modify-write
┌─────────────────┐  │
│  PM2 process C  │──┘
│  (enrich script)│
└─────────────────┘
         │ miss
         ▼
┌─────────────────────────────────────┐
│  Gate: dexscreener-api-gate.mjs     │
│  data/dexscreener-api-gate.json     │
│  nextAllowedMs + minGap = 60s/RPM   │
└─────────────────────────────────────┘
         │
         ▼
   DexScreener HTTP
```

**Алгоритм одного fetch (упрощённо):**

1. Проверить L1 (in-process)
2. Прочитать L2 (file), если `fetchedAtMs` свежее TTL → вернуть
3. `acquireDexScreenerSlot()` — зарезервировать слот (может **подождать**)
4. **Повторно** проверить L2 (double-check после ожидания)
5. HTTP → распарсить лучшую Solana-пару (max `liquidity.usd`)
6. Записать в L2 + L1

### 2.2. Файлы Oscar (эталон для копирования логики)

| Файл | Роль |
|------|------|
| `scripts-tmp/dexscreener-api-gate.mjs` | Cross-process slot scheduler |
| `scripts-tmp/dexscreener-quote-cache.mjs` | L2 file cache + batch fetch + collector row helper |
| `src/papertrader/pricing/dexscreener-quote-cache.ts` | TS-версия для live-trader discovery (gate встроен) |
| `src/papertrader/pricing/discovery-market-quote.ts` | Orchestrator: Birdeye → Dex (via cache) → PG |

**Пути данных на Oscar VPS:**

| Файл | Default path |
|------|----------------|
| Quote cache | `data/dexscreener-quote-cache.json` |
| Quote cache lock | `data/dexscreener-quote-cache.json.lock` |
| Gate state | `data/dexscreener-api-gate.json` |
| Gate lock | `data/dexscreener-api-gate.json.lock` |

### 2.3. Gate (rate limit coordinator)

- Env: `DEXSCREENER_GLOBAL_RATE_LIMIT=1` (default ON), `DEXSCREENER_GLOBAL_MAX_RPM=42`
- `minGapMs = ceil(60000 / maxRpm)` — между **любыми** Dex HTTP с этого VPS
- Collectors **дополнительно** вызывают `acquireDexScreenerSlot()` перед **любым** URL с `api.dexscreener.com` (не только `/tokens/`)

### 2.4. Формат L2 cache entry

```json
{
  "entries": {
    "<mint>": {
      "miss": false,
      "priceUsd": 0.001,
      "marketCapUsd": 5000000,
      "liquidityUsd": 120000,
      "volume5mUsd": 8000,
      "volume1hUsd": 45000,
      "pairAddress": "...",
      "baseMint": "...",
      "quoteMint": "So11111111111111111111111111111111111111112",
      "fetchedAtMs": 1750000000000
    }
  },
  "updatedAt": 1750000000000
}
```

- TTL default **20 s** (clamp **12–60 s**)
- Prune при write: entries старше `TTL × 3` удаляются
- `miss: true` — негативный кэш (не долбить Dex каждый тик)

### 2.5. PM2 на Oscar (куда прокинут env)

`ecosystem.config.cjs`:

- `DEXSCREENER_GATE_ENV` + `DEX_QUOTE_CACHE_ENV` на: `live-oscar`, `sa-raydium`, `sa-meteora`, `sa-moonshot`, `sa-pumpswap`
- Discovery eval: `fetchDexScreenerMarketSnapshot()` → `fetchDexScreenerQuoteViaCache()` когда `DEX_QUOTE_CACHE_ENABLED=1`

---

## 3. Что должна сделать Lera

### 3.1. Рекомендация фазы 1: **локальный mirror Oscar** (per-server file cache)

**Почему не HTTP-клиент к Oscar в фазе 1:**

- Lera и Oscar — **разные egress IP** → у Lera **своя** квота DexScreener; Oscar cache не снимает 429 на Lera
- File cache на `/opt/lera` решает **внутри-VPS** dedup (главная боль)
- Нет cross-product runtime coupling, firewall, latency
- Копирование проверенного кода быстрее и безопаснее

**План:**

1. Портировать (или symlink/copy из Oscar fork) модули gate + quote-cache в Lera repo
2. Подключить **все** прямые Dex HTTP call sites на Lera VPS
3. Прописать env в Lera `ecosystem.config.cjs` (или аналог) для **каждого** процесса, который трогает Dex
4. Убедиться, что пути кэша — под **`/opt/lera/data/`**, не Oscar

**Альтернатива (не рекомендуется в фазе 1):** только gate без L2 — снижает 429, но duplicate HTTP на разные mint в одном tick останутся.

**Альтернатива (фаза 2):** HTTP quote service — см. §8.

### 3.2. Минимальный scope кода

- [ ] `dexscreener-api-gate.mjs` (или TS-эквивалент) — **один** на VPS
- [ ] `dexscreener-quote-cache.mjs` + TS wrapper для live-trader
- [ ] Замена прямых `fetch('https://api.dexscreener.com/...')` на `fetchDexQuoteViaCache` / `fetchDexQuotesBatchViaCache`
- [ ] Collectors: `isDexScreenerUrl(url)` → `acquireDexScreenerSlot()` в HTTP wrapper
- [ ] `.env.example` + PM2 env blocks
- [ ] Unit tests (vitest) по образцу Oscar `tests/dexscreener-quote-cache.test.ts`

### 3.3. Defaults для Lera (стартовые)

Скопировать Oscar defaults, при необходимости **снизить** RPM если Lera меньше процессов:

| Переменная | Default | Комментарий |
|------------|---------|-------------|
| `DEXSCREENER_GLOBAL_RATE_LIMIT` | `1` | OFF только для отладки |
| `DEXSCREENER_GLOBAL_MAX_RPM` | `42` | Можно `30` если 429 остаются |
| `DEXSCREENER_GLOBAL_GATE_PATH` | `data/dexscreener-api-gate.json` | Абсolute via PM2 |
| `DEX_QUOTE_CACHE_ENABLED` | `1` | |
| `DEX_QUOTE_CACHE_TTL_MS` | `20000` | 12–60 s |
| `DEX_QUOTE_CACHE_PATH` | `data/dexscreener-quote-cache.json` | **Только Lera VPS** |

---

## 4. Точки интеграции в кодовой базе Lera

Агент работает на **`/opt/lera`** (VPS `72.62.152.201`). Структура — Oscar-clone (`PAPER_STRATEGY_ID=live-lera`, journal `data/live/pt1-lera-live.jsonl`). Точные пути могут отличаться — **найти через grep**.

### 4.1. Обязательный reconnaissance (на VPS или локальном Lera clone)

```bash
cd /opt/lera

# Все прямые обращения к DexScreener
rg -n "api\.dexscreener\.com|dexscreener\.com/latest" --glob '*.{ts,mjs,js,cjs}'

# Уже существующий cache/gate (если частично портировали)
rg -n "DEX_QUOTE_CACHE|DEXSCREENER_GLOBAL|dexscreener-quote-cache|dexscreener-api-gate" .

# Discovery / market quote orchestrator
rg -n "fetchDexScreener|discovery-market-quote|resolveDiscoveryMarketQuote" src/

# Collectors
rg -n "acquireDexScreenerSlot|COLLECTOR_INTERVAL" scripts-tmp/ ecosystem.config.cjs

# Enrich / open-mint snapshot
rg -n "open-snapshot-enrich|birdeye-collector-enrich|getCachedDexQuote" scripts-tmp/

# PM2 процессы Lera
pm2 jlist | jq -r '.[].name'   # или pm2 list
grep -E "name:|dex|lera|collector|live" ecosystem.config.cjs
```

### 4.2. Ожидаемые классы интеграции (по аналогии с Oscar)

| Область | Oscar файл | Что сделать на Lera |
|---------|------------|---------------------|
| Live discovery eval | `src/papertrader/pricing/discovery-market-quote.ts` | `fetchDexScreenerMarketSnapshot` → cache wrapper |
| Live trader entrypoint | `src/scripts/live-*.ts` (искать `live-lera`) | env gate+cache в PM2 |
| DEX collectors | `scripts-tmp/*-collector.mjs` | gate в fetch wrapper + cache в enrich |
| Open mint enrich | `scripts-tmp/paper2-open-snapshot-enrich.mjs` | batch via `fetchDexQuotesBatchViaCache` |
| Birdeye enrich fallback | `scripts-tmp/birdeye-collector-enrich.mjs` | `getCachedDexQuote` before HTTP |

### 4.3. Journal / observability

- SSOT journal: **`/opt/lera/data/live/pt1-lera-live.jsonl`**
- После внедрения: искать в journal/events снижение `birdeye_coverage_gap` / Dex-related skip reasons
- Опционально: поле `_dexQuoteCache: true` в collector rows (как Oscar) для аудита

### 4.4. Cross-product граница

- Oscar dashboard читает Lera через rsync/API (`DASHBOARD_LERA_JSONL`, `72.62.152.201:3009`) — **не менять** в этом spec
- Не писать в Oscar `data/lera/` с Lera VPS как substitute cache

---

## 5. Env vars и PM2

### 5.1. Env block для ecosystem (шаблон)

```javascript
const DEXSCREENER_GATE_ENV = {
  DEXSCREENER_GLOBAL_RATE_LIMIT: '1',
  DEXSCREENER_GLOBAL_MAX_RPM: '42',
  DEXSCREENER_GLOBAL_GATE_PATH: path.join(root, 'data/dexscreener-api-gate.json'),
};

const DEX_QUOTE_CACHE_ENV = {
  DEX_QUOTE_CACHE_ENABLED: '1',
  DEX_QUOTE_CACHE_TTL_MS: '20000',
  DEX_QUOTE_CACHE_PATH: path.join(root, 'data/dexscreener-quote-cache.json'),
};
```

### 5.2. PM2 процессы — куда прокинуть (чеклист)

Найти на Lera все apps, которые:

- делают HTTP к DexScreener, **или**
- вызывают discovery eval с Dex fallback, **или**
- enrich open/pin mints из Dex

**Минимум (типичный Oscar-clone):**

- [ ] `live-lera` (или имя live-trader процесса)
- [ ] `sa-raydium` / `sa-meteora` / `sa-moonshot` / `sa-pumpswap` (какие включены на Lera)
- [ ] Любой one-shot/cron enrich с Dex (если есть отдельный PM2)

**Не обязательно:**

- Dashboard-only процессы без Dex
- Jupiter watcher / RPC / Telegram bots

### 5.3. `.env.example` на Lera

Добавить секцию (mirror Oscar `.env.example` строки 315–322):

```bash
# DexScreener shared gate + quote cache (Lera VPS — live-lera + collectors share one egress IP).
# DEXSCREENER_GLOBAL_RATE_LIMIT=1
# DEXSCREENER_GLOBAL_MAX_RPM=42
# DEXSCREENER_GLOBAL_GATE_PATH=data/dexscreener-api-gate.json
# DEX_QUOTE_CACHE_ENABLED=1
# DEX_QUOTE_CACHE_TTL_MS=20000
# DEX_QUOTE_CACHE_PATH=data/dexscreener-quote-cache.json
# Oscar VPS cache is NOT shared — separate file on /opt/lera only.
```

### 5.4. Deploy на Lera VPS

По политике Lera (аналог NORM для Oscar): Git → `npm ci` → `pm2 reload ecosystem.config.cjs --update-env`.  
**Не** `scp` tracked trees поверх клона. После reload:

```bash
ls -la /opt/lera/data/dexscreener-*.json
pm2 env <live-lera-app-id> | grep DEX_
```

---

## 6. Тесты, rollout, метрики успеха

### 6.1. Unit tests (локально, до deploy)

Портировать сценарии из Oscar `tests/dexscreener-quote-cache.test.ts`:

- [ ] fresh entry read from file
- [ ] second `fetchDexQuoteViaCache` — **0** дополнительных HTTP
- [ ] `DEX_QUOTE_CACHE_ENABLED=0` отключает L2
- [ ] (optional) gate serializes two parallel fetches

Запуск: `npm run typecheck` + targeted vitest file.

### 6.2. Rollout plan

1. **Branch** в Lera repo, PR по локальной политике
2. **Staging:** `DEX_QUOTE_CACHE_ENABLED=1` на одном collector + live-lera, остальные без изменений — сравнить 429
3. **Full:** все Dex-процессы + `pm2 reload --update-env`
4. **48h soak:** мониторинг логов collectors + journal eval rate

**Rollback:** `DEX_QUOTE_CACHE_ENABLED=0` + `DEXSCREENER_GLOBAL_RATE_LIMIT=0` (emergency) → reload; удалить json cache optional

### 6.3. Метрики успеха

| Метрика | Как мерить | Цель |
|---------|------------|------|
| Dex HTTP 429 count | `rg 429` в `~/.pm2/logs/*` за 1h до/после | **↓ ≥80%** |
| Duplicate mint fetch | log counter или временный debug: mint+pid за 30s window | **≤1 HTTP/mint/TTL** across processes |
| Discovery eval consistency | `evals1h`, `passed1h` в journal / dashboard API | без регрессии >5% за 48h |
| `coverage_gap` / Dex miss events | journal `kind` grep | не растут |
| Gate wait p95 | optional log `dex_gate_wait_ms` | < 3s при RPM=42 |

**Команды на Lera VPS (read-only):**

```bash
grep -h '429' ~/.pm2/logs/*-error*.log | tail -20
grep -h 'api.dexscreener.com' ~/.pm2/logs/*.log | wc -l   # до/после
tail -f /opt/lera/data/live/pt1-lera-live.jsonl | rg 'coverage_gap|dex'
stat /opt/lera/data/dexscreener-quote-cache.json
```

---

## 7. Явные NON-goals

- **Не менять Oscar** (`/opt/solana-alpha`, solana-alpha PR) в рамках Lera-задачи
- **Не использовать** Oscar file cache по NFS/scp/rsync как hot path
- **Не добавлять** Lera в shared PostgreSQL schema / cross-schema writes без явного approval владельца + `PLATFORM_CHANGELOG` (platform rule)
- **Не регистрировать** product в `products.yaml` в этом PR (отдельная задача)
- **Не поднимать** Phase 2 HTTP service на Oscar без отдельного spec и approval
- **Не повышать** `DEXSCREENER_GLOBAL_MAX_RPM` выше 120 (hard cap в коде)
- **Не отключать** gate в prod ради «скорости»

---

## 8. Фаза 2 (опционально): HTTP quote service на Oscar

**Когда имеет смысл:** несколько VPS/products с **пересекающимися mint** и желанием **одной** Dex квоты на org level.

**Эскиз (не реализовывать без отдельного approval):**

```
Lera process → GET http://100.82.221.89:<port>/internal/dex-quote?mint=...
Oscar service → L1/L2 cache + gate + Dex HTTP
```

- Auth: mTLS или internal token (не public)
- Lera fallback: local file cache если Oscar недоступен
- Cross-product: требует согласования egress, security, SLA

**До фазы 2:** Lera **самодостаточна** с local file cache.

---

## 9. Чеклист готовности для Lera-агента

### Код
- [ ] `dexscreener-api-gate` портирован
- [ ] `dexscreener-quote-cache` (mjs + ts) портирован
- [ ] Все `api.dexscreener.com` call sites используют cache+gate
- [ ] `discovery-market-quote` (или аналог) wired
- [ ] Unit tests green

### Config
- [ ] `ecosystem.config.cjs` — gate+cache env на все Dex-процессы
- [ ] `.env.example` обновлён
- [ ] `data/` writable от user PM2

### Deploy
- [ ] Git merge + VPS reload
- [ ] `dexscreener-quote-cache.json` создаётся после первого miss
- [ ] 48h metrics: 429 down, eval stable

### Документация
- [ ] Краткий changelog entry в Lera repo (если есть)
- [ ] Ссылка на этот spec в PR description

---

## 10. Ссылки на Oscar reference (read-only)

| Артефакт | Путь в solana-alpha |
|----------|---------------------|
| Quote cache (mjs) | `scripts-tmp/dexscreener-quote-cache.mjs` |
| API gate (mjs) | `scripts-tmp/dexscreener-api-gate.mjs` |
| Quote cache (ts) | `src/papertrader/pricing/dexscreener-quote-cache.ts` |
| Discovery integration | `src/papertrader/pricing/discovery-market-quote.ts` |
| PM2 env | `ecosystem.config.cjs` → `DEXSCREENER_GATE_ENV`, `DEX_QUOTE_CACHE_ENV` |
| Env docs | `.env.example` (строки Dex gate/cache + note про Lera) |
| Tests | `tests/dexscreener-quote-cache.test.ts`, `tests/discovery-market-quote.test.ts` |
| Lera journal (Oscar dashboard) | `scripts-tmp/lera-dashboard.ts` → `/opt/lera/data/live/pt1-lera-live.jsonl` |
