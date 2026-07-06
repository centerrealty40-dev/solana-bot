# Архитектурный аудит live-oscar (2026-07-07)

**Продукт:** solana-alpha / live-oscar only. **Cross-product changes:** none.

---

## Принцип Wallet = SoT, Journal = post-factum

| Правило | Смысл |
|---------|--------|
| **Wallet = SoT** | Размер exit, orphan, heal, boot — только по Oscar-attributed chain USD (`oscarChainUsdFromRaw`). |
| **Journal = post-factum** | Журнал отражает уже случившееся on-chain; **никогда** не инициирует buy «догнать journal». |
| **PERIODIC_HEAL** | Только: закрыть journal под chain **или** продать лишнее на chain. Cancel pending split/avg при heal-close. **Без buy.** |
| **Boot после PM2 reload** | Journal open + chain zero → **close journal** (orphan reconcile), **не buy** по любой цене. Без entry_split legs из ghost state. |
| **Copy** | Leader = hint; Oscar владеет lifecycle с avg/TP. Фикс double-buy copy+Oscar, **не** отключение staged entry на adopt. |
| **Все buys** | Только `dip pass:true` **или** copy signal (нет позиции). **Не** journal-driven buy на зелёной свече. |

Spec: `docs/strategy/live-oscar/WALLET_BALANCE_SOURCE_OF_TRUTH.md`

---

## Cross-reference RCA сессии

| Инцидент | Суть | Статус |
|----------|------|--------|
| **62YE1d4s pump** | `sell_full` от stale journal (~$811), chain ~$100 → slice $400, tail flush не срабатывал | Fix PR-A (exit slice + onSliceSuccess partial TP) |
| **manlet / DdPrHY** | `pg_stale_now` блокировал repeat mint; profit re-entry churn | [Unreleased] familiar mint bypass в CHANGELOG |
| **J8PS / TripleT** | Wave B без avg: первая TP +7.5%, +5–6% PnL без продаж | Fixed 1.11.228 (`WAVE_B_V1_TP_GRID_NO_AVG`) |
| **Dex gate (#404 pattern)** | live-oscar + collectors на cache+gate; **copy-trader, dashboard — вне** | PR-B (dex cache env) |

---

## 1. Sell / Exit

### 1.1 Exit slice: stale journal vs chain (62YE) — **P0**

**Проблема:** Multi-slice exit использовал journal notional; после первого slice journal не обновлялся → oversize slice, `tail flush` не видел dust.

**Root cause:** `runSlicedTokenToSolPipeline` резал по `args.usdNotional` без `min(journal, chain)`; `onSliceSuccess` не вызывался на partial TP.

**Simple fix:** `planExitSliceUsdNotional` + `shouldBypassExitSlicing` + `onSliceSuccess` → `syncOpenTradeAfterLiveExitSlice` на partial TP (`tracker.ts`), как на full exit.

**Файлы:** `src/live/exit-slice.ts`, `src/live/wallet-balance-exit-reconcile.ts`, `src/papertrader/executor/tracker.ts`, `tests/live-exit-slice.test.ts`

---

### 1.2 Wallet-first asymmetry: max vs min — **P1**

**Проблема:** Full/partial sizing — `max(journal, chain)`; slice planner — `min(journal, chain)`.

**Root cause:** Два контракта без единого API «effective notional for intent».

**Simple fix:** Один экспорт `planExitNotional({ intent: 'size' | 'slice', ... })` в `wallet-balance-exit-reconcile.ts`.

---

### 1.3 Partial TP без inter-slice journal — **P0** (часть 1.1)

**Проблема:** `onSliceSuccess` только на full exit path.

**Simple fix:** Тот же hook на partial TP (~1215), skip duplicate partial row если slice уже journaled.

---

### 1.4 Tail flush / post-close / periodic heal — три входа — **P1**

**Проблема:** Tail flush через три модуля; цена — PG snapshot, не dex cache.

**Simple fix:** Tail flush pricing → `resolveDiscoveryMarketQuote` или `fetchDexScreenerQuoteViaCache`; один `runTailFlush(context)`.

---

### 1.5 Wave B vs full exit — **P2**

**Simple fix:** Вынести «managed exposure + force tail close» в один helper.

---

### 1.6 `LIVE_POLICY_ONLY_EXITS` vs heal — **P1**

**Simple fix:** Whitelist «hygiene sells» (tail below $X) отдельно от TP/KILLSTOP policy.

---

## 2. Lifecycle

### 2.1 Boot restore: journal ghost, chain zero — **P0**

**Проблема:** После PM2 reload journal может содержать open без SPL на wallet.

**Root cause:** Boot restore только **добавлял** orphan chain→journal, не закрывал journal→chain mismatch.

**Simple fix:** `closeJournalGhostOpensWhenChainEmpty` на boot: close journal, cancel split/avg, **never buy**.

**Файлы:** `src/live/boot-open-restore.ts`, `src/live/journal-ghost-close.ts`

---

### 2.2 PERIODIC_HEAL: close-not-buy — **P0**

**Проблема:** Heal мог оставлять journal open при chain zero до tracker tick.

**Simple fix:** В `periodic-self-heal.ts`: journal-only close при SPL=0; cancel pending legs; sell excess on chain only.

---

### 2.3 `copy_leader_exit_adopt` — pricing вне fetcher — **P1**

**Simple fix:** `resolveCopyLeaderAdoptTier` → `resolveDiscoveryMarketQuote` (Dex→PG). Staged entry/avg **сохраняем**.

---

### 2.4 Boot restore — два пути — **P2**

**Simple fix:** После любого boot: chain scan → reconcile all opens.

---

### 2.5 Heal vs re-entry — **P1**

**Simple fix:** Общая `executionBuyGateReasons(mint, px)` для всех buy intents.

---

## 3. Pricing

### 3.1 Dex cache done on live-oscar, не на всех PM2 — **P0**

**Simple fix:** `fetchDexInfo` → `fetchDexScreenerQuoteViaCache`; env `DEX_QUOTE_CACHE_*` на copy-trader PM2.

---

### 3.2 Pool pick asymmetry — **P2**

**Simple fix:** Экспорт `pickBestSolanaPair` из `dexscreener-quote-cache.ts`.

---

### 3.3 PG stale / MTM — **P1**

**Simple fix:** Wallet reconcile USD на том же Jupiter probe / dex cache, что MTM.

---

## 4. Discovery gates

### 4.1 `volume_ephemeral` vs familiar mint — **P1**

**Simple fix:** Merge familiar bypass; audit flag в JSONL.

---

### 4.2 Re-entry fork discovery vs execution — **P2**

**Simple fix:** Shared `candidatePriceForReentryGate(mint)`.

---

## 5. Journal / wallet SoT desync

| Паттерн | Проявление | Fix |
|---------|------------|-----|
| Journal expand, не shrink | Manual sell lag | `resyncRemainingFractionFromChain` + `afterOnChainSell` |
| TP close journal-only | MENSA false close | `hasManagedWalletExposure` |
| Multi-slice без partial rows | 62YE zombie | `onSliceSuccess` + partial journal |
| Boot journal ghost | PM2 reload drift | `closeJournalGhostOpensWhenChainEmpty` |
| Copy-leader attribution | Shared wallet oversize | `oscarChainUsdFromRaw` |
| Journal-driven buy | Ghost restore / green candle | **Запрещено** — только dip pass / copy signal |

---

## 6. PM2 / memory

### 6.1 `max_memory_restart: 3072M` — **done (monitor)**

### 6.2 Orphan PIDs live-oscar — **P1**

**Simple fix:** `strategy-process-watch` + `assessLiveOscarProcessSingleton`.

---

## Roadmap

### P0 — PR-A / PR-B

1. **Exit slice complete** — merge + `onSliceSuccess` partial TP
2. **Wallet SoT boot/heal** — close-not-buy, cancel pending legs
3. **Dex gate completeness** — copy-trader → unified cache

### P1

4. Unified exit notional API
5. Tail flush pricing через dex cache
6. `copy_leader_exit_adopt` → discovery quote
7. Execution buy gates parity
8. Familiar mint gate bypass
9. Policy-only vs hygiene tail sells

### P2

10. Single tail-flush module
11. Boot position state machine (chain-first)
12. Shared `pickBestSolanaPair`
13. Hot-tick / tracker dedup force-close
14. Re-entry gate single price source

---

## Порядок PR

```
PR-A (P0): exit slice + partial onSliceSuccess + wallet SoT boot/heal
PR-B (P0): dex cache on copy-trader + fetchDexInfo via cache
PR-C (P1): familiar mint bypass release tag
PR-D (P1): tail flush → dex cache pricing
PR-E (P1): unified planExitNotional API
PR-F (P2): boot chain-first reconcile
```

---

## Принцип «include brain»

| Сейчас (N мозгов) | Цель |
|-------------------|------|
| Dex: 6+ raw HTTP call sites | **One fetcher:** `fetchDexScreenerQuoteViaCache` |
| Sell: tracker partial/full, hot-tick, heal, post-close | **One sell planner:** `wallet-balance-exit-reconcile` + один tail executor |
| Position: journal fraction, chain, orphan, boot | **One state machine:** reconcile on every tick + boot chain scan |
| Re-entry: dip-clones + phase4-execution | **One gate fn** + one price resolver |
| Buy intents | **One rule:** dip pass OR copy signal only — never journal-driven |
