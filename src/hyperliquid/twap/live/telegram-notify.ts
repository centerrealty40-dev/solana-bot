import {
  aggregateCoinHourlyImpacts,
  activeTwapsForCoin,
  type ActiveTwapLookup,
} from '../coin-twap-analysis.js';
import {
  formatDurationRu,
  formatPctShare,
  formatUsdCompact,
  formatUsdPrice,
} from '../format-telegram.js';
import { computeTwapSchedule, formatMoscowDateTime } from '../twap-schedule.js';
import type { NormalizedTwapSignal } from '../types.js';
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
  if (reason === 'before_last_cycle') return 'таймер TWAP (legacy)';
  if (reason === 'twap_early_exit') return 'выход −10m до конца TWAP';
  if (reason === 'twap_hold_to_end') return 'удержание до ETA последнего цикла TWAP';
  if (reason === 'impact_edge_lost') return 'перекрёстный TWAP съел edge';
  if (reason.endsWith('_reconciled')) return 'позиция уже закрыта на бирже';
  if (reason.startsWith('twap_')) return reason.replace(/^twap_/, 'TWAP ').replace(/_/g, ' ');
  return reason;
}

function pnlSign(v: number): string {
  return v >= 0 ? '+' : '';
}

function twapLine(sig: NormalizedTwapSignal): string {
  const sched = computeTwapSchedule(sig);
  const side = sideLabel(sig.side);
  const dur = formatDurationRu(sig.minutes);
  const impact = formatPctShare(sig.volumeSharePct);
  const eta = formatMoscowDateTime(sched.lastCycleEtaMs);
  return `${side} ${formatUsdCompact(sig.notionalUsd)} · ${sched.cycleCount} циклов · ${dur} · impact ${impact} · до ${eta}`;
}

/** Текст уведомления об открытии live-позиции. */
export function buildLiveTradeOpenMessage(
  pos: HlTwapLiveOpen,
  _cfg: HlTwapLiveConfig,
  watchState?: ActiveTwapLookup | null,
): string {
  const sym = pos.displaySymbol;
  const dir = sideLabel(pos.side);
  const px = formatUsdPrice(pos.avgEntryPx);
  const margin = pos.marginUsd ?? pos.initialNotionalUsd;
  const lev = pos.entryLeverage ?? 1;
  const gross = pos.initialNotionalUsd;
  const ourLine =
    lev > 1
      ? `наша позиция ${formatUsdCompact(gross)} (маржа ${formatUsdCompact(margin)} · ${lev}x) @ ${px}`
      : `наша позиция ${formatUsdCompact(gross)} @ ${px}`;

  const whaleSig: NormalizedTwapSignal = {
    hash: pos.hash,
    twapId: null,
    user: pos.whaleUser,
    side: pos.side,
    coin: pos.coin,
    displaySymbol: pos.displaySymbol,
    isSpot: false,
    size: pos.whaleSize ?? 0,
    minutes: pos.minutes,
    randomize: false,
    reduceOnly: false,
    notionalUsd: pos.whaleNotionalUsd ?? 0,
    midPx: pos.avgEntryPx,
    dayNtlVlmUsd: null,
    volumeSharePct: pos.impactPct,
    startedAtMs: pos.twapStartMs,
    block: 0,
    ended: null,
  };
  const whaleSched = computeTwapSchedule(whaleSig);
  const whaleLine =
    pos.whaleNotionalUsd != null && pos.whaleNotionalUsd > 0
      ? `Кит TWAP: ${formatUsdCompact(pos.whaleNotionalUsd)} · ${whaleSched.cycleCount} циклов · ${formatDurationRu(pos.minutes)} · impact ${formatPctShare(pos.impactPct)}`
      : `Кит TWAP: ${whaleSched.cycleCount} циклов · ${formatDurationRu(pos.minutes)} · impact ${formatPctShare(pos.impactPct)}`;

  const whaleSide = pos.side === 'buy' ? 'buy TWAP' : 'sell TWAP';
  const lines = [`🟢 Открыли ${sym} ${dir} · вместе с китом (${whaleSide}) · ${ourLine}`, '', whaleLine];

  if (watchState) {
    const onCoin = activeTwapsForCoin(watchState, pos.coin);
    const others = onCoin.filter((t) => t.hash !== pos.hash);
    const { buyPctPerHour, sellPctPerHour } = aggregateCoinHourlyImpacts(onCoin);
    const delta = Math.abs(buyPctPerHour - sellPctPerHour);
    lines.push(
      `Перекрёст: long ${formatPctShare(buyPctPerHour)}%/h · short ${formatPctShare(sellPctPerHour)}%/h (Δ ${formatPctShare(delta)}%/h)`,
    );
    if (others.length === 0) {
      lines.push('Другие TWAP на монете: нет');
    } else {
      lines.push(`Другие TWAP на монете (${others.length}):`);
      for (const t of others) {
        lines.push(`  · ${twapLine(t)}`);
      }
    }
  }

  lines.push('', `Выход по таймеру: ${formatMoscowDateTime(pos.liveCloseAtMs)}`);
  return lines.join('\n');
}

/** Краткое уведомление об открытии live-позиции (отдельный канал, не whale-алерты). */
export async function notifyLiveTradeOpen(
  pos: HlTwapLiveOpen,
  cfg: HlTwapLiveConfig,
  watchState?: ActiveTwapLookup | null,
): Promise<void> {
  if (cfg.mode !== 'live') return;
  await sendLiveTradesTelegram(buildLiveTradeOpenMessage(pos, cfg, watchState));
}

/** Emergency drawdown stop — trading halted, all positions flattened. */
export async function notifyDrawdownHalt(params: {
  peakUsd: number;
  equityUsd: number;
  drawdownUsd: number;
  thresholdUsd: number;
}): Promise<void> {
  const { peakUsd, equityUsd, drawdownUsd, thresholdUsd } = params;
  const stopLevel = peakUsd - thresholdUsd;
  const msg = [
    '🛑 STOP LOSS — trading halted',
    `Drawdown $${drawdownUsd.toFixed(2)} ≥ $${thresholdUsd.toFixed(0)} (trailing peak)`,
    `Peak $${peakUsd.toFixed(2)} → equity $${equityUsd.toFixed(2)} (stop level $${stopLevel.toFixed(2)})`,
    'All HL positions flattened. New entries blocked until HL_TWAP_LIVE_DRAWDOWN_CLEAR_HALT=1 + restart.',
  ].join('\n');
  await sendLiveTradesTelegram(msg);

  const whaleToken = process.env.HL_TWAP_TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const whaleChat = process.env.HL_TWAP_TELEGRAM_CHAT_ID?.trim() ?? '';
  if (whaleToken && whaleChat) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${whaleToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: whaleChat,
          text: msg,
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        console.warn('[hl-twap-live:drawdown] whale telegram send failed', res.status);
      }
    } catch (e) {
      console.warn('[hl-twap-live:drawdown] whale telegram error', String(e));
    }
  }
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
