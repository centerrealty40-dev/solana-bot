import { request } from 'undici';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';

const log = child('telegram');

/**
 * Best-effort Telegram alert. No-ops when bot token / chat id are missing.
 * Used by live executor for trade alerts and kill-switch trips.
 */
export async function sendTelegram(text: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (res.statusCode !== 200) {
      log.warn({ status: res.statusCode }, 'telegram non-200');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'telegram send failed');
  }
}
