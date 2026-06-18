# Live Oscar — дорожная карта оптимизации: гибрид Shyft + PG

**Продукт:** solana-alpha / стратегия `live-oscar` (PM2 на `salpha-v2`)
**Статус:** трекаемый план. Этап 0 реализован в **1.11.466**.
**Архитектурное решение (зафиксировано пользователем):** делаем **ГИБРИД Shyft + PG внутри `live-oscar`** — Shyft как primary-источник свежей цены, PG как fallback. **Никаких** новых отдельных стрим-продуктов; `oscar-stream` **не возрождать** (закрыт/удалён). Цель — максимально оптимизировать существующую стратегию `live-oscar`.

---

## Контекст и принцип

> **Сначала надёжность, потом скорость.** Скорость — **вторичный** рычаг к уже-правильной логике. Главные источники альфы (CF360, когорта 363 он-чейн покупок) — **отказ от усреднения вниз**, ранний тейк и тайм-стоп — это **логика**, а не скорость. Скорость лишь снимает «слепоту цены» и помогает на маржине (дешёвый дип-филл, захват раннего отскока).

Опорные документы:
- Полный технический разбор пайплайна, latency-бюджета и контеншена: `scripts-tmp/_live_oscar_shyft_analysis_ru.md`.
- Выводы CF360 по рычагам PnL: `scripts-tmp/_cf360_optimal_strategy_ru.md`.
- Известный stale-price инцидент (RC-1…6, накоплено на закрытом `oscar-stream`): `docs/strategy/live-oscar/OSCAR_STREAM_AGENT_HANDOFF_STALE_PRICE.md`.
- Лимиты Shyft Build и потребление соседями: `docs/strategy/superbot2-shyft-optimization-spec.md` §3–4.
- Прод-параметры стратегии (источник истины — `ecosystem.config.cjs`): `docs/strategy/live-oscar/LIVE_OSCAR_TRADING_SPEC_STREAM.md` (DEPRECATED-снимок).

**Текущий прод (baseline, который улучшаем):** Wave B (долив leg-2 при −10% + TP-лесенка шаг +2.5% + defensive trail после +7.5%); scratch/re-entry **выключен** (1.11.465); robust-flat (плоский +8%) — **хуже в ~4×, НЕ внедрять**. Baseline = **+$9 481** на когорте 363.

**Главный дефект надёжности — свежесть цены:** PG-снапшоты (поллинг коллектора 30s) + reeval 15–30s → **30–90s слепоты на входе**. Исполнение быстрое (2–15s); выходы ускорены hot-tick'ом 2s.

**Принцип безопасности на всех этапах:** всё новое — за флагами **default-OFF**; **freshness-gate** на stream-цену с **откатом на PG**; прод-надёжность не должна падать. Каждый этап А/B-проверяем и обратимый.

---

## Этап 0 — Надёжность без Shyft (РЕАЛИЗОВАНО в 1.11.466)

Цель: убрать расхождения «доки ≠ прод» (источник ошибок) и **измерить** лаг цены входа перед тем, как чинить его Shyft'ом. Прод-поведение торговли **не меняется**.

### 0.1 Гигиена конфига
- `ecosystem.config.cjs`: комментарий у `PAPER_DCA_KILLSTOP` говорил «−9%», фактическое значение `-0.50` (**−50%**) — приведён к факту. Проверены соседние комментарии live-oscar: notional `$1000+$500/$1500`, leg-2 при −10%, тайм-стоп `PAPER_TIMEOUT_HOURS=48` (к Wave B не применяется) — фактические значения **не тронуты**, поправлены только формулировки.
- `LIVE_OSCAR_TRADING_SPEC_STREAM.md` (DEPRECATED): числа приведены к проду — `$730+$730/$1460` → `$1000+$500/$1500`, killstop `−9% → −50%`.

### 0.2 Алерт/метрика на устаревшую цену входа (observability-only)
- Env `PAPER_LIVE_OSCAR_STALE_PRICE_WARN_MS` (default **45000**; `0` = выкл). В пути входа (`src/papertrader/main.ts`, перед `resolveLiveStagedEntrySignal`) при возрасте использованной PG-цены > порога журналируется метрика `live_stale_price_warn` (`priceAgeMs`, `mint`, `lane`, `source`, `priceUsd`, `snapshotTsMs`).
- Возраст берётся из нового `SnapshotFeatures.snapshot_ts_ms` (из `*_pair_snapshots.ts`).
- Опц. троттлед-алерт: `LIVE_OSCAR_STALE_PRICE_TELEGRAM_ENABLED=1` (default OFF), cooldown `LIVE_OSCAR_STALE_PRICE_TELEGRAM_COOLDOWN_MS`.
- **Поведение торговли НЕ меняется.** Это база для доказательства лага (распределение `priceAgeMs`) перед Этапом 1.
- **Вне scope:** anti-churn для scratch (scratch выключен).

**Файлы:** `ecosystem.config.cjs`, `src/papertrader/config.ts`, `src/papertrader/types.ts`, `src/papertrader/stale-price.ts` (новый), `src/papertrader/discovery/dip-clones.ts`, `src/papertrader/main.ts`, `tests/stale-price-observability.test.ts` (новый).

**Как читать результат:** собрать `live_stale_price_warn` из прод-журнала за 24–48 ч → распределение `priceAgeMs` по lane → это количественное обоснование Этапа 1 и подбор `MAX_STALE_MS`.

---

## Этап 1 — Гибрид Shyft внутри live-oscar

Принцип: **Shyft = primary свежей цены, PG = fallback.** Один gRPC-консьюмер внутри процесса `live-oscar`, узкие фильтры, всё за флагами.

### 1.1 Shadow-стрим (измеримость, без изменения решений) — shadow ENABLED in 1.11.470, collecting lag
- **Статус:** shadow ENABLED in 1.11.470, collecting lag (консьюмер подключается с 1.11.471). Флаг `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED='1'` на проде, креды (`SHYFT_GRPC_TOKEN`/`SHYFT_GRPC_ENDPOINT=https://grpc.fra.shyft.to`) в `.env` на `salpha-v2`. В 1.11.471 исправлен gRPC-консьюмер (CJS/ESM interop резолв класса `Client` + явный `connect()` перед `subscribe()`) — токен принят, стрим подключается. Консьюмер журналирует `live_shyft_shadow_price`; идёт сбор распределения лага PG 24–48 ч перед активацией Stage 1.2. Прочие Shyft-флаги остаются OFF.
- **Что:** Yellowstone gRPC-консьюмер по **watched/open** mint'ам; в журнал пишется stream-цена и лаг **рядом** с PG-ценой. Решения **не меняются** — стрим-цена не читается ни одним гейтом/eval/исполнением.
- **Файлы (факт):** новые `src/papertrader/stream/shadow-price.ts` (чистая логика), `shadow-state.ts` (in-memory last-price + watched-set, без gRPC), `shyft-shadow-consumer.ts` (gRPC ingest, узкий `accountInclude`, reconnect/backoff). Точки сравнения — `observeShyftShadowEntryPrice` рядом с `observeStaleEntryPrice` (`src/papertrader/main.ts`) и MTM-цикл `tracker.ts`. Старт консьюмера — `src/live/main.ts`. Env-блок в `ecosystem.config.cjs`. Зависимость `@triton-one/yellowstone-grpc@^5.0.9`.
- **Формат журнала:** `live_shyft_shadow_price` = `{mint, lane, surface, streamPriceUsd, pgPriceUsd, streamTsMs, pgSnapshotTsMs, pgPriceAgeMs, streamVsPgLagMs, streamVsPgPriceDiffPct, streamSlot}`.
- **Риск:** низкий (shadow, ничего не исполняет). Точки риска — gRPC reconnect-штормы (RC-4; митигировано backoff+jitter и in-place обновлением подписки без reconnect) и счётчик коннектов Shyft (один консьюмер на весь процесс).
- **A/B-проверка:** оффлайн — сопоставить stream-цену vs PG на одних и тех же mint/ts; доля случаев, где stream «увидел» −5%/−10% касание раньше PG, и медианный выигрыш по времени.
- **Флаг:** `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED` default **OFF** (+ `PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_AGE_MS`, `PAPER_LIVE_OSCAR_SHYFT_SHADOW_MAX_MINTS`; креды `SHYFT_GRPC_ENDPOINT`/`SHYFT_GRPC_TOKEN` в `.env`).

### 1.2 Stream-цена primary для discovery-eval и MTM + freshness-gate — РЕАЛИЗОВАН (default-OFF) в 1.11.468
- **Статус:** код реализован за флагами **default-OFF** (`npm run typecheck` зелёный; `tests/shyft-price-primary.test.ts` 12/12). Чистый резолвер `src/papertrader/stream/price-primary.ts` (`resolvePrimaryPriceUsd` — passthrough на PG при OFF) + инъекции в MTM (`tracker.ts`, override `curMetric` перед exec-sell) и discovery (`dip-clones.ts`, `evalRow` для snapshot/dip/features). Флаги: `SHYFT_PRICE_PRIMARY_ENABLED` (мастер, default 0), `SHYFT_PRICE_PRIMARY_MTM_ENABLED` (default 1), `SHYFT_PRICE_PRIMARY_DISCOVERY_ENABLED` (default 0, MTM-first), `SHYFT_MAX_STALE_MS` (default 5000). Активация требует включённого Stage 1.1 shadow (`SHYFT_GRPC_TOKEN` + `PAPER_LIVE_OSCAR_SHYFT_SHADOW_ENABLED=1`). Наблюдение: `live_shyft_price_primary`.
- **Что:** для discovery-eval (дип −5/−10%) и MTM открытых позиций брать stream-цену как primary; `MAX_STALE_MS` freshness-gate — если stream-цена старше порога/недоступна, **откат на PG** (текущее поведение).
- **Файлы (план):** `src/papertrader/pricing.ts` (источник цены за абстракцией), `src/papertrader/discovery/dip-clones.ts` (eval), `src/papertrader/executor/tracker.ts` (MTM); env `SHYFT_PRICE_PRIMARY_ENABLED`, `SHYFT_MAX_STALE_MS`.
- **Риск:** средний — меняет данные, на которых принимаются решения. Митигация: freshness-gate + PG-fallback + поэтапный rollout (сначала MTM, потом discovery).
- **A/B-проверка:** включить на части lane / shadow-сравнение PnL; следить, что число входов/выходов не разъезжается из-за более «дёрганой» цены; сверять с baseline +$9 481.
- **Флаг:** `SHYFT_PRICE_PRIMARY_ENABLED` default **OFF**; при OFF поведение байт-в-байт = PG.

### 1.3 DeFi API Shyft для mcap/liq на кандидатах — РЕАЛИЗОВАН (default-OFF) в 1.11.469
- **Статус:** код реализован за флагом **default-OFF** (`npm run typecheck` зелёный; `tests/shyft-defi-mcap.test.ts` 9/9). Модуль `src/papertrader/stream/shyft-defi-mcap.ts` (защитный парсер `parseShyftDefiPools` + `resolveShyftDefiMcap` с TTL-кэшем/таймаутом/fallback). Инъекция в `dip-clones.ts`: override `refMcap` (tier) + `evalRow.market_cap_usd/liquidity_usd`. Флаги: `SHYFT_DEFI_MCAP_ENABLED` (default 0), `SHYFT_DEFI_MCAP_TTL_MS` (default 12000); ключ `SHYFT_DEFI_API_KEY`/`SHYFT_API_KEY` в `.env`. Наблюдение: `live_shyft_defi_mcap`. **Перед активацией владельцу подтвердить схему ответа DeFi API** (при несовпадении полей — fallback на PG, прод-безопасно).
- **Что:** mcap/liq-гейт на кандидатах через Shyft DeFi API (`defi.shyft.to/v0/pools/...`) c **TTL-кэшем** (10–15s) и **fallback** на текущий PG/pump.fun источник.
- **Файлы (план):** `src/papertrader/pricing.ts` (mcap-резолвер) или новый `src/papertrader/stream/shyft-defi-mcap.ts`; env `SHYFT_DEFI_MCAP_ENABLED`, `SHYFT_DEFI_MCAP_TTL_MS`.
- **Риск:** низкий-средний — DeFi API req/s лимит (см. контеншен); только на кандидатах + TTL-кэш ограничивают бёрст.
- **A/B-проверка:** сравнить mcap/liq из DeFi vs PG на тех же кандидатах (расхождение, свежесть); убедиться, что tier-резолв (`micro/low/prod`) не сдвигает входы непреднамеренно.
- **Флаг:** `SHYFT_DEFI_MCAP_ENABLED` default **OFF**.

> RabbitStream ранний детект — **после** стабильного 1.2 (низкий-средний приоритет, риск RC-4). В этой карте не детализируем до завершения 1.2.

---

## Этап 2 — Исполнение

- **Pre-arm на TP-уровни Wave B:** расширить механизм предсобранного swap (сейчас только killstop pre-arm) на TP-уровни Wave B, чтобы тейк на резком отскоке отправлялся без задержки сборки. Файлы: `src/live/open-position-hot-tick.ts`, `src/papertrader/executor/exit-policy-wave-b.ts`. Риск: средний (нужен TTL/инвалидция предсобранного swap при сдвиге уровня). Флаг default-OFF.
- **Пересмотр priority-fee cap:** проверить cap `0.0001 SOL` + адаптивный буст ×2.5 под congestion vs реальный confirm-latency; подобрать по факту, не вслепую.
- **Execution остаётся на Alchemy** — **не** грузить Shyft RPC (нулевой риск для send-path соседей).

---

## Контеншен с SuperBot (общий аккаунт Shyft Build, разные VPS)

`live-oscar` (`salpha-v2`) и `superbot2`/закрытый `oscar-stream` (`oscar-stream-de`) — **разные машины**; общий ресурс — только **аккаунт Shyft Build** и его лимиты.

**Чеклист лимитов перед подключением (Shyft dashboard):**
- [ ] Макс. конкурентных Yellowstone gRPC-коннектов (~10) и сколько занято сейчас (superbot2 ~1–2).
- [ ] Учитывается ли RabbitStream отдельно от Yellowstone в лимите коннектов.
- [ ] DeFi API: req/s (~10) и месячный credit cap.
- [ ] RPC: req/s и месячный credit cap (execution live-oscar **не** на Shyft RPC).
- [ ] Один x-token с двух VPS/IP — есть ли per-IP rate limits.
- [ ] Реально ли «unmetered bandwidth» или soft-cap.

**Дисциплина:**
1. Узкие `accountInclude`-фильтры (только watched/open mint'ы, не program-wide firehose).
2. Один gRPC-консьюмер на все lane внутри `live-oscar` (не плодить подписки).
3. Mcap/liq через DeFi API только на кандидатах + in-memory TTL.
4. Execution на Alchemy.
5. Раздельные x-token / sub-аккаунты, если Shyft позволяет.

---

## Принципы безопасности (сводно)

- Всё новое — за флагами **default-OFF**; при OFF прод-поведение торговли **байт-в-байт** = текущее.
- **Freshness-gate** (`MAX_STALE_MS`) на любую stream-цену + **PG-fallback**.
- Каждый этап обратим (env-флаг + redeploy предыдущего тега).
- Сначала **shadow/измеримость**, потом переключение primary.
- Релиз/деплой — по `docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`; версии и откаты — в `CHANGELOG.md`.

---

*Документ: продукт `solana-alpha` only. Кросс-продуктовых изменений нет.*
