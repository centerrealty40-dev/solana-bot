/**
 * Hyperliquid TWAP → Telegram + optional paper/live perp bot.
 *
 * Стратегия: **следуем за китом** (buy TWAP → LONG, sell TWAP → SHORT). Перекрёстные TWAP — фильтр, не разворот.
 * Документация: docs/platform/hl-twap.md
 *
 * Data source: HypurrScan `GET https://api.hypurrscan.io/twap/*` + optional HL WebSocket fast-path.
 *
 * Env (separate bot — do not reuse Live Oscar TELEGRAM_*):
 * - HL_TWAP_TELEGRAM_BOT_TOKEN / HL_TWAP_TELEGRAM_CHAT_ID — whale alerts
 * - HL_TWAP_MIN_IMPACT_PCT_HOUR=2 — min net impact % **per hour** (not % of day vol)
 * - HL_TWAP_WHALE_DENYLIST — optional whale addresses to skip (comma-sep)
 * - HL_TWAP_FADE_WHALES — comma-sep whales to fade (invert side); overrides denylist for those addresses
 * - HL_TWAP_BTC_ALIGNED_GATE=1 — block long when BTC 1h < 0, block short when BTC 1h > 0
 * - HL_TWAP_BTC_GATE_MAX_STALE_MS=900000 — max age of Binance BTC klines for gate
 * - HL_TWAP_BTC_REFRESH_MS=300000 — poll interval for BTC context when gate enabled
 * - HL_TWAP_BUY_ONLY=0 — long+short (legacy: sell только после buy OPEN)
 * - HL_TWAP_PAPER_NOTIONAL_USD=1000 — бумажная нота на сигнал (плитка 3 дашборда)
 * - HL_TWAP_LIVE_ENABLED=0 — live bot; см. docs/platform/hl-twap.md
 * - HL_TWAP_LIVE_DRY_RUN=1 — simulate orders until HL_TWAP_LIVE_PRIVATE_KEY set
 * - HL_TWAP_LIVE_TRADES_TELEGRAM_BOT_TOKEN / HL_TWAP_LIVE_TRADES_TELEGRAM_CHAT_ID — краткие open/close (отдельно от whale-алертов)
 * - HL_TWAP_NOTIFY_ENDED=1
 * - HL_TWAP_META_REFRESH_MS=120000
 * - HL_TWAP_DRY_RUN=0
 * - HL_TWAP_AUDIT_JSONL=path (optional, default data/hl-twap/signals.jsonl)
 * - HL_TWAP_MEXC_LINKS=1 — append MEXC perp URL when symbol known
 * - HL_TWAP_WS_ENABLED=1 — HL WebSocket fast-path for watched whales (HypurrScan poll remains reconcile/discovery)
 * - HL_TWAP_WS_MAX_SUBS=30 — whale cap when deriving list from signals.jsonl
 * - HL_TWAP_WS_WHALE_LIST=0x... — optional comma-sep override
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import {
  detectTwapChanges,
  createTwapWatchState,
  markTwapOpenedNotified,
  seedTwapWatchState,
} from '../hyperliquid/twap/detect.js';
import {
  computeCoinEntryPlan,
  minImpactPctHour,
  opposingActiveTwapsForCoin,
  shouldCloseForImpactLoss,
} from '../hyperliquid/twap/coin-twap-analysis.js';
import { deniedWhaleAddresses } from '../hyperliquid/twap/whale-denylist.js';
import { fadeWhaleAddresses, hlTwapEntrySide } from '../hyperliquid/twap/fade-whales.js';
import { abortWhaleExitOnRestart } from '../hyperliquid/twap/twap-whale-exit.js';
import {
  hlTwapBtcAlignedGateEnabled,
  hlTwapBtcGateMaxStaleMs,
} from '../hyperliquid/twap/twap-btc-gate.js';
import {
  twapCancelExitDelayMinutes,
  twapExitEarlyMinutes,
  twapMaxMinutes,
  twapMinMinutes,
} from '../hyperliquid/twap/twap-duration.js';
import {
  buildCrossingNote,
  buildTwapEndMessage,
  buildTwapStartMessage,
  mexcFuturesUrl,
} from '../hyperliquid/twap/format-telegram.js';
import { fetchHypurrscanTwapFeed } from '../hyperliquid/twap/hypurrscan.js';
import { HlWsTwapFeed, loadHlWsFeedConfig } from '../hyperliquid/twap/hl-ws-feed.js';
import {
  absorbHypurrscanDuplicate,
  createWsIntegrateState,
  mergeWhaleAddresses,
  resolveLocalTwapHash,
  tryAcceptWsTwap,
  withLocalTwapHash,
} from '../hyperliquid/twap/hl-ws-integrate.js';
import { detectLagMs } from '../hyperliquid/twap/hl-ws-parse.js';
import { loadHlWsWhaleList } from '../hyperliquid/twap/hl-ws-whales.js';
import { loadHyperliquidMarketCache, type HyperliquidMarketCache } from '../hyperliquid/twap/hyperliquid-meta.js';
import { normalizeHypurrscanRow } from '../hyperliquid/twap/normalize.js';
import { enrichEndFromTwapHistory } from '../hyperliquid/twap/twap-history.js';
import {
  closePaperTrade,
  handlePaperOnTwapEnd,
  loadPaperOpensFromJournal,
  paperJournalPath,
  processPaperTrades,
  schedulePaperTrade,
} from '../hyperliquid/twap/paper-trader.js';
import { loadHlTwapLiveConfig } from '../hyperliquid/twap/live/config.js';
import { createHlTwapExchangeClient, type HlTwapExchangeClient } from '../hyperliquid/twap/live/exchange-client.js';
import {
  handleLiveOnTwapEnd,
  processLiveLadders,
  processLiveTrades,
  processExchangeResiduals,
  scheduleLiveTrade,
  closeLiveTrade,
} from '../hyperliquid/twap/live/live-trader.js';
import { loadLiveOpensFromJournal } from '../hyperliquid/twap/live/journal.js';
import { resolveUserTwapRating, type UserTwapRating } from '../hyperliquid/twap/user-rating.js';
import type { HypurrscanTwapRow, NormalizedTwapSignal, TwapSide } from '../hyperliquid/twap/types.js';
import { refreshBtcContext } from '../papertrader/pricing.js';
import type { PaperTraderConfig } from '../papertrader/config.js';

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v === 'yes';
}

const POLL_MS = Math.max(2000, envNum('HL_TWAP_POLL_INTERVAL_MS', 2000));
const META_REFRESH_MS = Math.max(30_000, envNum('HL_TWAP_META_REFRESH_MS', 120_000));
const MIN_IMPACT_PCT_HOUR = minImpactPctHour();
const BUY_ONLY = envBool('HL_TWAP_BUY_ONLY', false);
const PAPER_ENABLED = envBool('HL_TWAP_PAPER_ENABLED', true);
const LIVE_CFG = loadHlTwapLiveConfig();
const LIVE_ENABLED = LIVE_CFG.enabled;
const NOTIFY_ENDED = envBool('HL_TWAP_NOTIFY_ENDED', true);
const DRY_RUN = envBool('HL_TWAP_DRY_RUN', false);
const MEXC_LINKS = envBool('HL_TWAP_MEXC_LINKS', true);
const WS_ENABLED = envBool('HL_TWAP_WS_ENABLED', true);
const WS_MAX_SUBS = Math.max(1, envNum('HL_TWAP_WS_MAX_SUBS', 30));
const ONCE = process.argv.includes('--once');

const TG_TOKEN = process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() ?? '';
const TG_CHAT = process.env.HL_TWAP_TELEGRAM_CHAT_ID?.trim() ?? '';
const AUDIT_PATH =
  process.env.HL_TWAP_AUDIT_JSONL?.trim() ||
  path.join(process.cwd(), 'data', 'hl-twap', 'signals.jsonl');
const RATING_CACHE_MS = Math.max(60_000, envNum('HL_TWAP_USER_RATING_CACHE_MS', 300_000));

const ratingCache = new Map<string, { at: number; rating: UserTwapRating }>();
const watchState = createTwapWatchState();
const wsIntegrate = createWsIntegrateState();
let liveExchange: HlTwapExchangeClient | null = null;
let wsFeed: HlWsTwapFeed | null = null;
let marketCache: HyperliquidMarketCache | null = null;
let marketCacheAt = 0;
let lastFeedRows: HypurrscanTwapRow[] = [];
let btcRefreshAt = 0;
const BTC_REFRESH_MS = Math.max(60_000, envNum('HL_TWAP_BTC_REFRESH_MS', 300_000));
const BTC_CFG = {} as PaperTraderConfig;

async function userRatingCached(user: string, feedRows: HypurrscanTwapRow[]): Promise<UserTwapRating> {
  const key = user.toLowerCase();
  const hit = ratingCache.get(key);
  if (hit && Date.now() - hit.at < RATING_CACHE_MS) return hit.rating;
  const rating = await resolveUserTwapRating(user, feedRows);
  ratingCache.set(key, { at: Date.now(), rating });
  return rating;
}

async function assertTelegramBot(): Promise<void> {
  if (DRY_RUN || !TG_TOKEN) return;
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`);
  const body = (await res.json()) as { ok?: boolean; description?: string };
  if (!body.ok) {
    console.error(
      '[hl-twap-telegram-watch] Invalid HL_TWAP_TELEGRAM_BOT_TOKEN (getMe failed):',
      body.description ?? res.status,
    );
    process.exit(1);
  }
}

async function sendTelegram(html: string): Promise<number | null> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('[hl-twap-telegram-watch] Telegram not configured');
    return null;
  }
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.warn('[hl-twap-telegram-watch] send failed', res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const body = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
  return body.result?.message_id ?? null;
}

function appendAudit(event: string, payload: unknown): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(
      AUDIT_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), event, payload })}\n`,
      'utf8',
    );
  } catch (e) {
    console.warn('[hl-twap-telegram-watch] audit write failed', String(e));
  }
}

async function announceStart(
  sig: NormalizedTwapSignal,
  feedRows: HypurrscanTwapRow[],
  _cache: HyperliquidMarketCache,
  detectSource: 'hypurrscan' | 'hl_ws' = 'hypurrscan',
  detectLagMsVal: number | null = null,
): Promise<void> {
  const plan = computeCoinEntryPlan(sig, watchState, MIN_IMPACT_PCT_HOUR);
  appendAudit('twap_start', { sig, plan, detectSource, detectLagMs: detectLagMsVal });
  markTwapOpenedNotified(watchState, sig);

  if (PAPER_ENABLED) schedulePaperAfterTelegramOpen(sig);
  if (LIVE_ENABLED) scheduleLiveAfterTelegramOpen(sig);

  if (DRY_RUN) {
    const mexc = MEXC_LINKS ? mexcFuturesUrl(sig.displaySymbol) : null;
    const userRating = await userRatingCached(sig.user, feedRows);
    const opposing = opposingActiveTwapsForCoin(watchState, sig);
    const crossingNote = buildCrossingNote({
      opposingTwaps: opposing,
      plan,
      messageLinks: watchState.telegramMessageByHash,
      telegramChatId: TG_CHAT,
    });
    const html = buildTwapStartMessage(sig, { mexcUrl: mexc, userRating, crossingNote });
    console.log('[hl-twap-telegram-watch] DRY_RUN start:\n', html.replace(/<[^>]+>/g, ''));
    return;
  }

  void deliverStartTelegram(sig, feedRows, plan).catch((e) => {
    console.warn('[hl-twap-telegram-watch] telegram start failed (trade already scheduled)', String(e));
  });
}

/** Telegram alert — does not block live/paper schedule. */
async function deliverStartTelegram(
  sig: NormalizedTwapSignal,
  feedRows: HypurrscanTwapRow[],
  plan: ReturnType<typeof computeCoinEntryPlan>,
): Promise<void> {
  const mexc = MEXC_LINKS ? mexcFuturesUrl(sig.displaySymbol) : null;
  const userRating = await userRatingCached(sig.user, feedRows);
  const opposing = opposingActiveTwapsForCoin(watchState, sig);
  const crossingNote = buildCrossingNote({
    opposingTwaps: opposing,
    plan,
    messageLinks: watchState.telegramMessageByHash,
    telegramChatId: TG_CHAT,
  });
  const html = buildTwapStartMessage(sig, { mexcUrl: mexc, userRating, crossingNote });
  const messageId = await sendTelegram(html);
  if (messageId != null) {
    watchState.telegramMessageByHash.set(sig.hash, messageId);
  }
}

function scheduleLiveAfterTelegramOpen(sig: NormalizedTwapSignal): void {
  if (!liveExchange) return;
  const { scheduled, reason } = scheduleLiveTrade(sig, watchState, LIVE_CFG);
  if (scheduled) {
    console.log(`[hl-twap-live] scheduled ${sig.side} ${sig.displaySymbol}`);
  } else if (reason !== 'already_tracked') {
    console.log(`[hl-twap-live] not scheduled ${sig.displaySymbol}: ${reason}`);
  }
}

function schedulePaperAfterTelegramOpen(sig: NormalizedTwapSignal): void {
  schedulePaperTrade(sig, watchState, MIN_IMPACT_PCT_HOUR);
}

async function closePositionsForImpactLoss(cache: HyperliquidMarketCache): Promise<void> {
  if (PAPER_ENABLED) {
    const opens = loadPaperOpensFromJournal(paperJournalPath());
    for (const pos of [...opens.values()]) {
      if (!shouldCloseForImpactLoss(pos.side, watchState, pos.coin, MIN_IMPACT_PCT_HOUR)) continue;
      const px = cache.mids.get(pos.coin) ?? cache.mids.get(pos.displaySymbol) ?? pos.entryPx;
      if (closePaperTrade({ hash: pos.hash, displaySymbol: pos.displaySymbol }, px, 'impact_edge_lost', watchState)) {
        console.log(`[hl-twap] paper closed ${pos.displaySymbol} impact edge lost`);
      }
    }
  }
  if (LIVE_ENABLED && liveExchange) {
    const opens = loadLiveOpensFromJournal(LIVE_CFG.journalPath);
    for (const pos of opens.values()) {
      if (shouldCloseForImpactLoss(pos.side, watchState, pos.coin, MIN_IMPACT_PCT_HOUR)) {
        const px =
          cache.mids.get(pos.coin) ?? cache.mids.get(pos.displaySymbol) ?? pos.avgEntryPx;
        await closeLiveTrade(pos.hash, px, 'impact_edge_lost', LIVE_CFG, liveExchange, watchState);
        console.log(`[hl-twap-live] closed ${pos.displaySymbol} impact edge lost`);
      }
    }
  }
}

async function announceEnd(
  sig: NormalizedTwapSignal,
  endedStatus: string,
  feedRows: HypurrscanTwapRow[],
): Promise<void> {
  const end = await enrichEndFromTwapHistory(sig, endedStatus);
  const userRating = await userRatingCached(sig.user, feedRows);
  const html = buildTwapEndMessage(sig, end, { userRating });
  appendAudit('twap_end', { sig, end });
  if (DRY_RUN) {
    console.log('[hl-twap-telegram-watch] DRY_RUN end:\n', html.replace(/<[^>]+>/g, ''));
    return;
  }
  await sendTelegram(html);
}

async function refreshBtcIfNeeded(): Promise<void> {
  if (!hlTwapBtcAlignedGateEnabled()) return;
  if (Date.now() - btcRefreshAt < BTC_REFRESH_MS) return;
  try {
    await refreshBtcContext(BTC_CFG);
    btcRefreshAt = Date.now();
  } catch (e) {
    console.warn('[hl-twap] btc context refresh failed', String(e));
  }
}

async function refreshMarketCacheIfNeeded(force = false): Promise<HyperliquidMarketCache> {
  if (!force && marketCache && Date.now() - marketCacheAt < META_REFRESH_MS) {
    return marketCache;
  }
  marketCache = await loadHyperliquidMarketCache();
  marketCacheAt = Date.now();
  return marketCache;
}

async function handleNewTwapSignal(
  sig: NormalizedTwapSignal,
  feedRows: HypurrscanTwapRow[],
  cache: HyperliquidMarketCache,
  detectSource: 'hypurrscan' | 'hl_ws',
  detectLagMsVal: number | null,
): Promise<void> {
  wsFeed?.addWhale(sig.user);
  const entrySide = hlTwapEntrySide(sig.user, sig.side);
  const openRows: Array<{ hash: string; whaleUser: string; coin: string; side: TwapSide }> = [];
  if (PAPER_ENABLED) openRows.push(...loadPaperOpensFromJournal(paperJournalPath()).values());
  if (LIVE_ENABLED) openRows.push(...loadLiveOpensFromJournal(LIVE_CFG.journalPath).values());
  const kept = abortWhaleExitOnRestart(watchState, sig, openRows, entrySide);
  for (const hash of kept) {
    console.log(
      `[hl-twap] whale restarted ${sig.displaySymbol} — keep position, abort delayed exit ${hash.slice(0, 12)}…`,
    );
  }
  const srcTag = detectSource === 'hl_ws' ? ' WS' : '';
  console.log(
    `[hl-twap] NEW${srcTag} ${sig.side} ${sig.displaySymbol} $${sig.notionalUsd.toFixed(0)} impact=${sig.volumeSharePct?.toFixed(2) ?? '?'}% ${sig.user.slice(0, 10)}… lag=${detectLagMsVal ?? '?'}ms`,
  );
  await announceStart(sig, feedRows, cache, detectSource, detectLagMsVal);
}

async function handleWsTwapEvent(ev: import('../hyperliquid/twap/hl-ws-types.js').HlWsTwapOpenEvent): Promise<void> {
  try {
    const cache = await refreshMarketCacheIfNeeded();
    const sig = tryAcceptWsTwap(ev, cache, watchState, wsIntegrate, {
      minVolumeSharePct: MIN_IMPACT_PCT_HOUR,
      buyOnly: BUY_ONLY,
    });
    if (!sig) return;
    const lag = detectLagMs(ev.receivedAtMs, ev.startedAtMs);
    await handleNewTwapSignal(sig, lastFeedRows, cache, 'hl_ws', lag);
  } catch (e) {
    console.warn('[hl-twap-ws] event failed', String(e));
  }
}

function startWsFeed(whales: string[]): void {
  if (!WS_ENABLED || whales.length === 0) return;
  const cfg = loadHlWsFeedConfig(whales);
  wsFeed = new HlWsTwapFeed(cfg, (ev) => {
    void handleWsTwapEvent(ev);
  });
  wsFeed.start();
}

async function runPass(cache: HyperliquidMarketCache): Promise<void> {
  await refreshBtcIfNeeded();
  const rows = await fetchHypurrscanTwapFeed();
  lastFeedRows = rows;
  for (const row of rows) {
    if (row.user) wsFeed?.addWhale(row.user);
  }
  const { newSignals, endedSignals } = detectTwapChanges(
    rows,
    (row) => normalizeHypurrscanRow(row, cache),
    watchState,
    { minVolumeSharePct: MIN_IMPACT_PCT_HOUR, buyOnly: BUY_ONLY },
  );

  for (const sig of newSignals) {
    if (absorbHypurrscanDuplicate(sig, watchState, wsIntegrate)) {
      console.log(
        `[hl-twap] hypurrscan duplicate of WS ${sig.displaySymbol} ${sig.hash.slice(0, 12)}… → local ${resolveLocalTwapHash(sig.hash, wsIntegrate).slice(0, 12)}…`,
      );
      continue;
    }
    const lag = sig.startedAtMs > 0 ? Date.now() - sig.startedAtMs : null;
    await handleNewTwapSignal(sig, rows, cache, 'hypurrscan', lag);
  }

  await closePositionsForImpactLoss(cache);

  if (PAPER_ENABLED) await processPaperTrades(cache, watchState);
  if (LIVE_ENABLED && liveExchange) {
    await processLiveTrades(cache, LIVE_CFG, liveExchange, watchState);
    await processLiveLadders(cache, LIVE_CFG, liveExchange, watchState);
    await processExchangeResiduals(cache, LIVE_CFG, liveExchange);
  }

  if (NOTIFY_ENDED) {
    for (const { signal, endedStatus } of endedSignals) {
      const localSig = withLocalTwapHash(signal, wsIntegrate);
      console.log(
        `[hl-twap] END ${localSig.displaySymbol} ${endedStatus} ${localSig.hash.slice(0, 12)}…`,
      );
      if (PAPER_ENABLED) handlePaperOnTwapEnd(localSig, cache, endedStatus, watchState);
      if (LIVE_ENABLED && liveExchange) {
        await handleLiveOnTwapEnd(localSig, cache, endedStatus, LIVE_CFG, liveExchange, watchState);
      }
      await announceEnd(localSig, endedStatus, rows);
    }
  }
}

async function main(): Promise<void> {
  if (!DRY_RUN && (!TG_TOKEN || !TG_CHAT)) {
    console.error(
      '[hl-twap-telegram-watch] Set HL_TWAP_TELEGRAM_BOT_TOKEN and HL_TWAP_TELEGRAM_CHAT_ID (or HL_TWAP_DRY_RUN=1).',
    );
    process.exit(1);
  }

  await assertTelegramBot();

  if (LIVE_ENABLED) {
    liveExchange = await createHlTwapExchangeClient(LIVE_CFG);
    console.log(
      `[hl-twap-live] enabled mode=${liveExchange.mode} margin=$${LIVE_CFG.notionalUsd} leverage=${LIVE_CFG.leverage}x (~$${LIVE_CFG.notionalUsd * LIVE_CFG.leverage}/position) ladder=±${LIVE_CFG.ladderStepPct}%/${LIVE_CFG.ladderSlicePct}% exit_slices=${LIVE_CFG.exitSlices} exit_interval_ms=${LIVE_CFG.exitSliceIntervalMs}`,
    );
  }

  console.log(
    `[hl-twap-telegram-watch] start poll=${POLL_MS}ms ws=${WS_ENABLED ? 1 : 0} ws_max=${WS_MAX_SUBS} min_impact=${MIN_IMPACT_PCT_HOUR}%/h twap_min=${twapMinMinutes()}m twap_max=${twapMaxMinutes()}m exit_early=${twapExitEarlyMinutes()}m cancel_exit_delay=${twapCancelExitDelayMinutes()}m whale_deny=${deniedWhaleAddresses().size} fade_whales=${fadeWhaleAddresses().size} btc_aligned=${hlTwapBtcAlignedGateEnabled() ? 1 : 0} btc_stale_ms=${hlTwapBtcGateMaxStaleMs()} buy_only=${BUY_ONLY} paper=${PAPER_ENABLED} live=${LIVE_ENABLED} ended=${NOTIFY_ENDED} dry=${DRY_RUN}`,
  );

  if (hlTwapBtcAlignedGateEnabled()) {
    await refreshBtcContext(BTC_CFG);
    btcRefreshAt = Date.now();
  }

  let cache = await refreshMarketCacheIfNeeded(true);

  const rows0 = await fetchHypurrscanTwapFeed();
  lastFeedRows = rows0;
  const seeded = seedTwapWatchState(
    rows0,
    (row) => normalizeHypurrscanRow(row, cache),
    watchState,
    { minVolumeSharePct: MIN_IMPACT_PCT_HOUR, buyOnly: BUY_ONLY },
  );
  console.log(`[hl-twap-telegram-watch] seeded ${seeded} active TWAP(s) (no retro alerts)`);

  if (WS_ENABLED) {
    const feedWhales = [...new Set(rows0.map((r) => r.user?.toLowerCase()).filter(Boolean) as string[])];
    const whales = mergeWhaleAddresses(loadHlWsWhaleList(), feedWhales, WS_MAX_SUBS);
    startWsFeed(whales);
    console.log(`[hl-twap-ws] subscribed ${whales.length} whale(s)`);
  }

  const loop = async (): Promise<void> => {
    try {
      cache = await refreshMarketCacheIfNeeded();
    } catch (e) {
      console.warn('[hl-twap] meta refresh failed', String(e));
    }
    try {
      await runPass(cache);
    } catch (e) {
      console.warn('[hl-twap] pass failed', String(e));
    }
    if (!ONCE) setTimeout(loop, POLL_MS);
  };

  await loop();
}

main().catch((e) => {
  console.error('[hl-twap-telegram-watch] fatal', e);
  process.exit(1);
});
