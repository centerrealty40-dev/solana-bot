/**
 * Throttled Telegram alerts for Birdeye tier limits and PG coverage gaps (live-oscar).
 * Pattern mirrors `notifyLiveOscarStalePrice` in papertrader/main.ts.
 */
import { sendTagged } from '../core/telegram/sender.js';
import { gmgnMintHrefHtml } from '../papertrader/discovery/near-ready-dip-watch.js';
import type { BirdeyeFetchErrorKind } from '../papertrader/pricing/birdeye-market.js';

function escapeHtmlPlain(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const tierLastMs = new Map<string, number>();
const coverageGapLastMs = new Map<string, number>();

function birdeyeTelegramEnabled(): boolean {
  return process.env.BIRDEYE_TELEGRAM_ENABLED === '1';
}

function resolveToken(): string | undefined {
  return (
    process.env.BIRDEYE_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.LIVE_OSCAR_STALE_PRICE_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    undefined
  );
}

function resolveChat(): string | undefined {
  return (
    process.env.BIRDEYE_TELEGRAM_CHAT_ID?.trim() ||
    process.env.LIVE_OSCAR_STALE_PRICE_TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    '-1003878024799'
  );
}

function tierCooldownMs(): number {
  return Math.max(0, Number(process.env.BIRDEYE_TELEGRAM_TIER_COOLDOWN_MS ?? 30 * 60_000));
}

function coverageGapCooldownMs(): number {
  return Math.max(0, Number(process.env.BIRDEYE_TELEGRAM_COVERAGE_GAP_COOLDOWN_MS ?? 30 * 60_000));
}

function shouldFire(cache: Map<string, number>, key: string, cooldownMs: number): boolean {
  const now = Date.now();
  const prev = cache.get(key) ?? 0;
  if (cooldownMs > 0 && now - prev < cooldownMs) return false;
  cache.set(key, now);
  return true;
}

function tierLabelRu(kind: BirdeyeFetchErrorKind | undefined): string {
  switch (kind) {
    case 'rate_limit':
      return 'rate limit (429)';
    case 'quota':
      return 'CU / quota';
    case 'auth':
      return 'auth / tier';
    default:
      return 'лимит API';
  }
}

export function notifyBirdeyeTierInsufficient(args: {
  mint: string;
  lane?: string;
  errorKind?: BirdeyeFetchErrorKind;
  message?: string;
  surface?: 'discovery' | 'mtm' | 'collector';
}): void {
  if (!birdeyeTelegramEnabled()) return;
  const key = `tier:${args.surface ?? 'any'}:${args.errorKind ?? 'quota'}`;
  if (!shouldFire(tierLastMs, key, tierCooldownMs())) return;

  const token = resolveToken();
  const chat = resolveChat();
  if (!token || !chat) return;

  const kindRu = tierLabelRu(args.errorKind);
  const surfaceRu =
    args.surface === 'mtm'
      ? 'MTM (открытая позиция)'
      : args.surface === 'collector'
        ? 'коллектор snapshots'
        : 'discovery eval';
  const text =
    `<b>Birdeye Lite — лимит тарифа</b>\n` +
    `<i>Birdeye Lite tier limit — upgrade recommended</i>\n\n` +
    `Причина: <b>${escapeHtmlPlain(kindRu)}</b>\n` +
    `Контекст: ${escapeHtmlPlain(surfaceRu)}\n` +
    `Mint: ${gmgnMintHrefHtml(args.mint, args.mint.slice(0, 8) + '…')}\n` +
    (args.lane ? `Lane: <code>${escapeHtmlPlain(args.lane)}</code>\n` : '') +
    `→ Нужен апгрейд Birdeye (Business+) или снизить частоту запросов.\n` +
    (args.message ? `Detail: <code>${escapeHtmlPlain(args.message.slice(0, 120))}</code>` : '');

  void sendTagged('ALERT', 'birdeye_tier_insufficient', text, {
    parseMode: 'HTML',
    skipQuietHours: true,
    telegramBotToken: token,
    telegramChatId: chat,
  }).catch(() => {
    /* best-effort */
  });
}

export function notifyBirdeyeCoverageGap(args: {
  mint: string;
  lane?: string;
  pgSnapshotAgeMs: number;
  coverageGapMinMs: number;
  resolvedSource: string;
  surface?: 'discovery' | 'mtm';
}): void {
  if (!birdeyeTelegramEnabled()) return;
  const key = `gap:${args.mint}`;
  if (!shouldFire(coverageGapLastMs, key, coverageGapCooldownMs())) return;

  const token = resolveToken();
  const chat = resolveChat();
  if (!token || !chat) return;

  const ageMin = (args.pgSnapshotAgeMs / 60_000).toFixed(1);
  const thrMin = (args.coverageGapMinMs / 60_000).toFixed(0);
  const surfaceRu = args.surface === 'mtm' ? 'MTM' : 'discovery';
  const text =
    `<b>Birdeye — coverage gap</b>\n` +
    `PG snapshot устарел (<b>${escapeHtmlPlain(ageMin)} min</b>, порог ${escapeHtmlPlain(thrMin)} min), ` +
    `Birdeye/DexScreener не дали свежую цену.\n` +
    `Контекст: ${escapeHtmlPlain(surfaceRu)}\n` +
    `Mint: ${gmgnMintHrefHtml(args.mint, args.mint.slice(0, 8) + '…')}\n` +
    (args.lane ? `Lane: <code>${escapeHtmlPlain(args.lane)}</code>\n` : '') +
    `Source: <code>${escapeHtmlPlain(args.resolvedSource)}</code>`;

  void sendTagged('ALERT', 'birdeye_coverage_gap', text, {
    parseMode: 'HTML',
    skipQuietHours: true,
    telegramBotToken: token,
    telegramChatId: chat,
  }).catch(() => {
    /* best-effort */
  });
}

/** Route journal/audit rows to Telegram when kind matches. */
export function handleBirdeyeObservabilityTelegram(row: Record<string, unknown>): void {
  const kind = row.kind;
  if (kind === 'birdeye_tier_insufficient') {
    notifyBirdeyeTierInsufficient({
      mint: String(row.mint ?? ''),
      lane: row.lane != null ? String(row.lane) : undefined,
      errorKind: row.errorKind as BirdeyeFetchErrorKind | undefined,
      message: row.message != null ? String(row.message) : undefined,
      surface: 'discovery',
    });
  } else if (kind === 'birdeye_coverage_gap') {
    notifyBirdeyeCoverageGap({
      mint: String(row.mint ?? ''),
      lane: row.lane != null ? String(row.lane) : undefined,
      pgSnapshotAgeMs: Number(row.pgSnapshotAgeMs ?? 0),
      coverageGapMinMs: Number(row.coverageGapMinMs ?? 0),
      resolvedSource: String(row.resolvedSource ?? 'pg_snapshot'),
      surface: 'discovery',
    });
  }
}

/** Test-only reset. */
export function __resetBirdeyeTelegramCooldownsForTests(): void {
  tierLastMs.clear();
  coverageGapLastMs.clear();
}
