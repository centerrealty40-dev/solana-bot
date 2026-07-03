# HL Oscar Majors — Mode B Scalp Spec

**Версия:** 0.1 (2026-07-03)  
**Статус:** paper/dry-run 14d на VPS (`HL_MAJORS_SCALP_DRY_RUN=1`)  
**Backtest:** `scripts-tmp/hl-majors-scalp-corridor-study-results.json`  
**Proposal:** `scripts-tmp/hl-majors-scalp-corridor-proposal.ru.md`

---

## 1. Scope

Mode B (scalp) дополняет существующий Mode A (knife, −6%) в том же PM2-процессе `hl-oscar-majors-watch`. Отдельный продукт или PM2 **не** создаётся.

| Параметр | Значение |
|----------|----------|
| Монеты | BTC, ETH (whitelist knife) |
| PM2 | `hl-oscar-majors-watch` |
| Код | `src/hyperliquid/oscar-majors/scalp-*.ts` |
| Journal | `data/hl-oscar-majors/live.jsonl` — поле `tradeMode: 'knife' \| 'scalp'` |
| Mutex | Один long на монету (knife **или** scalp, не оба) |

---

## 2. Mode dispatch

```text
HL_MAJORS_MODE=knife   # только Mode A (legacy default)
HL_MAJORS_MODE=scalp   # только Mode B
HL_MAJORS_MODE=both    # knife + scalp, mutex per coin
```

При `both`: scalp сканируется **первым** (приоритет при свободном слоте). Knife не открывается, если на монете уже есть позиция (любого режима).

**Execution mode (live vs paper):**

| Lane | Env | Default VPS |
|------|-----|-------------|
| Knife | `HL_MAJORS_LIVE_ENABLED`, `HL_MAJORS_DRY_RUN` | live |
| Scalp | `HL_MAJORS_SCALP_LIVE_ENABLED`, `HL_MAJORS_SCALP_DRY_RUN` | **paper** (14d) |

Scalp может быть paper при live knife — независимые флаги.

---

## 3. Entry (Mode B)

| Параметр | Env | Default |
|----------|-----|---------|
| Dip от 2h high | `HL_MAJORS_SCALP_DIP_PCT` | **−2** |
| Окно high | `HL_MAJORS_SCALP_WINDOW_MIN` | **120** (мин) |
| Фильтр 24h range | `HL_MAJORS_SCALP_RANGE_FILTER` | **1** (on) |
| Max pos in range | `HL_MAJORS_SCALP_RANGE_MAX_PCT` | **0.40** (≤40% = нижняя часть range) |
| Cooldown | `HL_MAJORS_SCALP_COOLDOWN_MIN` | **30** |

**Формула dip:** `close / high_2h − 1 ≤ dipPct` (dipPct отрицательный, напр. −2).

**Формула range:** `posIn24hRange = (close − low_24h) / (high_24h − low_24h)`; вход только если `≤ rangeMaxPct`.

---

## 4. Exit (Mode B)

| Параметр | Env | Default |
|----------|-----|---------|
| TP ladder | `HL_MAJORS_SCALP_TP_RUNGS` | **0.005,0.01** (+0.5%, +1.0%) |
| Sell frac per rung | `HL_MAJORS_SCALP_TP_SELL_FRAC` | **0.5** (50% remaining) |
| Stop loss | `HL_MAJORS_SCALP_SL_PCT` | **2.5** (−2.5% от avg entry) |
| Time stop | `HL_MAJORS_SCALP_TIME_STOP_MIN` | **240** (4h) |
| Trail arm | `HL_MAJORS_SCALP_TRAIL_ARM_PCT` | **0.8** (+0.8%) |
| Trail step | `HL_MAJORS_SCALP_TRAIL_STEP_PCT` | **0.4** |

Нет staged entry, нет knife kill −15%. Journal reason codes: `TP`, `SCALP_SL`, `TIME_STOP`, `TRAIL`, `BREAKEVEN`, `REMAINDER_FLUSH`.

---

## 5. Sizing

| Параметр | Env | Default |
|----------|-----|---------|
| Margin | `HL_MAJORS_SCALP_MARGIN_USD` | **$25** |
| Leverage | `HL_MAJORS_SCALP_LEVERAGE` | **2** |
| Gross | (derived) | **$50** |
| Max open scalp | `HL_MAJORS_SCALP_MAX_OPEN` | **2** |

Knife остаётся $50 margin / $100 gross @ 2x. При `both` max exposure per coin policy: до $75 margin ($150 gross) если оба режима когда-либо открыты на разных монетах — mutex на монету ограничивает до одной позиции.

---

## 6. Backtest reference (30d, BTC+ETH combined)

| Profile | Exp/trade | Sig/day | Max DD |
|---------|-----------|---------|--------|
| Scalp −2% → TP +1% (4h) | **+0.38%** | 4.2 | 14.1% |
| Scalp −2% → TP +0.5% (2h) | +0.19% | 4.2 | 6.2% |
| Knife −6% (BTC only) | +1.73% | 0.47 | 0% |

Реализован профиль **−2% / +0.5% / +1.0% / SL 2.5% / 4h** — лучший risk/reward в study.

---

## 7. Journal schema

Все события `open`, `partial_exit`, `close` содержат:

```json
{ "tradeMode": "scalp", "mode": "dry_run" }
```

- `tradeMode` — стратегия: `knife` | `scalp`
- `mode` — исполнение: `dry_run` | `live`

Heartbeat (`heartbeat.json`):

```json
{ "strategyMode": "both", "scalpMode": "dry_run", "mode": "live" }
```

---

## 8. Rollout plan

| Phase | Action | Duration |
|-------|--------|----------|
| **1 (now)** | Deploy `both`, scalp paper | 14d |
| 2 | Review journal: fee/slippage vs backtest | after 14d |
| 3 | `HL_MAJORS_SCALP_LIVE_ENABLED=1`, `HL_MAJORS_SCALP_DRY_RUN=0` | if metrics OK |

**Не делать:** scalp −1%, grid 10+ levels, abandon knife.

---

## 9. Code map

```
src/hyperliquid/oscar-majors/
  scalp-entry.ts        # −2% from 2h high + 24h range filter
  scalp-exit-engine.ts  # TP +0.5/+1%, SL 2.5%, 4h stop
  config.ts             # HL_MAJORS_MODE, HL_MAJORS_SCALP_*
  trader.ts             # dual scan, mutex, exit routing
src/scripts/hl-oscar-majors-watch.ts
ecosystem.config.cjs    # HL_MAJORS_MODE=both, scalp paper flags
```

---

*Rollback:* set `HL_MAJORS_MODE=knife` or `HL_MAJORS_SCALP_ENABLED=0` → pm2 reload `hl-oscar-majors-watch`.
