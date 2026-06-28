# HL Oscar Majors — спецификация бота knife-catch для BTC и ETH

**Версия:** 0.2 (2026-06-28)  
**Статус:** draft для реализации отдельным агентом  
**Источник данных:** 30d backtest BTC+ETH, 15m HL (`scripts-tmp/hl-majors-btc-eth-strategy-study-results.json`, summary: `scripts-tmp/hl-majors-btc-eth-strategy-study-summary.ru.md`)

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

**Не входит в scope:** SOL, HYPE, alt-универсум HL Oscar, Solana live-oscar, deploy prod (только spec + paper после реализации).

---

## 2. Вердикт архитектуры (30d BTC+ETH study)

| Option | Описание | Вердикт |
|--------|----------|---------|
| **A** | Один бот, общие env для BTC+ETH | Entry **−6%** ок; TP **не** унифицировать |
| **B** | Один процесс, **per-coin env overrides** (TP ladder) | **✅ Рекомендуется** |
| **C** | Два отдельных PM2/бота | Не нужен — corr 100% (±1h), unified entry деградирует <8% |

**Рекомендация implementer:** **Option B** — один `hl-oscar-majors-watch`, общий entry **−6% / impulse off**, разные TP ladder через `HL_MAJORS_BTC_TP_RUNGS` и `HL_MAJORS_ETH_TP_RUNGS`.

**Почему не alt Oscar params:** impulse ≥10% даёт **0** сигналов BTC за 30d; alt ladder +5/+7.5/+10% — reach +5%@12h **0%** (BTC) и **3.6%** (ETH) при рекомендуемом entry.

---

## 3. Почему majors ≠ alt Oscar

| Параметр | Alt Oscar (118 coins, imp≥10%) | BTC / ETH (30d) |
|----------|----------------------------------|-----------------|
| Impulse filter | ≥10% | BTC: **0 sig** @ imp10 на всех порогах; ETH: imp10 убыточен |
| Dip entry | −7% от 2h/6h/12h high | Оптимум **−6…−7%** (не −3/−5) |
| Avg bounce 12h | +5.2% @ −7% | BTC **+2.0%** @ −6%; ETH **+1.8%** @ −6% |
| Reach +5% @ 12h | **36%** @ −7% | BTC **0%**; ETH **3.6%** @ −7% |
| Exit ladder | +5/+7.5/+10% | Alt ladder PnL: BTC **+1.7%** vs majors ladder **+2.0%** только при −7%; ETH alt ladder **−0.35%** |
| Knife после входа | ~−5% | BTC @ −6%: **−2.9%** med; ETH @ −6%: **−3.7%** med |

**Do NOT use alt Oscar +5% ladder** — доказательство (профиль `impnone_th-7`, 30d):

| Coin | Reach +5% @ 12h | Alt ladder (+5/+7.5/+10%) avg PnL | Majors ladder (+2/+3/+4%) avg PnL |
|------|-----------------|----------------------------------|-----------------------------------|
| BTC | **0%** | +1.71% (редко TP1) | **+2.01%** |
| ETH | **3.6%** | **−0.35%** | −0.04% (→ нужен lower TP, см. §3.5) |

---

## 4. Рекомендуемые параметры (data-backed)

### 4.1. Whitelist

```text
HL_MAJORS_WHITELIST=BTC,ETH
HL_MAJORS_MIN_DAY_VOLUME_USD=1000000
```

### 4.2. Entry — dip и impulse

**Не брать −3% / −5%** как primary entry: ловят продолжение падения, низкий reach +2% и отрицательный или слабый PnL.

| Dip | BTC sig/30d | BTC +2%@12h | BTC ladder +2/3/4 | ETH sig/30d | ETH +2%@12h | ETH ladder +2/3/4 | Комментарий |
|-----|-------------|-------------|-------------------|-------------|-------------|---------------------|-------------|
| −3% | 405 | 15.1% | −0.69% | 363 | 38.1% | −0.34% | Слишком рано |
| −5% | 89 | 40.4% | +0.62% | 214 | 29.9% | −0.47% | BTC ok, ETH убыточен |
| **−6%** | **45** | **44.4%** | **+0.75%** | **139** | **40.3%** | −0.10% | **Баланс частота/PnL** |
| −7% | 10 | 80.0% | +2.01% | 83 | 43.4% | −0.04% | BTC качество↑ частота↓ |

**Impulse:** фильтр **≥10% отключить** (0 или не задавать). Impulse 5–8% почти не меняет counts на −6/−7%; imp10 = 0 sig BTC.

**Стартовые env (общие):**

```text
HL_MAJORS_DIP_MIN_PCT=-6
HL_MAJORS_DIP_MAX_PCT=-50
HL_MAJORS_DIP_MIN_IMPULSE_PCT=0
HL_MAJORS_DIP_WINDOWS_MIN=120,360,720
HL_MAJORS_DIP_COOLDOWN_MIN=30
```

**Per-coin dip override (optional phase 2):** BTC `−7%` для качества (10 sig/mo, +2%@12h=80%); ETH оставить `−6%`.

**24h window (1440m):** в study включено; большинство −6% sig приходят с 24h окна. Phase 1: **оставить 2h/6h/12h** как alt Oscar; phase 2 A/B с `1440` в whitelist окон.

### 4.3. Где дно? (knife после сигнала, imp≥6% grid)

Median **дополнительного** падения от цены входа до локального минимума (12h path):

| Entry dip | BTC med knife | ≈ дно от high | BTC med time to bottom | ETH med knife | ≈ дно от high |
|-----------|---------------|---------------|------------------------|---------------|---------------|
| −3% | −3.16% | ~−6.2% | ~615 min | −4.50% | ~−7.5% |
| −5% | −2.78% | ~−7.8% | ~915 min | −4.14% | ~−9.1% |
| −6% | −2.93% | ~−8.9% | ~1185 min | −3.70% | ~−9.7% |
| −7% | −2.24% | ~−9.2% | ~1155 min | −4.98% | ~−12.0% |

**Выводы:**

- **−3% entry** не «ранний bottom» — median knife **глубже**, чем при −6/−7% (BTC: −3.16% vs −2.24%).
- **−5% vs −7%:** при −7% BTC ловит меньше post-entry knife (−2.24%), но сигналов мало (10/mo).
- **−3% staged leg2 @ −5% от entry** часто исполняется (ETH ~31% @ −5% entry) — подтверждает «нож продолжается».

### 4.4. Staged entry

| | BTC −6% | ETH −6% |
|--|---------|---------|
| leg2 @ −5% от entry | ~0% | ~30% |
| leg3 @ −10% | ~0% | ~0% |

**Phase 1:** `HL_MAJORS_STAGED_ENTRY=0` (single-shot @ signal).

**Phase 2 (optional):** leg2 **−3%** / leg3 **−5%** от signal, split 50/25/25 — соответствует observed knife.

```text
HL_MAJORS_STAGED_ENTRY=0
# phase 2:
HL_MAJORS_LEG2_DROP_PCT=3
HL_MAJORS_LEG3_DROP_PCT=5
```

### 4.5. Exit — TP ladder (NOT alt +5%)

**Reach rates** (профиль `impnone_th-6`, 30d):

| TP | BTC @ 6h | BTC @ 12h | BTC @ 24h | ETH @ 6h | ETH @ 12h | ETH @ 24h |
|----|----------|-----------|-----------|----------|-----------|-----------|
| +1% | 75.6% | 82.2% | 82.2% | — | 78.4% | — |
| +1.5% | 55.6% | 55.6% | 57.8% | — | 60.4% | — |
| +2% | 42.2% | **44.4%** | 44.4% | — | **40.3%** | — |
| +3% | 20.0% | 20.0% | 22.2% | — | 16.5% | — |
| +5% | 0% | **0%** | 0.2% | — | 0% | — |

**Simulated ladder PnL @ 12h** (sell 50% remaining per rung, time stop 12h):

| Ladder | BTC −6% | ETH −6% |
|--------|---------|---------|
| +1.5 / +2.5 / +3.5% | +0.55% | **+0.06%** |
| +2 / +2.5 / +3% | +0.68% | −0.02% |
| **+2 / +3 / +4%** | **+0.75%** | −0.10% |
| Alt +5/+7.5/+10% | +0.55% | −0.35% |

**Single exit @ 12h:**

| TP | BTC hit% | BTC avg PnL | ETH hit% | ETH avg PnL |
|----|----------|-------------|----------|-------------|
| +2% | 44.4% | +0.55% | 40.3% | negative |
| +3% | 20.0% | +0.47% | 16.5% | negative |

**Рекомендуемый exit:**

| Coin | TP rungs | Trail | Kill | Time stop |
|------|----------|-------|------|-----------|
| **BTC** | **+2% / +3% / +4%** (50% remaining each) | arm @ +2%, step −1.0% peak, sell 25% | **−15%** | **12h** |
| **ETH** | **+1.5% / +2% / +2.5%** (50% remaining each) | arm @ +1.5%, step −0.8% | **−15%** | **12h** |

```text
# BTC defaults
HL_MAJORS_BTC_TP_RUNGS=0.02,0.03,0.04
HL_MAJORS_BTC_TRAIL_ARM_FRAC=0.02
HL_MAJORS_BTC_TRAIL_STEP_DROP_FRAC=0.01

# ETH defaults
HL_MAJORS_ETH_TP_RUNGS=0.015,0.02,0.025
HL_MAJORS_ETH_TRAIL_ARM_FRAC=0.015
HL_MAJORS_ETH_TRAIL_STEP_DROP_FRAC=0.008

# shared
HL_MAJORS_TP_SELL_FRAC=0.5
HL_MAJORS_TRAIL_SELL_FRAC=0.25
HL_MAJORS_TIME_STOP_HOURS=12
HL_MAJORS_KILL_PCT=15
HL_MAJORS_STAGED_KILL_DROP_PCT=10
```

Median time to +2% (BTC −6%): **~16 bars (~4h)**.

### 4.6. Sizing

```text
HL_MAJORS_LEVERAGE=2
HL_MAJORS_MARGIN_USD=50
HL_MAJORS_MAX_OPEN_POSITIONS=2
```

**Corr BTC↔ETH:** 100% BTC signals имеют ETH-сигнал в ±1h; Pearson maxUp24 на парах **0.59**. Рассмотреть `HL_MAJORS_MAX_CONCURRENT=1` при одном macro dip (open question).

---

## 5. Архитектура (без изменений vs v0.1)

```
src/scripts/hl-oscar-majors-watch.ts
src/hyperliquid/oscar-majors/
  config.ts          ← HL_MAJORS_* env; per-coin TP map
  entry-signal.ts    ← reuse evaluateOscarEntry
  exit-engine.ts     ← NEW: majors TP (BTC vs ETH rungs)
  candles.ts, trader.ts, journal.ts, reconcile.ts, drawdown.ts
  universe.ts        ← whitelist [BTC, ETH]
```

Reuse exchange layer via `toHlTwapLiveConfig()` pattern from `oscar-perp`.

---

## 6. Env vars (`HL_MAJORS_*`)

| Env | Default | Описание |
|-----|---------|----------|
| `HL_MAJORS_ENABLED` | `1` | master switch |
| `HL_MAJORS_LIVE_ENABLED` | `0` | paper default |
| `HL_MAJORS_DRY_RUN` | `1` | |
| `HL_MAJORS_WHITELIST` | `BTC,ETH` | |
| `HL_MAJORS_DIP_MIN_PCT` | `-6` | |
| `HL_MAJORS_DIP_MAX_PCT` | `-50` | |
| `HL_MAJORS_DIP_MIN_IMPULSE_PCT` | `0` | **не 10** |
| `HL_MAJORS_DIP_WINDOWS_MIN` | `120,360,720` | |
| `HL_MAJORS_DIP_COOLDOWN_MIN` | `30` | |
| `HL_MAJORS_BTC_TP_RUNGS` | `0.02,0.03,0.04` | |
| `HL_MAJORS_ETH_TP_RUNGS` | `0.015,0.02,0.025` | |
| `HL_MAJORS_TP_SELL_FRAC` | `0.5` | |
| `HL_MAJORS_TIME_STOP_HOURS` | `12` | |
| `HL_MAJORS_KILL_PCT` | `15` | |
| `HL_MAJORS_STAGED_ENTRY` | `0` | |
| `HL_MAJORS_MAX_OPEN_POSITIONS` | `2` | |
| `HL_MAJORS_JOURNAL_JSONL` | `data/hl-oscar-majors/live.jsonl` | |

Полный список — как v0.1 §5 + per-coin TP keys.

---

## 7. Success metrics

| Метрика | Target | Floor |
|---------|--------|-------|
| Signals/month BTC @ −6% | ≥15 | ≥5 |
| Signals/month ETH @ −6% | ≥30 | ≥10 |
| Reach TP1 (BTC +2% / ETH +1.5%) | ≥40% | ≥25% |
| Avg realized PnL/trade (paper) | >0% | ≥0% |
| Max drawdown | < $300 | env stop |

Paper **14d** перед live.

---

## 8. Reference tables (30d, `hl-majors-btc-eth-strategy-study`)

**Методология:** 15m HL candles, 30d, cooldown 30m, windows 2h/6h/12h/24h (first match), entry = close ≤ threshold от window high.

### 8.1. Entry grid — BTC (top by ladder +2/3/4 PnL)

| Profile | Sig | Med knife | +1%@12h | +2%@12h | +3%@12h | Ladder +2/3/4 |
|---------|-----|-----------|---------|---------|---------|---------------|
| impnone_th-7 | 10 | −2.24% | 100% | **80%** | 70% | **+2.01%** |
| imp8_th-6 | 21 | −2.55% | 95.2% | 57.1% | 28.6% | +1.26% |
| impnone_th-6 | 45 | −2.93% | 82.2% | 44.4% | 20% | **+0.75%** |
| impnone_th-5 | 89 | −2.76% | 73.0% | 40.4% | 20.2% | +0.62% |
| impnone_th-3 | 405 | −3.16% | 47.9% | 15.1% | 4.4% | −0.69% |

### 8.2. Entry grid — ETH (top by ladder +1.5/2.5/3.5 PnL)

| Profile | Sig | Med knife | +1%@12h | +2%@12h | Ladder +1.5/2.5/3.5 |
|---------|-----|-----------|---------|---------|----------------------|
| impnone_th-6 | 139 | −3.70% | 78.4% | 40.3% | **+0.06%** |
| impnone_th-7 | 83 | −4.98% | 85.5% | 43.4% | ~0% |
| imp8_th-7 | 82 | −4.95% | 85.4% | 43.9% | −0.04% |
| impnone_th-5 | 214 | −4.14% | 69.2% | 29.9% | −0.47% |
| impnone_th-3 | 363 | −4.50% | 71.9% | 38.1% | −0.34% |

### 8.3. BTC vs ETH timing (profile `impnone_th-6`)

| Metric | Value |
|--------|-------|
| BTC signals | 45 |
| ETH signals | 139 |
| Coincident ±1h | 100% of BTC |
| Median lag | ~0 min |
| Pearson maxUp24 | 0.587 |

### 8.4. Alt universe benchmark (118 coins, imp≥10%, −7%)

| Reach +5%@12h | Avg bounce | Alt ladder PnL |
|---------------|------------|----------------|
| **36%** | +5.22% | +0.05% |

Majors ETH reach +5%@12h @ −7%: **3.6%** — **10× ниже**.

---

## 9. Open questions

1. **24h window** — добавить в prod или оставить 12h max?
2. **MAX_OPEN=1** при 100% corr — cap exposure?
3. **BTC −7% quality mode** — отдельный env flag?
4. **oscar-shared refactor** vs duplicate package?
5. Fees/slippage sim on +1.5% ETH TP?

---

## 10. Implementation checklist

- [ ] `src/hyperliquid/oscar-majors/` + watch script
- [ ] Per-coin exit-engine (BTC +2/3/4, ETH +1.5/2/2.5)
- [ ] `HL_MAJORS_*` config + `.env.example`
- [ ] PM2 `hl-oscar-majors-watch` (paper default)
- [ ] Tests + `npm run verify`
- [ ] Paper 14d → compare §7
- [ ] **Не деплоить** до review paper metrics

---

## 11. Связанные артефакты

| Файл | Назначение |
|------|------------|
| `scripts-tmp/hl-majors-btc-eth-strategy-study.mjs` | study script |
| `scripts-tmp/hl-majors-btc-eth-strategy-study-results.json` | full JSON |
| `scripts-tmp/hl-majors-btc-eth-strategy-study-summary.ru.md` | RU summary |
| `src/hyperliquid/oscar-perp/` | reference impl |
| `scripts-tmp/hl-oscar-four-coins-dip-study-results.json` | prior 4-coin study |
