# Hyperliquid TWAP — стратегия и эксплуатация

Единый документ по watch-боту, live/perp-торговле и Telegram. Техническая карта модулей: [`hl-twap-live-architecture.md`](./hl-twap-live-architecture.md).

---

## 1. Что делает бот

| Компонент | PM2 | Назначение |
|-----------|-----|------------|
| **Watch** | `hl-twap-telegram-watch` | HypurrScan TWAP → фильтры → whale-алерты + (опционально) paper + live |
| **Live** | тот же процесс | Реальные perp на Hyperliquid, журнал `data/hl-twap/live.jsonl` |
| **Dashboard** | `live-oscar-dashboard` | Плитка «HL TWAP» на `/papertrader2` |

---

## 2. Направление сделок (главное)

### Мы **следуем за китом**, не играем против

| TWAP кита (HypurrScan) | Наша позиция | Ордер на HL |
|------------------------|--------------|-------------|
| **Buy** (bid, покупка) | **LONG** | `buy` |
| **Sell** (ask, продажа) | **SHORT** | `sell` |

Код: сторона берётся из `tw.b` в фиде и **нигде не инвертируется**.

```
HypurrScan tw.b=true  → sig.side='buy'  → LONG
HypurrScan tw.b=false → sig.side='sell' → SHORT
```

### Что такое «перекрёстные TWAP»

Это **фильтр входа**, не смена направления:

1. На монете суммируем impact всех активных TWAP: `buyPct`, `sellPct`.
2. Доминирующая сторона = больший impact; edge = `|buy − sell|`.
3. Вход **только если** наш сигнал = доминирующая сторона **и** edge > 3%.
4. Если мешает встречный TWAP — вход **откладывается** до его окончания (сторона та же).
5. Если edge пропал — открытые позиции на этой монете **закрываются** (`impact_edge_lost`).

**Мы никогда не открываем SHORT на buy-TWAP кита** (и наоборот).

### Почему LONG после buy-TWAP может показывать минус

Это **не перевёрнутая сторона**. Типичные причины:

| Причина | Пояснение |
|---------|-----------|
| **Тайминг входа** | Вход **после 1-го 30s-слайса**, не в момент старта TWAP. Кит мог уже поднять цену за первый цикл — дальше откат. |
| **TWAP ≠ памп** | Кит покупает **мелкими кусками часами**. Цена не обязана расти монотонно между слайсами. |
| **Короткое окно** | Держим позицию **до конца TWAP** (выход перед последним слайсом), не «до бесконечности». |
| **5x leverage** | В UI HL **−10% ROE** ≈ **−2% движения цены** — кажется «уже −10%», хотя цена почти не сдвинулась. |
| **Рынок** | Доминирование buy-impact не гарантирует рост в каждом отрезке. |

**Статистика live (kvm2):** большинство **SHORT** после sell-TWAP закрывались в плюс; часть **LONG** после buy-TWAP — небольшой минус на коротком окне (см. журнал). Направление в журнале совпадает с TWAP кита.

---

## 3. Тайминг входа / выхода

Hyperliquid TWAP = ордер каждые **30 секунд** в течение `minutes`.

| Событие | Когда |
|---------|--------|
| Алерт в Telegram | Сразу при новом TWAP (impact ≥ порога) |
| **Открытие live/paper** | `startedAt + 30s` (после **1-го** слайса) |
| **Закрытие** | За **30s до конца** TWAP (`before_last_cycle`) |
| Досрочное закрытие | TWAP исчез из фида / edge потерян / impact close |

---

## 4. Размер позиции и плечо

| Параметр | Значение |
|----------|----------|
| Маржа на сигнал | `HL_TWAP_LIVE_NOTIONAL_USD` = **$100** |
| Плечо | `HL_TWAP_LIVE_LEVERAGE` = **5x** (cap по монете на HL, напр. REZ 3x) |
| Gross notional | **$100 × leverage** (напр. $500) |
| Несколько TWAP | Каждый `hash` = **отдельная** позиция; same coin + same side **стакаются** |

---

## 5. Лестница TP / DCA (±3%)

Пороги считаются по **ROE маржи** ≈ `движение_цены × leverage` (чтобы ±3% в UI совпадали с ±3% в настройках).

| Уровень | Действие | Размер |
|---------|----------|--------|
| +3%, +6%, +9%… ROE | Take profit | 10% от **начального** gross |
| −3%, −6%, −9%… ROE | DCA (докупка в сторону позиции) | 10% от **начального** gross |

Опорная цена для порогов: **средняя** `avgEntryPx` (после DCA пересчитывается).

---

## 6. Telegram

| Канал | Env | Содержимое |
|-------|-----|------------|
| Whale TWAP | `HL_TWAP_TELEGRAM_*` | Новые/завершённые TWAP китов |
| Live сделки | `HL_TWAP_LIVE_TRADES_TELEGRAM_*` | Open/close **наших** позиций + PnL |

---

## 7. Переменные окружения (кратко)

| Variable | Default | Назначение |
|----------|---------|------------|
| `HL_TWAP_MIN_VOLUME_SHARE_PCT` | `3` | Impact для **алертов** и detect |
| `HL_TWAP_BUY_ONLY` | `0` | `0` = long+short; legacy режим только sell-after-buy |
| `HL_TWAP_LIVE_ENABLED` | `0` | Live trading |
| `HL_TWAP_LIVE_DRY_RUN` | `1` | Без ключа — симуляция |
| `HL_TWAP_LIVE_PRIVATE_KEY` | — | **Только `.env`**, не PM2 |
| `HL_TWAP_LIVE_NOTIONAL_USD` | `100` | Маржа |
| `HL_TWAP_LIVE_LEVERAGE` | `5` | Плечо |
| `HL_TWAP_LIVE_MIN_IMPACT_PCT` | `3` | Impact для **live** schedule (можно = watch) |
| `HL_TWAP_LIVE_LADDER_STEP_PCT` | `3` | Шаг лестницы (ROE %) |
| `HL_TWAP_LIVE_LADDER_SLICE_PCT` | `10` | Slice TP/DCA (% от initial gross) |
| `HL_TWAP_LIVE_JSONL` | `data/hl-twap/live.jsonl` | Журнал |

Полный список в `.env.example` (блок `Hyperliquid TWAP`).

---

## 8. Деплой и мониторинг

```bash
# kvm2 — только watch (не трогать live-oscar / copy-trader без необходимости)
git fetch && git checkout sa-alpha-1.11.331   # или новее
pm2 reload ecosystem.config.cjs --only hl-twap-telegram-watch --update-env
tail -f data/hl-twap/live.jsonl
pm2 logs hl-twap-telegram-watch --lines 50
```

Проверка направления по журналу:

```bash
npx tsx scripts-tmp/_hl_trade_direction_audit.mjs data/hl-twap/live.jsonl
```

---

## 9. FAQ

**Мы торгуем против кита?**  
Нет. Buy TWAP → LONG, sell TWAP → SHORT.

**Почему в дашборде раньше было «разворот» на SHORT?**  
Устаревшая подпись старой логики (sell-after-buy). Убрана; SHORT = sell TWAP кита.

**Sell TWAP — это шорт «против рынка»?**  
Это шорт **вместе с китом**, который продаёт через TWAP (давление вниз).

**Можно ли открыть LONG и SHORT на одной монете?**  
Нет одновременно (perps net). Opposite side блокируется, пока есть открытая позиция.

**Когда перепроверяется edge?**  
При detect, при отложенном входе, при impact close; **перед исполнением open** — повторная проверка плана.
