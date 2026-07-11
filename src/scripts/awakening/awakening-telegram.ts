import type { AwakeningConfig } from './awakening-config.js';
import type { AwakeningCandidate, AwakeningDexMarket, AwakeningSignalResult } from './awakening-types.js';

export function formatAwakeningSignalTelegramHtml(
  cfg: AwakeningConfig,
  candidate: AwakeningCandidate,
  market: AwakeningDexMarket,
  verdict: AwakeningSignalResult,
): string {
  const vol5m = Math.round(verdict.metrics.vol5mUsd).toLocaleString('en-US');
  const prior6h = Math.round(verdict.metrics.priorVol6hUsd).toLocaleString('en-US');
  const mcap = Math.round(market.marketCapUsd ?? 0).toLocaleString('en-US');
  const liq = Math.round(market.liquidityUsd ?? 0).toLocaleString('en-US');

  if (cfg.mode === 'shadow') {
    return [
      '<b>Awakening shadow — сигнал пойман</b>',
      '',
      `mint: <code>${candidate.mint}</code>`,
      `vol5m: $${vol5m} · prior6h: $${prior6h}`,
      `mcap: $${mcap} · liq: $${liq}`,
      `src: ${candidate.source}`,
      '',
      `Awakening поймал монету и <b>хотел бы</b> поставить гипотетический вход $${cfg.legUsd} (линия dormant_awakening).`,
      'Но реальная покупка через awakening <b>не выполняется</b> — фича в <b>shadow</b>-режиме (только журнал).',
      '',
      'Важно: live-lera по своей обычной воронке может купить эту же монету независимо — awakening в shadow ничего не блокирует и не исполняет.',
    ].join('\n');
  }

  return [
    `<b>Awakening live — сигнал → очередь входа</b>`,
    '',
    `mint: <code>${candidate.mint}</code>`,
    `vol5m: $${vol5m} · prior6h: $${prior6h}`,
    `mcap: $${mcap} · liq: $${liq}`,
    `src: ${candidate.source}`,
    '',
    `Поставлен intent $${cfg.legUsd} в очередь live-lera10 (dormant_awakening).`,
  ].join('\n');
}
