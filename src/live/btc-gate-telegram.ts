/**
 * Telegram (dips / whitelist channel): edge alerts when BTC gate blocks or clears new buys.
 */
import { sendTagged, type TelegramCategory } from '../core/telegram/sender.js';
import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { resolveLiveBtcGateStatus, type LiveBtcGateStatus } from './btc-gate.js';

const log = child('live-btc-gate-telegram');

type TelegramPhase = 'blocked' | 'ok' | 'stale' | 'disabled';

let lastTelegramPhase: TelegramPhase | null = null;
let inFlight = false;

function btcGateTelegramEnabled(): boolean {
  const s = process.env.LIVE_BTC_GATE_TELEGRAM_ENABLED?.trim();
  return s !== '0' && s !== 'false';
}

function btcGateTelegramCategory(): TelegramCategory {
  const s = process.env.LIVE_BTC_GATE_TELEGRAM_CATEGORY?.trim().toUpperCase();
  if (s === 'ALERT' || s === 'REPORT' || s === 'ADVICE' || s === 'HEALTH') return s;
  const wl = process.env.LIVE_MINT_WHITELIST_TELEGRAM_CATEGORY?.trim().toUpperCase();
  if (wl === 'ALERT' || wl === 'REPORT' || wl === 'ADVICE' || wl === 'HEALTH') return wl;
  return 'ADVICE';
}

/** Same bot/chat as `live_whitelist_miss` (dips channel) unless overridden. */
function btcGateTelegramOpts(): {
  telegramBotToken?: string;
  telegramChatId?: string;
  skipQuietHours: boolean;
} {
  const token =
    process.env.LIVE_BTC_GATE_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim();
  const chatId =
    process.env.LIVE_BTC_GATE_TELEGRAM_CHAT_ID?.trim() ||
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

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function statusToPhase(status: LiveBtcGateStatus): TelegramPhase {
  if (status.kind === 'blocked') return 'blocked';
  if (status.kind === 'ok') return 'ok';
  if (status.kind === 'stale') return 'stale';
  return 'disabled';
}

function blockAlertText(status: Extract<LiveBtcGateStatus, { kind: 'blocked' }>): string {
  const window =
    status.limit === 'btc_dump_1h'
      ? `1 час (порог −${status.blockAtDrawdownPct}%)`
      : `4 часа (порог −${status.blockAtDrawdownPct}%)`;
  return (
    `Новые позиции (buy_open) не открываются: Bitcoin в просадке.\n` +
    `Причина: ${status.limit === 'btc_dump_1h' ? 'просадка за 1ч' : 'просадка за 4ч'} (Binance BTCUSDT).\n` +
    `Окно: ${window}\n` +
    `BTC ret1h: ${fmtPct(status.ret1h_pct)} | ret4h: ${fmtPct(status.ret4h_pct)}\n` +
    `Вторая нога сплита и staged-усреднение по уже открытым mint — не блокируются этим гейтом.\n` +
    `Снимется автоматически, когда ret1h/ret4h снова выше порогов (обновление ~каждые 5 мин).`
  );
}

function clearAlertText(status: Extract<LiveBtcGateStatus, { kind: 'ok' }>): string {
  return (
    `BTC gate снят — снова можно открывать новые позиции (buy_open).\n` +
    `BTC ret1h: ${fmtPct(status.ret1h_pct)} | ret4h: ${fmtPct(status.ret4h_pct)}`
  );
}

/** Edge-triggered Telegram; safe to call every heartbeat / buy attempt. */
export function tickLiveBtcGateTelegram(liveCfg: LiveOscarConfig): void {
  if (!btcGateTelegramEnabled()) return;
  const opts = btcGateTelegramOpts();
  if (!opts.telegramBotToken || !opts.telegramChatId) return;

  const status = resolveLiveBtcGateStatus(liveCfg);
  const phase = statusToPhase(status);
  if (phase === lastTelegramPhase) return;
  if (inFlight) return;

  const prev = lastTelegramPhase;
  if (phase === 'blocked' && prev !== 'blocked') {
    if (status.kind !== 'blocked') return;
    inFlight = true;
    void (async () => {
      try {
        const ok = await sendTagged(
          btcGateTelegramCategory(),
          'live_btc_gate_block',
          blockAlertText(status),
          opts,
        );
        log.info({ limit: status.limit, ok }, 'live_btc_gate_block telegram');
        if (ok) lastTelegramPhase = 'blocked';
      } catch (e) {
        log.warn({ err: String(e) }, 'live_btc_gate_block telegram failed');
      } finally {
        inFlight = false;
      }
    })();
    return;
  }

  if (phase === 'ok' && prev === 'blocked' && status.kind === 'ok') {
    inFlight = true;
    void (async () => {
      try {
        const ok = await sendTagged(
          btcGateTelegramCategory(),
          'live_btc_gate_clear',
          clearAlertText(status),
          opts,
        );
        log.info({ ok }, 'live_btc_gate_clear telegram');
        if (ok) lastTelegramPhase = 'ok';
      } catch (e) {
        log.warn({ err: String(e) }, 'live_btc_gate_clear telegram failed');
      } finally {
        inFlight = false;
      }
    })();
    return;
  }

  if (phase === 'disabled' || phase === 'stale') {
    lastTelegramPhase = phase;
    return;
  }

  if (phase === 'ok' && prev !== 'blocked') {
    lastTelegramPhase = 'ok';
  }
}

/** For tests. */
export function resetLiveBtcGateTelegramState(): void {
  lastTelegramPhase = null;
  inFlight = false;
}
