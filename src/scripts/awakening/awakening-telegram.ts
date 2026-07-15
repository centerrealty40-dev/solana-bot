import type { AwakeningConfig } from './awakening-config.js';
import type { AwakeningCandidate, AwakeningDexMarket, AwakeningSignalResult } from './awakening-types.js';

function gmgnUrl(mint: string): string {
  return `https://gmgn.ai/sol/token/${encodeURIComponent(mint.trim())}`;
}

function mskNow(): string {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtPrice(px: number | null | undefined): string {
  if (px == null || !Number.isFinite(px) || px <= 0) return '?';
  return px >= 1 ? `$${px.toFixed(4)}` : `$${px.toFixed(6)}`;
}

export function formatAwakeningSignalTelegramHtml(
  cfg: AwakeningConfig,
  candidate: AwakeningCandidate,
  market: AwakeningDexMarket,
  verdict: AwakeningSignalResult,
): string {
  const vol5m = Math.round(verdict.metrics.vol5mUsd).toLocaleString('en-US');
  const spike6h = verdict.metrics.vol5mSpikeVs6hMult.toFixed(1);
  const spike1h = verdict.metrics.vol5mSpikeVs1hMult.toFixed(1);
  const mcap = Math.round(market.marketCapUsd ?? 0).toLocaleString('en-US');
  const liq = Math.round(market.liquidityUsd ?? 0).toLocaleString('en-US');
  const entryPath = verdict.metrics.entryPath ?? '?';
  const gmgn = gmgnUrl(candidate.mint);
  const entryPx = fmtPrice(market.priceUsd);
  const m5 = market.priceChangeM5;
  const m5Str = m5 == null ? '?' : `${m5 >= 0 ? '+' : ''}${m5.toFixed(1)}%`;

  if (cfg.mode === 'shadow') {
    return [
      '<b>Awakening shadow — гипотетическая покупка</b>',
      '',
      `🕐 ${mskNow()} MSK`,
      `mint: <code>${candidate.mint}</code>`,
      `path: <b>${entryPath}</b> · src: ${candidate.source}`,
      '',
      `<b>Цена входа:</b> ${entryPx} · mcap $${mcap} · m5 ${m5Str}`,
      `vol5m: $${vol5m} · spike 6h/1h: ${spike6h}x / ${spike1h}x · liq $${liq}`,
      `leg: $${cfg.legUsd} (dormant_awakening)`,
      '',
      `<a href="${gmgn}">GMGN — смотреть онлайн</a>`,
      '',
      'Shadow: реальной покупки нет — только журнал. Сравни на GMGN, хороший вход или нет.',
    ].join('\n');
  }

  return [
    `<b>Awakening live — сигнал → очередь входа</b>`,
    '',
    `🕐 ${mskNow()} MSK`,
    `mint: <code>${candidate.mint}</code>`,
    `path: <b>${entryPath}</b> · src: ${candidate.source}`,
    '',
    `<b>Цена входа:</b> ${entryPx} · mcap $${mcap} · m5 ${m5Str}`,
    `vol5m: $${vol5m} · spike 6h/1h: ${spike6h}x / ${spike1h}x · liq $${liq}`,
    '',
    `<a href="${gmgn}">GMGN — смотреть онлайн</a>`,
    '',
    `Intent $${cfg.legUsd} → очередь live-lera10 (dormant_awakening).`,
  ].join('\n');
}
