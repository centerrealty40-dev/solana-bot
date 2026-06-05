import { formatUsdPrice } from '../format-telegram.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapLiveClose, HlTwapLiveOpen } from './types.js';

type LiveTradesTelegramConfig = {
  token: string;
  chatId: string;
};

function loadLiveTradesTelegram(): LiveTradesTelegramConfig | null {
  const token = process.env.HL_TWAP_LIVE_TRADES_TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const chatId = process.env.HL_TWAP_LIVE_TRADES_TELEGRAM_CHAT_ID?.trim() ?? '';
  if (!token || !chatId) return null;
  return { token, chatId };
}

async function sendLiveTradesTelegram(text: string): Promise<void> {
  const cfg = loadLiveTradesTelegram();
  if (!cfg) return;
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.warn(
        '[hl-twap-live:telegram]',
        'send failed',
        res.status,
        (await res.text()).slice(0, 200),
      );
    }
  } catch (e) {
    console.warn('[hl-twap-live:telegram] send error', String(e));
  }
}

function sideLabel(side: 'buy' | 'sell'): string {
  return side === 'buy' ? 'LONG' : 'SHORT';
}

function closeReasonRu(reason: string): string {
  if (reason === 'before_last_cycle') return 'таймер TWAP';
  if (reason.startsWith('twap_')) return reason.replace(/^twap_/, 'TWAP ').replace(/_/g, ' ');
  return reason;
}

function pnlSign(v: number): string {
  return v >= 0 ? '+' : '';
}

/** Краткое уведомление об открытии live-позиции (отдельный канал, не whale-алерты). */
export async function notifyLiveTradeOpen(
  pos: HlTwapLiveOpen,
  cfg: HlTwapLiveConfig,
): Promise<void> {
  if (cfg.mode !== 'live') return;
  const sym = pos.displaySymbol;
  const dir = sideLabel(pos.side);
  const px = formatUsdPrice(pos.avgEntryPx);
  const notional = pos.initialNotionalUsd.toFixed(0);
  await sendLiveTradesTelegram(
    `🟢 Открыли ${sym} ${dir} $${notional} @ ${px}`,
  );
}

/** Краткое уведомление о закрытии live-позиции с PnL. */
export async function notifyLiveTradeClose(
  close: HlTwapLiveClose,
  cfg: HlTwapLiveConfig,
): Promise<void> {
  if (cfg.mode !== 'live') return;
  const sym = close.displaySymbol;
  const dir = sideLabel(close.side);
  const pnlUsd = close.pnlUsd;
  const pnlPct = close.pnlPct;
  const reason = closeReasonRu(close.exitReason);
  await sendLiveTradesTelegram(
    `🔴 Закрыли ${sym} ${dir} · PnL ${pnlSign(pnlUsd)}$${pnlUsd.toFixed(2)} (${pnlSign(pnlPct)}${pnlPct.toFixed(2)}%) · ${reason}`,
  );
}
