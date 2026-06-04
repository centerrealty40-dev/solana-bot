/**
 * Hyperliquid TWAP → Telegram. Единственный фильтр: price impact (% от 24h perp volume).
 *
 * Data source: HypurrScan L1 indexer `GET https://api.hypurrscan.io/twap/*`
 *
 * Pricing / impact: Hyperliquid `meta`, `spotMeta`, `allMids`, `metaAndAssetCtxs` (dayNtlVlm).
 *
 * Env (separate bot — do not reuse Live Oscar TELEGRAM_*):
 * - HL_TWAP_TELEGRAM_BOT_TOKEN / HL_TWAP_TELEGRAM_CHAT_ID
 * - HL_TWAP_POLL_INTERVAL_MS=5000
 * - HL_TWAP_MIN_VOLUME_SHARE_PCT=1 — price impact (notional / dayNtlVlm × 100)
 * - HL_TWAP_PAPER_NOTIONAL_USD=1000 — бумажная нота на сигнал (плитка 3 дашборда)
 * - HL_TWAP_NOTIFY_ENDED=1
 * - HL_TWAP_META_REFRESH_MS=120000
 * - HL_TWAP_DRY_RUN=0
 * - HL_TWAP_AUDIT_JSONL=path (optional, default data/hl-twap/signals.jsonl)
 * - HL_TWAP_MEXC_LINKS=1 — append MEXC perp URL when symbol known
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
  buildTwapEndMessage,
  buildTwapStartMessage,
  mexcFuturesUrl,
} from '../hyperliquid/twap/format-telegram.js';
import { fetchHypurrscanTwapFeed } from '../hyperliquid/twap/hypurrscan.js';
import { loadHyperliquidMarketCache, type HyperliquidMarketCache } from '../hyperliquid/twap/hyperliquid-meta.js';
import { normalizeHypurrscanRow } from '../hyperliquid/twap/normalize.js';
import { enrichEndFromTwapHistory } from '../hyperliquid/twap/twap-history.js';
import {
  closePaperTrade,
  exitPxForOpen,
  loadPaperOpensFromJournal,
  openPaperTrade,
  paperJournalPath,
} from '../hyperliquid/twap/paper-trader.js';
import { resolveUserTwapRating, type UserTwapRating } from '../hyperliquid/twap/user-rating.js';
import type { HypurrscanTwapRow, NormalizedTwapSignal } from '../hyperliquid/twap/types.js';

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

const POLL_MS = Math.max(2000, envNum('HL_TWAP_POLL_INTERVAL_MS', 5000));
const META_REFRESH_MS = Math.max(30_000, envNum('HL_TWAP_META_REFRESH_MS', 120_000));
const MIN_VOLUME_SHARE_PCT = Math.max(0, envNum('HL_TWAP_MIN_VOLUME_SHARE_PCT', 1));
const PAPER_ENABLED = envBool('HL_TWAP_PAPER_ENABLED', true);
const NOTIFY_ENDED = envBool('HL_TWAP_NOTIFY_ENDED', true);
const DRY_RUN = envBool('HL_TWAP_DRY_RUN', false);
const MEXC_LINKS = envBool('HL_TWAP_MEXC_LINKS', true);
const ONCE = process.argv.includes('--once');

const TG_TOKEN = process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() ?? '';
const TG_CHAT = process.env.HL_TWAP_TELEGRAM_CHAT_ID?.trim() ?? '';
const AUDIT_PATH =
  process.env.HL_TWAP_AUDIT_JSONL?.trim() ||
  path.join(process.cwd(), 'data', 'hl-twap', 'signals.jsonl');
const RATING_CACHE_MS = Math.max(60_000, envNum('HL_TWAP_USER_RATING_CACHE_MS', 300_000));

const ratingCache = new Map<string, { at: number; rating: UserTwapRating }>();
const watchState = createTwapWatchState();

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

async function sendTelegram(html: string): Promise<boolean> {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn('[hl-twap-telegram-watch] Telegram not configured');
    return false;
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
    return false;
  }
  return true;
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

async function announceStart(sig: NormalizedTwapSignal, feedRows: HypurrscanTwapRow[]): Promise<void> {
  const mexc = MEXC_LINKS ? mexcFuturesUrl(sig.displaySymbol) : null;
  const userRating = await userRatingCached(sig.user, feedRows);
  const html = buildTwapStartMessage(sig, { mexcUrl: mexc, userRating });
  appendAudit('twap_start', sig);
  if (DRY_RUN) {
    console.log('[hl-twap-telegram-watch] DRY_RUN start:\n', html.replace(/<[^>]+>/g, ''));
    markTwapOpenedNotified(watchState, sig.hash);
    return;
  }
  const ok = await sendTelegram(html);
  if (ok) markTwapOpenedNotified(watchState, sig.hash);
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

async function runPass(cache: HyperliquidMarketCache): Promise<void> {
  const rows = await fetchHypurrscanTwapFeed();
  const { newSignals, endedSignals } = detectTwapChanges(
    rows,
    (row) => normalizeHypurrscanRow(row, cache),
    watchState,
    { minVolumeSharePct: MIN_VOLUME_SHARE_PCT },
  );

  for (const sig of newSignals) {
    console.log(
      `[hl-twap] NEW ${sig.side} ${sig.displaySymbol} $${sig.notionalUsd.toFixed(0)} impact=${sig.volumeSharePct?.toFixed(2) ?? '?'}% ${sig.user.slice(0, 10)}…`,
    );
    if (PAPER_ENABLED) openPaperTrade(sig);
    await announceStart(sig, rows);
  }

  if (NOTIFY_ENDED) {
    for (const { signal, endedStatus } of endedSignals) {
      console.log(`[hl-twap] END ${signal.displaySymbol} ${endedStatus} ${signal.hash.slice(0, 12)}…`);
      if (PAPER_ENABLED) {
        const opens = loadPaperOpensFromJournal(paperJournalPath());
        if (opens.has(signal.hash)) {
          const px = exitPxForOpen(opens.get(signal.hash)!, cache);
          closePaperTrade(signal, px, `twap_${endedStatus}`);
        }
      }
      await announceEnd(signal, endedStatus, rows);
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

  console.log(
    `[hl-twap-telegram-watch] start poll=${POLL_MS}ms min_impact=${MIN_VOLUME_SHARE_PCT}% paper=${PAPER_ENABLED} ended=${NOTIFY_ENDED} dry=${DRY_RUN}`,
  );

  let cache = await loadHyperliquidMarketCache();
  let cacheAt = Date.now();

  const rows0 = await fetchHypurrscanTwapFeed();
  const seeded = seedTwapWatchState(
    rows0,
    (row) => normalizeHypurrscanRow(row, cache),
    watchState,
    { minVolumeSharePct: MIN_VOLUME_SHARE_PCT },
  );
  console.log(`[hl-twap-telegram-watch] seeded ${seeded} active TWAP(s) (no retro alerts)`);

  const loop = async (): Promise<void> => {
    if (Date.now() - cacheAt >= META_REFRESH_MS) {
      try {
        cache = await loadHyperliquidMarketCache();
        cacheAt = Date.now();
      } catch (e) {
        console.warn('[hl-twap] meta refresh failed', String(e));
      }
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
