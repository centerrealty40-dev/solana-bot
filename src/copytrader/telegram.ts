import type { CopyTraderConfig } from './config.js';
import {
  copyTraderOpsAlertsEnabled,
  copyTraderTelegramEnabled,
  copyTraderTradePingsEnabled,
} from './config.js';

export async function notifyCopyTraderTelegram(
  cfg: CopyTraderConfig,
  text: string,
): Promise<void> {
  if (!copyTraderTelegramEnabled(cfg)) return;
  const token = cfg.telegramBotToken!;
  const chatId = cfg.telegramChatId!;

  const send = async (markdown: boolean): Promise<{ ok: boolean; status: number; body: string }> => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(markdown ? { parse_mode: 'Markdown' } : {}),
        disable_web_page_preview: true,
      }),
    });
    return { ok: res.ok, status: res.status, body: res.ok ? '' : (await res.text()).slice(0, 300) };
  };

  try {
    const first = await send(true);
    if (first.ok) return;
    /**
     * Token symbols are arbitrary strings and routinely contain `_`, `*` or backticks,
     * which Telegram rejects as broken markup. Losing the alert matters more than losing
     * the formatting, so retry once as plain text.
     */
    if (first.status === 400) {
      const plain = await send(false);
      if (plain.ok) return;
      console.warn('[copy-trader] telegram send failed', plain.status, plain.body);
      return;
    }
    console.warn('[copy-trader] telegram send failed', first.status, first.body);
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

/** Routine fill / queue chatter — off by default (ops alerts only). */
export async function notifyCopyTradePing(cfg: CopyTraderConfig, text: string): Promise<void> {
  if (!copyTraderTradePingsEnabled()) return;
  await notifyCopyTraderTelegram(cfg, text);
}

/** Serious operational failures only. */
export async function notifyCopyOpsAlert(cfg: CopyTraderConfig, text: string): Promise<void> {
  if (!copyTraderOpsAlertsEnabled(cfg)) return;
  await notifyCopyTraderTelegram(cfg, text);
}
