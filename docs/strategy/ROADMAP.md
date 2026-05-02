# Solana Alpha — единая дорожная карта

**Назначение:** один список, по которому движемся дальше. **SSOT по выполненным work packages** — `[docs/strategy/specs/INDEX.md](./specs/INDEX.md)` и `[docs/strategy/release/CHANGELOG.md](./release/CHANGELOG.md)` (релизы продукта 1.x). Этот файл **группирует** и **добавляет** будущие ID, которых ещё нет в `INDEX`.

**Правило нумерации:** не путать с устаревшими таблицами, где «W7.5 = simulate». В репозитории **W7.5 = liquidity drain**, **W7.6 = impulse confirm**, **W7.8 (ниже) = simulate audit** — так помечено здесь.

---

## Легенда статусов


| Статус          | Смысл                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| **done**        | Смержено в `v2`, ведёт кода/спек по `INDEX` или к релизу в `CHANGELOG`          |
| **done (m)**    | Операционный milestone / инфраструктурный слой без отдельного `W*.md` в `INDEX` |
| **done (doc)**  | Спека есть; код live не в релизе (черновик)                                     |
| **in_progress** | Уточнить в комментариях к задаче/ветке (по умолчанию пусто)                     |
| **next**        | Логичный следующий шаг после done                                               |
| **deferred**    | Сознательно отложено (условия/данные)                                           |
| **backlog**     | В плане, spec/строка в `INDEX` появятся по мере готовности                      |


---

## 0. Как читать порядок

Идём **сверху вниз** в рамках каждого блока. Зависимости указаны в колонке **После**. Пункты **(m)** — не отдельные PR по spec-файлу, а «закрытая планка» инфраструктуры/операций.

---

## 1. Фундамент W6 (коллекторы, paper, дашборд)


| ID      | Статус           | Цель (кратко)                                               | После                                | Примечание                                        |
| ------- | ---------------- | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| W6.0    | done             | Миграции, базовые таблицы                                   | —                                    |                                                   |
| W6.1    | done             | DEX-коллекторы, health                                      | W6.0                                 |                                                   |
| W6.2    | **отменён (v1)** | Intel / smart-money в первом цикле                          | —                                    | Переоткрытие в W6.7+ при необходимости            |
| W6.3a   | done             | Скелет papertrader                                          | W6.1                                 |                                                   |
| W6.3b   | done             | Discovery, фильтры, dip                                     | W6.3a                                |                                                   |
| W6.3c   | done             | Исполнитель, main loop, JSONL                               | W6.3b                                |                                                   |
| W6.3c.1 | **normative**    | Семантика TP-ладдера / `remainingFraction`                  | W6.3c                                | См. `W6.3c_tp_ladder_*.md`; в проде релизы 1.2.0+ |
| W6.4    | done             | Observability, cron, logrotate                              | W6.3c                                |                                                   |
| W6.5    | done             | Запуск 3 стратегий (DipRunner / Oscar / Dno) PM2            | W6.4                                 |                                                   |
| W6.6    | **deferred**     | Strategy-lab (пересчёт TP/SL/timeout по накопленному JSONL) | W6.5 + N дней paper, стабилизация W7 | Файл спеки отслеживать в `INDEX`                  |
| W6.7+   | backlog          | Smart Lottery, Coverage, smart-money                        | TBD                                  | Пока без spec                                     |


**Продукт (paper, не отдельный W-ID):** релизы **1.1.0** (impulse/bypass / `entry_path`), **1.2.0** (TP-ladder), **1.2.1** (DCA) — детали в `CHANGELOG.md`.

---

## 2. Milestones W7.0–W7.1 (без дублей в старых таблицах)


| ID           | Статус   | Цель (кратко)                                                                                                                             | После    | Где в репо                                                                            |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| **(m) W7.0** | done (m) | «Preflight» прод: дашборд, коллекторы, 3 paper-стратегии; `sa-stream` / `sa-parser` / `sa-atlas` не в целевом PM2; лимиты QN (см. скрипт) | W6.5     | `scripts-tmp/w70-preflight-vps.sh`, `ecosystem.config.cjs`                            |
| **(m) W7.1** | done (m) | Общий QN HTTP-клиент, per-feature кредитомер, `GET /api/qn/usage`                                                                         | (m) W7.0 | `src/core/rpc/qn-client.ts`, `qn-feature-usage.ts`, `scripts-tmp/dashboard-server.ts` |


**Опционально, без W-номера:** ad-hoc / one-shot разбор JSONL (post-mortem) — 0 QN, процесс, не артефакт W7.

---

## 3. W7.2–W7.6 — QN + реализм paper (канон = INDEX)


| ID   | Статус                                | Цель (кратко)                                                                                             | После                        | Примечание                                                                                                    |
| ---- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| W7.2 | done                                  | Pre-entry safety (mint + top holders batch, feature `safety`)                                             | (m) W7.1                     | `INDEX` ✓                                                                                                     |
| W7.3 | done                                  | Priority fee с сети → JSONL, не фиктив 0.05                                                               | W7.2                         | `INDEX` ✓                                                                                                     |
| W7.4 | done                                  | Pre-entry **цена:** Jupiter **quote** vs снапшот (slip/impact, block опционально)                         | W7.3                         | **Не** «vault-only» verify; `INDEX` ✓                                                                         |
| W7.5 | done                                  | **Liquidity drain** по снимкам в PG, `LIQ_DRAIN`, dashboard/API; **без** `accountSubscribe` в MVP         | W7.4                         | `INDEX` ✓                                                                                                     |
| W7.6 | **done** | **Impulse confirm** (PG-дельта → on-chain / Orca path → согласование с Jupiter; bypass dip; `entry_path`) | W6.3b + W7.4                 | `INDEX` ✓; деталь — [W7.6 spec](./specs/W7.6_impulse_confirm_entry_path.md) + `impulse-confirm.ts` |
| W8.0 | done (doc)                            | Спека **live Oscar** (`LIVE_`*, `live-oscar`, риск, 2X)                                                   | W6.3c + W7.4 + release model | **Код live** — отдельные будущие задачи                                                                       |


---

## 4. Подзадачи и углубления (уже намечены в footnote’ах спек, не везде есть строка в INDEX)


| ID     | Статус  | Цель (кратко)                                                          | После   | Примечание                      |
| ------ | ------- | ---------------------------------------------------------------------- | ------- | ------------------------------- |
| W7.4.1 | backlog | Retries / circuit для Jupiter quote при `skipped`                      | W7.4    | `W7.4_*.md` — будущие шаги      |
| W7.4.2 | done             | Pre-**exit** price verify (Jupiter mint→SOL vs snapshot перед partial/full close) | W7.4     | `W7.4.2_pre_exit_price_verify.md`, `price-verify.ts` + `tracker.ts` |
| W7.4.3 | backlog | Dedup quote per mint, TTL                                              | W7.4    |                                 |
| W7.5.1 | backlog | Vault-адреса в open + `getMultipleAccounts` для liq (толстый RPC path) | W7.5    | `liq-watch` placeholder в коде  |
| W7.5.2 | backlog | Heuristic «rug» до срабатывания liq-drain                              | W7.5    |                                 |
| W7.7   | backlog | Сводный дашборд: эффекты W7.2… по метрикам                             | W7.5+   | Упомянуто в спеке W7.5 как идея |


---

## 5. Следующий крупный пласт (ещё **нет** в INDEX как обязательная строка)


| ID       | Статус               | Цель (кратко)                                                                                                            | После                   | Примечание                                                                                          |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------- |
| **W7.8** | **next (рекоменд.)** | `simulateTransaction` (sample opens), `simAudit` в JSONL; `qnCall` `feature: 'sim'`; v1 **не** gate; см. **[`W7.8_simulate_transaction_audit.md`](./specs/W7.8_simulate_transaction_audit.md)** | (m) W7.1 + W7.4 + W6.3c | Спека **готова**; код — **после** ветки `task/w7-8-sim-audit` |
| W7.9     | backlog (опц.)       | Подписка WS / `accountSubscribe` на LP (если **смена** стратегии; текущий W7.5 MVP без WS)                               | TBD                     | Конкурирует с философией W7.5 snapshot-first                                                        |


**Live-исполнение (деньги):** после стабилизации paper + по `[W8.0_live_oscar_trading_bot.md](./specs/W8.0_live_oscar_trading_bot.md)` — отдельные эпики (out of scope **этой** таблицы, пока нет spec-ID на implementation).

---

## 6. Рекомендуемый порядок «по чеклисту» дальше

1. ~~**Доки:** `INDEX` ↔ W7.6~~ — **сделано** (W7.6 = выполнено).
2. **W7.4.1** (или **W7.8** first — по приоритету: стабильность quote vs on-chain sim-аудит) — оформить spec + строку в `INDEX` при старте работ.
3. **W7.8** `simulate` — если приоритет «аудит исполнимости» выше, чем retry quote.
4. **W6.6** — когда накопится окно paper после стабилизации W7.x.
5. **W8.0 implementation** — только после отдельного go/no-go и чеклиста `RELEASE_OPERATING_MODEL.md`.

---

## 7. Версия документа

- **2026-05-02** — первая версия единой карты (согласована с `INDEX`, `W7.x` спеками и `CHANGELOG` 1.2.x).
- **2026-05-02** — `INDEX` и ROADMAP: W7.6 помечен **выполнено** (impulse-confirm в проде).
- **2026-05-02** — добавлена нормативная **draft**-спека **W7.8** (`W7.8_simulate_transaction_audit.md`), строка в `INDEX`.