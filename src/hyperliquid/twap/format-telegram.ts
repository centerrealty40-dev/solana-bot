import { formatUserRatingLineRu, type UserTwapRating } from './user-rating.js';
import type { NormalizedTwapSignal } from './types.js';

export function shortAddress(addr: string): string {
  const a = addr.toLowerCase();
  if (a.length < 10) return a;
  return `#${a.slice(-10)}`;
}

export function formatDurationRu(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '?';
  if (minutes < 60) return `${minutes} ${pluralMin(minutes)}`;
  const hours = minutes / 60;
  if (Math.abs(hours - Math.round(hours)) < 0.01) {
    const h = Math.round(hours);
    return `${h} ${pluralHour(h)}`;
  }
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${pluralHour(rounded)}`;
}

function pluralMin(n: number): string {
  const m = Math.abs(Math.round(n)) % 100;
  const m10 = m % 10;
  if (m10 === 1 && m !== 11) return 'минуту';
  if (m10 >= 2 && m10 <= 4 && (m < 10 || m >= 20)) return 'минуты';
  return 'минут';
}

function pluralHour(n: number): string {
  const h = Math.abs(Math.round(n)) % 100;
  const h10 = h % 10;
  if (h10 === 1 && h !== 11) return 'час';
  if (h10 >= 2 && h10 <= 4 && (h < 10 || h >= 20)) return 'часа';
  return 'часов';
}

export function formatUsdCompact(v: number): string {
  if (!Number.isFinite(v)) return '?';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

export function formatUsdPrice(px: number): string {
  if (!Number.isFinite(px) || px <= 0) return '?';
  if (px >= 100) return `$${px.toFixed(2)}`;
  if (px >= 1) return `$${px.toFixed(4)}`;
  return `$${px.toFixed(6)}`;
}

export function formatPctShare(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '?';
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}

function sideEmoji(side: NormalizedTwapSignal['side']): string {
  return side === 'buy' ? '🟩' : '🟥';
}

function sideVerbRu(side: NormalizedTwapSignal['side']): string {
  return side === 'buy' ? 'покупка' : 'продажа';
}

export function buildTwapStartMessage(
  sig: NormalizedTwapSignal,
  opts?: { mexcUrl?: string | null; userRating?: UserTwapRating | null },
): string {
  const sym = sig.displaySymbol;
  const mexcLine = opts?.mexcUrl ? ` (${opts.mexcUrl})` : '';
  const volLine =
    sig.dayNtlVlmUsd != null
      ? `Объем: ${formatUsdCompact(sig.dayNtlVlmUsd)} (${formatPctShare(sig.volumeSharePct)})`
      : `Объем: n/a`;

  const lines = [
    `${sideEmoji(sig.side)} ${formatUsdCompact(sig.notionalUsd)} ${sideVerbRu(sig.side)} <b>${escapeHtml(sym)}</b>${mexcLine} в течении ${formatDurationRu(sig.minutes)}`,
    '',
    `Цена: ${formatUsdPrice(sig.midPx)}`,
    volLine,
    `Субъект: <code>${sig.user}</code> ${shortAddress(sig.user)}`,
    opts?.userRating ? formatUserRatingLineRu(opts.userRating) : '',
    `Создан в: ${formatUtcTime(sig.startedAtMs)}`,
    '',
    `🔗 <a href="${explorerTxUrl(sig.hash)}">Explorer</a> · <a href="${hypurrscanAddressUrl(sig.user)}">Hypurrscan</a>`,
  ];
  return lines.join('\n');
}

export type TwapEndDetails = {
  status: string;
  executedPct: number | null;
  executedSz: number | null;
  totalSz: number | null;
  coin: string;
  twapId: number | null;
  priceStart: number | null;
  priceEnd: number | null;
  priceChangePct: number | null;
};

export function buildTwapEndMessage(
  sig: NormalizedTwapSignal,
  end: TwapEndDetails,
  opts?: { userRating?: UserTwapRating | null },
): string {
  const statusLabel = endStatusLabelRu(end.status);
  const icon = endIcon(end.status);
  const pctLine =
    end.executedPct != null && end.executedSz != null && end.totalSz != null
      ? `Исполнено: ${end.executedPct.toFixed(2)}%\nРазмер: ${fmtSize(end.executedSz)} / ${fmtSize(end.totalSz)} ${end.coin}`
      : `Статус: ${escapeHtml(end.status)}`;

  const twapIdLine = end.twapId != null ? `TwapId: <code>${end.twapId}</code>` : '';
  const priceLines =
    end.priceStart != null && end.priceEnd != null
      ? `Цена в начале: ${formatUsdPrice(end.priceStart)}\nЦена в конце: ${formatUsdPrice(end.priceEnd)} ${priceDeltaEmoji(end.priceChangePct)} (${formatSignedPct(end.priceChangePct)})`
      : '';

  const lines = [
    `${icon} TWAP ${statusLabel}`,
    pctLine,
    twapIdLine,
    `Субъект: <code>${sig.user}</code>`,
    opts?.userRating ? formatUserRatingLineRu(opts.userRating) : '',
    priceLines,
    '',
    `🔗 <a href="${explorerTxUrl(sig.hash)}">Explorer</a> · <a href="${hypurrscanAddressUrl(sig.user)}">Hypurrscan</a>`,
  ].filter((l) => l.length > 0);
  return lines.join('\n');
}

function endStatusLabelRu(status: string): string {
  const s = status.toLowerCase();
  if (s === 'finished') return 'завершён';
  if (s === 'error') return 'отменён (частично)';
  if (s === 'terminated') return 'отменён (частично)';
  if (s === 'activated') return 'активен';
  return status;
}

function endIcon(status: string): string {
  const s = status.toLowerCase();
  if (s === 'finished') return '✅';
  if (s === 'error' || s === 'terminated') return '❌';
  return 'ℹ️';
}

function priceDeltaEmoji(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '';
  if (pct < -0.0001) return '🔴';
  if (pct > 0.0001) return '🟢';
  return '⚪';
}

function formatSignedPct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '?';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function fmtSize(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toFixed(4).replace(/\.?0+$/, '');
}

export function formatUtcTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} (UTC)`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function explorerTxUrl(hash: string): string {
  return `https://app.hyperliquid.xyz/explorer/tx/${hash}`;
}

export function hypurrscanAddressUrl(user: string): string {
  return `https://hypurrscan.io/address/${user}`;
}

export function mexcFuturesUrl(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  if (!s || s.includes('/') || s.startsWith('@')) return null;
  return `https://www.mexc.com/ru-RU/futures/${s}_USDT`;
}
