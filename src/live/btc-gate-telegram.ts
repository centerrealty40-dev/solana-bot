/**
 * Telegram (dips / whitelist channel): edge alerts when BTC gate blocks or clears new buys.
 */
import { sendTagged, type TelegramCategory } from '../core/telegram/sender.js';
import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { resolveLiveBtcGateStatus, type LiveBtcGateStatus } from './btc-gate.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';

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
  return 'ALERT';
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

function blockReasonLabel(limit: Extract<LiveBtcGateStatus, { kind: 'blocked' }>['limit']): string {
  switch (limit) {
    case 'btc_dump_1h':
      return 'просадка за 1ч';
    case 'btc_dump_4h':
      return 'просадка за 4ч';
    case 'btc_dump_24h':
      return 'просадка за 24ч';
    case 'btc_dump_72h':
      return 'просадка за 72ч';
    case 'btc_dump_peak_72h':
      return 'просадка от пика 72ч';
    default:
      return limit;
  }
}

function blockAlertText(status: Extract<LiveBtcGateStatus, { kind: 'blocked' }>): string {
  return (
    `Live Oscar: покупки новых монет (buy_open) приостановлены из-за падения Bitcoin.\n` +
    `Триггер: ${blockReasonLabel(status.limit)} (Binance BTCUSDT, порог −${status.blockAtDrawdownPct}%).\n` +
    `BTC ret1h: ${fmtPct(status.ret1h_pct)} | ret4h: ${fmtPct(status.ret4h_pct)} | ret24h: ${fmtPct(status.ret24h_pct)} | ret72h: ${fmtPct(status.ret72h_pct)} | от пика 72ч: ${fmtPct(status.retPeak72hDrawdown_pct)}\n` +
    `Discovery и оценка кандидатов продолжаются; блокируется только открытие новых позиций.\n` +
    `DCA и вторая нога сплита по уже открытым mint не блокируются.\n` +
    `Сообщение о возобновлении придёт, когда BTC снова выше порогов.`
  );
}

function clearAlertText(status: Extract<LiveBtcGateStatus, { kind: 'ok' }>): string {
  return (
    `Live Oscar: стратегия возобновила оценку и покупки новых монет — препятствий со стороны Bitcoin больше нет.\n` +
    `BTC ret1h: ${fmtPct(status.ret1h_pct)} | ret4h: ${fmtPct(status.ret4h_pct)} | ret24h: ${fmtPct(status.ret24h_pct)} | ret72h: ${fmtPct(status.ret72h_pct)} | от пика 72ч: ${fmtPct(status.retPeak72hDrawdown_pct)}`
  );
}

function journalBtcGateTelegram(
  tag: 'live_btc_gate_block' | 'live_btc_gate_clear',
  status: LiveBtcGateStatus,
  telegramOk: boolean,
): void {
  if (status.kind !== 'blocked' && status.kind !== 'ok') return;
  appendLiveJsonlEvent({
    kind: 'risk_note',
    reason: tag,
    detail: {
      telegramOk,
      ...(status.kind === 'blocked'
        ? {
            limit: status.limit,
            blockAtDrawdownPct: status.blockAtDrawdownPct,
            ret1h_pct: status.ret1h_pct,
            ret4h_pct: status.ret4h_pct,
            ret24h_pct: status.ret24h_pct,
            ret72h_pct: status.ret72h_pct,
            retPeak72hDrawdown_pct: status.retPeak72hDrawdown_pct,
          }
        : {
            ret1h_pct: status.ret1h_pct,
            ret4h_pct: status.ret4h_pct,
            ret24h_pct: status.ret24h_pct,
            ret72h_pct: status.ret72h_pct,
            retPeak72hDrawdown_pct: status.retPeak72hDrawdown_pct,
          }),
    },
  });
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
        journalBtcGateTelegram('live_btc_gate_block', status, ok);
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
        journalBtcGateTelegram('live_btc_gate_clear', status, ok);
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
