# Rings Paper-Trader — runbook

Live forward-test для гипотезы "Coordinated Buying Rings". Без реальных денег.

## Запуск (на VPS под salpha)

```bash
cd /opt/solana-alpha
git pull
npm install                           # на случай новых deps (тут не добавлялись)
npm run db:migrate                    # применит 0006_paper_trades

# отладочный прогон одного цикла
npm run paper:trader:once

# постоянный прогон через pm2
pm2 start npm --name sa-paper-trader -- run paper:trader
pm2 save
pm2 logs sa-paper-trader --lines 50
```

## Сводка

```bash
npm run paper:stats
```

Покажет:
- статусы (open / partial_2x / partial_5x / closed_win / closed_loss / closed_rug / closed_timeout)
- realized + unrealized PnL, ROI
- топ-5 wins, топ-5 losses
- все open позиции с текущим P&L

## Как работает

**Каждые 30 сек:**
1. Ищет в `swaps` свежие (≤10 мин назад) окна, где **≥5 уникальных кошельков** купили один токен за **≤180 сек**, **≥$100 каждый**.
2. **Independence filter**: ≥3 разных funder'а в `money_flows`, ≤30% покупателей с farm/scam-меткой.
3. **Quality filter (Dexscreener)**:
   - liquidity ≥ $10k
   - возраст пула ≥ 30 мин (отсекаем pump.fun curve)
   - vol_h6/(vol_h1*6) ≥ 0.4 (объём не упал в 0)
   - не катастрофический dump (sells > 2× buys и >30 продаж/час)
4. **Honeypot pre-flight (Jupiter)**: SOL→TOKEN→SOL роунд-трип на 0.05 SOL, отклоняем если потери >30%.
5. Если всё прошло → `INSERT paper_trades` с entry $10.

**Каждые 30 сек для open позиций:**
- Pull current price из Dexscreener.
- Лесенка выхода:
  - **+100% (2x)** → продаём 50% (вернули стейк).
  - **+400% (5x)** → продаём ещё 30%.
  - **20% moon bag** → trailing stop −50% от пика, или timeout 7 дней.
- Hard stop −60% от entry → продаём всё.
- Если токен пропал из dexscreener (rug) → закрываем по 0.

## Что мы измеряем

Через 48-72 часа реального прогона смотрим в `paper:stats`:

| метрика | целевое значение | вывод |
|---|---|---|
| win rate (>0% net) | ≥40% | паттерн рабочий |
| median return | ≥+20% | сигнал есть |
| moonshots (>11x net) | ≥1 на 30 trades | EV считается |
| Equity ROI | положительный | можно переходить к live trading |

Если ROI отрицательный, но moonshots ≥1 — крутим параметры лесенки.
Если win rate <30% и moonshots = 0 — гипотеза не работает, добавляем фильтры или хороним.

## Настройки

В шапке `rings-paper-trader.ts`:
- `SCAN_INTERVAL_MS / TRACK_INTERVAL_MS` — частота
- `MIN_BUYERS / WINDOW_SEC / MIN_USD_PER_BUY` — детектор колец
- `MIN_LIQUIDITY_USD / MIN_TOKEN_AGE_MIN / MIN_VOL_SURVIVAL` — quality filter
- `TARGETS` — лесенка ([{mult, sellFraction}])
- `TRAILING_STOP_FROM_PEAK / HARD_STOP_LOSS / TIMEOUT_HOURS` — exit правила
