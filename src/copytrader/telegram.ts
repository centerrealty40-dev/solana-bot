import type { CopyTraderConfig } from './config.js';
import { copyTraderTelegramEnabled } from './config.js';

export async function notifyCopyTraderTelegram(
  cfg: CopyTraderConfig,
  text: string,
): Promise<void> {
  if (!copyTraderTelegramEnabled(cfg)) return;
  const token = cfg.telegramBotToken!;
  const chatId = cfg.telegramChatId!;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.warn('[copy-trader] telegram send failed', res.status);
    }
  } catch (err) {
    console.warn('[copy-trader] telegram error', (err as Error).message);
  }
}

export function fmtCopyAlert(args: {
  action: 'leader_buy' | 'leader_sell' | 'our_buy' | 'our_sell' | 'skip';
  mint: string;
  symbol: string;
  wallet: string;
  priceUsd?: number;
  detail?: string;
}): string {
  const short = (s: string) => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
  const lines = [
    `*Copy-trader* · ${args.action}`,
    `${args.symbol} (\`${short(args.mint)}\`)`,
    `Leader: \`${short(args.wallet)}\``,
  ];
  if (args.priceUsd && args.priceUsd > 0) lines.push(`Price: $${args.priceUsd.toPrecision(4)}`);
  if (args.detail) lines.push(args.detail);
  return lines.join('\n');
}
