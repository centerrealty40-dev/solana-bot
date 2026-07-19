# Unified Position Engine — единый контур исполнения live Oscar

**Продукт:** `solana-alpha` / PM2 `live-oscar`  
**Статус:** normative — **фазы A–D реализованы** (2026-07-19, продукт **1.11.608**)

## 1. Проблема

Текущий runtime — **несколько независимых подсистем** без общего контракта:

| Подсистема | SSOT |
|------------|------|
| Journal / `OpenTrade.legs` | Оптимистичный notional |
| Kill / TP | PG/Jupiter MTM vs `avgEntry` |
| Sell pipeline | `chain_full_balance` |
| Close PnL | `proceeds / totalInvestedUsd` |

Класс **Ge87**: journal $1200, chain ~$300, kill по MTM ~−0.8%, close **−75%**.

## 2. Принцип

**Один mint → одна state machine → один ledger.**

Цепь (SPL + подтверждённые tx) — единственный источник правды для **размера** и **выхода**.  
Journal — проекция ledger, обновляется **только после confirm**.

## 3. Фазы позиции

```
OPENING ──► ACQUIRING ──► MANAGED ──► EXITING ──► CLOSED
              │              │
              │              └── TP / kill / trail / timeout
              └── entry split legs (buys only)
```

| Фаза | Разрешено | Запрещено |
|------|-----------|-----------|
| **OPENING** | Первая buy после gates | Любой exit |
| **ACQUIRING** | Доборы entry-split / staged avg | Kill, TP, emergency sell, full exit |
| **MANAGED** | Вся exit-policy | Новые entry-split ноги (кроме явного DCA policy) |
| **EXITING** | Завершение sell in-flight | Новые buys, смена journal cost |
| **CLOSED** | — | Всё |

**Исключение ACQUIRING:** только `LIQ_DRAIN` (pool collapse) — явный env `LIVE_UPE_ALLOW_LIQ_DRAIN_DURING_ACQUIRE=1` (default on).

## 4. Ledger (confirmed-only)

```typescript
ConfirmedBuyLeg  { txSignature, sizeUsd, effectivePrice, rawTokens, ts }
ConfirmedSell    { txSignature, solProceedsLamports, tokensSoldRaw, reason, ts }
```

- `costBasisUsd` = Σ confirmed buys − attributed cost of confirmed partial sells  
- `chainExposureUsd` = raw balance × spot (Oscar-attributed)  
- `remainingFraction` = chain tokens / Σ confirmed buy tokens (cap 1)

**Leg в journal пишется только после `execution_result.confirmed`.**

## 5. Инварианты (runtime assert)

| ID | Проверка | Действие при нарушении |
|----|----------|------------------------|
| **UPE-I1** | Фаза ACQUIRING → exit reason ∉ {LIQ_DRAIN} | **block exit** |
| **UPE-I2** | `chainExposureUsd / costBasisUsd < LIVE_UPE_MIN_CHAIN_JOURNAL_RATIO` (default 0.55) перед full exit | **block exit**, log `upe_desync_block` |
| **UPE-I3** | Close PnL denominator = `min(costBasisUsd, chainExposureUsd + partialProceeds)` при desync | Не показывать −75% на flat price |
| **UPE-I4** | Emergency / policy sell → запись в `partialSells` или `confirmedSells` | Repair на следующем тике |
| **UPE-I5** | `EXITING` пока sell attempt in-flight | block duplicate full exit |

## 6. Модули

| Путь | Роль |
|------|------|
| `src/live/position-engine/types.ts` | Фазы, ledger types |
| `src/live/position-engine/ledger.ts` | cost basis, remaining, PnL |
| `src/live/position-engine/guards.ts` | `evaluateExitGuard`, `derivePhase` |
| `src/live/position-engine/adapter.ts` | Bridge `OpenTrade` + chain → snapshot |
| `src/live/position-engine/index.ts` | Public API |

## 7. Интеграция (миграция)

**Фаза A ✅:** guards в `tracker.ts` — block exit при UPE-I1/I2; close PnL по UPE-I3.  
**Фаза B ✅:** `syncLiveUpeOnTrackerTick` + `notifyUpeEntryLegConfirmed`; `liveUpePhase` на `OpenTrade`.  
**Фаза C ✅:** partial/full sells через `evaluateExitIntent`; `liveUpeExitInFlight` на sell pipeline.  
**Фаза D (ongoing):** tracker остаёт orchestrator; policy modules постепенно переносятся в engine.

Env: `LIVE_UNIFIED_POSITION_ENGINE=1` (default **1** в live mode).

## 8. Тесты

- Ge87 replay: 4 journal legs, chain 25% → kill blocked in ACQUIRING; close PnL ≠ −75% on flat.  
- Entry split mid-flight + wave B kill → blocked.  
- Post split complete + real −8% → kill allowed.

## 9. Не входит

- Discovery / dip gates (остаются в papertrader discovery)  
- Jupiter rate limits (отдельный слой)  
- Copy-trader attribution (input в chain snapshot)
