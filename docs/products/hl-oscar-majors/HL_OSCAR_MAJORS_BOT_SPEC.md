# HL Oscar Majors — спецификация бота knife-catch для BTC и ETH

**Версия:** 0.1 (2026-06-28)  
**Статус:** draft для реализации отдельным агентом  
**Источник данных:** 30d backtest, 15m свечи HL (`scripts-tmp/hl-oscar-four-coins-dip-study-results.json`, `scripts-tmp/hl-oscar-dip-threshold-study-results.json`)

---

## 1. Scope продукта

| Параметр | Значение |
|----------|----------|
| Биржа | Hyperliquid perpetual |
| Монеты | **только BTC, ETH** (whitelist жёсткий) |
| Кошелёк / API | тот же infra, что у `hl-oscar-perp-watch` (`HL_TWAP_*` / `HL_OSCAR_*` fallback) |
| PM2-процесс (целевой) | `hl-oscar-majors-watch` |
| Код (целевой) | `src/hyperliquid/oscar-majors/` или fork `oscar-perp` с product prefix |
| Journal | `data/hl-oscar-majors/live.jsonl` |
| Denylist в alt Oscar | BTC, ETH в `OSCAR_PERP_DENYLIST_DEFAULT` + `HL_OSCAR_DENYLIST_EXTRA` |

**Не входит в scope:** SOL, HYPE, alt-универсум HL Oscar, Solana live-oscar.

---

## 2. Почему majors ≠ alt Oscar

Alt Oscar (`hl-oscar-perp`) настроен под высоковолатильные альты:

| Параметр | Alt Oscar (prod) | BTC / ETH (30d data) |
|----------|------------------|----------------------|
| Impulse filter | ≥10% | BTC: **0 сигналов** при imp≥10% на всех порогах; ETH imp10: ladder **−3.3%** при −3% dip |
| Dip entry | −7% от 2h/6h/12h high | BTC imp10: 0 sig; без imp: bounce **+1.5%** avg, reach +5% = **0%** |
| Exit ladder | +5% / +7.5% / +10% | BTC reach +5% = **0%**; ETH reach +5% = **0–16.7%** (vs alt universe **36%** при −7% imp10) |
| Avg bounce после входа | ~5% (alt grid) | BTC **+1.51%** (−3%), ETH **+1.81–2.86%** |
| Avg knife после входа | ~−5% (продолжение падения) | ETH imp10: **−4.6%** доп. нож; BTC без imp: **−1.4…−2.0%** |
| Сигналов/мес (−7% imp10) | ~10 764 (118 монет) | BTC: **0**; ETH: **8** (все с отриц. ladder) |

**Вывод:** текущая связка «impulse 10% + dip −7% + TP +5%» для majors **не работает**: либо нет сигналов (BTC), либо отскок слишком мелкий для alt-лadder (ETH).

---

## 3. Рекомендуемые параметры (data-backed)

### 3.1. Whitelist и universe

```text
HL_MAJORS_WHITELIST=BTC,ETH
HL_MAJORS_MIN_DAY_VOLUME_USD=1000000   # majors всегда выше; можно не фильтровать
```

### 3.2. Impulse filter

| Вариант | Обоснование |
|---------|-------------|
| **Рекомендация: 5–8%** | Alt grid imp8 @ −7%: 13 214 sig vs imp10 10 764 (+23%); majors менее импульсны |
| BTC | При imp≥10% — **ноль** сигналов за 30d → обязательно снизить или отключить |
| ETH | imp10 @ −3…−8%: win12h=0%, ladder −3.1…−3.46% → imp10 **вреден** для ETH |

**Стартовые env:**

```text
HL_MAJORS_DIP_MIN_IMPULSE_PCT=6     # или 0 = выкл; A/B 5 vs 8
```

Провести отдельный grid 5/6/7/8% только на BTC+ETH (скрипт `hl-oscar-four-coins-dip-study.mjs` расширить).

### 3.3. Entry dip thresholds

Тестировать **без imp10** и с imp 5–8%:

| Монета | Порог | Sig/30d | Win12h | Avg bounce | Reach +5% | Ladder PnL (alt exit) | Комментарий |
|--------|-------|---------|--------|------------|-----------|----------------------|-------------|
| BTC | −3% | 164 | 54.3% | +1.51% | 0% | −0.08% | Слишком часто, мелкий bounce |
| BTC | **−5%** | **21** | **85.7%** | **+3.09%** | 0% | **+1.72%** | **Лучший компромисс BTC** |
| BTC | −7% | 1 | 100% | +4.19% | 0% | +3.28% | Мало sig, overfit risk |
| ETH | −3% | 267 | 46.8% | +1.81% | 1.9% | −0.66% | Шум |
| ETH | −5% | 81 | 42.0% | +2.00% | 3.7% | −0.89% | Часто, alt-ladder убыточен |
| ETH | **−7%** | **18** | 38.9% | **+2.86%** | **16.7%** | −1.04% | Глубже, реже; нужен новый exit |
| ETH imp10 | −3…−8% | 7–9 | 0% | ~2% | 0% | **−3.1…−3.46%** | **Не использовать imp10** |

**Рекомендация старт:**

```text
HL_MAJORS_DIP_MIN_PCT=-5          # единый для обеих; или per-coin override
HL_MAJORS_DIP_MAX_PCT=-50
HL_MAJORS_DIP_WINDOWS_MIN=120,360,720
HL_MAJORS_DIP_COOLDOWN_MIN=30
```

**Per-coin override (phase 2):** BTC −5%, ETH −7% — если реализуется map в config.

**Окна:** данные показывают концентрацию в 12h (720m): BTC −3%: 109/164 sig; ETH −3%: 144/267. Окна 2h/6h/12h оставить; **не расширять до 24h** без нового backtest.

### 3.4. Staged entry (legs)

Alt Oscar: leg1 @ dip, leg2 −5% / leg3 −10% от signal, 30/30/40.

Для majors bounce ~1.5–3%, alt-ladder TP +5% недостижим → staged legs чаще **не окупаются**:

| | BTC −5% no imp | ETH −5% no imp |
|--|----------------|----------------|
| leg2 fill (−5% от entry) | 0% | 30.9% |
| leg3 fill (−10%) | 0% | 0% |
| ETH imp10 −3% | — | leg2 44.4%, ladder −3.3% |

**Рекомендация:**

- **Phase 1:** single-shot (`HL_MAJORS_STAGED_ENTRY=0`) — проще, меньше exposure в продолжающемся ноже.
- **Phase 2 (optional):** staged с **более узкими** leg2/leg3: −3% / −6% от signal, 50/25/25 split; backtest перед prod.

```text
# Phase 1
HL_MAJORS_STAGED_ENTRY=0

# Phase 2 candidate
HL_MAJORS_STAGED_ENTRY=1
HL_MAJORS_LEG2_DROP_PCT=3
HL_MAJORS_LEG3_DROP_PCT=6
```

### 3.5. Exit strategy — НЕ alt +5% ladder

Alt ladder (+5/+7.5/+10%, sell 50% remaining) **неприменим**:

- BTC: reach +5% = **0%** на всех порогах без imp
- ETH: max reach +5% = **16.7%** (−7% no imp), **3.7%** (−5%)

**Рекомендуемый exit majors:**

| Механизм | Параметр | Обоснование |
|----------|----------|-------------|
| TP1 | **+1.5%** от avg, sell 50% | BTC avg bounce +1.51% @ −3%; захват мелкого отскока |
| TP2 | **+2.5%**, sell 50% remaining | ETH avg bounce до +2.86% @ −7% |
| TP3 | **+3.5%**, sell rest | редко, но покрывает хвост BTC −5% (+3.09% bounce) |
| Trail | arm @ +1.5%, step −1.0% от peak, sell 25% | уже есть паттерн в `exit-engine.ts` |
| Time stop | **12h** (как alt) | сохранить |
| Kill | **−15…−20%** от avg (не −45%) | majors ликвиднее; −45% избыточен для $100 notional |
| Staged kill | **−10%** от signal anchor | уже narrower knife на majors |

```text
HL_MAJORS_TP_RUNGS=0.015,0.025,0.035
HL_MAJORS_TP_SELL_FRAC=0.5
HL_MAJORS_TRAIL_ARM_FRAC=0.015
HL_MAJORS_TRAIL_STEP_DROP_FRAC=0.01
HL_MAJORS_TRAIL_SELL_FRAC=0.25
HL_MAJORS_TIME_STOP_HOURS=12
HL_MAJORS_KILL_PCT=18
HL_MAJORS_STAGED_KILL_DROP_PCT=10
```

**Breakeven exit** после trail arm — перенести из alt Oscar.

### 3.6. Sizing (старт)

Как alt Oscar, но max 2 позиции (BTC+ETH):

```text
HL_MAJORS_LEVERAGE=2
HL_MAJORS_MARGIN_USD=50
HL_MAJORS_MAX_OPEN_POSITIONS=2
```

---

## 4. Архитектура (sketch)

```
src/scripts/hl-oscar-majors-watch.ts     # entrypoint (PM2)
src/hyperliquid/oscar-majors/
  config.ts          ← fork from oscar-perp; HL_MAJORS_* env prefix
  entry-signal.ts    ← reuse evaluateOscarEntry (same candle math)
  exit-engine.ts     ← NEW: majors TP rungs (+1.5/2.5/3.5%), tighter trail/kill
  candles.ts         ← reuse
  trader.ts          ← reuse HL TWAP exchange client via toHlTwapLiveConfig
  journal.ts         ← reuse pattern, separate path
  reconcile.ts       ← reuse
  drawdown.ts        ← reuse
  telegram-notify.ts ← reuse, HL_MAJORS_TELEGRAM_* prefix
  universe.ts        ← whitelist-only [BTC, ETH], no denylist scan
  position-types.ts  ← reuse
```

**Reuse без копипасты (preferred):**

1. Вынести shared candle/signal math в `src/hyperliquid/oscar-shared/` (optional refactor).
2. Или импортировать из `oscar-perp/` напрямую + override `exit-engine` и `config`.
3. Exchange layer: `toHlTwapLiveConfig()` — тот же паттерн.

**PM2 block** в `ecosystem.config.cjs`:

```javascript
const HL_MAJORS_DATA_DIR = path.join(root, 'data/hl-oscar-majors');
const HL_MAJORS_ENV = { /* см. §5 */ };
// { name: 'hl-oscar-majors-watch', args: 'src/scripts/hl-oscar-majors-watch.ts', env: HL_MAJORS_ENV }
```

**Dashboard:** отдельная плитка или секция в superbot-dashboard (phase 2).

---

## 5. Env vars (`HL_MAJORS_*`)

| Env | Default | Описание |
|-----|---------|----------|
| `HL_MAJORS_ENABLED` | `1` | master switch |
| `HL_MAJORS_LIVE_ENABLED` | `0` | paper default |
| `HL_MAJORS_DRY_RUN` | `1` | dry run |
| `HL_MAJORS_WHITELIST` | `BTC,ETH` | жёсткий whitelist |
| `HL_MAJORS_PRIVATE_KEY` | → `HL_TWAP_LIVE_PRIVATE_KEY` | fallback chain |
| `HL_MAJORS_MASTER_ADDRESS` | → `HL_TWAP_MASTER_ADDRESS` | |
| `HL_MAJORS_LEVERAGE` | `2` | |
| `HL_MAJORS_MARGIN_USD` | `50` | |
| `HL_MAJORS_STAGED_ENTRY` | `0` | phase 1 single-shot |
| `HL_MAJORS_DIP_MIN_PCT` | `-5` | |
| `HL_MAJORS_DIP_MAX_PCT` | `-50` | |
| `HL_MAJORS_DIP_MIN_IMPULSE_PCT` | `6` | 0 = off |
| `HL_MAJORS_DIP_WINDOWS_MIN` | `120,360,720` | |
| `HL_MAJORS_DIP_COOLDOWN_MIN` | `30` | |
| `HL_MAJORS_TP_RUNGS` | `0.015,0.025,0.035` | comma-sep fractions |
| `HL_MAJORS_TP_SELL_FRAC` | `0.5` | |
| `HL_MAJORS_TRAIL_ARM_FRAC` | `0.015` | |
| `HL_MAJORS_TRAIL_STEP_DROP_FRAC` | `0.01` | |
| `HL_MAJORS_TRAIL_SELL_FRAC` | `0.25` | |
| `HL_MAJORS_TIME_STOP_HOURS` | `12` | |
| `HL_MAJORS_KILL_PCT` | `18` | |
| `HL_MAJORS_STAGED_KILL_DROP_PCT` | `10` | |
| `HL_MAJORS_MAX_OPEN_POSITIONS` | `2` | |
| `HL_MAJORS_POLL_MS` | `60000` | |
| `HL_MAJORS_JOURNAL_JSONL` | `data/hl-oscar-majors/live.jsonl` | |
| `HL_MAJORS_HEARTBEAT_PATH` | `data/hl-oscar-majors/heartbeat.json` | |
| `HL_MAJORS_TELEGRAM_ENABLED` | `1` | |
| `HL_MAJORS_TELEGRAM_CHAT_ID` | → news channel | |
| `HL_MAJORS_DRAWDOWN_STOP_USD` | `300` | lower than alt (2 coins) |

Добавить секцию в `.env.example`.

---

## 6. Success metrics

| Метрика | Target (30d extrapolation) | Floor |
|---------|---------------------------|-------|
| Signals/month (BTC) | ≥15 @ −5% no imp | ≥5 |
| Signals/month (ETH) | ≥15 @ −7% no imp | ≥5 |
| Reach TP1 (+1.5%) | ≥40% trades | ≥25% |
| Avg realized PnL/trade | >0% after fees | ≥0% |
| Max drawdown | < $300 | hard stop env |
| Win rate 12h (mark) | ≥45% | ≥35% |
| Uptime | PM2 autorestart, heartbeat <2m stale | — |

**Paper phase:** минимум 14d live paper перед `HL_MAJORS_LIVE_ENABLED=1`.

---

## 7. Open questions (для implementer)

1. **Per-coin dip map** — единый −5% или BTC −5% / ETH −7%? Нужен A/B в paper.
2. **Impulse 5 vs 6 vs 8%** — нет grid в four-coins study; запустить перед prod.
3. **Single-shot vs staged** — phase 1 single-shot; когда включать staged?
4. **Shared code refactor** — `oscar-shared` vs duplicate `oscar-majors`?
5. **Kill −18% vs −15%** — симуляция с HL fees/slippage.
6. **24h window** — стоит ли добавить для majors (медленнее alt)?
7. **Корреляция BTC↔ETH** — одновременный вход в обе: limit `MAX_OPEN=1` при высокой corr?
8. **Funding / carry** — учитывать в time stop?
9. **Dashboard integration** — отдельный JSONL path в superbot-dashboard.
10. **Coexistence с alt Oscar** — same wallet, aggregate exposure cap?

---

## 8. Reference tables (30d backtest)

**Методология:** 15m candles, 30d, cooldown 30m, entry = close ≤ threshold от high окна 2h/6h/12h, staged sim leg2 @ −5% / leg3 @ −10%, exit alt-ladder +5/+7.5/+10% sell 50%, time stop 12h.

### 8.1. BTC

| Threshold | Impulse | Sig/30d | Win12h | Avg knife | Avg bounce | +5% | +7.5% | +10% | −5% after | Leg2 | Leg3 | Ladder PnL |
|-----------|---------|---------|--------|-----------|------------|-----|-------|------|-----------|------|------|------------|
| −3% | ≥10% | 0 | — | — | — | — | — | — | — | — | — | — |
| −5% | ≥10% | 0 | — | — | — | — | — | — | — | — | — | — |
| −7% | ≥10% | 0 | — | — | — | — | — | — | — | — | — | — |
| −3% | none | 164 | 54.3% | −2.01% | +1.51% | 0% | 0% | 0% | 3% | 3% | 0% | −0.08% |
| −5% | none | 21 | 85.7% | −1.36% | +3.09% | 0% | 0% | 0% | 0% | 0% | 0% | **+1.72%** |
| −7% | none | 1 | 100% | −1.28% | +4.19% | 0% | 0% | 0% | 0% | 0% | 0% | +3.28% |

**By window (BTC, no imp):**

| Threshold | 2h (120m) | 6h (360m) | 12h (720m) |
|-----------|-----------|-----------|------------|
| −3% | 8 | 47 | 109 |
| −5% | 1 | 5 | 15 |
| −7% | 0 | 0 | 1 |

### 8.2. ETH

| Threshold | Impulse | Sig/30d | Win12h | Avg knife | Avg bounce | +5% | +7.5% | +10% | −5% after | Leg2 | Leg3 | Ladder PnL |
|-----------|---------|---------|--------|-----------|------------|-----|-------|------|-----------|------|------|------------|
| −3% | ≥10% | 9 | 0% | −4.64% | +1.90% | 0% | 0% | 0% | 44.4% | 44.4% | 0% | **−3.30%** |
| −5% | ≥10% | 9 | 0% | −4.64% | +1.90% | 0% | 0% | 0% | 44.4% | 44.4% | 0% | **−3.30%** |
| −7% | ≥10% | 8 | 0% | −4.53% | +1.93% | 0% | 0% | 0% | 37.5% | 37.5% | 0% | **−3.46%** |
| −8% | ≥10% | 7 | 0% | −4.31% | +2.38% | 0% | 0% | 0% | 42.9% | 42.9% | 0% | **−3.10%** |
| −3% | none | 267 | 46.8% | −2.98% | +1.81% | 1.9% | 0% | 0% | 22.8% | 22.8% | 0.7% | −0.66% |
| −5% | none | 81 | 42.0% | −3.94% | +2.00% | 3.7% | 0% | 0% | 30.9% | 30.9% | 0% | −0.89% |
| −7% | none | 18 | 38.9% | −3.69% | +2.86% | 16.7% | 0% | 0% | 27.8% | 27.8% | 0% | −1.04% |
| −8% | none | 10 | 20.0% | −4.11% | +2.43% | 0% | 0% | 0% | 30.0% | 30.0% | 0% | −2.08% |

**By window (ETH, no imp):**

| Threshold | 2h | 6h | 12h |
|-----------|----|----|-----|
| −3% | 27 | 96 | 144 |
| −5% | 4 | 22 | 55 |
| −7% | 0 | 4 | 14 |

### 8.3. Alt universe benchmark (118 coins, imp≥10%)

Для сравнения — почему alt Oscar использует −7% / imp10 / +5% ladder:

| Threshold | Signals | Win12h | Avg bounce | Reach +5% | Ladder PnL |
|-----------|---------|--------|------------|-----------|------------|
| −3% | 18 569 | 44.2% | +4.86% | 32.2% | −0.12% |
| −5% | 14 838 | 45.5% | +5.00% | 33.4% | −0.04% |
| −7% | 10 764 | 46.4% | +5.22% | 36.0% | +0.05% |
| −8% | 8 620 | 46.9% | +5.47% | 38.7% | +0.16% |
| −10% | 4 468 | 46.8% | +6.22% | 44.2% | +0.38% |

Imp≥8% @ −7%: 13 214 sig, reach +5% = 35%, ladder +0.08%.

### 8.4. SOL / HYPE (контроль — остаются в alt Oscar)

| Coin | Best no-imp | Sig | Bounce | Reach +5% | Ladder |
|------|-------------|-----|--------|-----------|--------|
| SOL | −7% | 13/mo | +4.58% | 30.8% | +2.05% |
| HYPE | −7% | (see JSON) | ~alt-like | >0% | positive |

SOL ближе к alt-профилю; BTC/ETH — outliers с мелким bounce.

---

## 9. Implementation checklist

- [ ] `src/hyperliquid/oscar-majors/` + watch script
- [ ] `HL_MAJORS_*` config + `.env.example`
- [ ] Custom exit-engine (+1.5/2.5/3.5%)
- [ ] PM2 entry `hl-oscar-majors-watch` (paper default)
- [ ] Tests: config, exit-engine, universe whitelist
- [ ] `npm run typecheck` + `npm run verify`
- [ ] Paper 14d → review metrics vs §6
- [ ] Confirm BTC/ETH denied in alt Oscar (already in denylist)

---

## 10. Связанные файлы

| Файл | Назначение |
|------|------------|
| `src/hyperliquid/oscar-perp/` | reference implementation |
| `src/hyperliquid/oscar-perp/universe.ts` | BTC/ETH denylist |
| `ecosystem.config.cjs` | `HL_OSCAR_DENYLIST_EXTRA=BTC,ETH` |
| `scripts-tmp/hl-oscar-four-coins-dip-study-results.json` | per-coin grid |
| `scripts-tmp/hl-oscar-dip-threshold-study-results.json` | alt universe grid |
| `scripts-tmp/hl-oscar-dip-threshold-study-summary.ru.txt` | alt summary |
