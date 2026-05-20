/** Operator ADVICE/health channel — canonical fallback when env omits chat id. */
export const OPERATOR_TELEGRAM_CHAT_ID = '-1003878024799';

export function resolveOperatorTelegramChatId(explicit?: string | null): string {
  return (
    explicit?.trim() ||
    process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    OPERATOR_TELEGRAM_CHAT_ID
  );
}

export function resolveOperatorTelegramBotToken(fallbackEnvKey = 'TELEGRAM_BOT_TOKEN'): string {
  const chat = resolveOperatorTelegramChatId();
  const wl = process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim();
  const main = process.env[fallbackEnvKey]?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (
    chat === OPERATOR_TELEGRAM_CHAT_ID ||
    chat === process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim()
  ) {
    return wl || main || '';
  }
  return main || wl || '';
}
