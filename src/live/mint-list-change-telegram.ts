/**
 * Telegram перед добавлением mint в permanent denylist или manual blacklist.
 */
import { sendTagged, type TelegramCategory } from '../core/telegram/sender.js';
import { child } from '../core/logger.js';

const log = child('live-mint-list-change-telegram');

export type MintListKind = 'denylist' | 'blacklist';

function gmgnSolTokenUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${mint}`;
}

function listChangeTelegramEnabled(): boolean {
  const s = process.env.LIVE_MINT_LIST_CHANGE_TELEGRAM_ENABLED?.trim();
  if (s === '0' || s === 'false') return false;
  return true;
}

function listChangeTelegramCategory(): TelegramCategory {
  const s = process.env.LIVE_MINT_LIST_CHANGE_TELEGRAM_CATEGORY?.trim().toUpperCase();
  if (s === 'ALERT' || s === 'REPORT' || s === 'ADVICE' || s === 'HEALTH') return s;
  return 'ALERT';
}

function listChangeTelegramOpts(): {
  telegramBotToken?: string;
  telegramChatId?: string;
  skipQuietHours: boolean;
} {
  const token =
    process.env.LIVE_MINT_LIST_CHANGE_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim();
  const chatId =
    process.env.LIVE_MINT_LIST_CHANGE_TELEGRAM_CHAT_ID?.trim() ||
    process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim();
  const o: {
    telegramBotToken?: string;
    telegramChatId?: string;
    skipQuietHours: boolean;
  } = { skipQuietHours: true };
  if (token) o.telegramBotToken = token;
  if (chatId) o.telegramChatId = chatId;
  return o;
}

function listLabel(kind: MintListKind): string {
  return kind === 'denylist' ? 'permanent denylist' : 'mint blacklist';
}

function alertText(args: {
  kind: MintListKind;
  mint: string;
  symbol?: string;
  reason: string;
  targetPath: string;
}): string {
  const sym = args.symbol?.trim() || '?';
  const list = listLabel(args.kind);
  return (
    `Сейчас добавляем монету в ${list} — новые buy_open будут заблокированы.\n` +
    `symbol: ${sym}\n` +
    `mint: ${args.mint}\n` +
    `причина: ${args.reason}\n` +
    `файл: ${args.targetPath}\n` +
    `Чтобы отменить — удалите строку с mint из файла до следующего reload.\n` +
    `GMGN: ${gmgnSolTokenUrl(args.mint)}`
  );
}

/** Fire-and-forget: вызывать непосредственно перед записью в файл. */
export function fireMintListChangeTelegramBefore(args: {
  kind: MintListKind;
  mint: string;
  symbol?: string;
  reason: string;
  targetPath: string;
}): void {
  if (!listChangeTelegramEnabled()) return;
  const opts = listChangeTelegramOpts();
  if (!opts.telegramBotToken || !opts.telegramChatId) {
    log.warn({ kind: args.kind, mint: args.mint.slice(0, 12) }, 'mint list change telegram skipped: no token/chat');
    return;
  }
  const tag = args.kind === 'denylist' ? 'live_mint_denylist_add' : 'live_mint_blacklist_add';
  void (async () => {
    try {
      const ok = await sendTagged(
        listChangeTelegramCategory(),
        tag,
        alertText(args),
        opts,
      );
      log.info({ kind: args.kind, mint: args.mint.slice(0, 12), ok }, 'mint list change telegram');
    } catch (e) {
      log.warn({ err: String(e), kind: args.kind }, 'mint list change telegram failed');
    }
  })();
}
